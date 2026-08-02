/**
 * Guardrails for incremental refinement of an existing ForeScene project.
 *
 * This is intentionally independent from the greenfield previs manifest: it
 * snapshots identity-bearing project data and permits only a reviewed batch to
 * advance. The CLI owns browser I/O; this module owns the durable contract.
 */

import type { LocationProject, Shot } from '../../domain/types';
import type { ExportSettingsOverride } from '../../domain/types';
import type { PlannedArtifactKind, ExportPlan } from '../exportPlan';

export const REFINEMENT_PLAN_VERSION = 1;
export const REFINEMENT_STATE_VERSION = 1;

export interface RefinementPreserveSettings {
  project: boolean;
  shots: boolean;
  panoramas: boolean;
  environmentObjects: boolean;
  cameras: boolean;
  timelines: boolean;
}

export interface RefinementCharacterImport {
  id: string;
  batchId: string;
  file: string;
  rigPackage?: string;
  rigMode?: 'saved-rig' | 'preserve' | 'autorig' | 'auto';
  name?: string;
}

export interface RefinementModelImport {
  id: string;
  batchId: string;
  file: string;
  /** Multi-object assets are combined by default when used for replacement. */
  mode?: 'combined' | 'separate';
}

export interface RefinementProxyReplacement {
  id: string;
  /** Optional legacy import batch. Replacement shots can span later batches. */
  batchId?: string;
  proxyObjectId: string;
  /** Model import id; requires that import to produce exactly one object. */
  replacementImportId?: string;
  /** Existing imported-model object id, when no import is required. */
  replacementObjectId?: string;
  shots: string[];
}

/** Assign a saved-rig character to its existing staging placeholder. */
export interface RefinementCharacterAssignment {
  id: string;
  importId: string;
  replaceObjectId: string;
  shots: string[];
}

/** Narrow, explicit value changes that remain subject to visual approval. */
export interface RefinementMutationAllowlist {
  shotStaging: string[];
  pose: string[];
  camera: string[];
  timeline: string[];
  visibility: string[];
}

export interface RefinementBatch {
  id: string;
  shots: string[];
}

export interface RefinementPlan {
  version: typeof REFINEMENT_PLAN_VERSION;
  mode: 'existing-project-refinement';
  preserve: RefinementPreserveSettings;
  allowMutations: RefinementMutationAllowlist;
  characterImports: RefinementCharacterImport[];
  characterAssignments: RefinementCharacterAssignment[];
  modelImports: RefinementModelImport[];
  proxyReplacements: RefinementProxyReplacement[];
  batches: RefinementBatch[];
  deliverablesProfile: string;
  /** Import ids or existing scene object ids that comprise the production cast. */
  castObjectIds?: string[];
}

export interface RefinementSnapshot {
  projectId: string;
  shotIds: string[];
  panoIds: string[];
  environmentObjectIds: string[];
  cameras: Record<string, unknown>;
  timelines: Record<string, unknown>;
}

export type RefinementBatchStatus = 'pending' | 'awaiting_visual_review' | 'approved' | 'failed';

export interface RefinementBatchState {
  status: RefinementBatchStatus;
  reviewManifestPath?: string;
  semanticReviewPath?: string;
  mutationCompletedAt?: string;
  approvedAt?: string;
  failure?: string;
  startingProject?: LocationProject;
  startingRevisionId?: string;
  attemptCount?: number;
  rolledBackAt?: string;
}

export interface RefinementImportState {
  kind: 'character' | 'model';
  objectIds: string[];
  completedAt: string;
}

export interface RefinementReplacementState {
  id: string;
  proxyObjectId: string;
  replacementObjectId: string;
  intendedShotIds: string[];
  completedShotIds: string[];
  initialized: boolean;
  workUnits: number;
  verified: boolean;
}

export interface RefinementAssignmentState {
  id: string;
  importId: string;
  placeholderObjectId: string;
  characterObjectId: string;
  intendedShotIds: string[];
  completedShotIds: string[];
  initialized: boolean;
  workUnits: number;
  verified: boolean;
}

export interface RefinementState {
  version: typeof REFINEMENT_STATE_VERSION;
  planFingerprint: string;
  preservation: RefinementSnapshot;
  batches: Record<string, RefinementBatchState>;
  imports: Record<string, RefinementImportState>;
  replacements: RefinementReplacementState[];
  assignments: RefinementAssignmentState[];
  finalization?: {
    completedAt: string;
    productionComplete: boolean;
    packagePath?: string;
    verification?: { ok: boolean; missingCount: number };
  };
}

export interface RefinementComparison {
  ok: boolean;
  errors: string[];
  missing: {
    shots: string[];
    panoramas: string[];
    environmentObjects: string[];
  };
}

export interface RefinementAuthorizedValueChange {
  shotId: string;
  shotNumber: string;
  kind: 'camera' | 'timeline';
}

export interface RefinementDeliverablesProfile {
  id: string;
  patch: ExportSettingsOverride;
  requiredArtifacts: Array<{ kind: PlannedArtifactKind; variant?: 'with_people' | 'clean_plate' }>;
}

const AI_CONTROL_FULL_PROFILE: RefinementDeliverablesProfile = {
  id: 'ai-control-full',
  patch: {
    peopleExportMode: 'both',
    characterPass: {
      enabled: true,
      includeStill: true,
      includeMotion: true,
      motionFormat: 'both',
      backgroundColor: '#00FF00',
      includeAttachedProps: true,
    },
    includeViewport: true,
    includeProjectedViewport: true,
    includeProjectedCameraMoveReferenceFrames: true,
    includeProjectedCameraMoveVideo: true,
    includeCameraMoveVideo: true,
    includeCameraMoveReferenceFrames: true,
    depth: {
      enabled: true,
      includeViewportStill: true,
      includeReferenceFrames: true,
      includeCameraMoveVideo: true,
      rangeMode: 'auto',
      invert: false,
    },
  },
  requiredArtifacts: [
    { kind: 'clay-viewport', variant: 'with_people' },
    { kind: 'clay-viewport', variant: 'clean_plate' },
    { kind: 'projected-viewport', variant: 'with_people' },
    { kind: 'projected-viewport', variant: 'clean_plate' },
    { kind: 'depth-viewport' },
    { kind: 'character-still' },
  ],
};

/** Resolve the declared deliverables profile rather than treating it as a label. */
export function resolveRefinementDeliverablesProfile(id: string): RefinementDeliverablesProfile | undefined {
  return id === AI_CONTROL_FULL_PROFILE.id ? AI_CONTROL_FULL_PROFILE : undefined;
}

/** Refuse a profile whose export plan omits any required pass for a selected shot. */
export function checkRefinementDeliverables(
  profile: RefinementDeliverablesProfile,
  exportPlan: Pick<ExportPlan, 'shots'>,
): string[] {
  const errors: string[] = [];
  for (const shot of exportPlan.shots) {
    const requiredArtifacts = [...profile.requiredArtifacts];
    if (shot.renderableCameraMove) {
      requiredArtifacts.push(
        { kind: 'clay-camera-move' },
        { kind: 'projected-camera-move' },
        { kind: 'depth-camera-move' },
        { kind: 'clay-reference-frames' },
        { kind: 'projected-reference-frames' },
        { kind: 'depth-reference-frames' },
      );
      if (shot.hasVisibleCharacters) {
        const characterPass = shot.resolvedSettings.characterPass;
        if (characterPass && (characterPass.motionFormat === 'green_mp4'
          || characterPass.motionFormat === 'both')) {
          requiredArtifacts.push({ kind: 'character-motion' });
        }
        if (characterPass && (characterPass.motionFormat === 'transparent_png_sequence'
          || characterPass.motionFormat === 'both')) {
          requiredArtifacts.push({ kind: 'character-sequence' });
        }
      }
    }
    for (const expected of requiredArtifacts) {
      const artifact = shot.artifacts.find((candidate) => candidate.kind === expected.kind);
      const expectedFile = expected.variant ? requiredVariantFile(expected.kind, expected.variant) : undefined;
      const hasExpectedFile = !expectedFile
        || Boolean(artifact?.files.some((file) => file.path.endsWith(`/${expectedFile}`)));
      if (!artifact || artifact.disposition !== 'produce' || artifact.files.length === 0 || !hasExpectedFile) {
        const variant = expected.variant ? ` (${expected.variant})` : '';
        errors.push(`Deliverables profile ${profile.id} omits ${expected.kind}${variant} for shot ${shot.shotId}.`);
      }
    }
  }
  return errors;
}

function requiredVariantFile(
  kind: PlannedArtifactKind,
  variant: 'with_people' | 'clean_plate',
): string | undefined {
  const prefix = kind === 'clay-viewport'
    ? 'viewport_clay'
    : kind === 'projected-viewport'
      ? 'viewport_projected'
      : kind === 'depth-viewport'
        ? 'viewport_depth'
        : undefined;
  if (!prefix) return undefined;
  return `${prefix}_${variant}.png`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function hasKnownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'boolean');
}

function hasStringListKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => stringList(value[key]) !== null);
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function timelineIdentity(shot: Shot): unknown {
  return shot.cameraKeyframes.map((keyframe) => ({
    id: keyframe.id,
    label: keyframe.label,
    timeSeconds: keyframe.timeSeconds,
    easing: keyframe.easing,
    camera: keyframe.camera,
  }));
}

/** Validate an external JSON plan before the CLI opens a write-enabled browser. */
export function parseRefinementPlan(raw: unknown): { ok: true; plan: RefinementPlan } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['Refinement plan must be a JSON object.'] };
  const errors: string[] = [];
  if (raw.version !== REFINEMENT_PLAN_VERSION) errors.push(`version must be ${REFINEMENT_PLAN_VERSION}.`);
  if (raw.mode !== 'existing-project-refinement') errors.push('mode must be "existing-project-refinement".');
  if (!isRecord(raw.preserve) || !hasKnownKeys(raw.preserve, ['project', 'shots', 'panoramas', 'environmentObjects', 'cameras', 'timelines'])) {
    errors.push('preserve must explicitly enable or disable project, shots, panoramas, environmentObjects, cameras, and timelines.');
  }
  if (!isRecord(raw.allowMutations) || !hasStringListKeys(raw.allowMutations, ['shotStaging', 'pose', 'camera', 'timeline', 'visibility'])) {
    errors.push('allowMutations must explicitly list shotStaging, pose, camera, timeline, and visibility identifiers.');
  }
  if (typeof raw.deliverablesProfile !== 'string' || raw.deliverablesProfile.length === 0) {
    errors.push('deliverablesProfile is required.');
  }
  const batches = Array.isArray(raw.batches) ? raw.batches : null;
  if (!batches || batches.length === 0) {
    errors.push('batches must contain at least one batch.');
  } else {
    const ids = new Set<string>();
    for (const batch of batches) {
      const shots = isRecord(batch) ? stringList(batch.shots) : null;
      if (!isRecord(batch) || typeof batch.id !== 'string' || !shots || shots.length === 0) {
        errors.push('Each batch needs an id and at least one shot identifier.');
        continue;
      }
      if (ids.has(batch.id)) errors.push(`Duplicate batch id: ${batch.id}.`);
      ids.add(batch.id);
    }
  }

  const batchIds = new Set((batches ?? []).flatMap((batch) => isRecord(batch) && typeof batch.id === 'string' ? [batch.id] : []));
  const importIds = new Set<string>();
  const characterImportIds = new Set<string>();
  const modelImportIds = new Set<string>();
  const characterImports = Array.isArray(raw.characterImports) ? raw.characterImports : null;
  const characterAssignments = Array.isArray(raw.characterAssignments) ? raw.characterAssignments : null;
  const modelImports = Array.isArray(raw.modelImports) ? raw.modelImports : null;
  const proxyReplacements = Array.isArray(raw.proxyReplacements) ? raw.proxyReplacements : null;
  if (!characterImports || !characterAssignments || !modelImports || !proxyReplacements) {
    errors.push('characterImports, characterAssignments, modelImports, and proxyReplacements must be arrays.');
  }
  for (const entry of characterImports ?? []) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.batchId !== 'string' || typeof entry.file !== 'string') {
      errors.push('Each import needs id, batchId, and file.');
      continue;
    }
    if (importIds.has(entry.id)) errors.push(`Duplicate import id: ${entry.id}.`);
    importIds.add(entry.id);
    characterImportIds.add(entry.id);
    if (!batchIds.has(entry.batchId)) errors.push(`Import ${entry.id} references unknown batch ${entry.batchId}.`);
  }
  for (const entry of modelImports ?? []) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.batchId !== 'string' || typeof entry.file !== 'string') {
      errors.push('Each import needs id, batchId, and file.');
      continue;
    }
    if (entry.mode !== undefined && entry.mode !== 'combined' && entry.mode !== 'separate') {
      errors.push(`Model import ${entry.id} mode must be "combined" or "separate".`);
    }
    if (importIds.has(entry.id)) errors.push(`Duplicate import id: ${entry.id}.`);
    importIds.add(entry.id);
    modelImportIds.add(entry.id);
    if (!batchIds.has(entry.batchId)) errors.push(`Import ${entry.id} references unknown batch ${entry.batchId}.`);
  }
  const seenAssignments = new Set<string>();
  for (const entry of characterAssignments ?? []) {
    const shots = isRecord(entry) ? stringList(entry.shots) : null;
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.importId !== 'string'
      || typeof entry.replaceObjectId !== 'string' || !shots || shots.length === 0) {
      errors.push('Each character assignment needs id, importId, replaceObjectId, and at least one shot.');
      continue;
    }
    if (seenAssignments.has(entry.id)) errors.push(`Duplicate character assignment id: ${entry.id}.`);
    seenAssignments.add(entry.id);
    if (!characterImportIds.has(entry.importId)) errors.push(`Character assignment ${entry.id} references unknown character import ${entry.importId}.`);
  }
  for (const entry of proxyReplacements ?? []) {
    const shots = isRecord(entry) ? stringList(entry.shots) : null;
    if (!isRecord(entry) || typeof entry.id !== 'string' || (entry.batchId !== undefined && typeof entry.batchId !== 'string')
      || typeof entry.proxyObjectId !== 'string' || !shots || shots.length === 0) {
      errors.push('Each proxy replacement needs id, optional batchId, proxyObjectId, and at least one shot.');
      continue;
    }
    if (typeof entry.batchId === 'string' && !batchIds.has(entry.batchId)) errors.push(`Replacement ${entry.id} references unknown batch ${entry.batchId}.`);
    const importId = entry.replacementImportId;
    const objectId = entry.replacementObjectId;
    if ((typeof importId === 'string') === (typeof objectId === 'string')) {
      errors.push(`Replacement ${entry.id} needs exactly one of replacementImportId or replacementObjectId.`);
    } else if (typeof importId === 'string' && !modelImportIds.has(importId)) {
      errors.push(`Replacement ${entry.id} references unknown model import ${importId}.`);
    }
  }
  if (raw.castObjectIds !== undefined && stringList(raw.castObjectIds) === null) errors.push('castObjectIds must be an array of import or object identifiers.');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: raw as unknown as RefinementPlan };
}

export function refinementPlanFingerprint(plan: RefinementPlan): string {
  return stable(plan);
}

export function captureRefinementSnapshot(project: LocationProject): RefinementSnapshot {
  return {
    projectId: project.id,
    shotIds: project.shots.map((shot) => shot.id),
    panoIds: project.panoRefs.map((pano) => pano.id),
    // Existing IDs are intentionally retained even when their staged visibility changes.
    environmentObjectIds: project.scene.objects.map((object) => object.id),
    cameras: Object.fromEntries(project.shots.map((shot) => [shot.id, structuredClone(shot.camera)])),
    timelines: Object.fromEntries(project.shots.map((shot) => [shot.id, timelineIdentity(shot)])),
  };
}

function missing(expected: readonly string[], actual: readonly string[]): string[] {
  const actualSet = new Set(actual);
  return expected.filter((id) => !actualSet.has(id));
}

/** Compare only immutable production identity and camera/timing data. */
export function compareRefinementSnapshot(
  baseline: RefinementSnapshot,
  project: LocationProject,
  preserve: RefinementPreserveSettings,
  allowMutations?: RefinementMutationAllowlist,
): RefinementComparison {
  const errors: string[] = [];
  const result = {
    shots: preserve.shots ? missing(baseline.shotIds, project.shots.map((shot) => shot.id)) : [],
    panoramas: preserve.panoramas ? missing(baseline.panoIds, project.panoRefs.map((pano) => pano.id)) : [],
    environmentObjects: preserve.environmentObjects ? missing(baseline.environmentObjectIds, project.scene.objects.map((object) => object.id)) : [],
  };
  if (preserve.project && project.id !== baseline.projectId) errors.push('Project id changed.');
  if (result.shots.length > 0) errors.push(`Preserved shot ids disappeared: ${result.shots.join(', ')}.`);
  if (result.panoramas.length > 0) errors.push(`Preserved panorama ids disappeared: ${result.panoramas.join(', ')}.`);
  if (result.environmentObjects.length > 0) errors.push(`Preserved environment object ids disappeared: ${result.environmentObjects.join(', ')}.`);
  for (const shot of project.shots) {
    if (preserve.cameras && baseline.cameras[shot.id] && stable(baseline.cameras[shot.id]) !== stable(shot.camera)
      && !mutationAllowed(allowMutations?.camera, shot)) {
      errors.push(`Camera changed for shot ${shot.shotNumber}.`);
    }
    if (preserve.timelines && baseline.timelines[shot.id] && stable(baseline.timelines[shot.id]) !== stable(timelineIdentity(shot))
      && !mutationAllowed(allowMutations?.timeline, shot)) {
      errors.push(`Timeline changed for shot ${shot.shotNumber}.`);
    }
  }
  return { ok: errors.length === 0, errors, missing: result };
}

function mutationAllowed(identifiers: readonly string[] | undefined, shot: Shot): boolean {
  return Boolean(identifiers?.includes(shot.id) || identifiers?.includes(shot.shotNumber));
}

/** Surface allowed camera/timeline changes so they can be reviewed explicitly. */
export function listAuthorizedRefinementValueChanges(
  baseline: RefinementSnapshot,
  project: LocationProject,
  allowMutations: RefinementMutationAllowlist,
): RefinementAuthorizedValueChange[] {
  const changes: RefinementAuthorizedValueChange[] = [];
  for (const shot of project.shots) {
    if (baseline.cameras[shot.id] && stable(baseline.cameras[shot.id]) !== stable(shot.camera)
      && mutationAllowed(allowMutations.camera, shot)) {
      changes.push({ shotId: shot.id, shotNumber: shot.shotNumber, kind: 'camera' });
    }
    if (baseline.timelines[shot.id] && stable(baseline.timelines[shot.id]) !== stable(timelineIdentity(shot))
      && mutationAllowed(allowMutations.timeline, shot)) {
      changes.push({ shotId: shot.id, shotNumber: shot.shotNumber, kind: 'timeline' });
    }
  }
  return changes;
}

export function createRefinementState(plan: RefinementPlan, project: LocationProject): RefinementState {
  return {
    version: REFINEMENT_STATE_VERSION,
    planFingerprint: refinementPlanFingerprint(plan),
    preservation: captureRefinementSnapshot(project),
    batches: Object.fromEntries(plan.batches.map((batch) => [batch.id, { status: 'pending' } satisfies RefinementBatchState])),
    imports: {},
    replacements: [],
    assignments: [],
  };
}

export function validateRefinementState(plan: RefinementPlan, state: RefinementState): string[] {
  const errors: string[] = [];
  if (state.version !== REFINEMENT_STATE_VERSION) errors.push(`Unsupported refinement state version ${state.version}.`);
  if (state.planFingerprint !== refinementPlanFingerprint(plan)) errors.push('Refinement plan changed after the preservation baseline was captured. Start with a new output directory.');
  for (const batch of plan.batches) if (!state.batches[batch.id]) errors.push(`State is missing batch ${batch.id}.`);
  return errors;
}

/** Rejects skipped, failed, awaiting-review, or already completed batches. */
export function canRunBatch(plan: RefinementPlan, state: RefinementState, batchId: string): string[] {
  const errors = validateRefinementState(plan, state);
  const index = plan.batches.findIndex((batch) => batch.id === batchId);
  if (index < 0) return [...errors, `Unknown batch ${batchId}.`];
  const status = state.batches[batchId]?.status;
  if (status !== 'pending') errors.push(`Batch ${batchId} is ${status}; it cannot be applied again.`);
  const previous = plan.batches.slice(0, index).find((batch) => state.batches[batch.id]?.status !== 'approved');
  if (previous) errors.push(`Batch ${previous.id} must be explicitly approved before ${batchId} can start.`);
  return errors;
}

export function canApproveBatch(plan: RefinementPlan, state: RefinementState, batchId: string): string[] {
  const errors = validateRefinementState(plan, state);
  if (!plan.batches.some((batch) => batch.id === batchId)) errors.push(`Unknown batch ${batchId}.`);
  if (state.batches[batchId]?.status !== 'awaiting_visual_review') {
    errors.push(`Batch ${batchId} is not awaiting visual review.`);
  }
  return errors;
}

export function canFinalizeRefinement(plan: RefinementPlan, state: RefinementState): string[] {
  const errors = validateRefinementState(plan, state);
  const unapproved = plan.batches.filter((batch) => state.batches[batch.id]?.status !== 'approved').map((batch) => batch.id);
  if (unapproved.length > 0) errors.push(`All batches require approval before finalization: ${unapproved.join(', ')}.`);
  for (const entry of plan.proxyReplacements) {
    const replacement = state.replacements.find((candidate) => candidate.id === entry.id);
    if (!replacement || !replacement.verified || replacement.workUnits <= 0) {
      errors.push(`Replacement ${entry.id} was not verified with nonzero work.`);
      continue;
    }
    const incomplete = replacement.intendedShotIds.filter((shotId) => !replacement.completedShotIds.includes(shotId));
    if (incomplete.length > 0) errors.push(`Replacement ${entry.id} remains incomplete for: ${incomplete.join(', ')}.`);
  }
  for (const entry of plan.characterAssignments) {
    const assignment = (state.assignments ?? []).find((candidate) => candidate.id === entry.id);
    if (!assignment || !assignment.verified || assignment.workUnits <= 0) {
      errors.push(`Character assignment ${entry.id} was not verified with nonzero work.`);
      continue;
    }
    const incomplete = assignment.intendedShotIds.filter((shotId) => !assignment.completedShotIds.includes(shotId));
    if (incomplete.length > 0) errors.push(`Character assignment ${entry.id} remains incomplete for: ${incomplete.join(', ')}.`);
  }
  return errors;
}

/** Objects whose effective visibility must be checked before finalization. */
export function listRefinementVisibilityTargets(
  state: Pick<RefinementState, 'replacements' | 'assignments'>,
): Array<{ proxyObjectId: string }> {
  return [
    ...state.replacements.map((replacement) => ({ proxyObjectId: replacement.proxyObjectId })),
    ...(state.assignments ?? []).map((assignment) => ({ proxyObjectId: assignment.placeholderObjectId })),
  ];
}

export interface ReviewMatrixCheck {
  ok: boolean;
  errors: string[];
}

/** Validate an evidence-linked semantic review before a batch can advance. */
export function checkSemanticReview(
  review: unknown,
  manifest: unknown,
  expectedShotIds: readonly string[],
): ReviewMatrixCheck {
  if (!isRecord(review) || review.approved !== true || !Array.isArray(review.shots)) {
    return { ok: false, errors: ['Semantic review must set approved: true and include per-shot verdicts.'] };
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.shots)) {
    return { ok: false, errors: ['Review manifest is unavailable for semantic evidence checks.'] };
  }
  const errors: string[] = [];
  const manifestByShot = new Map(manifest.shots.filter(isRecord).map((shot) => [shot.id, shot]));
  const reviewByShot = new Map(review.shots.filter(isRecord).map((shot) => [shot.id, shot]));
  for (const shotId of expectedShotIds) {
    const verdict = reviewByShot.get(shotId);
    if (!verdict) {
      errors.push(`Semantic review is missing shot ${shotId}.`);
      continue;
    }
    if (verdict.verdict !== 'pass') errors.push(`Semantic review did not pass shot ${shotId}.`);
    const reasons = stringList(verdict.reasons);
    if (!reasons || reasons.length === 0 || reasons.some((reason) => reason.trim().length < 8)) {
      errors.push(`Semantic review needs concrete reasons for shot ${shotId}.`);
    }
    for (const key of ['primarySubject', 'correctVariant', 'framing', 'creature', 'proxyAbsent', 'props']) {
      if (verdict[key] !== true) errors.push(`Semantic review must affirm ${key} for shot ${shotId}.`);
    }
    const hasAuthorizedChanges = Array.isArray(manifest.authorizedMutations)
      && manifest.authorizedMutations.some((change) => isRecord(change) && change.shotId === shotId);
    if (hasAuthorizedChanges && verdict.authorizedMutationDecision !== 'approved') {
      errors.push(`Semantic review must approve authorized value changes for shot ${shotId}.`);
    }
    if (!hasAuthorizedChanges && verdict.authorizedMutationDecision !== 'not_applicable') {
      errors.push(`Semantic review must record no authorized value changes for shot ${shotId}.`);
    }
    const reviewedArtifacts = Array.isArray(verdict.reviewedArtifacts) ? verdict.reviewedArtifacts.filter(isRecord) : [];
    const reviewedHashes = new Map(
      reviewedArtifacts
        .filter((artifact) => typeof artifact.fileName === 'string' && typeof artifact.sha256 === 'string')
        .map((artifact) => [artifact.fileName as string, artifact.sha256 as string]),
    );
    const manifestShot = manifestByShot.get(shotId);
    const temporal = manifestShot && isRecord(manifestShot.temporal) ? manifestShot.temporal : undefined;
    if (!temporal || typeof temporal.renderable !== 'boolean') {
      errors.push(`Review manifest is missing temporal evidence for shot ${shotId}.`);
    } else if (temporal.renderable) {
      if (verdict.motionDecision !== 'approved') {
        errors.push(`Semantic review must approve motion for renderable shot ${shotId}.`);
      }
    } else if (verdict.motionDecision !== 'not_applicable') {
      errors.push(`Semantic review must mark motion not_applicable for non-renderable shot ${shotId}.`);
    }
    const passRecords = manifestShot && Array.isArray(manifestShot.passes) ? manifestShot.passes.filter(isRecord) : [];
    for (const pass of passRecords) {
      if (pass.ok !== true || typeof pass.fileName !== 'string' || typeof pass.sha256 !== 'string') continue;
      if (reviewedHashes.get(pass.fileName) !== pass.sha256) {
        errors.push(`Semantic review hash does not match ${pass.fileName} for shot ${shotId}.`);
      }
    }
    if (temporal?.renderable === true) {
      for (const key of ['start', 'mid', 'end', 'video']) {
        const artifact = isRecord(temporal[key]) ? temporal[key] : undefined;
        const fileName = artifact && typeof artifact.fileName === 'string' ? artifact.fileName : undefined;
        const output = artifact && typeof artifact.output === 'string' ? artifact.output : undefined;
        const sha256 = artifact && typeof artifact.sha256 === 'string' ? artifact.sha256 : undefined;
        const reviewedHash = (fileName && reviewedHashes.get(fileName))
          ?? (output && reviewedHashes.get(output));
        if (!fileName || !output || !sha256 || reviewedHash !== sha256) {
          errors.push(`Semantic review hash does not match temporal ${key} evidence for shot ${shotId}.`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

const REQUIRED_REVIEW_FILES = new Set([
  'clay_with-characters.png',
  'clay_clean-plate.png',
  'projected_with-characters.png',
  'projected_clean-plate.png',
  'characters-only.png',
  'depth.png',
]);

/** Check the durable manifest shape before a human/model approval is accepted. */
export function checkReviewMatrix(manifest: unknown, expectedShotIds: readonly string[]): ReviewMatrixCheck {
  if (!isRecord(manifest) || manifest.ok !== true || !Array.isArray(manifest.shots)) {
    return { ok: false, errors: ['Review manifest is missing or reports a failed render.'] };
  }
  const errors: string[] = [];
  const byId = new Map(manifest.shots.filter(isRecord).map((shot) => [shot.id, shot]));
  for (const id of expectedShotIds) {
    const shot = byId.get(id);
    if (!shot || !Array.isArray(shot.passes)) {
      errors.push(`Review matrix is missing shot ${id}.`);
      continue;
    }
    const rendered = new Set(
      shot.passes.filter(isRecord).filter((pass) => pass.ok === true && typeof pass.fileName === 'string').map((pass) => pass.fileName as string),
    );
    for (const fileName of REQUIRED_REVIEW_FILES) {
      if (!rendered.has(fileName)) errors.push(`Review matrix is missing ${fileName} for shot ${id}.`);
    }
    const temporal = isRecord(shot.temporal) ? shot.temporal : undefined;
    if (!temporal || typeof temporal.renderable !== 'boolean') {
      errors.push(`Review matrix is missing temporal evidence for shot ${id}.`);
    } else if (temporal.renderable) {
      for (const key of ['start', 'mid', 'end', 'video']) {
        const artifact = isRecord(temporal[key]) ? temporal[key] : undefined;
        if (!artifact
          || typeof artifact.fileName !== 'string'
          || typeof artifact.output !== 'string'
          || typeof artifact.sha256 !== 'string') {
          errors.push(`Review matrix is missing temporal ${key} evidence for shot ${id}.`);
        }
        if (key === 'video' && (!artifact || typeof artifact.durationSeconds !== 'number' || artifact.durationSeconds <= 0)) {
          errors.push(`Review matrix is missing temporal video duration for shot ${id}.`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
