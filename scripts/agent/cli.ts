#!/usr/bin/env tsx
/**
 * ForeScene Agent CLI — Playwright host for window.foreScene.
 *
 * Usage:
 *   npm run agent:capabilities
 *   npm run agent:inspect
 *   npm run agent:open -- --file project.fsp --write
 *   npm run agent:save -- --output project.fsp --write
 *   npm run agent:preview -- --plan plans/example.json
 *   npm run agent:apply -- --plan plans/example.json --write
 *   npm run agent:screenshot -- --workspace shots --output artifacts/shot.png
 *   npm run agent:run -- --plan plans/example.json --screenshot artifacts/out.png --write
 *   npm run agent:package -- --write --output artifacts/package.zip
 *   npm run agent:analyze-character -- --file actor.glb --rig-package actor.fsrig --rig-mode saved-rig
 *   npm run agent:import-character -- --file actor.glb --rig-package actor.fsrig --rig-mode saved-rig --name "Actor" --write
 *   npm run agent:import-model -- --file set.glb --write
 *   npm run agent:shot-panorama -- --shot 02 --pano pano_id --write
 *   npm run agent:shot-panorama -- --shot 02 --pano null --write
 *   npm run agent:replace-proxy -- --proxy proxy-id --replacement model-id --shots 08,09 --output artifacts/refinement/swap.json --write
 *   npm run agent:render-passes -- --shots 01,02 --output artifacts/reviews/batch-01
 *   npm run agent:plan-exports -- --shots 01,02 --output artifacts/preflight/deliverables-plan.json
 *   npm run agent:verify-package -- --plan artifacts/preflight/deliverables-plan.json --package artifacts/package.zip
 *   npm run agent:refine -- --plan production/refinement-plan.json --batch batch-01 --write --output artifacts/refinement
 *   npm run agent:previs -- --manifest examples/previs/minimal-dialogue.json --write --reset-project --output artifacts/previs
 *   npm run agent:production -- --manifest examples/previs/minimal-dialogue.json --write --reset-project --mode rapid-review
 *   npm run agent:render-stills -- --output artifacts/previs
 *   npm run agent:contact-sheet -- --input artifacts/previs/shots --output artifacts/previs/contact-sheet.png
 *   npm run agent:visual-preflight -- --shots 01,02
 *   npm run agent:asset-contract
 *   npm run agent:world-preview -- --shots 01,02
 *   npm run agent:world-mock -- --shots 01,02
 *   npm run agent:world-depth -- --shot 02 --time 1.5 --resolution 640x360 --output artifacts/depth.npy
 *   npm run agent:verify -- --json
 *   npm run agent:frame -- --shot 01 --mode projected --output artifacts/01.projected.png
 *
 * Write commands require explicit `--write` (session) or `--persist-write` (profile).
 * Project reset additionally requires `--reset-project`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openAgentBrowser, waitForAgentIdle, type AgentBrowserSession } from './browser';
import { createCliAbortScope, installCliAbortBridge, type CliAbortScope } from './cliAbort';
import { inspectViaBrowser } from './inspect';
import { captureSceneScreenshot, openWorkspace } from './screenshot';
import { runContactSheetCli, runPrevisCli, runRenderStillsCli } from './previs';
import { runProduction } from './production';
import {
  createProxyReplacementPlan,
  verifyProxyReplacement,
} from '../../src/engine/agent/proxyReplacement';
import { verifyPackageAgainstExportPlan } from '../../src/engine/agent/packageVerification';
import { runRefinementCli } from './refinement';
import {
  refreshAgentSessionRevision,
  saveAgentArtifactToFile,
  toCliArtifactTransfer,
  type AgentArtifactTransferTelemetry,
} from './artifactIo';
import {
  agentCliCommandRequiresProfile,
  requireExplicitAgentProfile,
} from './agentProfile';
import { activeAgentRunSession } from './agentSession';
import { parseAgentCliArgs } from './cliArgs';
import {
  buildAgentCliCapabilitiesDocument,
  commandToOperationName,
  resolveAgentRenderAppearance,
  type AgentRenderAppearance,
} from './cliCapabilities';
import { buildAgentCliHelpDocument } from './cliCommands';
import {
  AGENT_CLI_EXIT,
  AgentCliUsageError,
  envelopeFromError,
  wrapAgentCliStdout,
  type CliStdoutContext,
} from './cliResult';
import {
  beginCliOperation,
  characterImportPhaseProgress,
  heartbeatIntervalMs,
  latestActiveCliOperation,
  listCliOperationRecords,
  requestCliOperationCancel,
} from './cliOperation';
import { createCliInvocationIdentity, publishCliInvocationIdentity } from './cliIdentity';
import {
  resolveCliCommandShotUsage,
  toOptionalRequestedShotIds,
  toVisualCollectionInput,
} from './cliShotSelection';

let activeCliCommand: string | undefined;
let activeCliOperation: ReturnType<typeof beginCliOperation> | undefined;
const cliStdout: CliStdoutContext = {
  operation: 'cli.inspect',
  startedAt: Date.now(),
};

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(wrapAgentCliStdout(cliStdout, value), null, 2)}\n`);
}

function printErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function watchBrowserProgress<T>(
  session: AgentBrowserSession,
  work: () => Promise<T>,
): Promise<T> {
  const poll = setInterval(() => {
    void session.page.evaluate(() => window.foreScene?.getCharacterImportProgress?.() ?? null)
      .then((progress) => {
        if (!progress || !activeCliOperation) return;
        return activeCliOperation.progress({
          progress: characterImportPhaseProgress(progress.phase),
          message: progress.message ?? progress.phase ?? 'Character import running',
        });
      })
      .catch(() => undefined);
  }, Math.min(2_000, heartbeatIntervalMs()));
  poll.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(poll);
  }
}

function resolveRenderAppearance(command: string, appearance?: string, mode?: string): AgentRenderAppearance {
  try {
    return resolveAgentRenderAppearance({ command, appearance, mode });
  } catch (error) {
    throw new AgentCliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function resolvePeopleVariant(value?: string): 'with_people' | 'clean_plate' | undefined {
  if (!value) return undefined;
  if (value === 'with_people' || value === 'clean_plate') return value;
  throw new AgentCliUsageError('--people-variant must be with_people or clean_plate.');
}

function resolveFrameContent(value?: string): 'full_scene' | 'characters_only' | undefined {
  if (!value) return undefined;
  if (value === 'full_scene' || value === 'characters_only' || value === 'full') {
    return value === 'full' ? 'full_scene' : value;
  }
  throw new AgentCliUsageError('--content must be full_scene, characters_only, or full.');
}

function resolveImageDimensions(value?: string): { width?: number; height?: number } {
  if (!value) return {};
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) throw new AgentCliUsageError('--resolution must be WIDTHxHEIGHT (for example 640x360).');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new AgentCliUsageError('--resolution dimensions must be positive integers.');
  }
  return { width, height };
}

function parseArgs(argv: string[]) {
  return parseAgentCliArgs(argv);
}

async function runCharacterAnalysis(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  file: string;
  rigPackage?: string;
  rigMode: 'preserve' | 'autorig' | 'auto' | 'saved-rig';
  output?: string;
  profile?: string;
}) {
  const target = path.resolve(options.file);
  const rigPackageTarget = options.rigPackage ? path.resolve(options.rigPackage) : undefined;
  if (options.rigMode === 'saved-rig' && !rigPackageTarget) {
    throw new Error('analyze-character with --rig-mode saved-rig requires --rig-package <path>.');
  }
  await withSession(options, async (session) => {
    await session.page.locator('[data-agent-character-import-input]').setInputFiles(target);
    if (rigPackageTarget) {
      await session.page.locator('[data-agent-character-rig-package-input]').setInputFiles(rigPackageTarget);
    }
    const result = await session.page.evaluate(async (input) => {
      const fileInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
      const file = fileInput?.files?.[0];
      if (!file) throw new Error('Character file was not staged in the browser.');
      if (input.rigMode === 'saved-rig') {
        const rigInput = document.querySelector('[data-agent-character-rig-package-input]') as HTMLInputElement | null;
        const rigPackageFile = rigInput?.files?.[0];
        if (!rigPackageFile) throw new Error('Saved-rig package was not staged in the browser.');
        return window.foreScene!.analyzeSavedRigCharacter({ sourceFile: file, rigPackageFile });
      }
      return window.foreScene!.analyzeCharacterImport({ file, mode: 'auto' });
    }, { rigMode: options.rigMode });
    if (options.output) {
      const output = path.resolve(options.output);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    printJson({ ...result, ...(options.output ? { output: path.resolve(options.output) } : {}) });
  });
}

async function runCharacterImport(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  file: string;
  rigPackage?: string;
  mapping?: string;
  rigMode: 'preserve' | 'autorig' | 'auto' | 'saved-rig';
  name?: string;
  consentToken?: string;
  allowHeavyCharacterImports: boolean;
  profile?: string;
}) {
  requireExplicitWrite('agent:import-character', options.writeAccess);
  const target = path.resolve(options.file);
  const rigPackageTarget = options.rigPackage ? path.resolve(options.rigPackage) : undefined;
  if (options.rigMode === 'saved-rig' && !rigPackageTarget) {
    throw new Error('import-character with --rig-mode saved-rig requires --rig-package <path>.');
  }
  let mappingOverrides: Record<string, string> | undefined;
  if (options.mapping) {
    const mappingPath = options.mapping;
    const parsed = JSON.parse(await readFile(path.resolve(mappingPath), 'utf8')) as unknown;
    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const candidate = record.mappingOverrides && typeof record.mappingOverrides === 'object'
      ? record.mappingOverrides as Record<string, unknown>
      : record;
    mappingOverrides = Object.fromEntries(
      Object.entries(candidate).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  await withSession(options, async (session) => {
    await session.page.locator('[data-agent-character-import-input]').setInputFiles(target);
    if (rigPackageTarget) {
      await session.page.locator('[data-agent-character-rig-package-input]').setInputFiles(rigPackageTarget);
    }
    const result = await watchBrowserProgress(session, () => session.page.evaluate(async (input) => {
      const fileInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
      const file = fileInput?.files?.[0];
      if (!file) throw new Error('Character file was not staged in the browser.');
      if (input.rigMode === 'saved-rig') {
        const rigInput = document.querySelector('[data-agent-character-rig-package-input]') as HTMLInputElement | null;
        const rigPackageFile = rigInput?.files?.[0];
        if (!rigPackageFile) throw new Error('Saved-rig package was not staged in the browser.');
        return window.foreScene!.importSavedRigCharacter({
          sourceFile: file,
          rigPackageFile,
          name: input.characterName ?? (file.name.replace(/\.(glb|gltf|fbx)$/i, '') || 'Poseable character'),
          consentToken: input.consentToken,
        });
      }
      const analysis = await window.foreScene!.analyzeCharacterImport({ file, mode: input.rigMode === 'auto' ? 'auto' : input.rigMode === 'preserve' ? 'preserveExistingRig' : 'autorig' });
      const mode = input.rigMode === 'autorig'
        ? 'autorig'
        : input.rigMode === 'preserve'
          ? 'preserveExistingRig'
          : analysis.hasSkeleton
            && analysis.hasSkinning
            && analysis.requiredMissing.length === 0
            && (analysis.mappingConfidence ?? 0) >= 0.7
            ? 'preserveExistingRig'
            : 'autorig';
      return window.foreScene!.importCharacter({
        analysisId: analysis.analysisId,
        mode,
        mappingOverrides: input.mappingOverrides,
        name: input.characterName,
        consentToken: input.consentToken,
      });
    }, {
      rigMode: options.rigMode,
      mappingOverrides,
      characterName: options.name,
      consentToken: options.consentToken ?? (options.allowHeavyCharacterImports ? 'allow-heavy-character-imports' : undefined),
    }));
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  });
}

async function runPanoramaImport(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  file: string;
  name?: string;
  profile?: string;
}) {
  requireExplicitWrite('agent:import-panorama', options.writeAccess);
  const target = path.resolve(options.file);
  await withSession({ ...options, command: 'import-panorama' }, async (session) => {
    await session.page.locator('[data-agent-pano-import-input]').setInputFiles(target);
    const result = await session.page.evaluate(async (input) => {
      const fileInput = document.querySelector('[data-agent-pano-import-input]') as HTMLInputElement | null;
      const file = fileInput?.files?.[0];
      if (!file) throw new Error('Panorama file was not staged in the browser.');
      return window.foreScene!.importPanoramaReference({
        file,
        mode: 'canonical',
        name: input.name,
      });
    }, { name: options.name });
    printJson(result);
    if (!result.ok) process.exitCode = AGENT_CLI_EXIT.failure;
  });
}

async function runShotPanorama(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  shotId: string;
  pano: string;
}) {
  requireExplicitWrite('agent:shot-panorama', options.writeAccess);
  const panoId = options.pano === 'null' || options.pano === '' ? null : options.pano;
  const looksLikeShotNumber = /^\d+$/.test(options.shotId.trim());
  await withSession({ ...options, command: 'shot-panorama' }, async (session) => {
    const result = await session.page.evaluate(async (input) => (
      window.foreScene!.setShotPanorama({
        shot: input.looksLikeShotNumber
          ? { shotNumber: input.shotId }
          : { id: input.shotId },
        panoId: input.panoId,
      })
    ), {
      shotId: options.shotId,
      panoId,
      looksLikeShotNumber,
    });
    printJson(result);
    if (!result.ok) process.exitCode = AGENT_CLI_EXIT.failure;
  });
}

async function runModelImport(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  file: string;
  consentToken?: string;
  allowHeavyModelImports: boolean;
  output?: string;
  profile?: string;
}) {
  requireExplicitWrite('agent:import-model', options.writeAccess);
  const target = path.resolve(options.file);
  await withSession(options, async (session) => {
    await session.page.locator('[data-agent-model-import-input]').setInputFiles(target);
    const result = await session.page.evaluate(async (input) => {
      const fileInput = document.querySelector('[data-agent-model-import-input]') as HTMLInputElement | null;
      const file = fileInput?.files?.[0];
      if (!file) throw new Error('Model file was not staged in the browser.');
      return window.foreScene!.importModel({
        file,
        mode: 'separate',
        consentToken: input.consentToken,
        extremeConfirmation: input.extremeConfirmation,
      });
    }, {
      consentToken: options.consentToken ?? (options.allowHeavyModelImports ? 'allow-heavy-model-imports' : undefined),
      extremeConfirmation: options.consentToken === 'IMPORT' ? 'IMPORT' : undefined,
    });
    if (options.output) {
      const output = path.resolve(options.output);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    printJson({ ...result, ...(options.output ? { output: path.resolve(options.output) } : {}) });
    if (!result.ok) process.exitCode = 1;
  });
}

async function readProxyReplacementSnapshot(session: AgentBrowserSession) {
  return session.page.evaluate(() => {
    const api = window.foreScene;
    if (!api) throw new Error('window.foreScene is not available.');
    const project = api.getProjectDocument();
    // Use the dedicated detailed endpoint for every shot. Do not infer staging
    // from the compact `inspectShot()` response.
    const shotDocuments = project.shots.map((shot) => api.getShotDocument({ id: shot.id }));
    return { project: { ...project, shots: shotDocuments }, shotDocuments };
  });
}

function safeEvidenceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'shot';
}

async function renderProxyEvidence(
  session: AgentBrowserSession,
  shots: Array<{ id: string; shotNumber: string }>,
  phase: 'before' | 'after',
  reportOutput: string,
) {
  const frames = await session.page.evaluate(async (shotIds) => Promise.all(
    shotIds.map((shotId) => window.foreScene!.renderShotFrame({
      shotId,
      appearance: 'clay',
      width: 960,
      height: 540,
    })),
  ), shots.map((shot) => shot.id));
  const reportPath = path.resolve(reportOutput);
  const reportDirectory = path.dirname(reportPath);
  const reportStem = path.basename(reportPath, path.extname(reportPath));
  const evidence: Array<Record<string, unknown>> = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const shot = shots[index]!;
    if (!frame.ok || !frame.pngDataUrl) {
      const detail = frame.diagnostics?.map((diagnostic) => diagnostic.message).join('; ') ?? 'No frame data was returned.';
      throw new Error(`Could not render ${phase} evidence for shot ${shot.shotNumber}: ${detail}`);
    }
    const comma = frame.pngDataUrl.indexOf(',');
    if (comma < 0) throw new Error(`Rendered ${phase} evidence for shot ${shot.shotNumber} was not a data URL.`);
    const output = path.join(reportDirectory, `${reportStem}.${safeEvidenceSegment(shot.shotNumber)}.${phase}.png`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(frame.pngDataUrl.slice(comma + 1), 'base64'));
    evidence.push({
      shotId: shot.id,
      shotNumber: shot.shotNumber,
      output,
      width: frame.width,
      height: frame.height,
      sampledTimeSeconds: frame.sampledTimeSeconds,
      pixelStats: frame.pixelStats,
      source: frame.source,
    });
  }
  return evidence;
}

async function runProxyReplacement(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  proxyObjectId: string;
  replacementObjectId: string;
  shotIds: string[];
  output: string;
  profile?: string;
}) {
  requireExplicitWrite('agent:replace-proxy', options.writeAccess);
  const output = path.resolve(options.output);
  const report: Record<string, unknown> = {
    ok: false,
    command: 'agent:replace-proxy',
    proxyObjectId: options.proxyObjectId,
    replacementObjectId: options.replacementObjectId,
    requestedShotIds: options.shotIds,
    output,
  };
  await withSession(options, async (session) => {
    let applied = false;
    try {
      await waitForAgentIdle(session.page);
      const before = await readProxyReplacementSnapshot(session);
      const planned = createProxyReplacementPlan({
        project: before.project,
        shotDocuments: before.shotDocuments,
        proxyObjectId: options.proxyObjectId,
        replacementObjectId: options.replacementObjectId,
        requestedShotIds: options.shotIds,
      });
      report.before = {
        projectId: before.project.id,
        shotIds: before.project.shots.map((shot) => shot.id),
        panoIds: before.project.panoRefs.map((pano) => pano.id),
      };
      if (!planned.ok) {
        report.errors = planned.errors;
        return;
      }
      report.plan = planned.plan;
      report.affectedShots = planned.affectedShots;
      report.beforeEvidence = await renderProxyEvidence(session, planned.affectedShots, 'before', output);

      const preview = await session.page.evaluate((plan) => window.foreScene!.previewPlan(plan), planned.plan);
      report.preview = preview;
      if (!preview.ok) {
        report.errors = preview.diagnostics;
        return;
      }

      const apply = await session.page.evaluate(async (plan) => window.foreScene!.applyPlan(plan), planned.plan);
      report.apply = apply;
      if (!apply.ok) {
        report.errors = apply.diagnostics;
        return;
      }
      applied = true;

      const after = await readProxyReplacementSnapshot(session);
      const verification = verifyProxyReplacement({
        beforeProject: before.project,
        afterProject: after.project,
        proxyObjectId: options.proxyObjectId,
        replacementObjectId: options.replacementObjectId,
        affectedShots: planned.affectedShots,
      });
      report.verification = verification;
      if (!verification.ok) throw new Error(verification.errors.join(' '));

      report.afterEvidence = await renderProxyEvidence(session, planned.affectedShots, 'after', output);
      report.after = {
        projectId: after.project.id,
        shotIds: after.project.shots.map((shot) => shot.id),
        panoIds: after.project.panoRefs.map((pano) => pano.id),
      };
      report.ok = true;
    } catch (error) {
      report.error = error instanceof Error ? error.message : 'Proxy replacement failed.';
      if (applied) {
        report.rollback = await session.page.evaluate(async () => window.foreScene!.undoLastPlan());
      }
    } finally {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      printJson(report);
      if (report.ok !== true) process.exitCode = 1;
    }
  });
}

async function runFrame(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  shotId: string;
  timeSeconds?: number;
  appearance: AgentRenderAppearance;
  peopleVariant?: 'with_people' | 'clean_plate';
  content?: 'full_scene' | 'characters_only';
  output: string;
}) {
  await withSession(options, async (session) => {
    const result = await session.page.evaluate(async (input) => (
      window.foreScene!.renderShotFrame({
        shotId: input.shotId,
        timeSeconds: input.timeSeconds,
        appearance: input.appearance,
        peopleVariant: input.peopleVariant,
        content: input.content,
      })
    ), {
      shotId: options.shotId,
      timeSeconds: options.timeSeconds,
      appearance: options.appearance,
      peopleVariant: options.peopleVariant,
      content: options.content,
    });
    if (!result.ok || !result.pngDataUrl) {
      printJson(result);
      process.exitCode = AGENT_CLI_EXIT.failure;
      return;
    }
    const comma = result.pngDataUrl.indexOf(',');
    if (comma < 0) throw new Error('Agent frame response did not contain a data URL.');
    const target = path.resolve(options.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(result.pngDataUrl.slice(comma + 1), 'base64'));
    printJson({ ...result, pngDataUrl: undefined, output: target, appearance: options.appearance });
  });
}

async function runOpenProject(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  file: string;
}) {
  requireExplicitWrite('agent:open', options.writeAccess);
  const target = path.resolve(options.file);
  await withSession(options, async (session) => {
    await session.page.locator('[data-agent-project-open-input]').setInputFiles(target);
    const result = await session.page.evaluate(async () => {
      const fileInput = document.querySelector('[data-agent-project-open-input]') as HTMLInputElement | null;
      const file = fileInput?.files?.[0];
      if (!file) throw new Error('Project package was not staged in the browser.');
      return window.foreScene!.openProjectPackage({ file });
    });
    printJson({ ...result, file: target });
    if (!result.ok) process.exitCode = AGENT_CLI_EXIT.failure;
  });
}

async function runSaveProject(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  output: string;
}) {
  requireExplicitWrite('agent:save', options.writeAccess);
  await withSession(options, async (session) => {
    const result = await session.page.evaluate(async () => (
      window.foreScene!.exportProjectBackup({ download: false })
    ));
    let savedPath: string | undefined;
    let transfer: AgentArtifactTransferTelemetry | undefined;
    if (result.ok && 'artifact' in result && result.artifact?.artifactId) {
      const saved = await saveAgentArtifactToFile(session.page, result.artifact.artifactId, options.output);
      savedPath = saved.savedPath;
      transfer = toCliArtifactTransfer(saved);
    } else if (result.ok && !result.artifact?.artifactId) {
      throw new Error('Project save reported success but no artifact handle was returned.');
    }
    printJson({ ...result, savedPath, transfer });
    if (!result.ok) process.exitCode = AGENT_CLI_EXIT.failure;
  });
}

const REVIEW_PASSES = [
  {
    fileName: 'clay_with-characters.png',
    appearance: 'clay' as const,
    peopleVariant: 'with_people' as const,
    content: 'full_scene' as const,
  },
  {
    fileName: 'clay_clean-plate.png',
    appearance: 'clay' as const,
    peopleVariant: 'clean_plate' as const,
    content: 'full_scene' as const,
  },
  {
    fileName: 'projected_with-characters.png',
    appearance: 'projected' as const,
    peopleVariant: 'with_people' as const,
    content: 'full_scene' as const,
  },
  {
    fileName: 'projected_clean-plate.png',
    appearance: 'projected' as const,
    peopleVariant: 'clean_plate' as const,
    content: 'full_scene' as const,
  },
  {
    fileName: 'characters-only.png',
    appearance: 'clay' as const,
    peopleVariant: 'with_people' as const,
    content: 'characters_only' as const,
  },
  {
    fileName: 'depth.png',
    appearance: 'depth' as const,
    peopleVariant: 'with_people' as const,
    content: 'full_scene' as const,
  },
] as const;

async function resolveShotIds(
  session: AgentBrowserSession,
  requestedIds: string[],
): Promise<Array<{ id: string; shotNumber: string }>> {
  const available = await session.page.evaluate(() => window.foreScene!.listShots());
  const requested = requestedIds.length > 0 ? requestedIds : available.map((shot) => shot.id);
  const resolved = requested.map((requestedId) => (
    available.find((shot) => shot.id === requestedId || shot.shotNumber === requestedId)
  ));
  const missing = requested.filter((id, index) => !resolved[index]);
  if (missing.length > 0) {
    throw new Error(`Unknown shot id or number: ${missing.join(', ')}.`);
  }
  return resolved as Array<{ id: string; shotNumber: string }>;
}

function dataUrlBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Agent frame response did not contain a data URL.');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

async function runRenderPasses(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  shotIds: string[];
  output: string;
}) {
  const outputRoot = path.resolve(options.output);
  await withSession(options, async (session) => {
    await waitForAgentIdle(session.page);
    const shots = await resolveShotIds(session, options.shotIds);
    const report: {
      schemaVersion: 1;
      generatedAt: string;
      shots: Array<{
        id: string;
        shotNumber: string;
        passes: Array<Record<string, unknown>>;
      }>;
      verification: { expectedPassCount: number; renderedPassCount: number; uniquePngCount: number };
      ok: boolean;
    } = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      shots: [],
      verification: { expectedPassCount: shots.length * REVIEW_PASSES.length, renderedPassCount: 0, uniquePngCount: 0 },
      ok: true,
    };
    const fingerprints = new Set<string>();

    for (const shot of shots) {
      const shotDirectory = path.join(outputRoot, shot.shotNumber);
      const passReports: Array<Record<string, unknown>> = [];
      for (const pass of REVIEW_PASSES) {
        const result = await session.page.evaluate((input) => (
          window.foreScene!.renderShotFrame(input)
        ), { shotId: shot.id, ...pass });
        if (!result.ok || !result.pngDataUrl) {
          report.ok = false;
          passReports.push({
            ...pass,
            ok: false,
            diagnostics: result.diagnostics ?? [{ code: 'render_failed', message: 'No PNG returned.' }],
          });
          continue;
        }
        const target = path.join(shotDirectory, pass.fileName);
        const bytes = dataUrlBytes(result.pngDataUrl);
        const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        await mkdir(shotDirectory, { recursive: true });
        await writeFile(target, bytes);
        fingerprints.add(sha256);
        report.verification.renderedPassCount += 1;
        passReports.push({
          ...pass,
          ok: true,
          output: target,
          sha256,
          width: result.width,
          height: result.height,
          source: result.source,
          pixelStats: result.pixelStats,
          depth: result.depth,
        });
      }
      report.shots.push({ id: shot.id, shotNumber: shot.shotNumber, passes: passReports });
    }

    report.verification.uniquePngCount = fingerprints.size;
    await mkdir(outputRoot, { recursive: true });
    const manifestPath = path.join(outputRoot, 'review-manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    printJson({ ...report, manifestPath });
    if (!report.ok) process.exitCode = 1;
  });
}

async function runPlanExports(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  shotIds: string[];
  output: string;
}) {
  await withSession(options, async (session) => {
    await waitForAgentIdle(session.page);
    const shots = await resolveShotIds(session, options.shotIds);
    const result = await session.page.evaluate((shotIds) => (
      window.foreScene!.createExportPlan({ shotIds })
    ), shots.map((shot) => shot.id));
    const target = path.resolve(options.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    printJson({ ...result, output: target });
    if (!result.ok) process.exitCode = 1;
  });
}

async function runVerifyPackage(options: { plan: string; packagePath: string }) {
  const planPath = path.resolve(options.plan);
  const packagePath = path.resolve(options.packagePath);
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as Parameters<typeof verifyPackageAgainstExportPlan>[0];
  const archive = new Blob([await readFile(packagePath)]);
  const result = await verifyPackageAgainstExportPlan(plan, archive);
  printJson({ ...result, planPath, packagePath });
  if (!result.ok) process.exitCode = 1;
}

async function runVideo(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  shotId: string;
  output?: string;
  resolution?: string;
  appearance?: string;
  content?: string;
  attachToShot: boolean;
  download: boolean;
}) {
  await withSession(options, async (session) => {
    const contentMode = options.content === 'full' ? 'full_scene' : options.content;
    const result = await session.page.evaluate(async (input) => (
      window.foreScene!.renderShotVideo({
        shotId: input.shotId,
        resolutionPreset: input.resolution as '720p' | '1080p' | '4k' | undefined,
        appearance: input.appearance as 'clay' | 'projected' | 'depth' | undefined,
        contentMode: input.content as 'full_scene' | 'clean_plate' | 'characters_only' | undefined,
        attachToShot: input.attachToShot,
        download: false,
      })
    ), { ...options, content: contentMode });
    let savedPath: string | undefined;
    let transfer: AgentArtifactTransferTelemetry | undefined;
    if (options.download && options.output && result.ok && result.artifact?.artifactId) {
      const saved = await saveAgentArtifactToFile(session.page, result.artifact.artifactId, options.output);
      savedPath = saved.savedPath;
      transfer = toCliArtifactTransfer(saved);
    }
    printJson({
      ...result,
      savedPath,
      transfer,
      provenance: (await session.page.evaluate(() => window.foreScene!.getStatus())).provenance,
    });
    if (!result.ok) process.exitCode = 1;
  });
}

function requireExplicitWrite(command: string, writeAccess: boolean): void {
  if (!writeAccess) {
    throw new AgentCliUsageError(
      `${command} requires --write (session) or --persist-write (trusted profile).`,
    );
  }
}

async function withSession<T>(
  options: {
    url?: string;
    headless: boolean;
    writeAccess: boolean;
    persistWrite: boolean;
    profile?: string;
    command?: string;
  },
  run: (session: AgentBrowserSession, abort: CliAbortScope) => Promise<T>,
): Promise<T> {
  let abortScope!: CliAbortScope;
  const operation = beginCliOperation({
    type: options.command ? commandToOperationName(options.command) : cliStdout.operation,
    profile: options.profile,
    onCancel: () => abortScope.abort(),
  });
  cliStdout.operationId = operation.record.operationId;
  let session: AgentBrowserSession | undefined;
  let cancelBrowserPromise: Promise<void> | undefined;
  let triggerBrowserAbort: (() => void) | undefined;

  abortScope = createCliAbortScope({
    onAbort: () => {
      triggerBrowserAbort?.();
      if (session) {
        cancelBrowserPromise = session.page.evaluate(() => {
          const api = window.foreScene;
          if (!api) return;
          api.cancelPackageExport?.();
          api.cancelShotVideoRender?.();
          api.cancelShotStillPreparation?.();
          api.cancelRenderWork?.();
          api.cancelCharacterImport?.();
        }).catch(() => undefined);
      }
      void operation.cancel('Agent CLI run was cancelled.');
    },
  });

  await operation.start(`Starting ${operation.record.type}`);
  let ownsBrowser = false;
  try {
    const shared = activeAgentRunSession();
    const reuse = Boolean(shared && options.profile && shared.profileDir === requireExplicitAgentProfile(options.profile));
    if (reuse && shared) {
      session = shared.browser;
      cliStdout.profile = shared.profileDir;
    } else {
      ownsBrowser = true;
      session = await openAgentBrowser({
        url: options.url,
        headless: options.headless || process.env.CI === 'true' || !process.stdout.isTTY,
        writeAccess: options.writeAccess,
        persistWrite: options.persistWrite,
        profileDir: options.profile,
      });
    }
    cliStdout.profileRecovery = session.profileRecovery;
    await publishCliInvocationIdentity(session.page, createCliInvocationIdentity({
      command: options.command ?? activeCliCommand,
      profile: options.profile ?? session.profileDir,
    }));
    triggerBrowserAbort = await installCliAbortBridge(session.page);
    activeCliOperation = operation;
    const result = await Promise.race([
      run(session, abortScope),
      new Promise<T>((_resolve, reject) => {
        if (abortScope.signal.aborted) {
          reject(Object.assign(new Error('Agent CLI run was cancelled.'), { name: 'AbortError' }));
          return;
        }
        abortScope.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('Agent CLI run was cancelled.'), { name: 'AbortError' }));
        }, { once: true });
      }),
    ]);
    await operation.complete();
    return result;
  } catch (error) {
    const cancelled = abortScope.signal.aborted
      || (error instanceof Error && error.name === 'AbortError');
    if (cancelled) await operation.cancel(error instanceof Error ? error.message : 'Cancelled.');
    else await operation.fail(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    activeCliOperation = undefined;
    operation.dispose();
    if (cancelBrowserPromise) await cancelBrowserPromise;
    abortScope.dispose();
    if (ownsBrowser) await session?.close();
  }
}

async function previewOrApply(
  command: 'preview' | 'apply',
  planPath: string,
  options: {
    url?: string;
    headless: boolean;
    writeAccess: boolean;
    persistWrite: boolean;
    profile?: string;
  },
) {
  const raw = await readFile(path.resolve(planPath), 'utf8');
  const plan = JSON.parse(raw) as unknown;
  await withSession({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
    profile: options.profile,
  }, async (session) => {
    if (command === 'apply') {
      await waitForAgentIdle(session.page);
    }
    const result = await session.page.evaluate(async ({ commandName, planJson }) => {
      const api = window.foreScene;
      if (!api) throw new Error('window.foreScene is not available');
      if (commandName === 'preview') return api.previewPlan(planJson);
      await api.waitForIdle({ timeoutMs: 60_000 });
      return api.applyPlan(planJson);
    }, { commandName: command, planJson: plan });
    printJson(result);
    if (!result || typeof result !== 'object' || !('ok' in result) || !(result as { ok: boolean }).ok) {
      process.exitCode = 1;
    }
  });
}

async function runScreenshot(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  workspace?: string;
  output: string;
}) {
  await withSession(options, async (session) => {
    if (options.workspace) {
      await openWorkspace(session.page, options.workspace);
      await waitForAgentIdle(session.page);
    }
    const screenshot = await captureSceneScreenshot(session.page, options.output);
    printJson({
      ok: true,
      screenshot,
      workspace: options.workspace,
      status: await session.page.evaluate(() => window.foreScene!.getStatus()),
    });
  });
}

async function runVerify(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  workspace?: string;
  output?: string;
  shotIds?: string[];
}) {
  const visualInput = toVisualCollectionInput({
    explicit: options.shotIds !== undefined,
    shotIds: options.shotIds ?? [],
  });
  await withSession(options, async (session) => {
    if (options.workspace) {
      await openWorkspace(session.page, options.workspace);
      await waitForAgentIdle(session.page);
    }
    const inspection = await inspectViaBrowser(session.page);
    let screenshot: string | undefined;
    if (options.output) {
      screenshot = await captureSceneScreenshot(session.page, options.output);
    }
    const checks = await session.page.evaluate(async (input) => {
      const api = window.foreScene!;
      const collected = api.collectVisualPreflightValidation(input);
      const assetPoseContract = api.inspectAssetPoseContract();
      const health = await api.inspectProjectHealth();
      const validation = api.recordRunValidation({
        source: 'verify',
        revisionId: api.getStatus().revisionId,
        ...(collected.visualPreflight !== undefined ? { visualPreflight: collected.visualPreflight } : {}),
        ...(collected.selection.unmatchedShotIds.length > 0
          ? { unmatchedVisualShotIds: collected.selection.unmatchedShotIds }
          : {}),
        assetPose: assetPoseContract,
        projectHealth: health,
      });
      return {
        collected,
        visualPreflight: collected.visualPreflight ?? [],
        assetPoseContract,
        health,
        validation,
        provenance: api.getStatus().provenance,
      };
    }, visualInput);
    const failedPreflight = checks.visualPreflight.filter((item) => item.gateStatus === 'failed' || (!item.ok && item.gateStatus !== 'warning'));
    const warningPreflight = checks.visualPreflight.filter((item) => item.gateStatus === 'warning' || (!item.ok && item.gateStatus !== 'failed' && (item.unresolvedVisibleObjectIds?.length ?? 0) > 0));
    const ok = checks.collected.ok && checks.validation.ok;
    printJson({
      ok,
      project: inspection.project,
      objectCount: (inspection.objects as unknown[]).length,
      shotCount: (inspection.shots as unknown[]).length,
      screenshot,
      status: inspection.status,
      visualPreflight: checks.visualPreflight,
      unmatchedShotIds: checks.collected.selection.unmatchedShotIds,
      diagnostic: checks.collected.selection.diagnostic,
      assetPoseContract: checks.assetPoseContract,
      health: checks.health,
      validation: checks.validation,
      provenance: checks.provenance,
      failedShotIds: failedPreflight.map((item) => item.shotId),
      warningShotIds: warningPreflight.map((item) => item.shotId),
    });
    if (!ok) process.exitCode = 1;
  });
}

async function runPipeline(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  plan: string;
  screenshot?: string;
  workspace?: string;
}) {
  const raw = await readFile(path.resolve(options.plan), 'utf8');
  const plan = JSON.parse(raw) as unknown;

  await withSession({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
    profile: options.profile,
  }, async (session) => {
    const inspection = await inspectViaBrowser(session.page);
    const preview = await session.page.evaluate(async (planJson) => (
      window.foreScene!.previewPlan(planJson)
    ), plan);
    if (!preview.ok) {
      printJson({ ok: false, stage: 'preview', preview });
      process.exitCode = 1;
      return;
    }

    await waitForAgentIdle(session.page);
    const applied = await session.page.evaluate(async (planJson) => {
      await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
      return window.foreScene!.applyPlan(planJson);
    }, plan);
    if (!applied.ok) {
      printJson({ ok: false, stage: 'apply', applied });
      process.exitCode = 1;
      return;
    }

    await waitForAgentIdle(session.page);

    if (options.workspace) {
      await openWorkspace(session.page, options.workspace);
    }

    let screenshot: string | undefined;
    if (options.screenshot) {
      screenshot = await captureSceneScreenshot(session.page, options.screenshot);
    }

    printJson({
      ok: true,
      planId: applied.planId,
      verifiedRevisionId: applied.verifiedRevisionId,
      affectedObjects: applied.summary?.affectedObjectIds.length ?? 0,
      affectedShots: applied.summary?.affectedShotIds.length ?? 0,
      screenshot,
      inspectedProjectId: (inspection.project as { id?: string }).id,
      previewSummary: preview.summary,
    });
  });
}

async function runPackage(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  output?: string;
  shotIds?: string[];
}) {
  await withSession({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
    profile: options.profile,
  }, async (session) => {
    await waitForAgentIdle(session.page);
    const revision = await refreshAgentSessionRevision(session.page).catch(() => ({ revisionId: undefined }));
    printErr('[agent] starting package export…');

    const result = await session.page.evaluate(async (input) => {
      await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
      return window.foreScene!.exportPackage({
        shotIds: input.shotIds,
        download: false,
        expectedRevisionId: input.expectedRevisionId,
      });
    }, { shotIds: options.shotIds, expectedRevisionId: revision.revisionId });

    let savedPath: string | undefined;
    let transfer: AgentArtifactTransferTelemetry | undefined;
    if (options.output && result.ok && result.artifact?.artifactId) {
      const saved = await saveAgentArtifactToFile(session.page, result.artifact.artifactId, options.output);
      savedPath = saved.savedPath;
      transfer = toCliArtifactTransfer(saved);
      printErr(`[agent] saved package ${savedPath} (${transfer.transferMode}, ${transfer.pageMaterialization}, ${transfer.byteLength} bytes, ${transfer.chunkCount} chunks)`);
    } else if (options.output && result.ok && !result.artifact?.artifactId) {
      throw new Error('Package export reported success but no artifact handle was returned.');
    }

    printJson({
      ...result,
      savedPath,
      transfer,
      provenance: (await session.page.evaluate(() => window.foreScene!.getStatus())).provenance,
    });
    if (!result.ok) process.exitCode = 1;
  });
}

async function runVisualPreflight(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  shotIds?: string[];
}) {
  const visualInput = toVisualCollectionInput({
    explicit: options.shotIds !== undefined,
    shotIds: options.shotIds ?? [],
  });
  await withSession(options, async (session) => {
    const result = await session.page.evaluate((input) => {
      const api = window.foreScene!;
      const collected = api.collectVisualPreflightValidation(input);
      const validation = api.recordRunValidation({
        source: 'visual-preflight',
        revisionId: api.getStatus().revisionId,
        ...(collected.visualPreflight !== undefined ? { visualPreflight: collected.visualPreflight } : {}),
        ...(collected.selection.unmatchedShotIds.length > 0
          ? { unmatchedVisualShotIds: collected.selection.unmatchedShotIds }
          : {}),
      });
      return {
        ok: collected.ok && validation.ok,
        unmatchedShotIds: collected.selection.unmatchedShotIds,
        diagnostic: collected.selection.diagnostic,
        visualPreflight: collected.visualPreflight ?? [],
        validation,
        provenance: api.getStatus().provenance,
      };
    }, visualInput);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  });
}

async function runAssetContract(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  shotId?: string;
}) {
  await withSession(options, async (session) => {
    const result = await session.page.evaluate((shotId) => {
      const api = window.foreScene!;
      const assetPoseContract = api.inspectAssetPoseContract(shotId ? { shotId } : {});
      api.recordRunValidation({
        source: 'asset-contract',
        revisionId: api.getStatus().revisionId,
        assetPose: assetPoseContract,
      });
      return {
        ok: true,
        assetPoseContract,
        provenance: api.getStatus().provenance,
      };
    }, options.shotId);
    printJson(result);
  });
}

async function runGenerativeWorldBoundary(options: {
  command: 'world-preview' | 'world-mock';
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  requestedShots?: string[];
  output?: string;
}) {
  await withSession(options, async (session) => {
    const result = await session.page.evaluate(({ command, requestedShots }) => {
      const api = window.foreScene!;
      const summaries = api.listShots();
      let shotIds: string[] | undefined;
      if (requestedShots !== undefined) {
        const resolved: string[] = [];
        const unmatched: string[] = [];
        for (const requested of requestedShots) {
          const shot = summaries.find((candidate) => (
            candidate.id === requested || candidate.shotNumber === requested
          ));
          if (!shot) unmatched.push(requested);
          else if (!resolved.includes(shot.id)) resolved.push(shot.id);
        }
        if (requestedShots.length === 0 || unmatched.length > 0) {
          return {
            ok: false,
            diagnostics: [{
              severity: 'error' as const,
              code: 'target_not_found',
              message: requestedShots.length === 0
                ? 'An explicit shot selection cannot be empty.'
                : `Unknown shot id(s) or number(s): ${unmatched.join(', ')}.`,
            }],
          };
        }
        shotIds = resolved;
      }
      return command === 'world-preview'
        ? api.previewGenerativeWorldRequest({ shotIds })
        : api.runMockGenerativeWorldBackend({ shotIds });
    }, {
      command: options.command,
      requestedShots: options.requestedShots,
    });
    if (options.output) {
      const output = path.resolve(options.output);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      printJson({ ...result, output });
    } else {
      printJson(result);
    }
    if (!result.ok) process.exitCode = AGENT_CLI_EXIT.failure;
  });
}

async function runGenerativeWorldDepth(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  requestedShot: string;
  timeSeconds?: number;
  resolution?: string;
  output: string;
}) {
  const dimensions = resolveImageDimensions(options.resolution);
  await withSession(options, async (session) => {
    const result = await session.page.evaluate(async (input) => {
      const api = window.foreScene!;
      const shot = api.listShots().find((candidate) => (
        candidate.id === input.requestedShot || candidate.shotNumber === input.requestedShot
      ));
      if (!shot) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.requestedShot,
          revisionId: api.getStatus().revisionId,
          width: input.width ?? 0,
          height: input.height ?? 0,
          diagnostics: [{
            severity: 'error' as const,
            code: 'target_not_found',
            message: `Unknown shot id or number: ${input.requestedShot}.`,
          }],
        };
      }
      return api.renderGenerativeWorldDepthPrior({
        shotId: shot.id,
        timeSeconds: input.timeSeconds,
        width: input.width,
        height: input.height,
      });
    }, {
      requestedShot: options.requestedShot,
      timeSeconds: options.timeSeconds,
      ...dimensions,
    });
    let savedPath: string | undefined;
    let transfer: AgentArtifactTransferTelemetry | undefined;
    if (result.ok && 'artifact' in result && result.artifact?.artifactId) {
      const saved = await saveAgentArtifactToFile(session.page, result.artifact.artifactId, options.output);
      savedPath = saved.savedPath;
      transfer = toCliArtifactTransfer(saved);
    }
    printJson({ ...result, savedPath, transfer });
    if (!result.ok || !savedPath) process.exitCode = AGENT_CLI_EXIT.failure;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  activeCliCommand = args.command;
  cliStdout.operation = commandToOperationName(args.command);
  if (agentCliCommandRequiresProfile(args.command)) {
    args.profile = requireExplicitAgentProfile(args.profile);
    cliStdout.profile = args.profile;
  }
  printErr(
    `[agent] command=${args.command}`
    + (args.rigMode ? ` rigMode=${args.rigMode}` : '')
    + ((args.mode || args.appearance) ? ` appearance=${args.mode ?? args.appearance}` : ''),
  );

  if (args.command === 'capabilities') {
    printJson(buildAgentCliCapabilitiesDocument());
    return;
  }

  if (args.command === 'operations') {
    const records = await listCliOperationRecords();
    printJson({
      ok: true,
      operations: records,
      active: records.filter((record) => record.state === 'running' || record.state === 'progress' || record.state === 'accepted' || record.state === 'requested'),
    });
    return;
  }

  if (args.command === 'cancel') {
    const targetId = args.operation ?? (await latestActiveCliOperation())?.operationId;
    if (!targetId) {
      throw new AgentCliUsageError('cancel requires --operation <id>, or an active CLI operation to cancel.');
    }
    const result = await requestCliOperationCancel(targetId);
    printJson(result);
    if (!result.ok) process.exitCode = AGENT_CLI_EXIT.failure;
    return;
  }

  if (args.command === 'analyze-character') {
    if (!args.file) throw new Error('analyze-character requires --file <path>.');
    await runCharacterAnalysis({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      file: args.file,
      rigPackage: args.rigPackage,
      rigMode: args.rigMode,
      output: args.output,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'import-character') {
    if (!args.file) throw new Error('import-character requires --file <path>.');
    await runCharacterImport({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      file: args.file,
      rigPackage: args.rigPackage,
      mapping: args.mapping,
      rigMode: args.rigMode,
      name: args.name,
      consentToken: args.consentToken,
      allowHeavyCharacterImports: args.allowHeavyCharacterImports,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'import-panorama') {
    if (!args.file) throw new AgentCliUsageError('import-panorama requires --file <path>.');
    await runPanoramaImport({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      file: args.file,
      name: args.name,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'shot-panorama') {
    const usage = resolveCliCommandShotUsage('shot-panorama', args.shotSelection);
    if (args.pano === undefined) {
      throw new AgentCliUsageError('shot-panorama requires --pano <pano-id> or --pano null.');
    }
    await runShotPanorama({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      shotId: usage.shotId!,
      pano: args.pano,
    });
    return;
  }

  if (args.command === 'import-model') {
    if (!args.file) throw new Error('import-model requires --file <path>.');
    await runModelImport({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      file: args.file,
      consentToken: args.consentToken,
      allowHeavyModelImports: args.allowHeavyModelImports,
      output: args.output,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'replace-proxy') {
    if (!args.proxy) throw new Error('replace-proxy requires --proxy <object-id>.');
    if (!args.replacement) throw new Error('replace-proxy requires --replacement <object-id>.');
    if (args.shotSelection.shotIds.length === 0) throw new Error('replace-proxy requires --shots <shot-id-or-number,...>.');
    if (!args.output) throw new Error('replace-proxy requires --output <report.json>.');
    await runProxyReplacement({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      proxyObjectId: args.proxy,
      replacementObjectId: args.replacement,
      shotIds: args.shotSelection.shotIds,
      output: args.output,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'help') {
    const help = buildAgentCliHelpDocument();
    if (args.json) {
      printJson(help);
    } else {
      printErr('ForeScene Agent CLI — use --json for machine-readable help.');
      printErr(`Commands: ${help.commands.join(', ')}`);
      printErr('Discovery: npm run agent:capabilities');
      printErr('Checks: visual-preflight, asset-contract, verify (includes both + health + provenance)');
    }
    return;
  }

  if (args.command === 'inspect') {
    await withSession({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
    }, async (session) => {
      printErr(`[agent] connected ${session.url}`);
      printJson(await inspectViaBrowser(session.page, { includeDocument: args.document }));
    });
    return;
  }

  if (args.command === 'open') {
    if (!args.file) throw new AgentCliUsageError('open requires --file <path.fsp>.');
    await runOpenProject({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      file: args.file,
    });
    return;
  }

  if (args.command === 'save') {
    if (!args.output) throw new AgentCliUsageError('save requires --output <path.fsp>.');
    await runSaveProject({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      output: args.output,
    });
    return;
  }

  if (args.command === 'render-passes') {
    if (!args.output) throw new Error('render-passes requires --output <directory>.');
    await runRenderPasses({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      shotIds: args.shotSelection.shotIds,
      output: args.output,
    });
    return;
  }

  if (args.command === 'plan-exports') {
    if (!args.output) throw new Error('plan-exports requires --output <deliverables-plan.json>.');
    await runPlanExports({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      shotIds: args.shotSelection.shotIds,
      output: args.output,
    });
    return;
  }

  if (args.command === 'verify-package') {
    if (!args.plan) throw new Error('verify-package requires --plan <deliverables-plan.json>.');
    if (!args.packagePath) throw new Error('verify-package requires --package <package.zip>.');
    await runVerifyPackage({ plan: args.plan, packagePath: args.packagePath });
    return;
  }

  if (args.command === 'refine') {
    if (!args.plan) throw new Error('refine requires --plan <refinement-plan.json>.');
    if (!args.output) throw new Error('refine requires --output <directory>.');
    const result = await runRefinementCli({
      planPath: args.plan,
      batchId: args.batch,
      approveBatchId: args.approveBatch,
      semanticReviewPath: args.review,
      retryBatchId: args.retryBatch,
      rollbackBatchId: args.rollbackBatch,
      finalize: args.finalize,
      output: args.output,
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      allowHeavyCharacterImports: args.allowHeavyCharacterImports,
      allowHeavyModelImports: args.allowHeavyModelImports,
    });
    printJson(result);
    return;
  }

  if (args.command === 'preview' || args.command === 'apply') {
    if (!args.plan) throw new Error(`--plan is required for ${args.command}`);
    if (args.command === 'apply') {
      requireExplicitWrite('apply', args.writeAccess);
    }
    await previewOrApply(args.command, args.plan, {
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'screenshot') {
    if (!args.output) throw new Error('--output is required for screenshot');
    await runScreenshot({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      workspace: args.workspace,
      output: args.output,
    });
    return;
  }

  if (args.command === 'frame') {
    const usage = resolveCliCommandShotUsage('frame', args.shotSelection);
    if (!args.output) throw new AgentCliUsageError('--output is required for frame');
    const appearance = resolveRenderAppearance('frame', args.appearance, args.mode);
    cliStdout.operation = `render.frame.${appearance}`;
    await runFrame({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      shotId: usage.shotId!,
      timeSeconds: args.timeSeconds,
      appearance,
      peopleVariant: resolvePeopleVariant(args.peopleVariant),
      content: resolveFrameContent(args.content),
      output: args.output,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'video') {
    const usage = resolveCliCommandShotUsage('video', args.shotSelection);
    requireExplicitWrite('video', args.writeAccess);
    const appearance = resolveRenderAppearance('video', args.appearance, args.mode);
    cliStdout.operation = `render.video.${appearance}`;
    await runVideo({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      shotId: usage.shotId!,
      output: args.output,
      resolution: args.resolution,
      appearance,
      content: args.content,
      attachToShot: !args.noAttach,
      download: !args.noDownload,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'verify') {
    const usage = resolveCliCommandShotUsage('verify', args.shotSelection);
    await runVerify({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      workspace: args.workspace,
      output: args.output ?? args.screenshot,
      profile: args.profile,
      shotIds: usage.requestedShotIds,
    });
    return;
  }

  if (args.command === 'visual-preflight') {
    const usage = resolveCliCommandShotUsage('visual-preflight', args.shotSelection);
    await runVisualPreflight({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      shotIds: usage.requestedShotIds,
    });
    return;
  }

  if (args.command === 'asset-contract') {
    const usage = resolveCliCommandShotUsage('asset-contract', args.shotSelection);
    await runAssetContract({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      shotId: usage.shotId,
    });
    return;
  }

  if (args.command === 'world-preview' || args.command === 'world-mock') {
    await runGenerativeWorldBoundary({
      command: args.command,
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      requestedShots: toOptionalRequestedShotIds(args.shotSelection),
      output: args.output,
    });
    return;
  }

  if (args.command === 'world-depth') {
    const usage = resolveCliCommandShotUsage('world-depth', args.shotSelection);
    if (!args.output) throw new AgentCliUsageError('world-depth requires --output <depth.npy>.');
    await runGenerativeWorldDepth({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      requestedShot: usage.shotId!,
      timeSeconds: args.timeSeconds,
      resolution: args.resolution,
      output: args.output,
    });
    return;
  }

  if (args.command === 'run') {
    if (!args.plan) throw new Error('--plan is required for run');
    requireExplicitWrite('run', args.writeAccess);
    await runPipeline({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      plan: args.plan,
      screenshot: args.screenshot ?? args.output,
      workspace: args.workspace ?? 'shots',
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'package') {
    requireExplicitWrite('package', args.writeAccess);
    await runPackage({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      profile: args.profile,
      output: args.output,
      shotIds: toOptionalRequestedShotIds(args.shotSelection),
    });
    return;
  }

  if (args.command === 'production') {
    if (!args.manifest) throw new Error('--manifest is required for production');
    if (args.resetProject) {
      requireExplicitWrite('production --reset-project', args.writeAccess);
    }
    const mode = args.mode === 'delivery' || args.mode === 'previs'
      ? args.mode
      : 'rapid-review';
    if (process.env.FORESCENE_BENCHMARK === '1' && process.env.FORESCENE_BENCHMARK_PROJECT_PACKAGE) {
      // Benchmark setup is part of this single documented candidate command.
      // It opens the frozen base once, then the production run owns all model
      // mutations and exports in the same isolated profile.
      await runOpenProject({
        url: args.url,
        headless: args.headless,
        writeAccess: args.writeAccess,
        persistWrite: args.persistWrite,
        profile: args.profile,
        file: process.env.FORESCENE_BENCHMARK_PROJECT_PACKAGE,
      });
    }
    let cancellationObserved = false;
    const productionOperation = beginCliOperation({
      type: commandToOperationName('production'),
      profile: args.profile,
      message: 'Production orchestration requested.',
      onCancel: () => { cancellationObserved = true; },
    });
    cliStdout.operationId = productionOperation.record.operationId;
    activeCliOperation = productionOperation;
    await productionOperation.start('Production orchestration in progress.');
    try {
      const result = await runProduction({
        manifestPath: args.manifest,
        url: args.url,
        headless: args.headless || process.env.CI === 'true' || !process.stdout.isTTY,
        writeAccess: args.writeAccess,
        persistWrite: args.persistWrite,
        resetProject: args.resetProject,
        updateManifest: args.updateManifest,
        initializeOnly: args.initializeOnly,
        outputDir: args.output ?? 'artifacts/production',
        skipPackage: args.skipPackage,
        profileDir: args.profile,
        allowHeavyCharacterImports: args.allowHeavyCharacterImports,
        mode,
        autoRepair: args.autoRepair,
        maxRepairPasses: args.maxRepairPasses,
        timeBudgetSeconds: args.timeBudgetSeconds,
        finalProjectPath: args.finalProject,
      });
      if (cancellationObserved || productionOperation.record.cancelRequested) {
        await productionOperation.cancel('Production cancellation was requested.');
      } else if (result.ok) {
        await productionOperation.complete(`Production ${result.status}.`);
      } else {
        await productionOperation.fail(result.error ?? `Production ${result.status}.`);
      }
      printJson(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      await productionOperation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (activeCliOperation === productionOperation) activeCliOperation = undefined;
      productionOperation.dispose();
    }
    return;
  }

  if (args.command === 'previs') {
    if (!args.manifest) throw new Error('--manifest is required for previs');
    if (args.resetProject) {
      requireExplicitWrite('previs --reset-project', args.writeAccess);
    }
    const result = await runPrevisCli({
      manifestPath: args.manifest,
      url: args.url,
      headless: args.headless || process.env.CI === 'true' || !process.stdout.isTTY,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      resetProject: args.resetProject,
      updateManifest: args.updateManifest,
      initializeOnly: args.initializeOnly,
      outputDir: args.output ?? 'artifacts/previs',
      skipPackage: args.skipPackage,
      profileDir: args.profile,
      allowHeavyCharacterImports: args.allowHeavyCharacterImports,
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === 'render-stills') {
    requireExplicitWrite('render-stills', args.writeAccess);
    const result = await runRenderStillsCli({
      url: args.url,
      headless: args.headless || process.env.CI === 'true' || !process.stdout.isTTY,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      outputDir: args.output ?? 'artifacts/previs',
      profileDir: args.profile,
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === 'contact-sheet') {
    if (!args.input) throw new Error('--input is required for contact-sheet');
    if (!args.output) throw new Error('--output is required for contact-sheet');
    const result = await runContactSheetCli({
      inputDir: args.input,
      outputPath: args.output,
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  throw new AgentCliUsageError(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  const { envelope, exitCode } = envelopeFromError(cliStdout, error);
  printErr(`[agent] ${envelope.error?.message ?? 'Command failed.'}`);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  process.exitCode = exitCode;
});
