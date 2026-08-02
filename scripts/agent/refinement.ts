/** Resumable, preservation-guarded refinement workflow for existing projects. */

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocationProject } from '../../src/domain/types';
import {
  canApproveBatch,
  canFinalizeRefinement,
  canRunBatch,
  captureRefinementSnapshot,
  checkReviewMatrix,
  compareRefinementSnapshot,
  createRefinementState,
  parseRefinementPlan,
  type RefinementPlan,
  type RefinementState,
} from '../../src/engine/agent/refinement';
import { createProxyReplacementPlan, verifyProxyReplacement } from '../../src/engine/agent/proxyReplacement';
import { verifyPackageAgainstExportPlan } from '../../src/engine/agent/packageVerification';
import { openAgentBrowser, waitForAgentIdle, type AgentBrowserSession } from './browser';

const REVIEW_PASSES = [
  { fileName: 'clay_with-characters.png', appearance: 'clay', peopleVariant: 'with_people', content: 'full_scene' },
  { fileName: 'clay_clean-plate.png', appearance: 'clay', peopleVariant: 'clean_plate', content: 'full_scene' },
  { fileName: 'projected_with-characters.png', appearance: 'projected', peopleVariant: 'with_people', content: 'full_scene' },
  { fileName: 'projected_clean-plate.png', appearance: 'projected', peopleVariant: 'clean_plate', content: 'full_scene' },
  { fileName: 'characters-only.png', appearance: 'clay', peopleVariant: 'with_people', content: 'characters_only' },
  { fileName: 'depth.png', appearance: 'depth', peopleVariant: 'with_people', content: 'full_scene' },
] as const;

export interface RefinementCliOptions {
  planPath: string;
  batchId?: string;
  approveBatchId?: string;
  finalize: boolean;
  output: string;
  url?: string;
  headless: boolean;
  writeAccess: boolean;
  persistWrite: boolean;
  profile?: string;
  allowHeavyCharacterImports: boolean;
  allowHeavyModelImports: boolean;
}

interface ResolvedShot {
  id: string;
  shotNumber: string;
}

function dataUrlBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Agent frame response did not contain a data URL.');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

function now(): string {
  return new Date().toISOString();
}

function statePath(outputRoot: string): string {
  return path.join(outputRoot, 'refinement-state.json');
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true).catch(() => false);
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function loadState(target: string): Promise<RefinementState | undefined> {
  if (!await exists(target)) return undefined;
  return JSON.parse(await readFile(target, 'utf8')) as RefinementState;
}

async function withSession<T>(options: RefinementCliOptions, run: (session: AgentBrowserSession) => Promise<T>): Promise<T> {
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

async function resolveShots(session: AgentBrowserSession, requested: readonly string[]): Promise<ResolvedShot[]> {
  const available = await session.page.evaluate(() => window.foreScene!.listShots());
  const resolved = requested.map((identifier) => available.find((shot) => shot.id === identifier || shot.shotNumber === identifier));
  const missing = requested.filter((identifier, index) => !resolved[index]);
  if (missing.length > 0) throw new Error(`Unknown shot id or number: ${missing.join(', ')}.`);
  return resolved as ResolvedShot[];
}

async function readProject(session: AgentBrowserSession): Promise<LocationProject> {
  return session.page.evaluate(() => window.foreScene!.getProjectDocument());
}

function assertPreserved(plan: RefinementPlan, state: RefinementState, project: LocationProject): void {
  const comparison = compareRefinementSnapshot(state.preservation, project, plan.preserve);
  if (!comparison.ok) throw new Error(`Preservation check failed: ${comparison.errors.join(' ')}`);
}

async function importCharacter(
  session: AgentBrowserSession,
  entry: RefinementPlan['characterImports'][number],
  options: RefinementCliOptions,
) {
  const source = path.resolve(entry.file);
  const rig = entry.rigPackage ? path.resolve(entry.rigPackage) : undefined;
  await session.page.locator('[data-agent-character-import-input]').setInputFiles(source);
  if (rig) await session.page.locator('[data-agent-character-rig-package-input]').setInputFiles(rig);
  const result = await session.page.evaluate(async (input) => {
    const sourceInput = document.querySelector('[data-agent-character-import-input]') as HTMLInputElement | null;
    const sourceFile = sourceInput?.files?.[0];
    if (!sourceFile) throw new Error('Character file was not staged in the browser.');
    if (input.rigMode === 'saved-rig') {
      const rigInput = document.querySelector('[data-agent-character-rig-package-input]') as HTMLInputElement | null;
      const rigFile = rigInput?.files?.[0];
      if (!rigFile) throw new Error('Saved-rig package was not staged in the browser.');
      return window.foreScene!.importSavedRigCharacter({
        sourceFile,
        rigPackageFile: rigFile,
        name: input.name ?? sourceFile.name.replace(/\.(glb|gltf|fbx)$/i, ''),
        consentToken: input.consentToken,
      });
    }
    const analysisMode = input.rigMode === 'preserve' ? 'preserveExistingRig' : input.rigMode;
    const analysis = await window.foreScene!.analyzeCharacterImport({ file: sourceFile, mode: analysisMode });
    const mode = input.rigMode === 'auto'
      ? (analysis.hasSkeleton && analysis.hasSkinning && analysis.requiredMissing.length === 0 ? 'preserveExistingRig' : 'autorig')
      : analysisMode;
    return window.foreScene!.importCharacter({
      analysisId: analysis.analysisId,
      mode: mode as 'preserveExistingRig' | 'autorig',
      name: input.name,
      consentToken: input.consentToken,
    });
  }, {
    rigMode: entry.rigMode ?? (rig ? 'saved-rig' : 'auto'),
    name: entry.name,
    consentToken: options.allowHeavyCharacterImports ? 'allow-heavy-character-imports' : undefined,
  });
  if (!result.ok || !result.objectId) {
    throw new Error(`Character import ${entry.id} failed: ${result.diagnostics?.map((item) => item.message).join('; ') ?? 'no object id returned'}`);
  }
  await waitForAgentIdle(session.page);
  return result;
}

async function importModel(
  session: AgentBrowserSession,
  entry: RefinementPlan['modelImports'][number],
  options: RefinementCliOptions,
) {
  await session.page.locator('[data-agent-model-import-input]').setInputFiles(path.resolve(entry.file));
  const result = await session.page.evaluate(async (input) => {
    const sourceInput = document.querySelector('[data-agent-model-import-input]') as HTMLInputElement | null;
    const file = sourceInput?.files?.[0];
    if (!file) throw new Error('Model file was not staged in the browser.');
    return window.foreScene!.importModel({ file, mode: 'separate', consentToken: input.consentToken });
  }, { consentToken: options.allowHeavyModelImports ? 'allow-heavy-model-imports' : undefined });
  if (!result.ok || !result.objectRefs || result.objectRefs.length === 0) {
    throw new Error(`Model import ${entry.id} failed: ${result.diagnostics?.map((item) => item.message).join('; ') ?? 'no object ids returned'}`);
  }
  await waitForAgentIdle(session.page);
  return result;
}

async function replaceProxy(
  session: AgentBrowserSession,
  entry: RefinementPlan['proxyReplacements'][number],
  replacementObjectId: string,
) {
  const before = await session.page.evaluate(() => {
    const project = window.foreScene!.getProjectDocument();
    const shots = project.shots.map((shot) => window.foreScene!.getShotDocument({ id: shot.id }));
    return { ...project, shots };
  });
  const plan = createProxyReplacementPlan({
    project: before,
    shotDocuments: before.shots,
    proxyObjectId: entry.proxyObjectId,
    replacementObjectId,
    requestedShotIds: entry.shots,
  });
  if (!plan.ok) throw new Error(`Replacement ${entry.id} cannot be planned: ${plan.errors.join(' ')}`);
  const preview = await session.page.evaluate((nextPlan) => window.foreScene!.previewPlan(nextPlan), plan.plan);
  if (!preview.ok) throw new Error(`Replacement ${entry.id} preview failed: ${preview.diagnostics.map((item) => item.message).join('; ')}`);
  const apply = await session.page.evaluate(async (nextPlan) => window.foreScene!.applyPlan(nextPlan), plan.plan);
  if (!apply.ok) throw new Error(`Replacement ${entry.id} apply failed: ${apply.diagnostics.map((item) => item.message).join('; ')}`);
  await waitForAgentIdle(session.page);
  const after = await session.page.evaluate(() => {
    const project = window.foreScene!.getProjectDocument();
    return { ...project, shots: project.shots.map((shot) => window.foreScene!.getShotDocument({ id: shot.id })) };
  });
  const verification = verifyProxyReplacement({
    beforeProject: before,
    afterProject: after,
    proxyObjectId: entry.proxyObjectId,
    replacementObjectId,
    affectedShots: plan.affectedShots,
  });
  if (!verification.ok) throw new Error(`Replacement ${entry.id} verification failed: ${verification.errors.join(' ')}`);
  return { plan, preview, apply, verification };
}

async function renderReviewMatrix(session: AgentBrowserSession, shots: ResolvedShot[], outputRoot: string) {
  const report: {
    ok: boolean;
    generatedAt: string;
    shots: Array<{ id: string; shotNumber: string; passes: Array<Record<string, unknown>> }>;
  } = { ok: true, generatedAt: now(), shots: [] };
  for (const shot of shots) {
    const passes: Array<Record<string, unknown>> = [];
    for (const pass of REVIEW_PASSES) {
      const result = await session.page.evaluate((input) => window.foreScene!.renderShotFrame(input), { shotId: shot.id, ...pass });
      if (!result.ok || !result.pngDataUrl) {
        report.ok = false;
        passes.push({ ...pass, ok: false, diagnostics: result.diagnostics ?? [] });
        continue;
      }
      const bytes = dataUrlBytes(result.pngDataUrl);
      const output = path.join(outputRoot, shot.shotNumber, pass.fileName);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes);
      passes.push({
        ...pass,
        ok: true,
        output,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        source: result.source,
        pixelStats: result.pixelStats,
        depth: result.depth,
      });
    }
    report.shots.push({ ...shot, passes });
  }
  const manifestPath = path.join(outputRoot, 'review-manifest.json');
  await writeJson(manifestPath, report);
  return { report, manifestPath };
}

async function renderTemporalSamples(session: AgentBrowserSession, shots: ResolvedShot[], outputRoot: string) {
  const samples: Array<Record<string, unknown>> = [];
  for (const shot of shots) {
    const timeline = await session.page.evaluate((id) => window.foreScene!.inspectShotTimeline({ id }), shot.id);
    if (!timeline.renderable) continue;
    for (const [label, timeSeconds] of [['start', 0], ['mid', timeline.durationSeconds / 2], ['end', timeline.durationSeconds]] as const) {
      const frame = await session.page.evaluate((input) => window.foreScene!.renderShotFrame(input), {
        shotId: shot.id, timeSeconds, appearance: 'clay', peopleVariant: 'with_people', content: 'full_scene',
      } as const);
      if (!frame.ok || !frame.pngDataUrl) throw new Error(`Temporal ${label} render failed for shot ${shot.shotNumber}.`);
      const output = path.join(outputRoot, shot.shotNumber, 'temporal', `${label}.png`);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, dataUrlBytes(frame.pngDataUrl));
      samples.push({ shotId: shot.id, shotNumber: shot.shotNumber, label, timeSeconds, output, source: frame.source });
    }
    const videoOutput = path.join(outputRoot, shot.shotNumber, 'temporal', 'motion-preview.mp4');
    const downloadPromise = session.page.waitForEvent('download', { timeout: 600_000 }).catch(() => null);
    const video = await session.page.evaluate((input) => window.foreScene!.renderShotVideo(input), {
      shotId: shot.id,
      mode: 'quickPreview',
      resolutionPreset: '720p',
      appearance: 'clay',
      contentMode: 'full_scene',
      attachToShot: false,
      download: true,
    } as const);
    if (!video.ok) throw new Error(`Motion video render failed for shot ${shot.shotNumber}: ${video.diagnostics.map((item) => item.message).join('; ')}`);
    const download = await downloadPromise;
    if (!download) throw new Error(`Motion video render for shot ${shot.shotNumber} did not produce a download.`);
    await download.saveAs(videoOutput);
    samples.push({ shotId: shot.id, shotNumber: shot.shotNumber, label: 'motion-video', output: videoOutput, mimeType: video.mimeType, durationSeconds: video.durationSeconds });
  }
  return samples;
}

async function filesInReviewManifestExist(manifest: unknown): Promise<string[]> {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray((manifest as { shots?: unknown[] }).shots)) return ['Review manifest has no shots.'];
  const missing: string[] = [];
  for (const shot of (manifest as { shots: Array<{ passes?: Array<{ ok?: boolean; output?: string; fileName?: string }> }> }).shots) {
    for (const pass of shot.passes ?? []) {
      if (pass.ok && pass.output && !await exists(pass.output)) missing.push(pass.output);
    }
  }
  return missing;
}

async function approveBatch(plan: RefinementPlan, state: RefinementState, batchId: string, session: AgentBrowserSession): Promise<void> {
  const errors = canApproveBatch(plan, state, batchId);
  if (errors.length > 0) throw new Error(errors.join(' '));
  const batch = plan.batches.find((candidate) => candidate.id === batchId)!;
  const shots = await resolveShots(session, batch.shots);
  const manifestPath = state.batches[batchId]!.reviewManifestPath;
  if (!manifestPath || !await exists(manifestPath)) throw new Error(`Batch ${batchId} review manifest is missing.`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const review = checkReviewMatrix(manifest, shots.map((shot) => shot.id));
  if (!review.ok) throw new Error(`Batch ${batchId} cannot be approved: ${review.errors.join(' ')}`);
  const filesMissing = await filesInReviewManifestExist(manifest);
  if (filesMissing.length > 0) throw new Error(`Batch ${batchId} review files are missing: ${filesMissing.join(', ')}`);
  const generatedAt = (manifest as { generatedAt?: string }).generatedAt;
  if (!generatedAt || generatedAt < (state.batches[batchId]!.mutationCompletedAt ?? '')) {
    throw new Error(`Batch ${batchId} review manifest is older than its mutations.`);
  }
  assertPreserved(plan, state, await readProject(session));
  state.batches[batchId]!.status = 'approved';
  state.batches[batchId]!.approvedAt = now();
}

async function finalize(plan: RefinementPlan, state: RefinementState, options: RefinementCliOptions, outputRoot: string, session: AgentBrowserSession) {
  const gate = canFinalizeRefinement(plan, state);
  if (gate.length > 0) throw new Error(gate.join(' '));
  assertPreserved(plan, state, await readProject(session));
  const visibleProxies = await session.page.evaluate((replacements) => {
    const api = window.foreScene!;
    const project = api.getProjectDocument();
    const visible: string[] = [];
    for (const replacement of replacements) {
      const proxy = project.scene.objects.find((object) => object.id === replacement.proxyObjectId);
      if (proxy?.visible) visible.push(replacement.proxyObjectId);
      for (const shot of project.shots) {
        const document = api.getShotDocument({ id: shot.id });
        const shotVisible = document.objectOverrides?.[replacement.proxyObjectId]?.visible ?? proxy?.visible ?? false;
        if (shotVisible) visible.push(`${replacement.proxyObjectId}@${shot.id}`);
        for (const keyframe of document.cameraKeyframes) {
          const keyframeVisible = keyframe.objectOverrides?.[replacement.proxyObjectId]?.visible ?? proxy?.visible ?? false;
          if (keyframeVisible) visible.push(`${replacement.proxyObjectId}@${shot.id}:${keyframe.id}`);
        }
      }
    }
    return [...new Set(visible)];
  }, state.replacements);
  if (visibleProxies.length > 0) throw new Error(`Visible proxies prevent finalization: ${visibleProxies.join(', ')}`);

  const planResult = await session.page.evaluate(() => window.foreScene!.createExportPlan());
  if (!planResult.ok || !planResult.plan) throw new Error(`Final export plan failed: ${planResult.diagnostics.map((item) => item.message).join('; ')}`);
  const exportPlanPath = path.join(outputRoot, 'final-export-plan.json');
  await writeJson(exportPlanPath, planResult);
  const packagePath = path.join(outputRoot, 'final-package.zip');
  const downloadPromise = session.page.waitForEvent('download', { timeout: 300_000 }).catch(() => null);
  const exported = await session.page.evaluate(() => window.foreScene!.exportPackage());
  if (!exported.ok) throw new Error(`Final package export failed: ${exported.diagnostics.map((item) => item.message).join('; ')}`);
  const download = await downloadPromise;
  if (!download) throw new Error('Final package export reported success but no browser download was received.');
  await download.saveAs(packagePath);
  const verification = await verifyPackageAgainstExportPlan(planResult, new Blob([await readFile(packagePath)]));
  const finalProject = await readProject(session);
  assertPreserved(plan, state, finalProject);
  state.finalization = {
    completedAt: now(),
    productionComplete: verification.ok,
    packagePath,
    verification: { ok: verification.ok, missingCount: verification.missing.length },
  };
  await writeJson(path.join(outputRoot, 'finalization-report.json'), {
    ok: verification.ok,
    preservation: compareRefinementSnapshot(state.preservation, finalProject, plan.preserve),
    exportPlanPath,
    packagePath,
    verification,
  });
  if (!verification.ok) throw new Error(`Final package omitted ${verification.missing.length} planned artifacts.`);
}

/** Entry point used by `agent:refine`. It writes state only after each durable checkpoint. */
export async function runRefinementCli(options: RefinementCliOptions): Promise<{ ok: boolean; output: string; statePath: string }> {
  const outputRoot = path.resolve(options.output);
  const raw = JSON.parse(await readFile(path.resolve(options.planPath), 'utf8')) as unknown;
  const parsed = parseRefinementPlan(raw);
  if (!parsed.ok) throw new Error(`Invalid refinement plan: ${parsed.errors.join(' ')}`);
  const plan = parsed.plan;
  if (Number(Boolean(options.batchId)) + Number(Boolean(options.approveBatchId)) + Number(options.finalize) !== 1) {
    throw new Error('agent:refine requires exactly one of --batch, --approve <batch>, or --finalize.');
  }
  if ((options.batchId || options.finalize) && !options.writeAccess) {
    throw new Error('agent:refine mutation and finalization require --write or --persist-write.');
  }
  const stateTarget = statePath(outputRoot);
  return withSession(options, async (session) => {
    await waitForAgentIdle(session.page);
    let state = await loadState(stateTarget);
    if (!state) {
      if (!options.batchId) throw new Error('No refinement state exists. Start the first batch before approval or finalization.');
      state = createRefinementState(plan, await readProject(session));
      await writeJson(stateTarget, state);
    }
    if (options.approveBatchId) {
      await approveBatch(plan, state, options.approveBatchId, session);
      await writeJson(stateTarget, state);
      return { ok: true, output: outputRoot, statePath: stateTarget };
    }
    if (options.finalize) {
      await finalize(plan, state, options, outputRoot, session);
      await writeJson(stateTarget, state);
      return { ok: true, output: outputRoot, statePath: stateTarget };
    }

    const batchId = options.batchId!;
    const gate = canRunBatch(plan, state, batchId);
    if (gate.length > 0) throw new Error(gate.join(' '));
    const batch = plan.batches.find((candidate) => candidate.id === batchId)!;
    const shots = await resolveShots(session, batch.shots);
    assertPreserved(plan, state, await readProject(session));
    const report: Record<string, unknown> = { ok: false, batchId, startedAt: now(), previewedMutations: [] as unknown[] };
    try {
      const modelImports = plan.modelImports.filter((entry) => entry.batchId === batchId);
      for (const entry of modelImports) {
        (report.previewedMutations as unknown[]).push({ id: entry.id, kind: 'model-import', file: path.resolve(entry.file), preflight: 'browser model import plan' });
        const result = await importModel(session, entry, options);
        state.imports[entry.id] = { kind: 'model', objectIds: result.objectRefs!.map((ref) => ref.id), completedAt: now() };
        assertPreserved(plan, state, await readProject(session));
      }
      const characterImports = plan.characterImports.filter((entry) => entry.batchId === batchId);
      for (const entry of characterImports) {
        (report.previewedMutations as unknown[]).push({ id: entry.id, kind: 'character-import', file: path.resolve(entry.file), preflight: 'rig compatibility analysis' });
        const result = await importCharacter(session, entry, options);
        state.imports[entry.id] = { kind: 'character', objectIds: [result.objectId!], completedAt: now() };
        assertPreserved(plan, state, await readProject(session));
      }
      for (const entry of plan.proxyReplacements.filter((candidate) => candidate.batchId === batchId)) {
        if (!entry.shots.every((id) => batch.shots.includes(id))) {
          throw new Error(`Replacement ${entry.id} includes a shot outside batch ${batchId}.`);
        }
        const imported = entry.replacementImportId ? state.imports[entry.replacementImportId] : undefined;
        const replacementObjectId = entry.replacementObjectId ?? (() => {
          if (!imported || imported.kind !== 'model' || imported.objectIds.length !== 1) {
            throw new Error(`Replacement ${entry.id} requires model import ${entry.replacementImportId} to produce exactly one object.`);
          }
          return imported.objectIds[0]!;
        })();
        const result = await replaceProxy(session, entry, replacementObjectId);
        state.replacements.push({
          id: entry.id,
          batchId,
          proxyObjectId: entry.proxyObjectId,
          replacementObjectId,
          affectedShotIds: result.plan.affectedShots.map((shot) => shot.id),
          workUnits: result.plan.plan.commands.length,
          verified: result.verification.ok,
        });
        (report.previewedMutations as unknown[]).push({ id: entry.id, kind: 'proxy-replacement', preview: result.preview.summary });
        assertPreserved(plan, state, await readProject(session));
      }
      state.batches[batchId]!.mutationCompletedAt = now();
      const reviews = await renderReviewMatrix(session, shots, path.join(outputRoot, 'reviews', batchId));
      const temporal = await renderTemporalSamples(session, shots, path.join(outputRoot, 'reviews', batchId));
      state.batches[batchId]!.reviewManifestPath = reviews.manifestPath;
      state.batches[batchId]!.status = reviews.report.ok ? 'awaiting_visual_review' : 'failed';
      report.reviewManifestPath = reviews.manifestPath;
      report.temporalSamples = temporal;
      report.preservation = compareRefinementSnapshot(state.preservation, await readProject(session), plan.preserve);
      report.ok = reviews.report.ok && (report.preservation as { ok: boolean }).ok;
      if (!report.ok) state.batches[batchId]!.failure = 'Review matrix or preservation verification failed.';
    } catch (error) {
      state.batches[batchId]!.status = 'failed';
      state.batches[batchId]!.failure = error instanceof Error ? error.message : 'Unknown refinement failure.';
      report.error = state.batches[batchId]!.failure;
    }
    report.completedAt = now();
    await writeJson(path.join(outputRoot, `batch-${batchId}-report.json`), report);
    await writeJson(stateTarget, state);
    if (report.ok !== true) throw new Error(String(report.error ?? state.batches[batchId]!.failure));
    return { ok: true, output: outputRoot, statePath: stateTarget };
  });
}
