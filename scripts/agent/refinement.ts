/** Resumable, preservation-guarded refinement workflow for existing projects. */

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocationProject } from '../../src/domain/types';
import {
  canApproveBatch,
  canFinalizeRefinement,
  canRunBatch,
  buildRefinementReviewCriteria,
  checkSemanticReview,
  captureRefinementSnapshot,
  checkReviewMatrix,
  checkRefinementDeliverables,
  compareRefinementSnapshot,
  createRefinementState,
  listRefinementVisibilityTargets,
  listAuthorizedRefinementValueChanges,
  parseRefinementPlan,
  resolveRefinementDeliverablesProfile,
  resolveRefinementFinalizationScope,
  resolveReviewedShotIds,
  type RefinementPlan,
  type RefinementState,
} from '../../src/engine/agent/refinement';
import { verifyPackageAgainstExportPlan } from '../../src/engine/agent/packageVerification';
import { projectFingerprint } from '../../src/engine/agent/planDiff';
import type { ForeSceneAgentPlan } from '../../src/engine/agent/protocol';
import { openAgentBrowser, waitForAgentIdle, type AgentBrowserSession } from './browser';
import { saveAgentArtifactToFile, toCliArtifactTransfer } from './artifactIo';

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
  semanticReviewPath?: string;
  retryBatchId?: string;
  rollbackBatchId?: string;
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

interface TemporalArtifactEvidence {
  fileName: string;
  output: string;
  sha256: string;
  durationSeconds?: number;
  transfer?: {
    transferMode: string;
    pageMaterialization: string;
    byteLength: number;
    chunkCount: number;
  };
}

interface TemporalEvidence {
  renderable: boolean;
  start?: TemporalArtifactEvidence;
  mid?: TemporalArtifactEvidence;
  end?: TemporalArtifactEvidence;
  video?: TemporalArtifactEvidence;
}

interface TemporalShotEvidence {
  shotId: string;
  shotNumber: string;
  temporal: TemporalEvidence;
}

interface ReviewEvidenceVerification {
  errors: string[];
  artifactCount: number;
}

function dataUrlBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Agent frame response did not contain a data URL.');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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

async function assertRefinementShotCoverage(session: AgentBrowserSession, plan: RefinementPlan): Promise<void> {
  const batchShotIds = new Set((await Promise.all(plan.batches.map((batch) => resolveShots(session, batch.shots))))
    .flatMap((shots) => shots.map((shot) => shot.id)));
  for (const entry of [...plan.proxyReplacements, ...plan.characterAssignments]) {
    const unresolved = (await resolveShots(session, entry.shots)).filter((shot) => !batchShotIds.has(shot.id));
    if (unresolved.length > 0) {
      throw new Error(`Refinement ${entry.id} includes shots outside the configured batches: ${unresolved.map((shot) => shot.shotNumber).join(', ')}.`);
    }
  }
}

async function readProject(session: AgentBrowserSession): Promise<LocationProject> {
  return session.page.evaluate(() => window.foreScene!.getProjectDocument());
}

/** Preview then apply narrowly-scoped object metadata updates. */
async function applyObjectUpdates(
  session: AgentBrowserSession,
  description: string,
  updates: Array<{ id: string; updates: Record<string, unknown> }>,
): Promise<void> {
  if (updates.length === 0) return;
  const project = await readProject(session);
  const plan: ForeSceneAgentPlan = {
    version: 1,
    planId: `refinement-${description.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    description,
    expectedFingerprint: projectFingerprint(project),
    commands: updates.map((entry) => ({ op: 'object.update' as const, object: { id: entry.id }, updates: entry.updates })),
  };
  const preview = await session.page.evaluate((candidate) => window.foreScene!.previewPlan(candidate), plan);
  if (!preview.ok) throw new Error(`${description} preview failed: ${preview.diagnostics.map((item) => item.message).join('; ')}`);
  const applied = await session.page.evaluate((candidate) => window.foreScene!.applyPlan(candidate), plan);
  if (!applied.ok) throw new Error(`${description} apply failed: ${applied.diagnostics.map((item) => item.message).join('; ')}`);
  await waitForAgentIdle(session.page);
}

async function applyDeliverablesProfile(session: AgentBrowserSession, profileId: string): Promise<void> {
  const profile = resolveRefinementDeliverablesProfile(profileId);
  if (!profile) throw new Error(`Unknown refinement deliverablesProfile: ${profileId}.`);
  const project = await readProject(session);
  const plan: ForeSceneAgentPlan = {
    version: 1,
    planId: `refinement-deliverables-${profile.id}`,
    description: `Apply refinement deliverables profile ${profile.id}`,
    expectedFingerprint: projectFingerprint(project),
    commands: [{ op: 'export.sceneDefaults.patch', patch: profile.patch }],
  };
  const preview = await session.page.evaluate((candidate) => window.foreScene!.previewPlan(candidate), plan);
  if (!preview.ok) throw new Error(`Deliverables profile ${profile.id} preview failed: ${preview.diagnostics.map((item) => item.message).join('; ')}`);
  const applied = await session.page.evaluate((candidate) => window.foreScene!.applyPlan(candidate), plan);
  if (!applied.ok) throw new Error(`Deliverables profile ${profile.id} apply failed: ${applied.diagnostics.map((item) => item.message).join('; ')}`);
  await waitForAgentIdle(session.page);
}

async function applyConfiguredCastRoles(session: AgentBrowserSession, plan: RefinementPlan, state: RefinementState): Promise<void> {
  const configured = plan.subjectObjectIds ?? [];
  if (configured.length === 0) return;
  const project = await readProject(session);
  const objectIds = new Set<string>();
  for (const identifier of configured) {
    if (state.imports[identifier]) state.imports[identifier]!.objectIds.forEach((id) => objectIds.add(id));
    if (project.scene.objects.some((object) => object.id === identifier)) objectIds.add(identifier);
  }
  await applyObjectUpdates(session, 'Classify configured subjects', [...objectIds].map((id) => ({ id, updates: { stagingRole: 'person' } })));
}

function assertPreserved(plan: RefinementPlan, state: RefinementState, project: LocationProject): void {
  const comparison = compareRefinementSnapshot(state.preservation, project, plan.preserve, plan.allowMutations);
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
  mode: 'combined' | 'separate',
) {
  await session.page.locator('[data-agent-model-import-input]').setInputFiles(path.resolve(entry.file));
  const result = await session.page.evaluate(async (input) => {
    const sourceInput = document.querySelector('[data-agent-model-import-input]') as HTMLInputElement | null;
    const file = sourceInput?.files?.[0];
    if (!file) throw new Error('Model file was not staged in the browser.');
    return window.foreScene!.importModel({ file, mode: input.mode, consentToken: input.consentToken });
  }, { mode, consentToken: options.allowHeavyModelImports ? 'allow-heavy-model-imports' : undefined });
  if (!result.ok || !result.objectRefs || result.objectRefs.length === 0) {
    throw new Error(`Model import ${entry.id} failed: ${result.diagnostics?.map((item) => item.message).join('; ') ?? 'no object ids returned'}`);
  }
  await waitForAgentIdle(session.page);
  return result;
}

async function replaceProxy(
  session: AgentBrowserSession,
  entry: { id: string; proxyObjectId: string; shots: readonly string[] },
  replacementObjectId: string,
  requestedShotIds: readonly string[],
  initializeVisibility: boolean,
) {
  const verified = await session.page.evaluate((input) => window.foreScene!.applyVerifiedProxyReplacement(input), {
    proxyObjectId: entry.proxyObjectId,
    replacementObjectId,
    requestedShotIds: [...requestedShotIds],
    intendedShotIds: [...entry.shots],
    initializeVisibility,
    description: `Replace proxy for refinement entry ${entry.id}`,
  });
  if (!verified.ok || !verified.plan || !verified.preview || !verified.verification) {
    const rollback = verified.rollback?.diagnostics.map((item) => item.message).join('; ');
    throw new Error(`Replacement ${entry.id} failed verification: ${[
      ...verified.diagnostics.map((item) => item.message),
      ...(rollback ? [`Rollback: ${rollback}`] : []),
    ].join('; ')}`);
  }
  const plan = {
    plan: verified.plan,
    preparedShots: verified.preparedShots ?? [],
    affectedShots: verified.affectedShots ?? [],
  };
  const preview = verified.preview;
  const apply = verified.apply;
  if (!apply.ok) throw new Error(`Replacement ${entry.id} apply failed: ${apply.diagnostics.map((item) => item.message).join('; ')}`);
  await waitForAgentIdle(session.page);
  return { plan, preview, apply, verification: verified.verification };
}

async function renderReviewMatrix(
  session: AgentBrowserSession,
  plan: RefinementPlan,
  shots: ResolvedShot[],
  outputRoot: string,
  authorizedMutations: ReturnType<typeof listAuthorizedRefinementValueChanges>,
  temporalEvidence: readonly TemporalShotEvidence[],
) {
  const report: {
    ok: boolean;
    generatedAt: string;
    shots: Array<{ id: string; shotNumber: string; requiredCriteria: ReturnType<typeof buildRefinementReviewCriteria>; passes: Array<Record<string, unknown>>; temporal: TemporalEvidence }>;
    authorizedMutations: ReturnType<typeof listAuthorizedRefinementValueChanges>;
  } = { ok: true, generatedAt: now(), shots: [], authorizedMutations };
  const temporalByShot = new Map(temporalEvidence.map((evidence) => [evidence.shotId, evidence.temporal]));
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
    const temporal = temporalByShot.get(shot.id) ?? { renderable: false };
    report.shots.push({
      ...shot,
      requiredCriteria: buildRefinementReviewCriteria(plan, shot, temporal.renderable, authorizedMutations),
      passes,
      temporal,
    });
  }
  const manifestPath = path.join(outputRoot, 'review-manifest.json');
  await writeJson(manifestPath, report);
  return { report, manifestPath, manifestSha256: sha256(await readFile(manifestPath)) };
}

async function renderTemporalSamples(
  session: AgentBrowserSession,
  shots: ResolvedShot[],
  outputRoot: string,
): Promise<TemporalShotEvidence[]> {
  const samples: TemporalShotEvidence[] = [];
  for (const shot of shots) {
    const timeline = await session.page.evaluate((id) => window.foreScene!.inspectShotTimeline({ id }), shot.id);
    if (!timeline.renderable) {
      samples.push({ shotId: shot.id, shotNumber: shot.shotNumber, temporal: { renderable: false } });
      continue;
    }
    const temporal: TemporalEvidence = { renderable: true };
    for (const [label, timeSeconds] of [['start', 0], ['mid', timeline.durationSeconds / 2], ['end', timeline.durationSeconds]] as const) {
      const frame = await session.page.evaluate((input) => window.foreScene!.renderShotFrame(input), {
        shotId: shot.id, timeSeconds, appearance: 'clay', peopleVariant: 'with_people', content: 'full_scene',
      } as const);
      if (!frame.ok || !frame.pngDataUrl) throw new Error(`Temporal ${label} render failed for shot ${shot.shotNumber}.`);
      const output = path.join(outputRoot, shot.shotNumber, 'temporal', `${label}.png`);
      await mkdir(path.dirname(output), { recursive: true });
      const bytes = dataUrlBytes(frame.pngDataUrl);
      await writeFile(output, bytes);
      temporal[label] = {
        fileName: `temporal/${label}.png`,
        output,
        sha256: sha256(bytes),
      };
    }
    const videoOutput = path.join(outputRoot, shot.shotNumber, 'temporal', 'motion-preview.mp4');
    const video = await session.page.evaluate((input) => window.foreScene!.renderShotVideo(input), {
      shotId: shot.id,
      mode: 'quickPreview',
      resolutionPreset: '720p',
      appearance: 'clay',
      contentMode: 'full_scene',
      attachToShot: false,
      download: false,
    } as const);
    if (!video.ok) throw new Error(`Motion video render failed for shot ${shot.shotNumber}: ${video.diagnostics.map((item) => item.message).join('; ')}`);
    if (!video.artifact?.artifactId) throw new Error(`Motion video render for shot ${shot.shotNumber} did not produce an artifact handle.`);
    const savedVideo = await saveAgentArtifactToFile(session.page, video.artifact.artifactId, videoOutput);
    const videoBytes = await readFile(videoOutput);
    temporal.video = {
      fileName: 'temporal/motion-preview.mp4',
      output: videoOutput,
      sha256: sha256(videoBytes),
      durationSeconds: video.durationSeconds ?? timeline.durationSeconds,
      transfer: toCliArtifactTransfer(savedVideo),
    };
    samples.push({ shotId: shot.id, shotNumber: shot.shotNumber, temporal });
  }
  return samples;
}

async function verifyReviewEvidenceOnDisk(manifest: unknown): Promise<ReviewEvidenceVerification> {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray((manifest as { shots?: unknown[] }).shots)) {
    return { errors: ['Review manifest has no shots.'], artifactCount: 0 };
  }
  const errors: string[] = [];
  let artifactCount = 0;
  const verify = async (shotId: string, label: string, artifact: unknown) => {
    const value = artifact as { output?: unknown; sha256?: unknown } | null;
    if (!value || typeof value.output !== 'string' || typeof value.sha256 !== 'string') {
      errors.push(`Review evidence ${label} for shot ${shotId} is missing its output or SHA-256.`);
      return;
    }
    artifactCount += 1;
    let bytes: Buffer;
    try {
      bytes = await readFile(value.output);
    } catch {
      errors.push(`Review evidence file is missing: ${value.output}.`);
      return;
    }
    if (bytes.length === 0) {
      errors.push(`Review evidence file is empty: ${value.output}.`);
      return;
    }
    const actual = sha256(bytes);
    if (actual !== value.sha256) {
      errors.push(`Review evidence hash does not match ${label} for shot ${shotId}.`);
    }
  };
  for (const shot of (manifest as { shots: Array<{ id?: unknown; passes?: unknown[]; temporal?: unknown }> }).shots) {
    const shotId = typeof shot.id === 'string' ? shot.id : '<unknown>';
    for (const pass of shot.passes ?? []) {
      const value = pass as { ok?: unknown; fileName?: unknown };
      if (value.ok === true) await verify(shotId, typeof value.fileName === 'string' ? value.fileName : 'still pass', pass);
    }
    const temporal = shot.temporal as { renderable?: unknown; [key: string]: unknown } | undefined;
    if (temporal?.renderable === true) {
      for (const key of ['start', 'mid', 'end', 'video']) await verify(shotId, `temporal ${key}`, temporal[key]);
    }
  }
  return { errors, artifactCount };
}

async function approveBatch(
  plan: RefinementPlan,
  state: RefinementState,
  batchId: string,
  semanticReviewPath: string | undefined,
  session: AgentBrowserSession,
): Promise<void> {
  const errors = canApproveBatch(plan, state, batchId);
  if (errors.length > 0) throw new Error(errors.join(' '));
  const batch = plan.batches.find((candidate) => candidate.id === batchId)!;
  const shots = await resolveShots(session, batch.shots);
  const manifestPath = state.batches[batchId]!.reviewManifestPath;
  if (!manifestPath || !await exists(manifestPath)) throw new Error(`Batch ${batchId} review manifest is missing.`);
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  const recordedManifestSha256 = state.batches[batchId]!.reviewManifestSha256;
  if (recordedManifestSha256 && recordedManifestSha256 !== manifestSha256) {
    throw new Error(`Batch ${batchId} review manifest bytes changed after rendering.`);
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  const review = checkReviewMatrix(manifest, shots.map((shot) => shot.id));
  if (!review.ok) throw new Error(`Batch ${batchId} cannot be approved: ${review.errors.join(' ')}`);
  if (!semanticReviewPath) {
    throw new Error(`Batch ${batchId} requires --review <semantic-review.json> for approval.`);
  }
  const semanticPath = path.resolve(semanticReviewPath);
  if (!await exists(semanticPath)) throw new Error(`Batch ${batchId} semantic review is missing: ${semanticPath}.`);
  const semanticBytes = await readFile(semanticPath);
  const semanticSha256 = sha256(semanticBytes);
  const semantic = JSON.parse(semanticBytes.toString('utf8')) as unknown;
  const semanticCheck = checkSemanticReview(semantic, manifest, shots.map((shot) => shot.id), manifestSha256);
  if (!semanticCheck.ok) throw new Error(`Batch ${batchId} semantic review failed: ${semanticCheck.errors.join(' ')}`);
  const evidence = await verifyReviewEvidenceOnDisk(manifest);
  if (evidence.errors.length > 0) throw new Error(`Batch ${batchId} review evidence failed: ${evidence.errors.join(' ')}`);
  const generatedAt = (manifest as { generatedAt?: string }).generatedAt;
  if (!generatedAt || generatedAt < (state.batches[batchId]!.mutationCompletedAt ?? '')) {
    throw new Error(`Batch ${batchId} review manifest is older than its mutations.`);
  }
  assertPreserved(plan, state, await readProject(session));
  const criterionIds = [...new Set((manifest as { shots: Array<{ requiredCriteria?: Array<{ id?: unknown }> }> }).shots
    .flatMap((shot) => (shot.requiredCriteria ?? []).map((criterion) => criterion.id))
    .filter((id): id is string => typeof id === 'string'))].sort();
  const approvalRecordPath = path.join(path.dirname(manifestPath), 'approval-record.json');
  const approvalRecord = {
    schemaVersion: 1,
    batchId,
    approvedAt: now(),
    manifestSha256,
    semanticReviewSha256: semanticSha256,
    shotIds: shots.map((shot) => shot.id),
    criterionIds,
    artifactCount: evidence.artifactCount,
  };
  await writeJson(approvalRecordPath, approvalRecord);
  const approvalRecordSha256 = sha256(await readFile(approvalRecordPath));
  state.batches[batchId]!.status = 'approved';
  state.batches[batchId]!.semanticReviewPath = semanticPath;
  state.batches[batchId]!.semanticReviewSha256 = semanticSha256;
  state.batches[batchId]!.reviewManifestSha256 = manifestSha256;
  state.batches[batchId]!.approvalRecordPath = approvalRecordPath;
  state.batches[batchId]!.approvalRecordSha256 = approvalRecordSha256;
  state.batches[batchId]!.approvedAt = now();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}

async function verifyApprovedBatchEvidence(
  plan: RefinementPlan,
  state: RefinementState,
  batchId: string,
): Promise<void> {
  const batchState = state.batches[batchId]!;
  const expectedShotIds = batchState.resolvedShotIds ?? [];
  if (!batchState.reviewManifestPath || !batchState.semanticReviewPath || !batchState.approvalRecordPath
    || !batchState.reviewManifestSha256 || !batchState.semanticReviewSha256 || !batchState.approvalRecordSha256) {
    throw new Error(`Approved batch ${batchId} is missing its immutable approval record.`);
  }
  if (!await exists(batchState.reviewManifestPath) || !await exists(batchState.semanticReviewPath) || !await exists(batchState.approvalRecordPath)) {
    throw new Error(`Approved batch ${batchId} is missing referenced review evidence.`);
  }
  const manifestBytes = await readFile(batchState.reviewManifestPath);
  const semanticBytes = await readFile(batchState.semanticReviewPath);
  const approvalBytes = await readFile(batchState.approvalRecordPath);
  const manifestSha256 = sha256(manifestBytes);
  const semanticReviewSha256 = sha256(semanticBytes);
  const approvalRecordSha256 = sha256(approvalBytes);
  if (manifestSha256 !== batchState.reviewManifestSha256 || semanticReviewSha256 !== batchState.semanticReviewSha256
    || approvalRecordSha256 !== batchState.approvalRecordSha256) {
    throw new Error(`Approved batch ${batchId} evidence bytes no longer match its approval record.`);
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  const semantic = JSON.parse(semanticBytes.toString('utf8')) as unknown;
  const approvalRecord = JSON.parse(approvalBytes.toString('utf8')) as {
    schemaVersion?: unknown;
    batchId?: unknown;
    manifestSha256?: unknown;
    semanticReviewSha256?: unknown;
    shotIds?: unknown;
    criterionIds?: unknown;
    artifactCount?: unknown;
  };
  const approvalErrors: string[] = [];
  if (approvalRecord.schemaVersion !== 1 || approvalRecord.batchId !== batchId) approvalErrors.push('approval record identity is invalid');
  if (approvalRecord.manifestSha256 !== manifestSha256) approvalErrors.push('manifest hash is not bound');
  if (approvalRecord.semanticReviewSha256 !== semanticReviewSha256) approvalErrors.push('semantic review hash is not bound');
  if (!Array.isArray(approvalRecord.shotIds) || !sameStringSet(approvalRecord.shotIds.filter((id): id is string => typeof id === 'string'), expectedShotIds)) {
    approvalErrors.push('reviewed shot ids are not bound');
  }
  const criterionIds = [...new Set((manifest as { shots: Array<{ requiredCriteria?: Array<{ id?: unknown }> }> }).shots
    .flatMap((shot) => (shot.requiredCriteria ?? []).map((criterion) => criterion.id))
    .filter((id): id is string => typeof id === 'string'))].sort();
  if (!Array.isArray(approvalRecord.criterionIds) || !sameStringSet(approvalRecord.criterionIds.filter((id): id is string => typeof id === 'string'), criterionIds)) {
    approvalErrors.push('criterion ids are not bound');
  }
  const matrix = checkReviewMatrix(manifest, expectedShotIds);
  if (!matrix.ok) approvalErrors.push(...matrix.errors);
  const semanticCheck = checkSemanticReview(semantic, manifest, expectedShotIds, manifestSha256);
  if (!semanticCheck.ok) approvalErrors.push(...semanticCheck.errors);
  const evidence = await verifyReviewEvidenceOnDisk(manifest);
  if (approvalRecord.artifactCount !== evidence.artifactCount) approvalErrors.push('artifact count is not bound');
  approvalErrors.push(...evidence.errors);
  if (approvalErrors.length > 0) throw new Error(`Approved batch ${batchId} evidence is no longer valid: ${approvalErrors.join(' ')}`);
}

async function finalize(plan: RefinementPlan, state: RefinementState, options: RefinementCliOptions, outputRoot: string, session: AgentBrowserSession) {
  const gate = canFinalizeRefinement(plan, state);
  if (gate.length > 0) throw new Error(gate.join(' '));
  for (const batch of plan.batches) await verifyApprovedBatchEvidence(plan, state, batch.id);
  assertPreserved(plan, state, await readProject(session));
  const scope = resolveRefinementFinalizationScope(plan);
  const reviewedShotIds = resolveReviewedShotIds(plan, state);
  const project = await readProject(session);
  const projectShotIds = project.shots.map((shot) => shot.id);
  const missingReviewedShotIds = projectShotIds.filter((shotId) => !reviewedShotIds.includes(shotId));
  const extraReviewedShotIds = reviewedShotIds.filter((shotId) => !projectShotIds.includes(shotId));
  if (scope === 'entire_project' && (missingReviewedShotIds.length > 0 || extraReviewedShotIds.length > 0)) {
    throw new Error(`Entire-project finalization requires approved review for every project shot. Missing: ${missingReviewedShotIds.join(', ') || 'none'}; extra: ${extraReviewedShotIds.join(', ') || 'none'}.`);
  }
  if (reviewedShotIds.length === 0) throw new Error('Finalization requires at least one approved reviewed shot.');
  const selectedShotIds = scope === 'entire_project' ? projectShotIds : reviewedShotIds;
  const visibleProxies = await session.page.evaluate((visibilityTargets) => {
    const api = window.foreScene!;
    const project = api.getProjectDocument();
    const visible: string[] = [];
    for (const target of visibilityTargets) {
      const proxy = project.scene.objects.find((object) => object.id === target.proxyObjectId);
      if (proxy?.visible) visible.push(target.proxyObjectId);
      for (const shot of project.shots) {
        const document = api.getShotDocument({ id: shot.id });
        const shotVisible = document.objectOverrides?.[target.proxyObjectId]?.visible ?? proxy?.visible ?? false;
        if (shotVisible) visible.push(`${target.proxyObjectId}@${shot.id}`);
        for (const keyframe of document.cameraKeyframes) {
          const keyframeVisible = keyframe.objectOverrides?.[target.proxyObjectId]?.visible ?? proxy?.visible ?? false;
          if (keyframeVisible) visible.push(`${target.proxyObjectId}@${shot.id}:${keyframe.id}`);
        }
      }
    }
    return [...new Set(visible)];
  }, listRefinementVisibilityTargets(state));
  if (visibleProxies.length > 0) throw new Error(`Visible proxies prevent finalization: ${visibleProxies.join(', ')}`);

  await applyDeliverablesProfile(session, plan.deliverablesProfile);
  const packageType: 'current-shot' | 'selected-shots' = selectedShotIds.length === 1 ? 'current-shot' : 'selected-shots';
  const planResult = await session.page.evaluate((input) => window.foreScene!.createExportPlan(input), {
    shotIds: selectedShotIds,
    packageType,
  });
  if (!planResult.ok || !planResult.plan) throw new Error(`Final export plan failed: ${planResult.diagnostics.map((item) => item.message).join('; ')}`);
  const plannedShotIds = planResult.plan.shots.map((shot) => shot.shotId);
  if (plannedShotIds.length !== selectedShotIds.length || plannedShotIds.some((shotId, index) => shotId !== selectedShotIds[index])) {
    throw new Error(`Final export plan shot scope mismatch. Requested ${selectedShotIds.join(', ')}; planned ${plannedShotIds.join(', ')}.`);
  }
  const profile = resolveRefinementDeliverablesProfile(plan.deliverablesProfile)!;
  const deliverableErrors = checkRefinementDeliverables(profile, planResult.plan);
  if (deliverableErrors.length > 0) throw new Error(deliverableErrors.join(' '));
  const exportPlanPath = path.join(outputRoot, 'final-export-plan.json');
  await writeJson(exportPlanPath, planResult);
  const packagePath = path.join(outputRoot, 'final-package.zip');
  const exported = await session.page.evaluate((input) => window.foreScene!.exportPackage(input), {
    shotIds: selectedShotIds,
    packageType,
    download: false,
  });
  if (!exported.ok) throw new Error(`Final package export failed: ${exported.diagnostics.map((item) => item.message).join('; ')}`);
  const exportedShotIds = exported.shotIds ?? [];
  const unreviewedExportedShotIds = exportedShotIds.filter((shotId) => !reviewedShotIds.includes(shotId));
  const reviewedButUnexportedShotIds = reviewedShotIds.filter((shotId) => !exportedShotIds.includes(shotId));
  if (unreviewedExportedShotIds.length > 0 || reviewedButUnexportedShotIds.length > 0) {
    throw new Error(`Final export shot scope mismatch. Unreviewed exports: ${unreviewedExportedShotIds.join(', ') || 'none'}; reviewed but unexported: ${reviewedButUnexportedShotIds.join(', ') || 'none'}.`);
  }
  if (!exported.artifact?.artifactId) throw new Error('Final package export reported success but no artifact handle was returned.');
  const savedPackage = await saveAgentArtifactToFile(session.page, exported.artifact.artifactId, packagePath);
  const packageTransfer = toCliArtifactTransfer(savedPackage);
  const verification = await verifyPackageAgainstExportPlan(planResult, new Blob([await readFile(packagePath)]));
  const finalProject = await readProject(session);
  assertPreserved(plan, state, finalProject);
  state.finalization = {
    scope,
    reviewedShotIds,
    plannedShotIds,
    exportedShotIds,
    unreviewedExportedShotIds,
    reviewedButUnexportedShotIds,
    completedAt: now(),
    productionComplete: verification.ok
      && unreviewedExportedShotIds.length === 0
      && reviewedButUnexportedShotIds.length === 0,
    packagePath,
    packageTransfer,
    verification: { ok: verification.ok, missingCount: verification.missing.length },
  };
  await writeJson(path.join(outputRoot, 'finalization-report.json'), {
    ok: verification.ok,
    scope,
    reviewedShotIds,
    plannedShotIds,
    exportedShotIds,
    unreviewedExportedShotIds,
    reviewedButUnexportedShotIds,
    productionComplete: state.finalization.productionComplete,
    preservation: compareRefinementSnapshot(state.preservation, finalProject, plan.preserve, plan.allowMutations),
    exportPlanPath,
    packagePath,
    packageTransfer,
    deliverablesProfile: profile.id,
    verification,
  });
  if (!state.finalization.productionComplete) throw new Error(`Final package or shot scope is incomplete: ${verification.missing.length} planned artifacts missing.`);
}

async function rollbackBatch(
  plan: RefinementPlan,
  state: RefinementState,
  batchId: string,
  session: AgentBrowserSession,
): Promise<void> {
  const batchState = state.batches[batchId];
  if (!batchState) throw new Error(`Unknown batch ${batchId}.`);
  if (batchState.status === 'approved') throw new Error(`Approved batch ${batchId} cannot be rolled back by the refinement runner.`);
  if (!batchState.startingRevisionId) throw new Error(`Batch ${batchId} has no verified starting checkpoint to restore.`);
  const restored = await session.page.evaluate((input) => window.foreScene!.restoreRefinementCheckpoint(input), {
    projectId: state.preservation.projectId,
    revisionId: batchState.startingRevisionId,
  });
  if (!restored.ok) throw new Error(`Rollback ${batchId} failed: ${restored.diagnostics.map((item) => item.message).join('; ')}`);
  await waitForAgentIdle(session.page);
  const batchShotIds = new Set((await resolveShots(session, plan.batches.find((batch) => batch.id === batchId)!.shots)).map((shot) => shot.id));
  for (const entry of plan.modelImports.filter((candidate) => candidate.batchId === batchId)) delete state.imports[entry.id];
  for (const entry of plan.characterImports.filter((candidate) => candidate.batchId === batchId)) delete state.imports[entry.id];
  state.replacements = state.replacements.flatMap((replacement) => {
    const completedShotIds = replacement.completedShotIds.filter((shotId) => !batchShotIds.has(shotId));
    return completedShotIds.length > 0 ? [{ ...replacement, completedShotIds }] : [];
  });
  state.assignments = state.assignments.flatMap((assignment) => {
    const completedShotIds = assignment.completedShotIds.filter((shotId) => !batchShotIds.has(shotId));
    return completedShotIds.length > 0 ? [{ ...assignment, completedShotIds }] : [];
  });
  state.batches[batchId] = {
    status: 'pending',
    attemptCount: batchState.attemptCount,
    rolledBackAt: now(),
  };
  assertPreserved(plan, state, await readProject(session));
}

/** Entry point used by `agent:refine`. It writes state only after each durable checkpoint. */
export async function runRefinementCli(options: RefinementCliOptions): Promise<{ ok: boolean; output: string; statePath: string }> {
  const outputRoot = path.resolve(options.output);
  const raw = JSON.parse(await readFile(path.resolve(options.planPath), 'utf8')) as unknown;
  const parsed = parseRefinementPlan(raw);
  if (!parsed.ok) throw new Error(`Invalid refinement plan: ${parsed.errors.join(' ')}`);
  const plan = parsed.plan;
  if (Number(Boolean(options.batchId)) + Number(Boolean(options.approveBatchId)) + Number(options.finalize)
    + Number(Boolean(options.retryBatchId)) + Number(Boolean(options.rollbackBatchId)) !== 1) {
    throw new Error('agent:refine requires exactly one of --batch, --approve <batch>, --retry <batch>, --rollback <batch>, or --finalize.');
  }
  if ((options.batchId || options.retryBatchId || options.rollbackBatchId || options.finalize) && !options.writeAccess) {
    throw new Error('agent:refine mutation, rollback, and finalization require --write or --persist-write.');
  }
  const stateTarget = statePath(outputRoot);
  return withSession(options, async (session) => {
    await waitForAgentIdle(session.page);
    let state = await loadState(stateTarget);
    if (!state) {
      if (!options.batchId) throw new Error('No refinement state exists. Start the first batch before approval, rollback, retry, or finalization.');
      state = createRefinementState(plan, await readProject(session));
      await writeJson(stateTarget, state);
    }
    state.assignments ??= [];
    if (options.approveBatchId) {
      await approveBatch(plan, state, options.approveBatchId, options.semanticReviewPath, session);
      await writeJson(stateTarget, state);
      return { ok: true, output: outputRoot, statePath: stateTarget };
    }
    if (options.finalize) {
      await finalize(plan, state, options, outputRoot, session);
      await writeJson(stateTarget, state);
      return { ok: true, output: outputRoot, statePath: stateTarget };
    }

    if (options.rollbackBatchId) {
      await rollbackBatch(plan, state, options.rollbackBatchId, session);
      await writeJson(stateTarget, state);
      return { ok: true, output: outputRoot, statePath: stateTarget };
    }

    if (options.retryBatchId) {
      await rollbackBatch(plan, state, options.retryBatchId, session);
      await writeJson(stateTarget, state);
    }

    const batchId = options.batchId ?? options.retryBatchId!;
    const gate = canRunBatch(plan, state, batchId);
    if (gate.length > 0) throw new Error(gate.join(' '));
    const batch = plan.batches.find((candidate) => candidate.id === batchId)!;
    const shots = await resolveShots(session, batch.shots);
    state.batches[batchId]!.resolvedShotIds = [...new Set(shots.map((shot) => shot.id))];
    await assertRefinementShotCoverage(session, plan);
    assertPreserved(plan, state, await readProject(session));
    const checkpoint = await session.page.evaluate((reason) => window.foreScene!.createRefinementCheckpoint({ reason }), `before refinement batch ${batchId}`);
    if (!checkpoint.ok || !checkpoint.revisionId) {
      throw new Error(`Could not checkpoint batch ${batchId}: ${checkpoint.diagnostics.map((item) => item.message).join('; ')}`);
    }
    state.batches[batchId]!.startingRevisionId = checkpoint.revisionId;
    state.batches[batchId]!.attemptCount = (state.batches[batchId]!.attemptCount ?? 0) + 1;
    await writeJson(stateTarget, state);
    const report: Record<string, unknown> = { ok: false, batchId, startedAt: now(), previewedMutations: [] as unknown[] };
    try {
      const modelImports = plan.modelImports.filter((entry) => entry.batchId === batchId);
      for (const entry of modelImports) {
        const usedForReplacement = plan.proxyReplacements.some((replacement) => replacement.replacementImportId === entry.id);
        const mode = entry.mode ?? (usedForReplacement ? 'combined' : 'separate');
        (report.previewedMutations as unknown[]).push({ id: entry.id, kind: 'model-import', file: path.resolve(entry.file), mode, preflight: 'browser model import plan' });
        const result = await importModel(session, entry, options, mode);
        state.imports[entry.id] = { kind: 'model', objectIds: result.objectRefs!.map((ref) => ref.id), completedAt: now() };
        if (usedForReplacement) {
          await applyObjectUpdates(session, `Hide imported model ${entry.id}`, state.imports[entry.id]!.objectIds.map((id) => ({ id, updates: { visible: false } })));
        }
        assertPreserved(plan, state, await readProject(session));
      }
      const characterImports = plan.characterImports.filter((entry) => entry.batchId === batchId);
      for (const entry of characterImports) {
        (report.previewedMutations as unknown[]).push({ id: entry.id, kind: 'character-import', file: path.resolve(entry.file), preflight: 'rig compatibility analysis' });
        const result = await importCharacter(session, entry, options);
        state.imports[entry.id] = { kind: 'character', objectIds: [result.objectId!], completedAt: now() };
        // Imported variants stay invisible until an explicit assignment stages them.
        await applyObjectUpdates(session, `Hide imported character ${entry.id}`, [{ id: result.objectId!, updates: { visible: false } }]);
        assertPreserved(plan, state, await readProject(session));
      }
      const batchShotIds = new Set(shots.map((shot) => shot.id));
      for (const entry of plan.proxyReplacements) {
        const intended = await resolveShots(session, entry.shots);
        const requested = intended.filter((shot) => batchShotIds.has(shot.id));
        if (requested.length === 0) continue;
        const imported = entry.replacementImportId ? state.imports[entry.replacementImportId] : undefined;
        const replacementObjectId = entry.replacementObjectId ?? (() => {
          if (!imported || imported.kind !== 'model' || imported.objectIds.length !== 1) {
            throw new Error(`Replacement ${entry.id} requires model import ${entry.replacementImportId} to produce exactly one object.`);
          }
          return imported.objectIds[0]!;
        })();
        const previous = state.replacements.find((replacement) => replacement.id === entry.id);
        const result = await replaceProxy(session, entry, replacementObjectId, requested.map((shot) => shot.id), !previous?.initialized);
        const completedShotIds = [...new Set([...(previous?.completedShotIds ?? []), ...result.plan.affectedShots.map((shot) => shot.id)])];
        const next = {
          id: entry.id,
          proxyObjectId: entry.proxyObjectId,
          replacementObjectId,
          intendedShotIds: intended.map((shot) => shot.id),
          completedShotIds,
          initialized: true,
          workUnits: (previous?.workUnits ?? 0) + result.plan.plan.commands.length,
          verified: Boolean(previous?.verified ?? true) && result.verification.ok,
        };
        if (previous) Object.assign(previous, next);
        else state.replacements.push(next);
        (report.previewedMutations as unknown[]).push({ id: entry.id, kind: 'proxy-replacement', preview: result.preview.summary });
        assertPreserved(plan, state, await readProject(session));
      }
      for (const entry of plan.characterAssignments) {
        const intended = await resolveShots(session, entry.shots);
        const requested = intended.filter((shot) => batchShotIds.has(shot.id));
        if (requested.length === 0) continue;
        const imported = state.imports[entry.importId];
        if (!imported || imported.kind !== 'character' || imported.objectIds.length !== 1) {
          throw new Error(`Character assignment ${entry.id} requires character import ${entry.importId} to produce exactly one object.`);
        }
        const previous = state.assignments.find((assignment) => assignment.id === entry.id);
        const result = await replaceProxy(session, {
          id: entry.id,
          proxyObjectId: entry.replaceObjectId,
          shots: entry.shots,
        }, imported.objectIds[0]!, requested.map((shot) => shot.id), !previous?.initialized);
        const completedShotIds = [...new Set([...(previous?.completedShotIds ?? []), ...result.plan.affectedShots.map((shot) => shot.id)])];
        const next = {
          id: entry.id,
          importId: entry.importId,
          placeholderObjectId: entry.replaceObjectId,
          characterObjectId: imported.objectIds[0]!,
          intendedShotIds: intended.map((shot) => shot.id),
          completedShotIds,
          initialized: true,
          workUnits: (previous?.workUnits ?? 0) + result.plan.plan.commands.length,
          verified: Boolean(previous?.verified ?? true) && result.verification.ok,
        };
        if (previous) Object.assign(previous, next);
        else state.assignments.push(next);
        (report.previewedMutations as unknown[]).push({ id: entry.id, kind: 'character-assignment', preview: result.preview.summary });
        assertPreserved(plan, state, await readProject(session));
      }
      await applyConfiguredCastRoles(session, plan, state);
      state.batches[batchId]!.mutationCompletedAt = now();
      const currentProject = await readProject(session);
      const authorizedMutations = listAuthorizedRefinementValueChanges(state.preservation, currentProject, plan.allowMutations)
        .filter((change) => batchShotIds.has(change.shotId));
      const temporal = await renderTemporalSamples(session, shots, path.join(outputRoot, 'reviews', batchId));
      const reviews = await renderReviewMatrix(
        session,
        plan,
        shots,
        path.join(outputRoot, 'reviews', batchId),
        authorizedMutations,
        temporal,
      );
      state.batches[batchId]!.reviewManifestPath = reviews.manifestPath;
      state.batches[batchId]!.reviewManifestSha256 = reviews.manifestSha256;
      state.batches[batchId]!.status = reviews.report.ok ? 'awaiting_visual_review' : 'failed';
      report.reviewManifestPath = reviews.manifestPath;
      report.temporalSamples = temporal;
      report.preservation = compareRefinementSnapshot(state.preservation, await readProject(session), plan.preserve, plan.allowMutations);
      report.ok = reviews.report.ok && (report.preservation as { ok: boolean }).ok;
      if (!report.ok) state.batches[batchId]!.failure = 'Review matrix or preservation verification failed.';
    } catch (error) {
      state.batches[batchId]!.status = 'failed';
      state.batches[batchId]!.failure = error instanceof Error ? error.message : 'Unknown refinement failure.';
      report.error = state.batches[batchId]!.failure;
    }
    if (report.ok !== true) {
      const failure = String(report.error ?? state.batches[batchId]!.failure ?? 'Refinement batch verification failed.');
      try {
        // A failed batch is not left as a dirty, failed working state. The
        // checkpoint remains the operator-visible recovery point, while the
        // pending state allows a retry without a separate rollback command.
        await rollbackBatch(plan, state, batchId, session);
        state.batches[batchId]!.failure = failure;
        report.automaticRollback = {
          ok: true,
          revisionId: state.batches[batchId]!.startingRevisionId,
          message: 'Blocking batch verification failure was rolled back automatically.',
        };
      } catch (rollbackError) {
        state.batches[batchId]!.status = 'failed';
        state.batches[batchId]!.failure = `${failure} Automatic rollback failed: ${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error.'}`;
        report.automaticRollback = {
          ok: false,
          message: state.batches[batchId]!.failure,
        };
      }
    }
    report.completedAt = now();
    await writeJson(path.join(outputRoot, `batch-${batchId}-report.json`), report);
    await writeJson(stateTarget, state);
    if (report.ok !== true) throw new Error(String(report.error ?? state.batches[batchId]!.failure));
    return { ok: true, output: outputRoot, statePath: stateTarget };
  });
}
