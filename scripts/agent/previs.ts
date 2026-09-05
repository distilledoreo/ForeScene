/**
 * ForeScene autonomous previs orchestration (CLI-side).
 *
 * Phases: validate → optional reset → locations/cast/props → shot batches →
 * render stills/control videos → validation/repairs → contact sheet → package.
 */

import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import {
  saveAgentArtifactToFile,
  toCliArtifactTransfer,
  type AgentArtifactTransferTelemetry,
} from './artifactIo';
import type { CameraData, LocationProject, Shot } from '../../src/domain/types';
import {
  assertManifestHashCompatible,
  applyManifestUpdateToRunState,
  aspectRatioValue,
  buildContactSheetSpec,
  buildRepairPlan,
  buildShotCompositionTelemetry,
  compileProduction,
  compileCastPhaseWithPersistedEntities,
  compilePropsPhaseWithPersistedEntities,
  compileShotList,
  contactSheetHtml,
  buildProductionReviewArtifacts,
  inspectShotCompositionError,
  createInitialRunState,
  firstIncompletePhase,
  inferExistingProjectLocationBindings,
  preflightProductionAssets,
  hashPrevisManifest,
  isCanonicalFrame,
  isRepairableIssue,
  migrateRenderPipelineVersion,
  migrateRenderProfileChange,
  parsePrevisProductionManifest,
  parseRunState,
  preflightContactSheet,
  setPhase,
  touchRunState,
  upsertEntity,
  upsertShotState,
  buildSubjectBoundsForRepair,
  buildSubjectIdentityMap,
  solidBlockersForRepair,
  validateShotFrame,
  mergeFrameValidationWithVisualPreflight,
  rankFrameValidation,
  isValidationRankImproved,
  extractFramingMetrics,
  type FrameValidationResult,
  type PrevisEntityMapping,
  type PrevisProductionManifestV1,
  type PrevisRunState,
  type RemovedShotEntry,
  type ShotCompositionTelemetry,
  type RenderProfile,
  DELIVERY_PROFILE,
  resolveRenderAppearanceForShot,
  resolveEmbeddedPropIntents,
  resolveRenderProfileForMode,
  renderProfileFingerprint,
  computeRenderFingerprint,
  emptyProductionTiming,
  ProductionTimeBudget,
  ProductionTimeBudgetExceededError,
  hasMissingControlVideos,
  type ProductionRunTiming,
} from '../../src/engine/previs/index';
import type { RenderSessionShotJob } from '../../src/engine/previs/renderSession';
import { isIntactSystemScaffoldShot } from '../../src/domain/scaffold';
import { attachAgentRunSession, detachAgentRunSession, startAgentRunSession } from './agentSession';
import { openAgentBrowser, waitForAgentIdle } from './browser';
import { captureSceneScreenshot, openWorkspace } from './screenshot';
import { createPersistentRenderSession, type PersistentRenderSession } from './renderSession';
import { createCliAbortScope, installCliAbortBridge } from './cliAbort';
import { createCliInvocationIdentity, publishCliInvocationIdentity } from './cliIdentity';
import {
  deriveRenderStillsOutcome,
  evaluateContactSheetFrames,
  type ContactSheetFrameReport,
} from './batchHonesty';
import { selectPrunableShots } from './shotPrune';

export interface PrevisCliOptions {
  manifestPath: string;
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  resetProject: boolean;
  /** Controlled correction loop: accept a changed manifest and invalidate dependents. */
  updateManifest?: boolean;
  /** When true, stop after initialize/reset (PR1 behavior). */
  initializeOnly?: boolean;
  outputDir: string;
  skipPackage?: boolean;
  profileDir?: string;
  /** Explicitly authorize heavy/extreme character imports for this run. */
  allowHeavyCharacterImports?: boolean;
  /** Production mode — rapid-review uses low-res frames and skips control videos. */
  mode?: 'rapid-review' | 'delivery' | 'previs';
  renderProfile?: RenderProfile;
  renderProfileId?: string;
  renderProfileFingerprint?: string;
  runId?: string;
  autoRepair?: boolean;
  maxRepairPasses?: number;
  timeBudgetSeconds?: number;
  skipControlVideos?: boolean;
  /** Export a verified .fsp backup before the production session closes. */
  finalProjectPath?: string;
  /**
   * Delete non-manifest user shots after compilation. Default false: only
   * intact scaffold shots (blank Origin) are pruned; other non-manifest shots
   * are retained and reported.
   */
  pruneNonManifestShots?: boolean;
}

export interface PrevisCliResult {
  ok: boolean;
  phase?: string;
  projectId?: string;
  manifestHash?: string;
  runStatePath?: string;
  shotsRequested?: number;
  shotsCreated?: number;
  importedCharacters?: number;
  framesRendered?: number;
  cacheHits?: number;
  cacheMisses?: number;
  cacheHitRate?: number;
  controlVideosRendered?: number;
  controlVideosFailed?: number;
  passed?: number;
  warnings?: number;
  failed?: number;
  reviewRequiredShotIds?: string[];
  contactSheet?: string;
  reviewArtifacts?: string[];
  package?: string;
  packageTransfer?: AgentArtifactTransferTelemetry;
  finalProject?: string;
  finalProjectTransfer?: AgentArtifactTransferTelemetry;
  artifactPaths?: string[];
  diagnostics?: unknown[];
  timing?: ProductionRunTiming;
  sourceRevisionId?: string;
  resultRevisionId?: string;
  provenance?: unknown;
  partial?: boolean;
  budgetExceeded?: boolean;
  /** Total repair passes attempted across the run (previs summary honesty). */
  repairsAttempted?: number;
  /** True iff --no-auto-repair disabled the repair loop for this run. */
  repairsDisabled?: boolean;
  /** Standalone render-stills conjunction report. */
  shotsConsidered?: number;
  renderedComplete?: number;
  failedShotNumbers?: string[];
  pendingShotNumbers?: string[];
  /** Standalone contact-sheet per-frame preflight report. */
  frames?: ContactSheetFrameReport['frames'];
  error?: string;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface RepairAttemptLogEntry {
  attempt: number;
  kept: boolean;
  before: Record<string, number>;
  action: { type: string; scale?: number; targetHeadY?: number; targetCropY?: number };
  after: Record<string, number>;
}

async function readRepairHistory(filePath: string): Promise<RepairAttemptLogEntry[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as RepairAttemptLogEntry[] : [];
  } catch {
    return [];
  }
}

async function writeDataUrlPng(dataUrl: string, filePath: string): Promise<void> {
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
  if (!match?.[1]) {
    throw new Error('renderShotFrame did not return a PNG data URL.');
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(match[1], 'base64'));
}

function readPngSizeSync(filePath: string): { width: number; height: number; isPng: boolean } {
  // Minimal PNG IHDR parse (no external deps).
  try {
    const fd = openSync(filePath, 'r');
    const header = Buffer.alloc(24);
    readSync(fd, header, 0, 24, 0);
    closeSync(fd);
    const isPng = header[0] === 0x89
      && header[1] === 0x50
      && header[2] === 0x4e
      && header[3] === 0x47;
    if (!isPng) return { width: 0, height: 0, isPng: false };
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return { width, height, isPng: true };
  } catch {
    return { width: 0, height: 0, isPng: false };
  }
}

/**
 * Select shot, wait for viewport readiness, then render a clean clay frame
 * via the shared package-export renderer (not a UI screenshot).
 */
async function renderCleanShotFrame(
  page: Page,
  shotId: string,
  framePath: string,
  options?: {
    debugUiPath?: string;
    captureDebugUi?: boolean;
    profile?: RenderProfile;
    renderSession?: PersistentRenderSession;
    shotNumber?: string;
    timeSeconds?: number;
    appearance?: RenderProfile['appearance'];
  },
): Promise<{
  ok: boolean;
  width: number;
  height: number;
  pixelStats?: {
    width: number;
    height: number;
    opaquePixelRatio: number;
    luminanceMean: number;
    luminanceVariance: number;
    sampledUniqueColorCount: number;
  };
  revisionId?: string;
  error?: string;
  fromCanonicalRenderer: boolean;
  source?: 'canonical_clay_renderer' | 'canonical_projected_renderer';
}> {
  if (options?.renderSession) {
    const result = await options.renderSession.renderShot({
      shotId,
      shotNumber: options.shotNumber ?? shotId,
      framePath,
      debugUiPath: options.debugUiPath,
      captureDebugUi: options.captureDebugUi,
      appearance: options.appearance,
    });
    return {
      ok: result.ok,
      width: result.width,
      height: result.height,
      pixelStats: result.pixelStats,
      revisionId: result.revisionId,
      error: result.error,
      fromCanonicalRenderer: result.fromCanonicalRenderer,
      source: result.source,
    };
  }

  const profile = options?.profile ?? DELIVERY_PROFILE;
  await page.evaluate(async (id) => {
    await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
    await window.foreScene!.applyPlan({
      version: 1,
      planId: `select-${id}`,
      commands: [{ op: 'shot.select', shot: { id } }],
    });
  }, shotId);

  await waitForAgentIdle(page);

  // Best-effort viewport readiness. Clean clay frames use the offline WebGL
  // renderer, so a readiness timeout is non-fatal (debug UI capture only).
  const ready = await page.evaluate(async (id) => {
    return window.foreScene!.waitForViewportReady({
      workspace: 'shots',
      shotId: id,
      timeoutMs: 12_000,
    });
  }, shotId).catch((error: unknown) => ({
    ok: false as const,
    diagnostics: [{
      code: 'render_not_ready',
      message: error instanceof Error ? error.message : String(error),
      severity: 'error' as const,
    }],
  }));

  if (!ready.ok && options?.debugUiPath) {
    await captureSceneScreenshot(page, options.debugUiPath).catch(() => undefined);
  }

  const result = await page.evaluate(async (payload) => {
    return window.foreScene!.renderShotFrame({
      shotId: payload.shotId,
      timeSeconds: payload.timeSeconds,
      appearance: payload.appearance,
      peopleVariant: payload.peopleVariant,
      content: payload.content,
      width: payload.width,
      height: payload.height,
    });
  }, {
    shotId,
    timeSeconds: options?.timeSeconds,
    appearance: options?.appearance ?? profile.appearance,
    peopleVariant: profile.peopleVariant,
    content: profile.content,
    ...(profile.overrideDimensions
      ? { width: profile.width, height: profile.height }
      : {}),
  });

  if (!result.ok || !result.pngDataUrl) {
    if (options?.debugUiPath) {
      await captureSceneScreenshot(page, options.debugUiPath).catch(() => undefined);
    }
    return {
      ok: false,
      width: result.width,
      height: result.height,
      pixelStats: result.pixelStats,
      revisionId: result.revisionId,
      error: result.diagnostics?.[0]?.message ?? 'Clean frame render failed.',
      fromCanonicalRenderer: false,
    };
  }

  await writeDataUrlPng(result.pngDataUrl, framePath);

  // Optional debug UI screenshot (never used as production frame). Success
  // screenshots are opt-in; failures are captured above for diagnosis.
  if (options?.debugUiPath && options.captureDebugUi) {
    await captureSceneScreenshot(page, options.debugUiPath).catch(() => undefined);
  }

  return {
    ok: true,
    width: result.width,
    height: result.height,
    pixelStats: result.pixelStats,
    revisionId: result.revisionId,
    fromCanonicalRenderer: result.source === 'canonical_clay_renderer'
      || result.source === 'canonical_projected_renderer',
    source: result.source === 'canonical_projected_renderer'
      ? 'canonical_projected_renderer'
      : 'canonical_clay_renderer',
  };
}

async function renderControlVideo(
  page: Page,
  shotId: string,
  videoPath: string,
  appearance: RenderProfile['appearance'],
): Promise<{ ok: boolean; assetId?: string; error?: string; transfer?: AgentArtifactTransferTelemetry }> {
  const result = await page.evaluate(async ({ id, resolvedAppearance }) => window.foreScene!.renderShotVideo({
    shotId: id,
    mode: 'render',
    resolutionPreset: '1080p',
    appearance: resolvedAppearance,
    contentMode: 'full_scene',
    // This runner owns the file artifact. Attaching here can race timeline
    // persistence and incorrectly turn a valid render into stale_revision.
    attachToShot: false,
    download: false,
  }), { id: shotId, resolvedAppearance: appearance });
  if (!result.ok) {
    return { ok: false, error: result.diagnostics?.[0]?.message ?? 'Control video render failed.' };
  }
  if (!result.artifact?.artifactId) {
    return { ok: false, error: 'Control video render completed without an artifact handle.' };
  }
  const saved = await saveAgentArtifactToFile(page, result.artifact.artifactId, videoPath);
  return { ok: true, assetId: result.assetId, transfer: toCliArtifactTransfer(saved) };
}

async function loadOrCreateRunState(params: {
  outputDir: string;
  manifest: PrevisProductionManifestV1;
  manifestHash: string;
  updateManifest?: boolean;
}): Promise<{
  state: PrevisRunState;
  resumed: boolean;
  error?: string;
  updated?: boolean;
  sceneRebuildRequired?: boolean;
  removedShots?: RemovedShotEntry[];
}> {
  const runStatePath = path.join(params.outputDir, 'run-state.json');
  const normalizedPath = path.join(params.outputDir, 'manifest.normalized.json');
  if (await pathExists(runStatePath)) {
    const raw = JSON.parse(await readFile(runStatePath, 'utf8')) as unknown;
    const existing = parseRunState(raw);
    if (!existing) {
      return {
        state: createInitialRunState({
          manifestHash: params.manifestHash,
          outputDir: params.outputDir,
          shotNumbers: params.manifest.shots.map((shot) => shot.shotNumber),
        }),
        resumed: false,
        error: 'Existing run-state.json is invalid; starting a fresh run-state.',
      };
    }
    // Invalidate UI-screenshot-era frames while preserving compiled shots.
    const migrated = migrateRenderPipelineVersion(existing);
    const baseState = migrated.state;

    const compatible = assertManifestHashCompatible(baseState, params.manifestHash);
    if (!compatible.ok) {
      if (!params.updateManifest) {
        return { state: baseState, resumed: true, error: compatible.message };
      }
      if (!(await pathExists(normalizedPath))) {
        return {
          state: baseState,
          resumed: true,
          error: 'Cannot --update-manifest without a previous manifest.normalized.json.',
        };
      }
      const previous = parsePrevisProductionManifest(
        JSON.parse(await readFile(normalizedPath, 'utf8')) as unknown,
      ).manifest;
      if (!previous) {
        return {
          state: baseState,
          resumed: true,
          error: 'Previous manifest.normalized.json failed to parse; cannot update.',
        };
      }
      const updated = applyManifestUpdateToRunState({
        state: baseState,
        previousManifest: previous,
        nextManifest: params.manifest,
        nextManifestHash: params.manifestHash,
      });
      // Re-apply pipeline migration after update-manifest (preserves compile invalidation).
      const remigrated = migrateRenderPipelineVersion(updated.state);
      const sceneRebuildRequired = (
        updated.diff.invalidateLocations
        || updated.diff.invalidateCast
        || updated.diff.invalidateProps
      );
      return {
        state: remigrated.state,
        resumed: true,
        updated: true,
        sceneRebuildRequired,
        removedShots: updated.removedShots,
      };
    }
    return { state: baseState, resumed: true };
  }

  return {
    state: createInitialRunState({
      manifestHash: params.manifestHash,
      outputDir: params.outputDir,
      shotNumbers: params.manifest.shots.map((shot) => shot.shotNumber),
    }),
    resumed: false,
  };
}

async function applyPlanOnPage(page: Page, plan: unknown) {
  await page.evaluate(async () => {
    await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
  });
  return page.evaluate(async (planJson) => window.foreScene!.applyPlan(planJson), plan);
}

function manifestCharacterSourcePath(manifestPath: string, source: string): string {
  return path.resolve(path.dirname(path.resolve(manifestPath)), source);
}

interface ResolvedManifestCharacterAsset {
  id: string;
  sourcePath: string;
  sourceSha256: string;
  rigPackagePath?: string;
  rigPackageSha256?: string;
  importFingerprint: string;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function resolveManifestCharacterAsset(
  manifestPath: string,
  character: Extract<PrevisProductionManifestV1['cast'][number], { type: 'imported_character' }>,
): Promise<ResolvedManifestCharacterAsset> {
  const sourcePath = manifestCharacterSourcePath(manifestPath, character.source);
  const sourceSha256 = await sha256File(sourcePath);
  const rigPackagePath = character.rigPackage
    ? manifestCharacterSourcePath(manifestPath, character.rigPackage)
    : undefined;
  const rigPackageSha256 = rigPackagePath ? await sha256File(rigPackagePath) : undefined;
  const importFingerprint = createHash('sha256')
    .update(await readFile(sourcePath))
    .update(rigPackagePath ? await readFile(rigPackagePath) : Buffer.alloc(0))
    .update(JSON.stringify({
      rigMode: character.rigMode,
      height: character.height,
      defaultPose: character.defaultPose,
    }))
    .digest('hex');
  return {
    id: character.id,
    sourcePath,
    sourceSha256,
    ...(rigPackagePath ? { rigPackagePath } : {}),
    ...(rigPackageSha256 ? { rigPackageSha256 } : {}),
    importFingerprint: `sha256:${importFingerprint}`,
  };
}

async function importManifestCharacter(
  page: Page,
  manifestPath: string,
  entry: {
    entityKey: string;
    character: Extract<PrevisProductionManifestV1['cast'][number], { type: 'imported_character' }>;
  },
  consentToken?: string,
) {
  const sourcePath = manifestCharacterSourcePath(manifestPath, entry.character.source);
  await page.locator('[data-agent-character-import-input]').setInputFiles(sourcePath);
  const result = await page.evaluate(async (input) => {
    const fileInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    if (!file) throw new Error('Character file was not staged in the browser.');

    const requestedMode = input.rigMode === 'saved-rig'
      ? 'auto'
      : input.rigMode === 'preserve-existing'
      ? 'preserveExistingRig'
      : input.rigMode;
    const analysis = await window.foreScene!.analyzeCharacterImport({
      file,
      mode: requestedMode,
      ...(input.height !== undefined ? { approximateHeightMeters: input.height } : {}),
    });
    const mode = input.rigMode === 'preserve-existing'
      ? 'preserveExistingRig'
      : input.rigMode === 'autorig'
        ? 'autorig'
        : analysis.hasSkeleton
          && analysis.hasSkinning
          && analysis.requiredMissing.length === 0
          && (analysis.mappingConfidence ?? 0) >= 0.7
          ? 'preserveExistingRig'
          : 'autorig';
    const result = await window.foreScene!.importCharacter({
      analysisId: analysis.analysisId,
      mode,
      name: input.name,
      consentToken: input.consentToken,
    });
    return { analysis, result };
  }, {
    name: entry.character.name,
    height: entry.character.height,
    rigMode: entry.character.rigMode,
    consentToken,
  });
  return { sourcePath, result };
}

async function importManifestModelAsset(
  page: Page,
  sourcePath: string,
  consentToken?: string,
) {
  await page.locator('[data-agent-model-import-input]').setInputFiles(sourcePath);
  return page.evaluate(async (input) => {
    const fileInput = document.querySelector('[data-agent-model-import-input]') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];
    if (!file) throw new Error('Model file was not staged in the browser.');
    return window.foreScene!.importModel({
      file,
      mode: 'separate',
      consentToken: input.consentToken,
    });
  }, { consentToken });
}

async function ensureImportedModelAssemblyGroup(
  page: Page,
  assetId: string,
  objectIds: string[],
  preferredGroupId?: string,
): Promise<{ ok: boolean; groupId?: string; diagnostics?: unknown[] }> {
  if (objectIds.length <= 1) return { ok: true };
  return page.evaluate(async (input) => {
    const project = window.foreScene!.getProjectDocument();
    const importedObjects = input.objectIds.map((objectId) => (
      project.scene.objects.find((object) => object.id === objectId)
    ));
    const sourceImportIds = [...new Set(importedObjects.flatMap((object) => (
      object?.importedModel?.sourceImportId ? [object.importedModel.sourceImportId] : []
    )))];
    if (importedObjects.some((object) => !object) || sourceImportIds.length !== 1) {
      return {
        ok: false,
        diagnostics: [{
          code: 'imported_assembly_identity_unresolved',
          severity: 'error',
          message: `Imported asset "${input.assetId}" does not resolve to one complete source import.`,
        }],
      };
    }
    const sourceImportId = sourceImportIds[0]!;
    const groups = project.scene.objectGroups ?? {};
    let existing = input.preferredGroupId ? groups[input.preferredGroupId] : undefined;
    if (!existing) {
      for (const group of Object.values(groups)) {
        if (group.objectIds.length !== input.objectIds.length) continue;
        let sameMembers = true;
        for (const objectId of group.objectIds) {
          if (!input.objectIds.includes(objectId)) {
            sameMembers = false;
            break;
          }
        }
        if (sameMembers) {
          existing = group;
          break;
        }
      }
    }
    if (existing?.sourceImportId === sourceImportId) return { ok: true, groupId: existing.id };
    const created = await window.foreScene!.createObjectGroup({
      name: `${input.assetId} assembly`,
      objectIds: input.objectIds,
      sourceImportId,
    });
    return {
      ok: created.ok,
      groupId: created.groupId,
      diagnostics: created.diagnostics,
    };
  }, { assetId, objectIds, preferredGroupId });
}

function collectManifestSemanticBindings(
  manifest: PrevisProductionManifestV1,
  state: PrevisRunState,
): { bindings: Record<string, string>; groupBindings: Record<string, string> } {
  const bindings: Record<string, string> = {};
  const groupBindings: Record<string, string> = {};
  const entities = [
    ...manifest.cast.map((entry) => ({ id: entry.id, key: `cast.${entry.id}` })),
    ...(manifest.props ?? []).map((entry) => ({ id: entry.id, key: `props.${entry.id}` })),
    ...(manifest.assets ?? []).map((entry) => ({ id: entry.id, key: `assets.${entry.id}` })),
  ];
  for (const entity of entities) {
    const mapping = state.entities[entity.key];
    if (mapping?.objectId) bindings[entity.id] = mapping.objectId;
    if (mapping?.groupId) groupBindings[entity.id] = mapping.groupId;
  }
  return { bindings, groupBindings };
}

async function synchronizeManifestProductionConfiguration(
  page: Page,
  manifest: PrevisProductionManifestV1,
  state: PrevisRunState,
) {
  const semantic = collectManifestSemanticBindings(manifest, state);
  return page.evaluate(async (input) => {
    const bound = await window.foreScene!.bindManifestAssets(input);
    const configuration = window.foreScene!.inspectProductionConfiguration();
    const validation = window.foreScene!.validateProductionConfiguration({ manifest: input.manifest });
    return { bound, configuration, validation };
  }, { manifest, ...semantic });
}

async function analyzeManifestSavedRigCharacter(
  page: Page,
  asset: ResolvedManifestCharacterAsset,
  character: Extract<PrevisProductionManifestV1['cast'][number], { type: 'imported_character' }>,
) {
  if (!asset.rigPackagePath) throw new Error(`No rig package was resolved for saved-rig character "${character.id}".`);
  await page.locator('[data-agent-character-import-input]').setInputFiles(asset.sourcePath);
  await page.locator('[data-agent-character-rig-package-input]').setInputFiles(asset.rigPackagePath);
  return page.evaluate(async (input) => {
    const sourceInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
    const rigInput = document.querySelector('[data-agent-character-rig-package-input]') as HTMLInputElement | null;
    const sourceFile = sourceInput?.files?.[0];
    const rigPackageFile = rigInput?.files?.[0];
    if (!sourceFile || !rigPackageFile) throw new Error('Saved-rig files were not staged in the browser.');
    const sourceAnalysis = await window.foreScene!.analyzeCharacterImport({
      file: sourceFile,
      mode: 'auto',
      ...(input.height !== undefined ? { approximateHeightMeters: input.height } : {}),
    });
    const compatibility = await window.foreScene!.analyzeSavedRigCharacter({
      sourceFile,
      rigPackageFile,
      ...(input.height !== undefined ? { approximateHeightMeters: input.height } : {}),
    });
    return { ...compatibility, sourceImportRequiresConsent: sourceAnalysis.requiresConsent };
  }, { height: character.height });
}

async function importManifestSavedRigCharacter(
  page: Page,
  asset: ResolvedManifestCharacterAsset,
  character: Extract<PrevisProductionManifestV1['cast'][number], { type: 'imported_character' }>,
  consentToken?: string,
) {
  if (!asset.rigPackagePath) throw new Error(`No rig package was resolved for saved-rig character "${character.id}".`);
  await page.locator('[data-agent-character-import-input]').setInputFiles(asset.sourcePath);
  await page.locator('[data-agent-character-rig-package-input]').setInputFiles(asset.rigPackagePath);
  return page.evaluate(async (input) => {
    const sourceInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
    const rigInput = document.querySelector('[data-agent-character-rig-package-input]') as HTMLInputElement | null;
    const sourceFile = sourceInput?.files?.[0];
    const rigPackageFile = rigInput?.files?.[0];
    if (!sourceFile || !rigPackageFile) throw new Error('Saved-rig files were not staged in the browser.');
    return window.foreScene!.importSavedRigCharacter({
      sourceFile,
      rigPackageFile,
      name: input.name,
      consentToken: input.consentToken,
      ...(input.height !== undefined ? { approximateHeightMeters: input.height } : {}),
    });
  }, { name: character.name, height: character.height, consentToken });
}

async function resetProjectOnPage(
  page: Page,
  input: {
    name: string;
    description?: string;
    aspectRatio?: string;
    frameRate?: number;
  },
) {
  await page.evaluate(async () => {
    await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
  });
  return page.evaluate(async (payload) => window.foreScene!.resetProject({
    ...payload,
    resetAuthorization: 'reset-project',
  }), input);
}

function resolveMappingIds(
  mapping: PrevisEntityMapping,
  createdRefs?: Record<string, { id: string; ref?: string; kind: string; name: string }>,
): PrevisEntityMapping {
  if (!createdRefs) return mapping;
  const next: PrevisEntityMapping = { ...mapping };
  if (mapping.objectId && createdRefs[mapping.objectId]) {
    next.objectId = createdRefs[mapping.objectId]!.id;
  }
  if (mapping.objectIds) {
    next.objectIds = mapping.objectIds.map((token) => createdRefs[token]?.id ?? token);
  }
  if (mapping.anchors) {
    next.anchors = Object.fromEntries(
      Object.entries(mapping.anchors).map(([key, token]) => [
        key,
        createdRefs[token]?.id ?? token,
      ]),
    );
  }
  if (mapping.refs) {
    next.refs = Object.fromEntries(
      Object.entries(mapping.refs).map(([key, token]) => [
        key,
        createdRefs[token]?.id ?? token,
      ]),
    );
  }
  return next;
}

export async function runPrevisCli(options: PrevisCliOptions): Promise<PrevisCliResult> {
  const runStartedAt = Date.now();
  const outputDir = path.resolve(options.outputDir);
  const mode = options.mode ?? 'previs';
  const renderProfile = options.renderProfile ?? resolveRenderProfileForMode(mode);
  const renderProfileFingerprintValue = options.renderProfileFingerprint
    ?? renderProfileFingerprint(renderProfile);
  const runId = options.runId ?? `previs_${Date.now().toString(36)}`;
  const autoRepair = options.autoRepair ?? true;
  const maxRepairPasses = options.maxRepairPasses ?? 3;
  const skipControlVideos = options.skipControlVideos ?? !renderProfile.renderVideo;
  const skipPackage = options.skipPackage ?? renderProfile.skipPackage;
  const timeBudget = options.timeBudgetSeconds
    ? new ProductionTimeBudget(options.timeBudgetSeconds, runStartedAt)
    : undefined;
  const timing = emptyProductionTiming();
  let sourceRevisionId: string | undefined;
  let resultRevisionId: string | undefined;
  let repairMs = 0;
  let repairsAttemptedTotal = 0;
  const pruneNonManifest = options.pruneNonManifestShots ?? false;

  await mkdir(outputDir, { recursive: true });
  await mkdir(path.join(outputDir, 'logs'), { recursive: true });
  await mkdir(path.join(outputDir, 'shots'), { recursive: true });
  await mkdir(path.join(outputDir, 'debug'), { recursive: true });

  const rawManifest = await readFile(path.resolve(options.manifestPath), 'utf8');
  const validationStartedAt = Date.now();
  const parsed = parsePrevisProductionManifest(JSON.parse(rawManifest) as unknown);
  timing.validationMs = Date.now() - validationStartedAt;
  if (!parsed.manifest || parsed.errors.length > 0) {
    return {
      ok: false,
      phase: 'validate',
      diagnostics: parsed.errors,
      error: 'Manifest validation failed.',
    };
  }

  const embeddedPropResolution = resolveEmbeddedPropIntents(parsed.manifest);
  const manifest = embeddedPropResolution.manifest;
  await writeJson(path.join(outputDir, 'logs', 'derived-semantic-intents.json'), {
    embeddedProps: embeddedPropResolution.derived,
  });
  const consentToken = options.allowHeavyCharacterImports
    ? 'agent:previs:allow-heavy-character-imports'
    : undefined;
  const manifestHash = hashPrevisManifest(manifest);
  const importedCharacterCount = manifest.cast.filter((character) => character.type === 'imported_character').length;
  const characterAssets: ResolvedManifestCharacterAsset[] = [];

  for (const character of manifest.cast) {
    if (character.type !== 'imported_character') continue;
    const sourcePath = manifestCharacterSourcePath(options.manifestPath, character.source);
    try {
      const info = await stat(sourcePath);
      if (!info.isFile()) throw new Error('source is not a file');
    } catch {
      return {
        ok: false,
        phase: 'validate',
        diagnostics: [{
          code: 'missing_imported_character_source',
          path: `cast[id=${character.id}].source`,
          message: `Imported character source was not found: ${sourcePath}`,
          severity: 'error',
        }],
        error: 'Manifest validation failed.',
      };
    }
    if (character.rigPackage) {
      const rigPackagePath = manifestCharacterSourcePath(options.manifestPath, character.rigPackage);
      try {
        const info = await stat(rigPackagePath);
        if (!info.isFile()) throw new Error('rigPackage is not a file');
      } catch {
        return {
          ok: false,
          phase: 'validate',
          diagnostics: [{
            code: 'missing_saved_rig_package',
            path: `cast[id=${character.id}].rigPackage`,
            message: `Saved rig package was not found: ${rigPackagePath}`,
            severity: 'error',
          }],
          error: 'Manifest validation failed.',
        };
      }
    }
    try {
      characterAssets.push(await resolveManifestCharacterAsset(options.manifestPath, character));
    } catch (error) {
      return {
        ok: false,
        phase: 'validate',
        diagnostics: [{
          code: 'character_asset_hash_failed',
          path: `cast[id=${character.id}]`,
          message: error instanceof Error ? error.message : `Could not hash imported character "${character.id}".`,
          severity: 'error',
        }],
        error: 'Manifest validation failed.',
      };
    }
  }

  const assetPreflight = await preflightProductionAssets(manifest, options.manifestPath);
  if (!assetPreflight.ok) {
    return {
      ok: false,
      phase: 'validate',
      diagnostics: assetPreflight.errors,
      error: 'Manifest asset preflight failed.',
    };
  }

  const loaded = await loadOrCreateRunState({
    outputDir,
    manifest,
    manifestHash,
    updateManifest: options.updateManifest,
  });
  let state = loaded.state;
  const profileMigration = migrateRenderProfileChange(state, renderProfileFingerprintValue);
  state = profileMigration.state;
  state = {
    ...state,
    runId,
    mode,
    renderProfileId: renderProfile.id,
    renderProfileFingerprint: renderProfileFingerprintValue,
  };
  const runStatePath = path.join(outputDir, 'run-state.json');

  if (loaded.error && loaded.resumed && !loaded.updated) {
    // Keep the previous manifest.normalized.json intact for a later --update-manifest.
    await writeJson(runStatePath, state);
    return {
      ok: false,
      phase: 'initialized',
      manifestHash,
      runStatePath,
      error: loaded.error,
    };
  }

  if (loaded.sceneRebuildRequired && !options.resetProject) {
    return {
      ok: false,
      phase: 'initialized',
      manifestHash,
      runStatePath,
      error:
        'Manifest update changed locations, cast, or props. Re-run with --update-manifest --reset-project so the scene can be rebuilt without duplicate creates. Shot-only edits do not need --reset-project.',
    };
  }

  const staleImportedCharacters = characterAssets.filter((asset) => {
    const mapping = state.entities[`cast.${asset.id}`];
    return Boolean(mapping?.objectId && mapping.importFingerprint !== asset.importFingerprint);
  });
  if (staleImportedCharacters.length > 0 && !(options.updateManifest && options.resetProject)) {
    const first = staleImportedCharacters[0]!;
    return {
      ok: false,
      phase: 'initialized',
      manifestHash,
      runStatePath,
      error:
        `Imported character "${first.id}" changed since the previous run. `
        + 'Run with --update-manifest --reset-project to rebuild cast-dependent shots.',
    };
  }

  await writeJson(path.join(outputDir, 'manifest.normalized.json'), manifest);

  if (loaded.updated) {
    await writeJson(path.join(outputDir, 'logs', 'manifest-update.json'), {
      nextHash: manifestHash,
      note: 'Applied controlled --update-manifest invalidation.',
      sceneRebuildRequired: Boolean(loaded.sceneRebuildRequired),
    });
    await writeJson(runStatePath, state);
  }

  if (options.resetProject && !options.writeAccess) {
    return {
      ok: false,
      error: '--reset-project requires --write (or --persist-write).',
    };
  }

  let triggerBrowserAbort: (() => void) | undefined;
  const abortScope = createCliAbortScope({
    onAbort: () => {
      triggerBrowserAbort?.();
      void session.page.evaluate(() => {
        const api = window.foreScene;
        if (!api) return;
        api.cancelPackageExport?.();
        api.cancelShotVideoRender?.();
        api.cancelShotStillPreparation?.();
        api.cancelRenderWork?.();
      }).catch(() => undefined);
    },
  });
  if (!options.profileDir) {
    return {
      ok: false,
      phase: 'validate',
      error: 'Production/previs runs require an explicit --profile.',
    };
  }
  const runSession = await startAgentRunSession({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
    profileDir: options.profileDir,
    command: 'previs',
  });
  attachAgentRunSession(runSession);
  const session = runSession.browser;
  triggerBrowserAbort = await installCliAbortBridge(session.page);
  await publishCliInvocationIdentity(session.page, createCliInvocationIdentity({
    command: 'previs',
    profile: options.profileDir,
  }));

  let framesRendered = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let controlVideosRendered = 0;
  let controlVideosFailed = 0;

  try {
    timeBudget?.assertWithinBudget('open_package');
    await waitForAgentIdle(session.page);
    const status = await session.page.evaluate(() => window.foreScene!.getStatus());
    sourceRevisionId = status.revisionId;

    const compilationStartedAt = Date.now();
    const savedRigPreflight = [] as Array<{
      id: string;
      source: string;
      rigPackage: string;
      sourceSha256: string;
      rigPackageSha256?: string;
      ok: boolean;
      analysis?: unknown;
      diagnostics?: unknown[];
    }>;
    for (const character of manifest.cast) {
      if (character.type !== 'imported_character' || character.rigMode !== 'saved-rig') continue;
      const asset = characterAssets.find((candidate) => candidate.id === character.id);
      if (!asset?.rigPackagePath) continue;
      try {
        const analysis = await analyzeManifestSavedRigCharacter(session.page, asset, character);
        const diagnostics = [...analysis.diagnostics];
        if (analysis.sourceImportRequiresConsent && !consentToken) {
          diagnostics.push({
            code: 'invalid_argument',
            message: 'This character import requires explicit consent because it exceeds the standard memory tier.',
            severity: 'error',
          });
        }
        savedRigPreflight.push({
          id: character.id,
          source: character.source,
          rigPackage: character.rigPackage!,
          sourceSha256: asset.sourceSha256,
          ...(asset.rigPackageSha256 ? { rigPackageSha256: asset.rigPackageSha256 } : {}),
          ok: analysis.ok && diagnostics.length === 0,
          analysis,
          diagnostics,
        });
      } catch (error) {
        savedRigPreflight.push({
          id: character.id,
          source: character.source,
          rigPackage: character.rigPackage!,
          sourceSha256: asset.sourceSha256,
          ...(asset.rigPackageSha256 ? { rigPackageSha256: asset.rigPackageSha256 } : {}),
          ok: false,
          diagnostics: [{
            code: 'saved_rig_preflight_failed',
            message: error instanceof Error ? error.message : String(error),
            severity: 'error',
          }],
        });
      }
    }
    if (savedRigPreflight.length > 0) {
      await writeJson(path.join(outputDir, 'logs', 'saved-rig-preflight.json'), {
        ok: savedRigPreflight.every((entry) => entry.ok),
        entries: savedRigPreflight,
      });
    }
    const failedSavedRig = savedRigPreflight.filter((entry) => !entry.ok);
    if (failedSavedRig.length > 0) {
      return {
        ok: false,
        phase: 'saved-rig-preflight',
        projectId: state.projectId,
        manifestHash,
        runStatePath,
        diagnostics: failedSavedRig.flatMap((entry) => entry.diagnostics ?? []),
        error: 'Saved-rig compatibility preflight failed; project reset was skipped.',
      };
    }

    if (options.resetProject) {
      const reset = await resetProjectOnPage(session.page, {
        name: manifest.project.name,
        description: manifest.project.description,
        aspectRatio: manifest.project.aspectRatio,
        frameRate: manifest.project.frameRate,
      });
      await writeJson(path.join(outputDir, 'logs', 'initialize.json'), { reset, status });
      if (!reset.ok) {
        return {
          ok: false,
          phase: 'initialized',
          manifestHash,
          runStatePath,
          diagnostics: reset.diagnostics,
          error: 'Project reset failed.',
        };
      }
      // After a controlled update + reset, keep completed frames for shots that
      // were not invalidated; staging must be recompiled into the blank project.
      const priorShots = loaded.updated ? state.shots : undefined;
      state = createInitialRunState({
        manifestHash,
        outputDir,
        projectId: reset.projectId,
        shotNumbers: manifest.shots.map((shot) => shot.shotNumber),
      });
      if (priorShots) {
        for (const [shotNumber, prior] of Object.entries(priorShots)) {
          const keepFrame = (
            prior.compile === 'complete'
            && prior.render === 'complete'
            && Boolean(prior.framePath)
          );
          state = upsertShotState(state, shotNumber, {
            compile: 'pending',
            render: keepFrame ? 'complete' : 'pending',
            validation: keepFrame ? prior.validation : 'pending',
            framePath: keepFrame ? prior.framePath : undefined,
            issues: keepFrame ? prior.issues : undefined,
            renderAttempts: keepFrame ? (prior.renderAttempts ?? prior.attempts ?? 0) : 0,
            repairAttempts: 0,
            attempts: 0,
          });
        }
      }
      state = setPhase(state, 'initialized', 'complete');
      state.revisionId = reset.verifiedRevisionId;
      state.projectId = reset.projectId;
    } else if (state.phases.initialized !== 'complete') {
      state = setPhase(state, 'initialized', 'complete');
      state.projectId = status.projectId;
      state.revisionId = status.revisionId;
    } else if (!state.projectId) {
      state.projectId = status.projectId;
    }

    await writeJson(runStatePath, state);

    if (options.initializeOnly) {
      return {
        ok: true,
        phase: 'initialized',
        projectId: state.projectId,
        manifestHash,
        runStatePath,
      };
    }

    if (!options.writeAccess) {
      return {
        ok: false,
        phase: firstIncompletePhase(state) ?? 'locations',
        projectId: state.projectId,
        manifestHash,
        runStatePath,
        error: 'Full previs orchestration requires --write.',
      };
    }

    const skipShots = new Set(
      Object.entries(state.shots)
        .filter(([, shot]) => shot.compile === 'complete')
        .map(([shotNumber]) => shotNumber),
    );

    const preparedProject = manifest.project.operatingMode === 'existing-project-refinement'
      ? await session.page.evaluate(() => window.foreScene!.getProjectDocument())
      : undefined;
    const locationBindings = preparedProject
      ? inferExistingProjectLocationBindings(preparedProject, manifest)
      : undefined;
    if (preparedProject) {
      const unboundLocations = manifest.locations.filter((location) => !locationBindings?.[location.id]);
      if (unboundLocations.length > 0) {
        await writeJson(runStatePath, state);
        return {
          ok: false,
          phase: 'locations',
          projectId: state.projectId,
          manifestHash,
          runStatePath,
          error: `Existing-project refinement could not bind prepared locations: ${unboundLocations.map((item) => item.id).join(', ')}.`,
        };
      }
    }
    const compiled = compileProduction(manifest, {
      skipShotNumbers: skipShots,
      locationBindings,
      presenceProject: preparedProject,
    });
    await writeJson(path.join(outputDir, 'logs', 'compile.json'), {
      ok: compiled.ok,
      diagnostics: compiled.diagnostics,
      locationCommands: compiled.locations.plan.commands.length,
      castCommands: compiled.cast.plan.commands.length,
      propCommands: compiled.props.plan.commands.length,
      shotBatches: compiled.shotBatches.length,
    });

    if (state.phases.locations !== 'complete' && compiled.locations.plan.commands.length > 0) {
      state = setPhase(state, 'locations', 'in_progress');
      const applied = await applyPlanOnPage(session.page, compiled.locations.plan);
      await writeJson(path.join(outputDir, 'logs', 'scene-locations.json'), applied);
      if (!applied.ok) {
        state = setPhase(state, 'locations', 'failed');
        await writeJson(runStatePath, state);
        return {
          ok: false,
          phase: 'locations',
          projectId: state.projectId,
          manifestHash,
          runStatePath,
          diagnostics: applied.diagnostics,
          error: 'Location apply failed.',
        };
      }
      for (const [key, mapping] of Object.entries(compiled.context.entities)) {
        if (key.startsWith('locations.')) {
          state = upsertEntity(state, key, resolveMappingIds(mapping, applied.summary?.createdRefs));
        }
      }
      state = setPhase(state, 'locations', 'complete');
      await writeJson(runStatePath, state);
    } else if (state.phases.locations !== 'complete') {
      state = setPhase(state, 'locations', 'complete');
    }

    if (state.phases.cast !== 'complete') {
      const castCompilation = compileCastPhaseWithPersistedEntities(
        manifest,
        compiled.context,
        state.entities,
      );
      state = setPhase(state, 'cast', 'in_progress');
      let applied: Awaited<ReturnType<typeof applyPlanOnPage>> | undefined;
      if (castCompilation.plan.commands.length > 0) {
        applied = await applyPlanOnPage(session.page, castCompilation.plan);
        if (!applied.ok) {
          state = setPhase(state, 'cast', 'failed');
          await writeJson(path.join(outputDir, 'logs', 'scene-cast.json'), {
            applied,
            importedCharacters: [],
          });
          await writeJson(runStatePath, state);
          return {
            ok: false,
            phase: 'cast',
            projectId: state.projectId,
            manifestHash,
            runStatePath,
            diagnostics: applied.diagnostics,
            error: 'Cast apply failed.',
          };
        }
        for (const [key, mapping] of Object.entries(castCompilation.context.entities)) {
          if (key.startsWith('cast.') && mapping.objectId) {
            state = upsertEntity(state, key, resolveMappingIds(mapping, applied.summary?.createdRefs));
          }
        }
      }

      const importedResults: Array<{
        id: string;
        source: string;
        rigPackage?: string;
        rigMode: string;
        ok: boolean;
        analysis?: unknown;
        objectId?: string;
        reused?: boolean;
        appliedSavedRig?: boolean;
        topologyVerified?: boolean;
        sourceSha256?: string;
        rigPackageSha256?: string;
        warnings?: string[];
        diagnostics?: unknown[];
      }> = [];
      for (const entry of castCompilation.importedCharacters ?? []) {
        const asset = characterAssets.find((candidate) => candidate.id === entry.character.id);
        const existingObjectId = state.entities[entry.entityKey]?.objectId;
        if (existingObjectId) {
          importedResults.push({
            id: entry.character.id,
            source: entry.character.source,
            ...(entry.character.rigPackage ? { rigPackage: entry.character.rigPackage } : {}),
            rigMode: entry.character.rigMode,
            ok: true,
            objectId: existingObjectId,
            reused: true,
            appliedSavedRig: state.entities[entry.entityKey]?.appliedSavedRig,
            topologyVerified: state.entities[entry.entityKey]?.topologyVerified,
            sourceSha256: asset?.sourceSha256,
            rigPackageSha256: asset?.rigPackageSha256,
          });
          continue;
        }
        const savedRig = entry.character.rigMode === 'saved-rig';
        const result = savedRig && asset?.rigPackagePath
          ? await importManifestSavedRigCharacter(session.page, asset, entry.character, consentToken)
          : (await importManifestCharacter(session.page, options.manifestPath, entry, consentToken)).result.result;
        const analysis = savedRig
          ? savedRigPreflight.find((item) => item.id === entry.character.id)?.analysis
          : undefined;
        importedResults.push({
          id: entry.character.id,
          source: entry.character.source,
          ...(entry.character.rigPackage ? { rigPackage: entry.character.rigPackage } : {}),
          rigMode: entry.character.rigMode,
          ok: result.ok,
          analysis,
          ...(result.objectId ? { objectId: result.objectId } : {}),
          ...(result.appliedSavedRig !== undefined ? { appliedSavedRig: result.appliedSavedRig } : {}),
          ...(result.topologyVerified !== undefined ? { topologyVerified: result.topologyVerified } : {}),
          sourceSha256: asset?.sourceSha256,
          rigPackageSha256: asset?.rigPackageSha256,
          warnings: result.warnings,
          diagnostics: result.diagnostics,
        });
        if (!result.ok || !result.objectId) {
          state = setPhase(state, 'cast', 'failed');
          await writeJson(path.join(outputDir, 'logs', 'scene-cast.json'), {
            applied,
            importedCharacters: importedResults,
          });
          await writeJson(runStatePath, state);
          return {
            ok: false,
            phase: 'cast',
            projectId: state.projectId,
            manifestHash,
            runStatePath,
            diagnostics: result.diagnostics,
            error: `Imported character "${entry.character.id}" failed.`,
          };
        }
        state = upsertEntity(state, entry.entityKey, {
          objectId: result.objectId,
          refs: { [result.objectId]: result.objectId },
          importFingerprint: asset?.importFingerprint,
          sourceSha256: asset?.sourceSha256,
          rigPackageSha256: asset?.rigPackageSha256,
          ...(result.appliedSavedRig !== undefined ? { appliedSavedRig: result.appliedSavedRig } : {}),
          ...(result.topologyVerified !== undefined ? { topologyVerified: result.topologyVerified } : {}),
        });
      }

      await writeJson(path.join(outputDir, 'logs', 'scene-cast.json'), {
        applied,
        importedCharacters: importedResults,
      });
      state = setPhase(state, 'cast', 'complete');
      await writeJson(runStatePath, state);
    }

    const importedModelResults: Array<{
      id: string;
      sourcePath?: string;
      sourceSha256?: string;
      ok: boolean;
      objectIds?: string[];
      groupId?: string;
      reused?: boolean;
      warnings?: string[];
      diagnostics?: unknown[];
    }> = [];
    for (const asset of assetPreflight.assets) {
      if (asset.expectedObjectType !== 'imported_model') continue;
      const entityKey = `assets.${asset.id}`;
      const existing = state.entities[entityKey];
      if (existing?.objectId) {
        const objectIds = existing.objectIds ?? [existing.objectId];
        const assembly = await ensureImportedModelAssemblyGroup(
          session.page,
          asset.id,
          objectIds,
          existing.groupId,
        );
        if (!assembly.ok) {
          await writeJson(path.join(outputDir, 'logs', 'scene-assets.json'), {
            importedModels: importedModelResults,
            assembly,
          });
          return {
            ok: false,
            phase: 'props',
            projectId: state.projectId,
            manifestHash,
            runStatePath,
            diagnostics: assembly.diagnostics,
            error: `Imported model asset "${asset.id}" could not restore its persistent assembly group.`,
          };
        }
        state = upsertEntity(state, entityKey, {
          ...existing,
          objectIds,
          ...(assembly.groupId ? { groupId: assembly.groupId } : {}),
        });
        importedModelResults.push({
          id: asset.id,
          sourcePath: asset.sourcePath,
          sourceSha256: asset.sourceSha256,
          ok: true,
          objectIds,
          ...(assembly.groupId ? { groupId: assembly.groupId } : {}),
          reused: true,
        });
        continue;
      }
      if (!asset.sourcePath) {
        if (!asset.required) continue;
        importedModelResults.push({ id: asset.id, ok: false });
        await writeJson(path.join(outputDir, 'logs', 'scene-assets.json'), importedModelResults);
        await writeJson(runStatePath, state);
        return {
          ok: false,
          phase: 'props',
          projectId: state.projectId,
          manifestHash,
          runStatePath,
          error: `Imported model asset "${asset.id}" has no resolved source path.`,
        };
      }
      const result = await importManifestModelAsset(
        session.page,
        asset.sourcePath,
        options.allowHeavyCharacterImports ? 'allow-heavy-model-imports' : undefined,
      );
      const objectIds = result.objectRefs?.map((ref) => ref.id).filter(Boolean) ?? [];
      importedModelResults.push({
        id: asset.id,
        sourcePath: asset.sourcePath,
        sourceSha256: asset.sourceSha256,
        ok: result.ok && objectIds.length > 0,
        objectIds,
        warnings: result.warnings,
        diagnostics: result.diagnostics,
      });
      if (!result.ok || objectIds.length === 0) {
        await writeJson(path.join(outputDir, 'logs', 'scene-assets.json'), importedModelResults);
        await writeJson(runStatePath, state);
        return {
          ok: false,
          phase: 'props',
          projectId: state.projectId,
          manifestHash,
          runStatePath,
          diagnostics: result.diagnostics,
          error: `Imported model asset "${asset.id}" failed.`,
        };
      }
      const assembly = await ensureImportedModelAssemblyGroup(session.page, asset.id, objectIds);
      if (!assembly.ok) {
        await writeJson(path.join(outputDir, 'logs', 'scene-assets.json'), {
          importedModels: importedModelResults,
          assembly,
        });
        return {
          ok: false,
          phase: 'props',
          projectId: state.projectId,
          manifestHash,
          runStatePath,
          diagnostics: assembly.diagnostics,
          error: `Imported model asset "${asset.id}" could not create a persistent assembly group.`,
        };
      }
      importedModelResults[importedModelResults.length - 1] = {
        ...importedModelResults.at(-1)!,
        ...(assembly.groupId ? { groupId: assembly.groupId } : {}),
      };
      if (asset.semanticRole === 'subject') {
        const roleApplied = await applyPlanOnPage(session.page, {
          version: 1,
          planId: `previs-asset-role-${asset.id}`,
          description: `Classify imported subject ${asset.id} for shot staging`,
          commands: objectIds.map((objectId) => ({
            op: 'object.update' as const,
            object: { id: objectId },
            updates: { stagingRole: 'prop' },
          })),
        });
        if (!roleApplied.ok) {
          await writeJson(path.join(outputDir, 'logs', 'scene-assets.json'), {
            importedModels: importedModelResults,
            roleApplied,
          });
          return {
            ok: false,
            phase: 'props',
            projectId: state.projectId,
            manifestHash,
            runStatePath,
            diagnostics: roleApplied.diagnostics,
            error: `Imported model subject "${asset.id}" could not be classified for shot staging.`,
          };
        }
      }
      state = upsertEntity(state, entityKey, {
        objectId: objectIds[0],
        objectIds,
        ...(assembly.groupId ? { groupId: assembly.groupId } : {}),
        refs: Object.fromEntries(objectIds.map((id) => [id, id])),
        sourceSha256: asset.sourceSha256,
      });
    }
    if (importedModelResults.length > 0) {
      await writeJson(path.join(outputDir, 'logs', 'scene-assets.json'), {
        importedModels: importedModelResults,
      });
      await writeJson(runStatePath, state);
    }

    if (state.phases.props !== 'complete') {
      // Re-resolve props after imported cast assets have concrete ids. This is
      // required for zero-command semantic aliases such as embedded props.
      const propCompilation = compilePropsPhaseWithPersistedEntities(
        manifest,
        compiled.cast.context,
        state.entities,
      );
      let applied: Awaited<ReturnType<typeof applyPlanOnPage>> | undefined;
      if (propCompilation.plan.commands.length > 0) {
        state = setPhase(state, 'props', 'in_progress');
        applied = await applyPlanOnPage(session.page, propCompilation.plan);
        await writeJson(path.join(outputDir, 'logs', 'scene-props.json'), applied);
        if (!applied.ok) {
          state = setPhase(state, 'props', 'failed');
          await writeJson(runStatePath, state);
          return {
            ok: false,
            phase: 'props',
            projectId: state.projectId,
            manifestHash,
            runStatePath,
            diagnostics: applied.diagnostics,
            error: 'Props apply failed.',
          };
        }
      }
      for (const [key, mapping] of Object.entries(propCompilation.context.entities)) {
        if (key.startsWith('props.')) {
          state = upsertEntity(state, key, resolveMappingIds(mapping, applied?.summary?.createdRefs));
        }
      }
      state = setPhase(state, 'props', 'complete');
      await writeJson(runStatePath, state);
    }

    // Persist the resolved semantic universe before shot compilation so the
    // compiler can author closed-world visibility from durable contracts.
    const preShotSemanticSync = await synchronizeManifestProductionConfiguration(
      session.page,
      manifest,
      state,
    );
    await writeJson(
      path.join(outputDir, 'logs', 'production-configuration-pre-shot.json'),
      preShotSemanticSync,
    );
    if (!preShotSemanticSync.bound.ok || !preShotSemanticSync.validation.ok) {
      await writeJson(runStatePath, state);
      return {
        ok: false,
        phase: 'shots',
        projectId: state.projectId,
        manifestHash,
        runStatePath,
        diagnostics: [
          ...preShotSemanticSync.bound.diagnostics,
          ...preShotSemanticSync.validation.diagnostics,
        ],
        error: 'Resolved production semantics could not be prepared before shot compilation.',
      };
    }

    // Re-compile shots against resolved entity ids from run-state.
    const resolvedContext = {
      ...compiled.context,
      entities: { ...compiled.context.entities, ...state.entities },
    };

    // Delete manifest-removed shots before upserts (Origin / leftovers pruned after create).
    const keepShotNumbers = new Set(manifest.shots.map((shot) => shot.shotNumber));
    const liveBeforeCompile = await session.page.evaluate(() => window.foreScene!.listShots());
    const removedNumbers = new Set((loaded.removedShots ?? []).map((entry) => entry.shotNumber));
    const deleteIds = new Set<string>();
    for (const entry of loaded.removedShots ?? []) {
      if (entry.shotId) deleteIds.add(entry.shotId);
    }
    for (const shot of liveBeforeCompile) {
      if (removedNumbers.has(shot.shotNumber)) {
        deleteIds.add(shot.id);
      }
    }
    // Never delete down to zero shots before creates — blank Origin stays until replacements exist.
    const remainingAfterDelete = liveBeforeCompile.filter((shot) => !deleteIds.has(shot.id)).length;
    if (deleteIds.size > 0 && remainingAfterDelete >= 1) {
      const deletePlan = {
        version: 1 as const,
        planId: 'previs-shot-delete',
        description: 'Remove obsolete previs shots',
        commands: [...deleteIds].map((id) => ({
          op: 'shot.delete' as const,
          shot: { id },
        })),
      };
      const deleted = await applyPlanOnPage(session.page, deletePlan);
      await writeJson(path.join(outputDir, 'logs', 'shots-delete.json'), {
        deleteIds: [...deleteIds],
        deleted,
      });
      if (!deleted.ok) {
        state = setPhase(state, 'shots', 'failed');
        await writeJson(runStatePath, state);
        return {
          ok: false,
          phase: 'shots',
          projectId: state.projectId,
          manifestHash,
          runStatePath,
          diagnostics: deleted.diagnostics,
          error: 'Failed to delete obsolete shots.',
        };
      }
    }

    const existingShotIds: Record<string, string> = {};
    for (const [shotNumber, shotState] of Object.entries(state.shots)) {
      if (shotState.shotId && !skipShots.has(shotNumber)) {
        existingShotIds[shotNumber] = shotState.shotId;
      }
    }

    // Asset imports happen after the initial production compile. Re-read the
    // live document so multipart geometry, bounds, presence, and panorama
    // routing are compiled against the objects that will actually be staged.
    const liveProjectForShotCompile = await session.page.evaluate(
      () => window.foreScene!.getProjectDocument(),
    );

    const shotBatches = compileShotList(manifest, resolvedContext, {
      skipShotNumbers: skipShots,
      existingShotIds,
      presenceProject: liveProjectForShotCompile,
    });

    state = setPhase(state, 'shots', 'in_progress');
    let shotsCreated = Object.values(state.shots).filter((shot) => shot.compile === 'complete').length;

    for (const batch of shotBatches) {
      if (batch.plan.commands.length === 0) continue;
      const applied = await applyPlanOnPage(session.page, batch.plan);
      await writeJson(
        path.join(
          outputDir,
          'logs',
          `shots-${batch.shotNumbers[0]}-${batch.shotNumbers.at(-1)}.json`,
        ),
        { applied, shotResults: batch.shotResults },
      );

      for (const shotNumber of batch.shotNumbers) {
        const result = batch.shotResults[shotNumber];
        const createdShotId = applied.summary?.createdRefs
          ? Object.values(applied.summary.createdRefs).find((ref) => (
            ref.kind === 'shot' && ref.ref === `shot_${shotNumber}`
          ))?.id
          : undefined;
        const retainedId = existingShotIds[shotNumber];
        if (result?.ok && applied.ok) {
          state = upsertShotState(state, shotNumber, {
            compile: 'complete',
            ...(createdShotId || retainedId
              ? { shotId: createdShotId ?? retainedId }
              : {}),
          });
          shotsCreated += 1;
        } else if (result && !result.ok) {
          state = upsertShotState(state, shotNumber, {
            compile: 'failed',
            lastError: result.warnings.join('; ') || 'compile failed',
          });
        } else if (!applied.ok) {
          state = upsertShotState(state, shotNumber, {
            compile: 'failed',
            lastError: 'batch apply failed',
          });
        }
      }
      await writeJson(runStatePath, state);
    }

    let liveShots = await session.page.evaluate(() => window.foreScene!.listShots());
    for (const shot of liveShots) {
      if (state.shots[shot.shotNumber]) {
        state = upsertShotState(state, shot.shotNumber, {
          shotId: shot.id,
          compile: state.shots[shot.shotNumber]?.compile === 'failed' ? 'failed' : 'complete',
        });
      }
    }
    // Final prune — drop intact scaffold shots (blank Origin). Non-manifest
    // user shots survive unless the operator passed --prune-non-manifest-shots.
    const liveProjectForPrune = await session.page.evaluate(
      () => window.foreScene!.getProjectDocument(),
    ) as LocationProject;
    const pruneDecision = selectPrunableShots(
      liveProjectForPrune.shots.map((shot) => ({
        id: shot.id,
        shotNumber: shot.shotNumber,
        isIntactScaffold: isIntactSystemScaffoldShot(shot),
      })),
      keepShotNumbers,
      { pruneNonManifest },
    );
    // Never delete down to zero shots.
    const prunable = liveShots.length - pruneDecision.prune.length >= 1
      ? pruneDecision.prune
      : [];
    if (prunable.length > 0) {
      const prune = await applyPlanOnPage(session.page, {
        version: 1,
        planId: 'previs-shot-prune',
        commands: prunable.map((shot) => ({
          op: 'shot.delete' as const,
          shot: { id: shot.id },
        })),
      });
      await writeJson(path.join(outputDir, 'logs', 'shots-prune.json'), {
        pruned: prunable,
        retainedNonManifest: pruneDecision.retainedNonManifest,
        pruneNonManifestAuthorized: pruneNonManifest,
        prune,
      });
      liveShots = await session.page.evaluate(() => window.foreScene!.listShots());
    } else if (pruneDecision.retainedNonManifest.length > 0) {
      await writeJson(path.join(outputDir, 'logs', 'shots-prune.json'), {
        pruned: [],
        retainedNonManifest: pruneDecision.retainedNonManifest,
        pruneNonManifestAuthorized: pruneNonManifest,
        note: 'Non-manifest shots were retained. Pass --prune-non-manifest-shots to remove them explicitly.',
      });
    }
    state = setPhase(state, 'shots', 'complete');
    await writeJson(runStatePath, state);

    const semanticSync = await synchronizeManifestProductionConfiguration(
      session.page,
      manifest,
      state,
    );
    await writeJson(path.join(outputDir, 'logs', 'production-configuration.json'), semanticSync);
    if (!semanticSync.bound.ok || !semanticSync.validation.ok) {
      state = setPhase(state, 'shots', 'failed');
      await writeJson(runStatePath, state);
      return {
        ok: false,
        phase: 'shots',
        projectId: state.projectId,
        manifestHash,
        runStatePath,
        diagnostics: [
          ...semanticSync.bound.diagnostics,
          ...semanticSync.validation.diagnostics,
        ],
        error: 'Compiled production semantics did not persist as a valid prepared configuration.',
      };
    }
    timing.compilationMs = Date.now() - compilationStartedAt;

    timeBudget?.assertWithinBudget('render_review_frames');
    const renderingStartedAt = Date.now();
    state = setPhase(state, 'render', 'in_progress');
    await openWorkspace(session.page, 'shots');
    const renderSession = await createPersistentRenderSession(
      session.page,
      renderProfile,
      `${runId}_render`,
    );

    try {
      const locationOrder = [...new Set(manifest.shots.map((shot) => shot.locationId))];
      const pendingJobs: RenderSessionShotJob[] = [];
      const renderProject = await session.page.evaluate(() => window.foreScene!.getProjectDocument()) as LocationProject;

      for (const definition of manifest.shots) {
        const shotState = state.shots[definition.shotNumber];
        if (!shotState || shotState.compile !== 'complete') continue;
        const currentShot = renderProject.shots.find((item) => item.shotNumber === definition.shotNumber);
        const renderFingerprint = currentShot
          ? computeRenderFingerprint({
            project: renderProject,
            shot: currentShot,
            profile: renderProfile,
            rendererVersion: `forescene-renderer-${state.renderPipelineVersion ?? 1}`,
            locationId: definition.locationId,
          })
          : undefined;
        if (isCanonicalFrame(shotState)
          && shotState.renderFingerprint === renderFingerprint?.key
          && shotState.framePath
          && await pathExists(shotState.framePath)) {
          framesRendered += 1;
          cacheHits += 1;
          state = upsertShotState(state, definition.shotNumber, { renderCacheHit: true });
          continue;
        }

        const shotId = shotState.shotId
          ?? liveShots.find((shot) => shot.shotNumber === definition.shotNumber)?.id;
        if (!shotId) continue;

        pendingJobs.push({
          shotId,
          shotNumber: definition.shotNumber,
          locationId: definition.locationId,
          framePath: path.join(outputDir, 'shots', `${definition.shotNumber}.png`),
          renderFingerprint: renderFingerprint?.key,
          appearance: currentShot
            ? resolveRenderAppearanceForShot(renderProfile, currentShot)
            : renderProfile.appearance,
        });
      }

      if (pendingJobs.length > 0) {
        cacheMisses += pendingJobs.length;
        timeBudget?.assertWithinBudget('render_review_frames');
        const batch = await renderSession.renderBatch(pendingJobs, {
          locationOrder,
          signal: abortScope.signal,
        });
        for (const frame of batch.results) {
          const shotState = state.shots[frame.shotNumber];
          let renderAttempts = (shotState?.renderAttempts ?? shotState?.attempts ?? 0) + 1;
          if (!frame.ok) {
            state = upsertShotState(state, frame.shotNumber, {
              render: 'failed',
              framePath: undefined,
              renderSource: undefined,
              renderFingerprint: undefined,
              renderCacheHit: undefined,
              pixelStats: undefined,
              renderAttempts,
              attempts: renderAttempts,
              lastError: frame.error,
            });
            continue;
          }
          if (!frame.fromCanonicalRenderer) {
            state = upsertShotState(state, frame.shotNumber, {
              render: 'failed',
              framePath: undefined,
              renderSource: undefined,
              renderFingerprint: undefined,
              renderCacheHit: undefined,
              pixelStats: undefined,
              renderAttempts,
              attempts: renderAttempts,
              lastError: 'Frame was not produced by the canonical renderer.',
            });
            continue;
          }
          const info = await stat(frame.framePath).catch(() => undefined);
          if (!info || info.size < 32) {
            state = upsertShotState(state, frame.shotNumber, {
              render: 'failed',
              framePath: undefined,
              renderSource: undefined,
              renderFingerprint: undefined,
              renderCacheHit: undefined,
              pixelStats: undefined,
              renderAttempts,
              attempts: renderAttempts,
              lastError: 'Clean frame file too small',
            });
            continue;
          }
          framesRendered += 1;
          state = upsertShotState(state, frame.shotNumber, {
            render: 'complete',
            framePath: frame.framePath,
            renderSource: frame.source,
            renderFingerprint: frame.renderFingerprint,
            renderCacheHit: false,
            pixelStats: frame.pixelStats,
            renderAttempts,
            attempts: renderAttempts,
          });
        }
        await writeJson(runStatePath, state);
      }

      controlVideosRendered = 0;
      controlVideosFailed = 0;
      if (!skipControlVideos) {
        for (const definition of manifest.shots) {
          if (!definition.motion?.renderControlVideo) continue;
          const shotState = state.shots[definition.shotNumber];
          if (!shotState || shotState.compile !== 'complete') continue;
          const videoPath = path.join(outputDir, 'shots', `${definition.shotNumber}.mp4`);
          if (shotState.video === 'complete' && shotState.videoPath && await pathExists(shotState.videoPath)) {
            controlVideosRendered += 1;
            continue;
          }
          const shotId = shotState.shotId
            ?? liveShots.find((shot) => shot.shotNumber === definition.shotNumber)?.id;
          if (!shotId) {
            controlVideosFailed += 1;
            state = upsertShotState(state, definition.shotNumber, {
              video: 'failed',
              videoPath: undefined,
              lastError: `No shot id for ${definition.shotNumber}`,
            });
            await writeJson(runStatePath, state);
            continue;
          }
          try {
            const videoShot = renderProject.shots.find((item) => item.id === shotId);
            const videoAppearance = videoShot
              ? resolveRenderAppearanceForShot(renderProfile, videoShot)
              : renderProfile.appearance;
            const video = await renderControlVideo(session.page, shotId, videoPath, videoAppearance);
            await writeJson(path.join(outputDir, 'logs', `video-${definition.shotNumber}.json`), video);
            if (!video.ok) throw new Error(video.error ?? 'Control video render failed.');
            controlVideosRendered += 1;
            state = upsertShotState(state, definition.shotNumber, {
              video: 'complete',
              videoPath,
              videoAssetId: video.assetId,
            });
          } catch (error) {
            controlVideosFailed += 1;
            state = upsertShotState(state, definition.shotNumber, {
              video: 'failed',
              videoPath: undefined,
              lastError: error instanceof Error ? error.message : String(error),
            });
          }
          await writeJson(runStatePath, state);
        }
      }
      timing.renderingMs = Date.now() - renderingStartedAt;
      state = setPhase(state, 'render', 'complete');
      await writeJson(runStatePath, state);

      timeBudget?.assertWithinBudget('structural_diagnostics');
      const validationStartedAt = Date.now();
      state = setPhase(state, 'validation', 'in_progress');
    let project = await session.page.evaluate(() => window.foreScene!.getProjectDocument()) as LocationProject;
    const names = buildSubjectIdentityMap(manifest, state);
    const validationResults: FrameValidationResult[] = [];
    let previousCamera: CameraData | undefined;

    for (const definition of manifest.shots) {
      const shotState = state.shots[definition.shotNumber];
      let shot = project.shots.find((item) => item.shotNumber === definition.shotNumber);
      const framePath = shotState?.framePath
        ?? path.join(outputDir, 'shots', `${definition.shotNumber}.png`);
      let exists = await pathExists(framePath);
      let byteSize = exists ? (await stat(framePath)).size : undefined;

      if (!shot) {
        const result: FrameValidationResult = {
          shotNumber: definition.shotNumber,
          status: 'failed',
          issues: [{ code: 'shot_missing', message: 'Shot missing after compile.' }],
        };
        validationResults.push(result);
        state = upsertShotState(state, definition.shotNumber, {
          validation: 'failed',
          issues: result.issues,
        });
        continue;
      }

      let telemetry: ShotCompositionTelemetry | undefined;
      try {
        telemetry = buildShotCompositionTelemetry({
          project,
          shot: shot as Shot,
          definition,
          subjectNames: names,
        });
        await writeJson(
          path.join(outputDir, 'shots', `${definition.shotNumber}.composition.json`),
          telemetry,
        );
      } catch {
        telemetry = undefined;
      }

      const isCanonical = isCanonicalFrame(shotState);
      if (exists && !isCanonical) {
        // Path alone is not provenance — force a frame_blank / missing style failure path.
        exists = false;
        byteSize = undefined;
      }

      let finalResult = validateShotFrame({
        project,
        shot: shot as Shot,
        definition,
        frameExists: exists && isCanonical,
        frameByteSize: byteSize,
        previousCamera,
        subjectNames: names,
        telemetry,
        fromCanonicalRenderer: isCanonical,
        // Use persisted stats from the clean renderer only — never invent "good" values.
        pixelStats: shotState?.pixelStats,
      });

      let repairAttempts = shotState?.repairAttempts ?? 0;
      if (autoRepair && shotState?.shotId) {
        await session.page.evaluate(async (shotId) => {
          window.foreScene!.beginShotRepairSession({ shotId, label: 'baseline' });
        }, shotState.shotId);
      }
      while (
        autoRepair
        && finalResult.status !== 'passed'
        && finalResult.issues.some((issue) => isRepairableIssue(issue.code))
        && repairAttempts < maxRepairPasses
        && shotState?.shotId
      ) {
        // Always re-read live project so objectOverrides match current staging.
        project = await session.page.evaluate(() => window.foreScene!.getProjectDocument()) as LocationProject;
        shot = project.shots.find((item) => (
          item.id === shotState.shotId || item.shotNumber === definition.shotNumber
        )) ?? shot;
        if (!shot) break;

        const repairSubjects = buildSubjectBoundsForRepair({
          project,
          shot: shot as Shot,
          definition,
          subjectNames: names,
        });
        const repairBlockers = solidBlockersForRepair({
          project,
          shot: shot as Shot,
        });
        const repair = buildRepairPlan({
          shotTarget: { id: shotState.shotId },
          camera: shot.camera,
          issues: finalResult.issues,
          telemetry: finalResult.telemetry ?? telemetry,
          template: definition.camera.template,
          primarySubjectId: definition.camera.subjects[0],
          foregroundSubjectId: definition.camera.foregroundSubject,
          subjects: repairSubjects,
          aspectRatio: shot.camera.aspectRatio ?? aspectRatioValue(manifest.project.aspectRatio),
          blockers: repairBlockers,
          shotDefinition: definition,
        });
        if (!repair) break;
        // Empty command plans (e.g. re-render only) still count as an attempt.
        if (repair.commands.length === 0 && repair.primaryIssueCode !== 'frame_blank'
          && repair.primaryIssueCode !== 'render_not_ready') {
          break;
        }

        repairAttempts += 1;
        repairsAttemptedTotal += 1;
        const repairStartedAt = Date.now();
        const rankBefore = rankFrameValidation(finalResult);
        const metricsBefore = extractFramingMetrics(
          finalResult,
          definition.camera.subjects[0],
        );
        const repairLogPath = path.join(outputDir, 'logs', `repairs-${definition.shotNumber}.json`);
        const repairHistory = await readRepairHistory(repairLogPath);

        await applyPlanOnPage(session.page, {
          version: 1,
          planId: `repair-${definition.shotNumber}-${repairAttempts}`,
          description: repair.description,
          commands: repair.commands,
        });
        await waitForAgentIdle(session.page);

        const reframe = await renderCleanShotFrame(
          session.page,
          shotState.shotId,
          framePath,
          {
            debugUiPath: path.join(outputDir, 'debug', `${definition.shotNumber}-ui.png`),
            renderSession,
            shotNumber: definition.shotNumber,
            appearance: resolveRenderAppearanceForShot(renderProfile, shot),
          },
        );
        if (!reframe.ok || !reframe.fromCanonicalRenderer) {
          repairMs += Date.now() - repairStartedAt;
          finalResult = {
            ...finalResult,
            status: 'failed',
            issues: [
              ...finalResult.issues,
              { code: 'frame_blank', message: reframe.error ?? 'Repair re-render failed.' },
            ],
          };
          break;
        }

        project = await session.page.evaluate(() => window.foreScene!.getProjectDocument()) as LocationProject;
        shot = project.shots.find((item) => item.shotNumber === definition.shotNumber) ?? shot;
        exists = await pathExists(framePath);
        byteSize = exists ? (await stat(framePath)).size : undefined;

        try {
          telemetry = buildShotCompositionTelemetry({
            project,
            shot: shot as Shot,
            definition,
            subjectNames: names,
          });
          await writeJson(
            path.join(outputDir, 'shots', `${definition.shotNumber}.composition.json`),
            telemetry,
          );
        } catch {
          telemetry = undefined;
        }

        let candidateResult = validateShotFrame({
          project,
          shot: shot as Shot,
          definition,
          frameExists: exists,
          frameByteSize: byteSize,
          previousCamera,
          subjectNames: names,
          telemetry,
          fromCanonicalRenderer: true,
          pixelStats: reframe.pixelStats,
        });
        const rankAfter = rankFrameValidation(candidateResult);
        const metricsAfter = extractFramingMetrics(
          candidateResult,
          definition.camera.subjects[0],
        );
        const rankImproved = isValidationRankImproved(rankBefore, rankAfter);
        const visualCandidate = await session.page.evaluate(async (input) => {
          const evaluated = window.foreScene!.evaluateShotRepairCandidate({
            shotId: input.shotId,
            label: input.label,
            subjectIds: input.subjectIds,
            accepted: input.accepted,
            keepWhenAccepted: input.keepWhenAccepted,
            restoreIfWorse: true,
          });
          const preflight = window.foreScene!.inspectShotVisualPreflight({
            shotId: input.shotId,
            subjectIds: input.subjectIds,
          });
          return { evaluated, preflight };
        }, {
          shotId: shotState.shotId,
          label: `repair-${repairAttempts}`,
          subjectIds: definition.camera.subjects,
          accepted: rankImproved,
          keepWhenAccepted: rankImproved,
        });
        let keptRepair = rankImproved && visualCandidate.evaluated.kept;
        let finalPixelStats = reframe.pixelStats;
        let finalByteSize = byteSize;

        if (!keptRepair && repair.commands.length > 0) {
          await session.page.evaluate(async (shotId) => {
            await window.foreScene!.commitBestShotRepairCandidate({ shotId });
          }, shotState.shotId);
          await waitForAgentIdle(session.page);
          const rollbackFrame = await renderCleanShotFrame(
            session.page,
            shotState.shotId,
            framePath,
            {
              debugUiPath: path.join(outputDir, 'debug', `${definition.shotNumber}-ui.png`),
              renderSession,
              shotNumber: definition.shotNumber,
              appearance: resolveRenderAppearanceForShot(renderProfile, shot),
            },
          );
          if (rollbackFrame.ok && rollbackFrame.fromCanonicalRenderer) {
            project = await session.page.evaluate(() => window.foreScene!.getProjectDocument()) as LocationProject;
            shot = project.shots.find((item) => item.shotNumber === definition.shotNumber) ?? shot;
            exists = await pathExists(framePath);
            finalByteSize = exists ? (await stat(framePath)).size : byteSize;
            finalPixelStats = rollbackFrame.pixelStats;
            try {
              telemetry = buildShotCompositionTelemetry({
                project,
                shot: shot as Shot,
                definition,
                subjectNames: names,
              });
              await writeJson(
                path.join(outputDir, 'shots', `${definition.shotNumber}.composition.json`),
                telemetry,
              );
            } catch {
              telemetry = finalResult.telemetry ?? telemetry;
            }
            candidateResult = validateShotFrame({
              project,
              shot: shot as Shot,
              definition,
              frameExists: exists,
              frameByteSize: finalByteSize,
              previousCamera,
              subjectNames: names,
              telemetry,
              fromCanonicalRenderer: true,
              pixelStats: rollbackFrame.pixelStats,
            });
          } else {
            candidateResult = finalResult;
          }
        }

        repairMs += Date.now() - repairStartedAt;

        finalResult = keptRepair ? candidateResult : finalResult;
        repairHistory.push({
          attempt: repairAttempts,
          kept: keptRepair,
          before: metricsBefore,
          action: repair.action ?? { type: repair.description },
          after: keptRepair ? metricsAfter : extractFramingMetrics(finalResult, definition.camera.subjects[0]),
        });
        await writeJson(repairLogPath, repairHistory);

        state = upsertShotState(state, definition.shotNumber, {
          render: 'complete',
          framePath,
          renderSource: reframe.source,
          pixelStats: finalPixelStats,
          repairAttempts,
          renderFingerprint: computeRenderFingerprint({
            project,
            shot: shot as Shot,
            profile: renderProfile,
            rendererVersion: `forescene-renderer-${state.renderPipelineVersion ?? 1}`,
            locationId: definition.locationId,
          }).key,
          renderCacheHit: false,
        });
        if (finalResult.status !== 'passed' && repairAttempts >= maxRepairPasses) {
          finalResult = {
            ...finalResult,
            status: finalResult.status === 'failed' ? 'needs_review' : finalResult.status,
            issues: [
              ...finalResult.issues,
              { code: 'repair_exhausted', message: `Applied ${repairAttempts} repairs without a clean pass.` },
            ],
          };
        }
        state = upsertShotState(state, definition.shotNumber, { repairAttempts });
      }

      const finalVisualPreflight = await session.page.evaluate((shotId) => (
        window.foreScene!.inspectShotVisualPreflight({
          shotId,
        })
      ), shot.id);
      finalResult = mergeFrameValidationWithVisualPreflight(finalResult, finalVisualPreflight);

      previousCamera = shot.camera;
      validationResults.push(finalResult);
      state = upsertShotState(state, definition.shotNumber, {
        validation: finalResult.status === 'passed'
          ? 'passed'
          : finalResult.status === 'warning'
            ? 'warning'
            : finalResult.status === 'needs_review'
              ? 'needs_review'
              : 'failed',
        issues: finalResult.issues,
        framePath,
        repairAttempts,
      });
    }

    await writeJson(path.join(outputDir, 'validation.json'), {
      results: validationResults,
      generatedAt: new Date().toISOString(),
    });
    state = setPhase(state, 'validation', 'complete');
    await writeJson(runStatePath, state);

    const sampledFramePaths: string[] = [];
    const sampledFrameFailures: Array<{
      shotNumber: string;
      timeSeconds: number;
      error: string;
    }> = [];
    for (const definition of manifest.shots) {
      if (!definition.motion?.keyframes.length) continue;
      const currentShot = project.shots.find((shot) => shot.shotNumber === definition.shotNumber);
      if (!currentShot) continue;
      for (const [index, keyframe] of definition.motion.keyframes.entries()) {
        const sampledPath = path.join(outputDir, 'shots', `${definition.shotNumber}-sample-${index}.png`);
        const sampled = await renderCleanShotFrame(session.page, currentShot.id, sampledPath, {
          profile: renderProfile,
          shotNumber: definition.shotNumber,
          timeSeconds: keyframe.timeSeconds,
          appearance: resolveRenderAppearanceForShot(renderProfile, currentShot),
        });
        if (!sampled.ok) {
          // Keyframe samples are benchmark evidence, not run-critical frames.
          // Record the failure and continue; the harness reports missing
          // evidence as not-graded and required stills still fail closed.
          sampledFrameFailures.push({
            shotNumber: definition.shotNumber,
            timeSeconds: keyframe.timeSeconds,
            error: sampled.error ?? 'unknown error',
          });
          continue;
        }
        sampledFramePaths.push(sampledPath);
      }
    }
    await writeJson(path.join(outputDir, 'logs', 'sampled-frames.json'), {
      ok: sampledFrameFailures.length === 0,
      frames: sampledFramePaths.length,
      failures: sampledFrameFailures,
    });

    timeBudget?.assertWithinBudget('create_review_sheets');
    state = setPhase(state, 'contactSheet', 'in_progress');
    const sheetEntries = manifest.shots.map((shot) => {
      const shotState = state.shots[shot.shotNumber];
      const framePath = shotState?.framePath
        ?? path.join(outputDir, 'shots', `${shot.shotNumber}.png`);
      return {
        shotNumber: shot.shotNumber,
        name: shot.name,
        framePath: path.resolve(framePath),
        status: shotState?.validation ?? 'pending',
        warningCount: shotState?.issues?.length ?? 0,
        // Provenance from run-state only — never assume from path.
        fromCanonicalRenderer: isCanonicalFrame(shotState),
      };
    });

    const preflight = await preflightContactSheet({
      shots: sheetEntries,
      fileExists: pathExists,
      readPngSize: async (filePath) => readPngSizeSync(filePath),
      expectedAspectRatio: aspectRatioValue(manifest.project.aspectRatio),
    });
    await writeJson(path.join(outputDir, 'logs', 'contact-sheet-preflight.json'), preflight);
    if (!preflight.ok) {
      // Surface preflight issues in validation log but still attempt the sheet
      // so operators can inspect partial output.
      await writeJson(path.join(outputDir, 'logs', 'contact-sheet-preflight-failed.json'), preflight);
    }

    const reviewFrames = manifest.shots.map((definition) => {
      const shotState = state.shots[definition.shotNumber];
      const validation = validationResults.find((item) => item.shotNumber === definition.shotNumber);
      const diagnosticCodes = validation?.issues.map((issue) => issue.code) ?? shotState?.issues?.map((issue) => issue.code) ?? [];
      const presenceFailure = diagnosticCodes.some((code) => (
        code === 'unexpected_dynamic_object'
        || code === 'expected_dynamic_object_missing'
        || code === 'expected_dynamic_object_hidden'
        || code === 'partial_group_visibility'
        || code === 'unclassified_dynamic_object'
        || code === 'dynamic_presence_changed_over_time'
      ));
      const panoramaFailure = diagnosticCodes.some((code) => (
        code === 'expected_panorama_missing'
        || code === 'wrong_panorama_linked'
        || code === 'panorama_not_in_location'
      ));
      const currentShot = project.shots.find((item) => item.shotNumber === definition.shotNumber);
      const composition = currentShot ? inspectShotCompositionError(project, currentShot) : undefined;
      const framePath = shotState?.framePath
        ?? path.join(outputDir, 'shots', `${definition.shotNumber}.png`);
      return {
        shotId: currentShot?.id ?? definition.id,
        shotNumber: definition.shotNumber,
        name: definition.name,
        framePath: path.resolve(framePath),
        locationId: definition.locationId,
        cameraRecipe: definition.camera.template,
        warningCount: shotState?.issues?.length ?? 0,
        presenceStatus: presenceFailure ? 'failed' : 'passed',
        panoramaStatus: panoramaFailure ? 'failed' : currentShot?.linkedPanoId ? 'passed' : 'optional',
        ...(composition?.contractPresent ? { compositionError: composition.totalWeightedError } : {}),
        reviewStatus: shotState?.validation === 'passed'
          ? 'approved' as const
          : shotState?.validation === 'failed'
            ? 'failed' as const
            : 'needs_review' as const,
        fromCanonicalRenderer: isCanonicalFrame(shotState),
        ...(shotState?.renderCacheHit === undefined ? {} : { cacheHit: shotState.renderCacheHit }),
        diagnosticCodes,
      };
    });
    const reviewPlan = buildProductionReviewArtifacts({ frames: reviewFrames });
    await writeJson(path.join(outputDir, 'logs', 'production-review-artifacts.json'), reviewPlan);

    const masterArtifact = reviewPlan.artifacts.find((artifact) => artifact.kind === 'master_sequence');
    if (!masterArtifact) {
      throw new Error('Production review artifact plan did not produce a master sequence sheet.');
    }
    const spec = {
      ...masterArtifact.contactSheet,
      title: `${manifest.project.name} — First Frames`,
    };
    const htmlPath = path.join(outputDir, 'contact-sheet.html');
    const contactSheetPath = path.join(outputDir, 'contact-sheet.png');
    const reviewDir = path.join(outputDir, 'review');
    await mkdir(reviewDir, { recursive: true });
    const reviewArtifactPaths = [contactSheetPath, htmlPath];
    const sheetBrowser = await chromium.launch({ headless: true });
    try {
      for (const artifact of reviewPlan.artifacts) {
        const isMaster = artifact.id === masterArtifact.id;
        const artifactSpec = isMaster ? spec : artifact.contactSheet;
        const artifactBase = isMaster ? 'contact-sheet' : path.join('review', artifact.id);
        const artifactHtmlPath = path.join(outputDir, `${artifactBase}.html`);
        const artifactPngPath = path.join(outputDir, `${artifactBase}.png`);
        await writeFile(artifactHtmlPath, contactSheetHtml({
          ...artifactSpec,
          shots: artifactSpec.shots.map((shot) => ({
            ...shot,
            framePath: `file://${shot.framePath}`,
          })),
        }), 'utf8');
        const sheetPage = await sheetBrowser.newPage({
          viewport: {
            width: Math.min(2400, artifactSpec.columns * artifactSpec.cellWidth + 80),
            height: Math.min(
              4000,
              100 + Math.ceil(Math.max(1, artifactSpec.shots.length) / artifactSpec.columns) * (artifactSpec.cellHeight + 70),
            ),
          },
        });
        try {
          await sheetPage.goto(`file://${artifactHtmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
          await sheetPage.screenshot({ path: artifactPngPath, fullPage: true });
        } finally {
          await sheetPage.close();
        }
        if (!isMaster) {
          reviewArtifactPaths.push(artifactPngPath, artifactHtmlPath);
        }
      }
    } finally {
      await sheetBrowser.close();
    }
    state = setPhase(state, 'contactSheet', 'complete');
    await writeJson(runStatePath, state);

    // Repairs and media rendering can revisit shot state. Reassert every
    // explicit manifest panorama contract immediately before package/backup,
    // including null for locations with no calibrated panorama.
    const liveShotsForPanoramaFinalize = await session.page.evaluate(() => window.foreScene!.listShots());
    const panoramaFinalizeCommands = manifest.shots.flatMap((manifestShot) => {
      const location = manifest.locations.find((item) => item.id === manifestShot.locationId);
      if (!location) return [];
      const specified = Object.prototype.hasOwnProperty.call(location, 'defaultPanoId')
        || (location.panoIds?.length ?? 0) > 0;
      if (!specified) return [];
      const liveShot = liveShotsForPanoramaFinalize.find((item) => item.shotNumber === manifestShot.shotNumber);
      if (!liveShot) return [];
      const panoId = location.defaultPanoId !== undefined
        ? location.defaultPanoId
        : location.panoIds?.[0];
      return [{
        op: 'shot.setPanorama' as const,
        shot: { id: liveShot.id },
        pano: typeof panoId === 'string' ? { id: panoId } : null,
      }];
    });
    if (panoramaFinalizeCommands.length > 0) {
      const panoramaFinalized = await applyPlanOnPage(session.page, {
        version: 1,
        planId: 'previs-finalize-shot-panoramas',
        description: 'Reassert production panorama contracts before export',
        commands: panoramaFinalizeCommands,
      });
      await writeJson(path.join(outputDir, 'logs', 'panorama-finalize.json'), panoramaFinalized);
      if (!panoramaFinalized.ok) {
        throw new Error(panoramaFinalized.diagnostics?.[0]?.message ?? 'Final panorama routing failed.');
      }
    }

    let packagePath: string | undefined;
    let packageTransfer: AgentArtifactTransferTelemetry | undefined;
    let packageFailed = false;
    const blockingReviewBeforePackage = mode !== 'rapid-review'
      && validationResults.some((item) => item.status !== 'passed');
    if (!skipPackage && blockingReviewBeforePackage) {
      packageFailed = true;
      state = setPhase(state, 'package', 'failed');
      await writeJson(path.join(outputDir, 'logs', 'package-blocked-by-review.json'), {
        reason: 'Production-integrity packaging requires every shot validation to pass.',
        shots: validationResults
          .filter((item) => item.status !== 'passed')
          .map((item) => ({ shotNumber: item.shotNumber, status: item.status })),
      });
      await writeJson(runStatePath, state);
    } else if (!skipPackage && !timeBudget?.isExpired()) {
      timeBudget?.assertWithinBudget('finalize');
      state = setPhase(state, 'package', 'in_progress');
      const pack = await session.page.evaluate(async () => {
        await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
        return window.foreScene!.exportPackage({ download: false });
      });
      await writeJson(path.join(outputDir, 'logs', 'export.json'), pack);
      if (pack.ok && pack.artifact?.artifactId) {
        packagePath = path.join(outputDir, 'package.zip');
        const saved = await saveAgentArtifactToFile(session.page, pack.artifact.artifactId, packagePath);
        packageTransfer = toCliArtifactTransfer(saved);
        state = setPhase(state, 'package', 'complete');
      } else if (pack.ok) {
        packageFailed = true;
        state = setPhase(state, 'package', 'failed');
      } else {
        packageFailed = true;
        state = setPhase(state, 'package', 'failed');
      }
      await writeJson(runStatePath, state);
    } else if (!skipPackage && timeBudget?.isExpired()) {
      state = setPhase(state, 'package', 'skipped');
      await writeJson(runStatePath, state);
    } else {
      state = setPhase(state, 'package', 'skipped');
    }

    let finalProjectPath: string | undefined;
    let finalProjectTransfer: AgentArtifactTransferTelemetry | undefined;
    if (options.finalProjectPath) {
      const backup = await session.page.evaluate(async () => (
        window.foreScene!.exportProjectBackup({ download: false })
      ));
      if (!backup.ok || !backup.artifact?.artifactId) {
        throw new Error(backup.diagnostics?.[0]?.message ?? 'Final project backup did not return an artifact.');
      }
      const saved = await saveAgentArtifactToFile(session.page, backup.artifact.artifactId, options.finalProjectPath);
      finalProjectPath = saved.savedPath;
      finalProjectTransfer = toCliArtifactTransfer(saved);
    }

    timing.repairMs = repairMs;
    timing.reviewMs = Date.now() - validationStartedAt;
    timing.totalMs = Date.now() - runStartedAt;

    const reviewRequiredShotIds = validationResults
      .filter((item) => (
        item.status === 'warning'
        || item.status === 'failed'
        || item.status === 'needs_review'
      ))
      .map((item) => item.shotNumber);

    const artifactPaths = [
      contactSheetPath,
      ...reviewArtifactPaths.filter((filePath) => filePath !== contactSheetPath && filePath !== htmlPath),
      htmlPath,
      path.join(outputDir, 'logs', 'production-review-artifacts.json'),
      packagePath,
      finalProjectPath,
      ...sampledFramePaths,
      path.join(outputDir, 'validation.json'),
    ].filter((value): value is string => Boolean(value));

    const endStatus = await session.page.evaluate(() => window.foreScene!.getStatus());
    resultRevisionId = renderSession.toDescriptor().revisionId ?? endStatus.revisionId;

    const passed = validationResults.filter((item) => item.status === 'passed').length;
    const warnings = validationResults.filter((item) => (
      item.status === 'warning' || item.status === 'needs_review'
    )).length;
    const failed = validationResults.filter((item) => item.status === 'failed').length;
    const missingFrames = manifest.shots.some((shot) => {
      const shotState = state.shots[shot.shotNumber];
      return shotState?.compile === 'complete' && shotState.render !== 'complete';
    });
    const missingControlVideos = hasMissingControlVideos({
      shots: manifest.shots,
      shotStates: state.shots,
      skipControlVideos,
    });

    const summary: PrevisCliResult = {
      ok: !missingFrames
        && !missingControlVideos
        && failed === 0
        && !packageFailed
        && (mode === 'rapid-review' || reviewRequiredShotIds.length === 0),
      projectId: state.projectId,
      shotsRequested: manifest.shots.length,
      shotsCreated,
      importedCharacters: importedCharacterCount,
      framesRendered,
      cacheHits,
      cacheMisses,
      cacheHitRate: cacheHits + cacheMisses > 0 ? cacheHits / (cacheHits + cacheMisses) : 0,
      controlVideosRendered,
      controlVideosFailed,
      passed,
      warnings,
      failed,
      reviewRequiredShotIds,
      repairsAttempted: repairsAttemptedTotal,
      repairsDisabled: !autoRepair,
      contactSheet: contactSheetPath,
      reviewArtifacts: reviewArtifactPaths,
      package: packagePath,
      packageTransfer,
      finalProject: finalProjectPath,
      finalProjectTransfer,
      artifactPaths,
      manifestHash,
      runStatePath,
      phase: 'complete',
      timing,
      sourceRevisionId,
      resultRevisionId,
      provenance: endStatus.provenance,
      ...(packageFailed ? { error: 'Package export failed.' } : {}),
    };
    await writeJson(path.join(outputDir, 'summary.json'), {
      ...summary,
      runId,
      mode,
      renderProfileId: renderProfile.id,
      renderProfileFingerprint: renderProfileFingerprintValue,
    });
    state = touchRunState(state);
    await writeJson(runStatePath, state);
    return summary;
    } finally {
      const descriptor = await renderSession.close();
      await writeJson(path.join(outputDir, 'render-session.json'), descriptor);
    }
  } catch (error) {
    timing.totalMs = Date.now() - runStartedAt;
    if (error instanceof ProductionTimeBudgetExceededError) {
      await writeJson(runStatePath, state);
      return {
        ok: false,
        partial: true,
        budgetExceeded: true,
        phase: error.phase,
        projectId: state.projectId,
        manifestHash,
        runStatePath,
        framesRendered,
        cacheHits,
        cacheMisses,
        cacheHitRate: cacheHits + cacheMisses > 0 ? cacheHits / (cacheHits + cacheMisses) : 0,
        controlVideosRendered,
        controlVideosFailed,
        repairsAttempted: repairsAttemptedTotal,
        repairsDisabled: !autoRepair,
        timing,
        sourceRevisionId,
        error: error.message,
      };
    }
    throw error;
  } finally {
    abortScope.dispose();
    detachAgentRunSession();
    await runSession.close();
  }
}

/** Standalone still renderer for already-created shots. */
export async function runRenderStillsCli(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  outputDir: string;
  profileDir?: string;
}): Promise<PrevisCliResult> {
  const outputDir = path.resolve(options.outputDir);
  await mkdir(path.join(outputDir, 'shots'), { recursive: true });
  await mkdir(path.join(outputDir, 'debug'), { recursive: true });
  const runStatePath = path.join(outputDir, 'run-state.json');
  if (!(await pathExists(runStatePath))) {
    return { ok: false, error: 'run-state.json not found. Run agent:previs first.' };
  }
  const state = parseRunState(JSON.parse(await readFile(runStatePath, 'utf8'))) ;
  if (!state) return { ok: false, error: 'Invalid run-state.json' };

  const session = await openAgentBrowser({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
    profileDir: options.profileDir,
  });
  try {
    await openWorkspace(session.page, 'shots');
    const shots = await session.page.evaluate(() => window.foreScene!.listShots());
    let framesRendered = 0;
    let next = state;
    for (const [shotNumber, shotState] of Object.entries(state.shots)) {
      if (shotState.compile !== 'complete') continue;
      if (shotState.render === 'complete') {
        framesRendered += 1;
        continue;
      }
      const shot = shots.find((item) => item.shotNumber === shotNumber || item.id === shotState.shotId);
      if (!shot) continue;
      const framePath = path.join(outputDir, 'shots', `${shotNumber}.png`);
      const frame = await renderCleanShotFrame(session.page, shot.id, framePath, {
        debugUiPath: path.join(outputDir, 'debug', `${shotNumber}-ui.png`),
      });
      if (!frame.ok) {
        next = upsertShotState(next, shotNumber, {
          render: 'failed',
          shotId: shot.id,
          lastError: frame.error,
        });
        await writeJson(runStatePath, next);
        continue;
      }
      next = upsertShotState(next, shotNumber, {
        render: 'complete',
        framePath,
        renderSource: frame.fromCanonicalRenderer ? 'canonical_clay_renderer' : 'unknown',
        pixelStats: frame.pixelStats,
        shotId: shot.id,
      });
      framesRendered += 1;
      await writeJson(runStatePath, next);
    }
    // Batch honesty: ok is a conjunction. A failed or unrendered compiled shot
    // makes the batch not-ok even though other frames rendered fine.
    const outcome = deriveRenderStillsOutcome(next.shots);
    return {
      ok: outcome.ok,
      framesRendered,
      shotsConsidered: outcome.shotsConsidered,
      renderedComplete: outcome.rendered,
      ...(outcome.failedShotNumbers.length > 0 ? { failedShotNumbers: outcome.failedShotNumbers } : {}),
      ...(outcome.pendingShotNumbers.length > 0 ? { pendingShotNumbers: outcome.pendingShotNumbers } : {}),
      ...(outcome.ok ? {} : { error: 'Render-stills batch is incomplete: '
        + `${outcome.failedShotNumbers.length} failed, ${outcome.pendingShotNumbers.length} not rendered.` }),
      runStatePath,
      projectId: state.projectId,
    };
  } finally {
    await session.close();
  }
}

/** Build a contact sheet from an existing shots directory + run-state. */
export async function runContactSheetCli(options: {
  inputDir: string;
  outputPath: string;
  title?: string;
  /** Build the sheet over existing frames even when preflight fails; ok stays false. */
  allowPartial?: boolean;
}): Promise<PrevisCliResult> {
  const inputDir = path.resolve(options.inputDir);
  const runStatePath = path.join(path.dirname(inputDir), 'run-state.json');
  const state = (await pathExists(runStatePath))
    ? parseRunState(JSON.parse(await readFile(runStatePath, 'utf8')))
    : undefined;

  const shotNumbers = state
    ? Object.keys(state.shots).sort()
    : (await import('node:fs/promises')).readdir(inputDir)
      .then((files) => files.filter((file) => file.endsWith('.png')).map((file) => file.replace(/\.png$/, '')));

  const numbers = Array.isArray(shotNumbers) ? shotNumbers : await shotNumbers;
  const entries = numbers.map((shotNumber) => ({
    shotNumber,
    framePath: path.join(inputDir, `${shotNumber}.png`),
    ...(state !== undefined ? { renderStatus: state.shots[shotNumber]?.render } : {}),
  }));

  // Fail-closed input contract: every frame must exist, be non-empty, and — when
  // run-state backs the invocation — have finished rendering. A sheet over stale
  // or missing frames must never claim ok:true.
  const preflight = await evaluateContactSheetFrames({
    entries,
    pathExists,
    readFile: (filePath) => readFile(filePath),
  });

  if (!preflight.ok && !options.allowPartial) {
    return {
      ok: false,
      error: 'Contact-sheet inputs failed preflight; no sheet was built. '
        + 'Pass --allow-partial to build a sheet over the frames that exist.',
      diagnostics: preflight.issues.map((issue) => ({
        severity: 'error' as const,
        code: `contact_sheet_${issue.kind}`,
        message: issue.message,
        shotNumber: issue.shotNumber,
      })),
      frames: preflight.frames,
    };
  }

  const includedEntries = preflight.ok
    ? entries
    : entries.filter((entry) => {
      const frame = preflight.frames.find((candidate) => candidate.shotNumber === entry.shotNumber);
      return Boolean(frame?.exists) && (frame?.byteLength ?? 0) > 0;
    });

  const sheetEntries = includedEntries.map((entry) => ({
    shotNumber: entry.shotNumber,
    name: entry.shotNumber,
    framePath: entry.framePath,
    status: state?.shots[entry.shotNumber]?.validation ?? 'unknown',
    warningCount: state?.shots[entry.shotNumber]?.issues?.length ?? 0,
  }));

  const spec = buildContactSheetSpec({
    title: options.title ?? 'ForeScene Contact Sheet',
    shots: sheetEntries,
  });
  const htmlPath = `${options.outputPath}.html`;
  await writeFile(htmlPath, contactSheetHtml({
    ...spec,
    shots: spec.shots.map((shot) => ({
      ...shot,
      framePath: `file://${path.resolve(shot.framePath)}`,
    })),
  }), 'utf8');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${path.resolve(htmlPath)}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.resolve(options.outputPath), fullPage: true });
  } finally {
    await browser.close();
  }

  return {
    ok: preflight.ok,
    ...(preflight.ok ? {} : {
      partial: true,
      error: 'Contact sheet was built over a partial frame set; ok stays false.',
      diagnostics: preflight.issues.map((issue) => ({
        severity: 'error' as const,
        code: `contact_sheet_${issue.kind}`,
        message: issue.message,
        shotNumber: issue.shotNumber,
      })),
    }),
    contactSheet: path.resolve(options.outputPath),
    frames: preflight.frames,
  };
}
