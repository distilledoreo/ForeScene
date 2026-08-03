#!/usr/bin/env tsx
/**
 * ForeScene Agent CLI — Playwright host for window.foreScene.
 *
 * Usage:
 *   npm run agent:inspect
 *   npm run agent:preview -- --plan plans/example.json
 *   npm run agent:apply -- --plan plans/example.json --write
 *   npm run agent:screenshot -- --workspace shots --output artifacts/shot.png
 *   npm run agent:run -- --plan plans/example.json --screenshot artifacts/out.png --write
 *   npm run agent:package -- --write --output artifacts/package.zip
 *   npm run agent:analyze-character -- --file actor.glb --rig-package actor.fsrig --rig-mode saved-rig
 *   npm run agent:import-character -- --file actor.glb --rig-package actor.fsrig --rig-mode saved-rig --name "Actor" --write
 *   npm run agent:import-model -- --file set.glb --write
 *   npm run agent:replace-proxy -- --proxy proxy-id --replacement model-id --shots 08,09 --output artifacts/refinement/swap.json --write
 *   npm run agent:render-passes -- --shots 01,02 --output artifacts/reviews/batch-01
 *   npm run agent:plan-exports -- --shots 01,02 --output artifacts/preflight/deliverables-plan.json
 *   npm run agent:verify-package -- --plan artifacts/preflight/deliverables-plan.json --package artifacts/package.zip
 *   npm run agent:refine -- --plan production/refinement-plan.json --batch batch-01 --write --output artifacts/refinement
 *   npm run agent:previs -- --manifest examples/previs/minimal-dialogue.json --write --reset-project --output artifacts/previs
 *   npm run agent:render-stills -- --output artifacts/previs
 *   npm run agent:contact-sheet -- --input artifacts/previs/shots --output artifacts/previs/contact-sheet.png
 *
 * Write commands require explicit `--write` (session) or `--persist-write` (profile).
 * Project reset additionally requires `--reset-project`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openAgentBrowser, waitForAgentIdle, type AgentBrowserSession } from './browser';
import { inspectViaBrowser } from './inspect';
import { captureSceneScreenshot, openWorkspace } from './screenshot';
import { runContactSheetCli, runPrevisCli, runRenderStillsCli } from './previs';
import {
  createProxyReplacementPlan,
  verifyProxyReplacement,
} from '../../src/engine/agent/proxyReplacement';
import { verifyPackageAgainstExportPlan } from '../../src/engine/agent/packageVerification';
import { runRefinementCli } from './refinement';

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv: string[]) {
  const args = {
    command: argv[0] ?? 'inspect',
    plan: undefined as string | undefined,
    manifest: undefined as string | undefined,
    url: undefined as string | undefined,
    headless: false,
    writeAccess: false,
    persistWrite: false,
    resetProject: false,
    updateManifest: false,
    initializeOnly: false,
    skipPackage: false,
    workspace: undefined as string | undefined,
    output: undefined as string | undefined,
    packagePath: undefined as string | undefined,
    screenshot: undefined as string | undefined,
    input: undefined as string | undefined,
    file: undefined as string | undefined,
    rigPackage: undefined as string | undefined,
    proxy: undefined as string | undefined,
    replacement: undefined as string | undefined,
    mapping: undefined as string | undefined,
    rigMode: 'preserve' as 'preserve' | 'autorig' | 'auto' | 'saved-rig',
    name: undefined as string | undefined,
    consentToken: undefined as string | undefined,
    profile: undefined as string | undefined,
    shotIds: [] as string[],
    timeSeconds: undefined as number | undefined,
    resolution: undefined as string | undefined,
    appearance: undefined as string | undefined,
    content: undefined as string | undefined,
    noAttach: false,
    noDownload: false,
    allowHeavyCharacterImports: false,
    allowHeavyModelImports: false,
    batch: undefined as string | undefined,
    approveBatch: undefined as string | undefined,
    review: undefined as string | undefined,
    retryBatch: undefined as string | undefined,
    rollbackBatch: undefined as string | undefined,
    finalize: false,
    json: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--plan') {
      args.plan = argv[++index];
    } else if (token === '--manifest') {
      args.manifest = argv[++index];
    } else if (token === '--url') {
      args.url = argv[++index];
    } else if (token === '--headless') {
      args.headless = true;
    } else if (token === '--write') {
      args.writeAccess = true;
    } else if (token === '--persist-write') {
      args.persistWrite = true;
      args.writeAccess = true;
    } else if (token === '--reset-project') {
      args.resetProject = true;
    } else if (token === '--update-manifest') {
      args.updateManifest = true;
    } else if (token === '--allow-heavy-character-imports') {
      args.allowHeavyCharacterImports = true;
    } else if (token === '--allow-heavy-imports') {
      args.allowHeavyModelImports = true;
    } else if (token === '--initialize-only') {
      args.initializeOnly = true;
    } else if (token === '--skip-package') {
      args.skipPackage = true;
    } else if (token === '--workspace') {
      args.workspace = argv[++index];
    } else if (token === '--output') {
      args.output = argv[++index];
    } else if (token === '--package') {
      args.packagePath = argv[++index];
    } else if (token === '--screenshot') {
      args.screenshot = argv[++index];
    } else if (token === '--input') {
      args.input = argv[++index];
    } else if (token === '--file') {
      args.file = argv[++index];
    } else if (token === '--rig-package') {
      args.rigPackage = argv[++index];
    } else if (token === '--proxy') {
      args.proxy = argv[++index];
    } else if (token === '--replacement') {
      args.replacement = argv[++index];
    } else if (token === '--mapping') {
      args.mapping = argv[++index];
    } else if (token === '--rig-mode') {
      const mode = argv[++index];
      if (mode !== 'preserve' && mode !== 'autorig' && mode !== 'auto' && mode !== 'saved-rig') {
        throw new Error('--rig-mode must be preserve, autorig, auto, or saved-rig');
      }
      args.rigMode = mode;
    } else if (token === '--name') {
      args.name = argv[++index];
    } else if (token === '--consent-token') {
      args.consentToken = argv[++index];
    } else if (token === '--profile') {
      args.profile = argv[++index];
    } else if (token === '--batch') {
      args.batch = argv[++index];
    } else if (token === '--approve') {
      args.approveBatch = argv[++index];
    } else if (token === '--review') {
      args.review = argv[++index];
    } else if (token === '--retry') {
      args.retryBatch = argv[++index];
    } else if (token === '--rollback') {
      args.rollbackBatch = argv[++index];
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--finalize') {
      args.finalize = true;
    } else if (token === '--shot') {
      const shotId = argv[++index];
      if (shotId) args.shotIds.push(shotId);
    } else if (token === '--shots') {
      const shotList = argv[++index];
      if (shotList) args.shotIds.push(...shotList.split(',').map((item) => item.trim()).filter(Boolean));
    } else if (token === '--time') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value)) throw new Error('--time must be a finite number');
      args.timeSeconds = value;
    } else if (token === '--resolution') {
      args.resolution = argv[++index];
    } else if (token === '--appearance') {
      args.appearance = argv[++index];
    } else if (token === '--content') {
      args.content = argv[++index];
    } else if (token === '--no-attach') {
      args.noAttach = true;
    } else if (token === '--no-download') {
      args.noDownload = true;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown flag: ${token}`);
    }
  }

  return args;
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
    const result = await session.page.evaluate(async (input) => {
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
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
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
  shotId: string;
  timeSeconds?: number;
  output: string;
}) {
  await withSession(options, async (session) => {
    const result = await session.page.evaluate(async (input) => (
      window.foreScene!.renderShotFrame({ shotId: input.shotId, timeSeconds: input.timeSeconds, appearance: 'clay' })
    ), { shotId: options.shotId, timeSeconds: options.timeSeconds });
    if (!result.ok || !result.pngDataUrl) {
      printJson(result);
      process.exitCode = 1;
      return;
    }
    const comma = result.pngDataUrl.indexOf(',');
    if (comma < 0) throw new Error('Agent frame response did not contain a data URL.');
    const target = path.resolve(options.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(result.pngDataUrl.slice(comma + 1), 'base64'));
    printJson({ ...result, pngDataUrl: undefined, output: target });
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
    const downloadPromise = options.download && options.output
      ? session.page.waitForEvent('download', { timeout: 600_000 })
      : null;
    const result = await session.page.evaluate(async (input) => (
      window.foreScene!.renderShotVideo({
        shotId: input.shotId,
        resolutionPreset: input.resolution as '720p' | '1080p' | '4k' | undefined,
        appearance: input.appearance as 'clay' | 'projected' | 'depth' | undefined,
        contentMode: input.content as 'full_scene' | 'clean_plate' | 'characters_only' | undefined,
        attachToShot: input.attachToShot,
        download: input.download,
      })
    ), { ...options, content: contentMode });
    let savedPath: string | undefined;
    if (downloadPromise && result.ok) {
      const download = await downloadPromise;
      savedPath = path.resolve(options.output!);
      await mkdir(path.dirname(savedPath), { recursive: true });
      await download.saveAs(savedPath);
    }
    printJson({ ...result, savedPath });
    if (!result.ok) process.exitCode = 1;
  });
}

function requireExplicitWrite(command: string, writeAccess: boolean): void {
  if (!writeAccess) {
    throw new Error(
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
  },
  run: (session: AgentBrowserSession) => Promise<T>,
): Promise<T> {
  const session = await openAgentBrowser({
    url: options.url,
    headless: options.headless || process.env.CI === 'true' || !process.stdout.isTTY,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
    profileDir: options.profile,
  });
  try {
    return await run(session);
  } finally {
    await session.close();
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
  workspace?: string;
  output?: string;
}) {
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
    printJson({
      ok: true,
      project: inspection.project,
      objectCount: (inspection.objects as unknown[]).length,
      shotCount: (inspection.shots as unknown[]).length,
      screenshot,
      status: inspection.status,
    });
  });
}

async function runPipeline(options: {
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
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
  shotIds: string[];
}) {
  await withSession({
    url: options.url,
    headless: options.headless,
    writeAccess: options.writeAccess,
    persistWrite: options.persistWrite,
    profile: options.profile,
  }, async (session) => {
    await waitForAgentIdle(session.page);
    printErr('[agent] starting package export…');

    const downloadPromise = options.output
      ? session.page.waitForEvent('download', { timeout: 300_000 }).catch(() => null)
      : null;

    const result = await session.page.evaluate(async (input) => {
      await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
      return window.foreScene!.exportPackage({
        shotIds: input.shotIds.length > 0 ? input.shotIds : undefined,
        download: true,
      });
    }, { shotIds: options.shotIds });

    let savedPath: string | undefined;
    if (downloadPromise && result.ok) {
      const download = await downloadPromise;
      if (!download) throw new Error('Package export reported success but the browser download was not received.');
      const target = path.resolve(options.output!);
      await mkdir(path.dirname(target), { recursive: true });
      await download.saveAs(target);
      savedPath = target;
      printErr(`[agent] saved package ${target}`);
    }

    printJson({
      ...result,
      savedPath,
    });
    if (!result.ok) process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  printErr(`[agent] command=${args.command}`);

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
    if (args.shotIds.length === 0) throw new Error('replace-proxy requires --shots <shot-id-or-number,...>.');
    if (!args.output) throw new Error('replace-proxy requires --output <report.json>.');
    await runProxyReplacement({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      proxyObjectId: args.proxy,
      replacementObjectId: args.replacement,
      shotIds: args.shotIds,
      output: args.output,
      profile: args.profile,
    });
    return;
  }

  if (args.command === 'help') {
    if (args.json) {
      printJson({
        commands: [
          'inspect', 'preview', 'apply', 'screenshot', 'frame', 'video', 'package',
          'verify', 'run', 'previs', 'render-stills', 'contact-sheet', 'help',
        ],
        discovery: {
          describeCapabilities: 'window.foreScene.describeCapabilities()',
          describeOperation: 'window.foreScene.describeOperation(name)',
          getAgentSchema: 'window.foreScene.getAgentSchema()',
        },
        artifactRetrieval: {
          renderShotFrame: 'result.artifact (inline dataUrl) + result.status',
          renderShotVideo: 'result.artifact.artifactId → downloadArtifact({ artifactId })',
          exportPackage: 'result.artifact.artifactId → downloadArtifact({ artifactId })',
          exportProjectBackup: 'window.foreScene.exportProjectBackup()',
        },
      });
    } else {
      printErr('ForeScene Agent CLI — use --json for machine-readable help.');
      printErr('Discovery: window.foreScene.describeCapabilities()');
      printErr('Schema: window.foreScene.getAgentSchema()');
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
      printJson(await inspectViaBrowser(session.page));
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
      shotIds: args.shotIds,
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
      shotIds: args.shotIds,
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
    const shotId = args.shotIds[0];
    if (!shotId) throw new Error('--shot is required for frame');
    if (!args.output) throw new Error('--output is required for frame');
    await runFrame({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      shotId,
      timeSeconds: args.timeSeconds,
      output: args.output,
    });
    return;
  }

  if (args.command === 'video') {
    const shotId = args.shotIds[0];
    if (!shotId) throw new Error('--shot is required for video');
    requireExplicitWrite('video', args.writeAccess);
    await runVideo({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      shotId,
      output: args.output,
      resolution: args.resolution,
      appearance: args.appearance,
      content: args.content,
      attachToShot: !args.noAttach,
      download: !args.noDownload,
    });
    return;
  }

  if (args.command === 'verify') {
    await runVerify({
      url: args.url,
      headless: args.headless,
      writeAccess: args.writeAccess,
      persistWrite: args.persistWrite,
      workspace: args.workspace,
      output: args.output ?? args.screenshot,
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
      shotIds: args.shotIds,
    });
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

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  printErr(`[agent] ${message}`);
  printJson({
    ok: false,
    error: message,
  });
  process.exitCode = 1;
});
