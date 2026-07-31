/**
 * ForeScene autonomous previs orchestration (CLI-side).
 *
 * Phases: validate → optional reset → locations/cast/props → shot batches →
 * render stills → validation/repairs → contact sheet → package.
 */

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
import type { CameraData, LocationProject, Shot } from '../../src/domain/types';
import {
  assertManifestHashCompatible,
  applyManifestUpdateToRunState,
  buildContactSheetSpec,
  buildRepairPlan,
  compileProduction,
  compileShotList,
  contactSheetHtml,
  createInitialRunState,
  firstIncompletePhase,
  hashPrevisManifest,
  isRepairableIssue,
  parsePrevisProductionManifest,
  parseRunState,
  setPhase,
  touchRunState,
  upsertEntity,
  upsertShotState,
  validateShotFrame,
  type FrameValidationResult,
  type PrevisEntityMapping,
  type PrevisProductionManifestV1,
  type PrevisRunState,
  type RemovedShotEntry,
} from '../../src/engine/previs/index';
import { openAgentBrowser, waitForAgentIdle } from './browser';
import { captureSceneScreenshot, openWorkspace } from './screenshot';

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
}

export interface PrevisCliResult {
  ok: boolean;
  phase?: string;
  projectId?: string;
  manifestHash?: string;
  runStatePath?: string;
  shotsRequested?: number;
  shotsCreated?: number;
  framesRendered?: number;
  passed?: number;
  warnings?: number;
  failed?: number;
  contactSheet?: string;
  package?: string;
  diagnostics?: unknown[];
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
    const compatible = assertManifestHashCompatible(existing, params.manifestHash);
    if (!compatible.ok) {
      if (!params.updateManifest) {
        return { state: existing, resumed: true, error: compatible.message };
      }
      if (!(await pathExists(normalizedPath))) {
        return {
          state: existing,
          resumed: true,
          error: 'Cannot --update-manifest without a previous manifest.normalized.json.',
        };
      }
      const previous = parsePrevisProductionManifest(
        JSON.parse(await readFile(normalizedPath, 'utf8')) as unknown,
      ).manifest;
      if (!previous) {
        return {
          state: existing,
          resumed: true,
          error: 'Previous manifest.normalized.json failed to parse; cannot update.',
        };
      }
      const updated = applyManifestUpdateToRunState({
        state: existing,
        previousManifest: previous,
        nextManifest: params.manifest,
        nextManifestHash: params.manifestHash,
      });
      const sceneRebuildRequired = (
        updated.diff.invalidateLocations
        || updated.diff.invalidateCast
        || updated.diff.invalidateProps
      );
      return {
        state: updated.state,
        resumed: true,
        updated: true,
        sceneRebuildRequired,
        removedShots: updated.removedShots,
      };
    }
    return { state: existing, resumed: true };
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

function subjectNameMap(manifest: PrevisProductionManifestV1): Record<string, string> {
  const map: Record<string, string> = {};
  for (const character of manifest.cast) map[character.id] = character.name;
  for (const prop of manifest.props ?? []) map[prop.id] = prop.name;
  return map;
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
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  await mkdir(path.join(outputDir, 'logs'), { recursive: true });
  await mkdir(path.join(outputDir, 'shots'), { recursive: true });

  const rawManifest = await readFile(path.resolve(options.manifestPath), 'utf8');
  const parsed = parsePrevisProductionManifest(JSON.parse(rawManifest) as unknown);
  if (!parsed.manifest || parsed.errors.length > 0) {
    return {
      ok: false,
      phase: 'validate',
      diagnostics: parsed.errors,
      error: 'Manifest validation failed.',
    };
  }

  const manifest = parsed.manifest;
  const manifestHash = hashPrevisManifest(manifest);

  const loaded = await loadOrCreateRunState({
    outputDir,
    manifest,
    manifestHash,
    updateManifest: options.updateManifest,
  });
  let state = loaded.state;
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

  const session = await openAgentBrowser({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
    profileDir: options.profileDir,
  });

  try {
    await waitForAgentIdle(session.page);
    const status = await session.page.evaluate(() => window.foreScene!.getStatus());

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

    const compiled = compileProduction(manifest, { skipShotNumbers: skipShots });
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

    if (state.phases.cast !== 'complete' && compiled.cast.plan.commands.length > 0) {
      state = setPhase(state, 'cast', 'in_progress');
      const applied = await applyPlanOnPage(session.page, compiled.cast.plan);
      await writeJson(path.join(outputDir, 'logs', 'scene-cast.json'), applied);
      if (!applied.ok) {
        state = setPhase(state, 'cast', 'failed');
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
      for (const [key, mapping] of Object.entries(compiled.context.entities)) {
        if (key.startsWith('cast.')) {
          state = upsertEntity(state, key, resolveMappingIds(mapping, applied.summary?.createdRefs));
        }
      }
      state = setPhase(state, 'cast', 'complete');
      await writeJson(runStatePath, state);
    } else if (state.phases.cast !== 'complete') {
      state = setPhase(state, 'cast', 'complete');
    }

    if (state.phases.props !== 'complete') {
      if (compiled.props.plan.commands.length > 0) {
        state = setPhase(state, 'props', 'in_progress');
        const applied = await applyPlanOnPage(session.page, compiled.props.plan);
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
        for (const [key, mapping] of Object.entries(compiled.context.entities)) {
          if (key.startsWith('props.')) {
            state = upsertEntity(state, key, resolveMappingIds(mapping, applied.summary?.createdRefs));
          }
        }
      }
      state = setPhase(state, 'props', 'complete');
      await writeJson(runStatePath, state);
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

    const shotBatches = compileShotList(manifest, resolvedContext, {
      skipShotNumbers: skipShots,
      existingShotIds,
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
    // Final prune — drop blank Origin and any leftover non-manifest shots.
    const extras = liveShots.filter((shot) => !keepShotNumbers.has(shot.shotNumber));
    if (extras.length > 0) {
      const prune = await applyPlanOnPage(session.page, {
        version: 1,
        planId: 'previs-shot-prune',
        commands: extras.map((shot) => ({
          op: 'shot.delete' as const,
          shot: { id: shot.id },
        })),
      });
      await writeJson(path.join(outputDir, 'logs', 'shots-prune.json'), { extras, prune });
      liveShots = await session.page.evaluate(() => window.foreScene!.listShots());
    }
    state = setPhase(state, 'shots', 'complete');
    await writeJson(runStatePath, state);

    state = setPhase(state, 'render', 'in_progress');
    await openWorkspace(session.page, 'shots');
    let framesRendered = 0;

    for (const definition of manifest.shots) {
      const shotState = state.shots[definition.shotNumber];
      if (!shotState || shotState.compile !== 'complete') continue;
      if (shotState.render === 'complete' && shotState.framePath) {
        framesRendered += 1;
        continue;
      }

      const framePath = path.join(outputDir, 'shots', `${definition.shotNumber}.png`);
      let renderAttempts = shotState.renderAttempts ?? shotState.attempts ?? 0;
      let rendered = false;
      let lastError: string | undefined;

      while (renderAttempts < 2 && !rendered) {
        renderAttempts += 1;
        try {
          const shotId = shotState.shotId
            ?? liveShots.find((shot) => shot.shotNumber === definition.shotNumber)?.id;
          if (!shotId) throw new Error(`No shot id for ${definition.shotNumber}`);

          await session.page.evaluate(async (id) => {
            await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
            return window.foreScene!.applyPlan({
              version: 1,
              planId: `select-${id}`,
              commands: [{ op: 'shot.select', shot: { id } }],
            });
          }, shotId);
          await waitForAgentIdle(session.page);
          await captureSceneScreenshot(session.page, framePath);
          const info = await stat(framePath);
          if (info.size < 32) throw new Error('Screenshot file too small');
          rendered = true;
          framesRendered += 1;
          state = upsertShotState(state, definition.shotNumber, {
            render: 'complete',
            framePath,
            renderAttempts,
            attempts: renderAttempts,
          });
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          state = upsertShotState(state, definition.shotNumber, {
            render: 'failed',
            renderAttempts,
            attempts: renderAttempts,
            lastError,
          });
        }
      }
      await writeJson(runStatePath, state);
    }
    state = setPhase(state, 'render', 'complete');
    await writeJson(runStatePath, state);

    state = setPhase(state, 'validation', 'in_progress');
    let project = await session.page.evaluate(() => window.foreScene!.getProjectDocument()) as LocationProject;
    const names = subjectNameMap(manifest);
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

      let finalResult = validateShotFrame({
        project,
        shot: shot as Shot,
        definition,
        frameExists: exists,
        frameByteSize: byteSize,
        previousCamera,
        subjectNames: names,
      });

      let repairAttempts = shotState?.repairAttempts ?? 0;
      while (
        finalResult.status !== 'passed'
        && finalResult.issues.some((issue) => isRepairableIssue(issue.code))
        && repairAttempts < 2
        && shotState?.shotId
      ) {
        const repair = buildRepairPlan({
          shotTarget: { id: shotState.shotId },
          camera: shot.camera,
          issues: finalResult.issues,
        });
        if (!repair) break;

        repairAttempts += 1;
        await applyPlanOnPage(session.page, {
          version: 1,
          planId: `repair-${definition.shotNumber}-${repairAttempts}`,
          description: repair.description,
          commands: repair.commands,
        });
        await waitForAgentIdle(session.page);
        await session.page.evaluate(async (id) => {
          await window.foreScene!.applyPlan({
            version: 1,
            commands: [{ op: 'shot.select', shot: { id } }],
          });
        }, shotState.shotId);
        await waitForAgentIdle(session.page);
        await captureSceneScreenshot(session.page, framePath);

        project = await session.page.evaluate(() => window.foreScene!.getProjectDocument()) as LocationProject;
        shot = project.shots.find((item) => item.shotNumber === definition.shotNumber) ?? shot;
        exists = await pathExists(framePath);
        byteSize = exists ? (await stat(framePath)).size : undefined;

        finalResult = validateShotFrame({
          project,
          shot: shot as Shot,
          definition,
          frameExists: exists,
          frameByteSize: byteSize,
          previousCamera,
          subjectNames: names,
        });
        if (finalResult.status !== 'passed' && repairAttempts >= 2) {
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
      };
    });
    const spec = buildContactSheetSpec({
      title: `${manifest.project.name} — First Frames`,
      shots: sheetEntries,
    });
    const htmlPath = path.join(outputDir, 'contact-sheet.html');
    await writeFile(htmlPath, contactSheetHtml({
      ...spec,
      shots: spec.shots.map((shot) => ({
        ...shot,
        framePath: `file://${shot.framePath}`,
      })),
    }), 'utf8');

    const contactSheetPath = path.join(outputDir, 'contact-sheet.png');
    const sheetBrowser = await chromium.launch({ headless: true });
    try {
      const sheetPage = await sheetBrowser.newPage({
        viewport: {
          width: Math.min(2400, spec.columns * spec.cellWidth + 80),
          height: Math.min(
            4000,
            100 + Math.ceil(Math.max(1, spec.shots.length) / spec.columns) * (spec.cellHeight + 70),
          ),
        },
      });
      await sheetPage.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
      await sheetPage.screenshot({ path: contactSheetPath, fullPage: true });
    } finally {
      await sheetBrowser.close();
    }
    state = setPhase(state, 'contactSheet', 'complete');
    await writeJson(runStatePath, state);

    let packagePath: string | undefined;
    let packageFailed = false;
    if (!options.skipPackage) {
      state = setPhase(state, 'package', 'in_progress');
      const downloadPromise = session.page.waitForEvent('download', { timeout: 300_000 });
      const pack = await session.page.evaluate(async () => {
        await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
        return window.foreScene!.exportPackage({ download: true });
      });
      await writeJson(path.join(outputDir, 'logs', 'export.json'), pack);
      if (pack.ok) {
        const download = await downloadPromise;
        packagePath = path.join(outputDir, 'package.zip');
        await download.saveAs(packagePath);
        state = setPhase(state, 'package', 'complete');
      } else {
        packageFailed = true;
        state = setPhase(state, 'package', 'failed');
      }
      await writeJson(runStatePath, state);
    } else {
      state = setPhase(state, 'package', 'skipped');
    }

    const passed = validationResults.filter((item) => item.status === 'passed').length;
    const warnings = validationResults.filter((item) => (
      item.status === 'warning' || item.status === 'needs_review'
    )).length;
    const failed = validationResults.filter((item) => item.status === 'failed').length;
    const missingFrames = manifest.shots.some((shot) => {
      const shotState = state.shots[shot.shotNumber];
      return shotState?.compile === 'complete' && shotState.render !== 'complete';
    });

    const summary: PrevisCliResult = {
      ok: !missingFrames && failed === 0 && !packageFailed,
      projectId: state.projectId,
      shotsRequested: manifest.shots.length,
      shotsCreated,
      framesRendered,
      passed,
      warnings,
      failed,
      contactSheet: contactSheetPath,
      package: packagePath,
      manifestHash,
      runStatePath,
      ...(packageFailed ? { error: 'Package export failed.' } : {}),
    };
    await writeJson(path.join(outputDir, 'summary.json'), summary);
    state = touchRunState(state);
    await writeJson(runStatePath, state);
    return summary;
  } finally {
    await session.close();
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
      await session.page.evaluate(async (id) => {
        await window.foreScene!.applyPlan({
          version: 1,
          commands: [{ op: 'shot.select', shot: { id } }],
        });
      }, shot.id);
      await waitForAgentIdle(session.page);
      await captureSceneScreenshot(session.page, framePath);
      next = upsertShotState(next, shotNumber, {
        render: 'complete',
        framePath,
        shotId: shot.id,
      });
      framesRendered += 1;
      await writeJson(runStatePath, next);
    }
    return { ok: true, framesRendered, runStatePath, projectId: state.projectId };
  } finally {
    await session.close();
  }
}

/** Build a contact sheet from an existing shots directory + run-state. */
export async function runContactSheetCli(options: {
  inputDir: string;
  outputPath: string;
  title?: string;
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
    name: shotNumber,
    framePath: path.join(inputDir, `${shotNumber}.png`),
    status: state?.shots[shotNumber]?.validation ?? 'unknown',
    warningCount: state?.shots[shotNumber]?.issues?.length ?? 0,
  }));

  const spec = buildContactSheetSpec({
    title: options.title ?? 'ForeScene Contact Sheet',
    shots: entries,
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

  return { ok: true, contactSheet: path.resolve(options.outputPath) };
}
