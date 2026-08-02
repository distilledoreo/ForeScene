/**
 * Guardrails for incremental refinement of an existing ForeScene project.
 *
 * This is intentionally independent from the greenfield previs manifest: it
 * snapshots identity-bearing project data and permits only a reviewed batch to
 * advance. The CLI owns browser I/O; this module owns the durable contract.
 */

import type { LocationProject, Shot } from '../../domain/types';

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
}

export interface RefinementProxyReplacement {
  id: string;
  batchId: string;
  proxyObjectId: string;
  /** Model import id; requires that import to produce exactly one object. */
  replacementImportId?: string;
  /** Existing imported-model object id, when no import is required. */
  replacementObjectId?: string;
  shots: string[];
}

export interface RefinementBatch {
  id: string;
  shots: string[];
}

export interface RefinementPlan {
  version: typeof REFINEMENT_PLAN_VERSION;
  mode: 'existing-project-refinement';
  preserve: RefinementPreserveSettings;
  characterImports: RefinementCharacterImport[];
  modelImports: RefinementModelImport[];
  proxyReplacements: RefinementProxyReplacement[];
  batches: RefinementBatch[];
  deliverablesProfile: string;
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
  mutationCompletedAt?: string;
  approvedAt?: string;
  failure?: string;
}

export interface RefinementImportState {
  kind: 'character' | 'model';
  objectIds: string[];
  completedAt: string;
}

export interface RefinementReplacementState {
  id: string;
  batchId: string;
  proxyObjectId: string;
  replacementObjectId: string;
  affectedShotIds: string[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function hasKnownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'boolean');
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
  const characterImports = Array.isArray(raw.characterImports) ? raw.characterImports : null;
  const modelImports = Array.isArray(raw.modelImports) ? raw.modelImports : null;
  const proxyReplacements = Array.isArray(raw.proxyReplacements) ? raw.proxyReplacements : null;
  if (!characterImports || !modelImports || !proxyReplacements) {
    errors.push('characterImports, modelImports, and proxyReplacements must be arrays.');
  }
  for (const entry of [...(characterImports ?? []), ...(modelImports ?? [])]) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.batchId !== 'string' || typeof entry.file !== 'string') {
      errors.push('Each import needs id, batchId, and file.');
      continue;
    }
    if (importIds.has(entry.id)) errors.push(`Duplicate import id: ${entry.id}.`);
    importIds.add(entry.id);
    if (!batchIds.has(entry.batchId)) errors.push(`Import ${entry.id} references unknown batch ${entry.batchId}.`);
  }
  for (const entry of proxyReplacements ?? []) {
    const shots = isRecord(entry) ? stringList(entry.shots) : null;
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.batchId !== 'string'
      || typeof entry.proxyObjectId !== 'string' || !shots || shots.length === 0) {
      errors.push('Each proxy replacement needs id, batchId, proxyObjectId, and at least one shot.');
      continue;
    }
    if (!batchIds.has(entry.batchId)) errors.push(`Replacement ${entry.id} references unknown batch ${entry.batchId}.`);
    const importId = entry.replacementImportId;
    const objectId = entry.replacementObjectId;
    if ((typeof importId === 'string') === (typeof objectId === 'string')) {
      errors.push(`Replacement ${entry.id} needs exactly one of replacementImportId or replacementObjectId.`);
    } else if (typeof importId === 'string' && !importIds.has(importId)) {
      errors.push(`Replacement ${entry.id} references unknown model import ${importId}.`);
    }
  }
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
    if (preserve.cameras && baseline.cameras[shot.id] && stable(baseline.cameras[shot.id]) !== stable(shot.camera)) {
      errors.push(`Camera changed for shot ${shot.shotNumber}.`);
    }
    if (preserve.timelines && baseline.timelines[shot.id] && stable(baseline.timelines[shot.id]) !== stable(timelineIdentity(shot))) {
      errors.push(`Timeline changed for shot ${shot.shotNumber}.`);
    }
  }
  return { ok: errors.length === 0, errors, missing: result };
}

export function createRefinementState(plan: RefinementPlan, project: LocationProject): RefinementState {
  return {
    version: REFINEMENT_STATE_VERSION,
    planFingerprint: refinementPlanFingerprint(plan),
    preservation: captureRefinementSnapshot(project),
    batches: Object.fromEntries(plan.batches.map((batch) => [batch.id, { status: 'pending' } satisfies RefinementBatchState])),
    imports: {},
    replacements: [],
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
  if (state.replacements.some((replacement) => !replacement.verified || replacement.workUnits <= 0)) {
    errors.push('Every replacement log must be verified and contain nonzero work.');
  }
  return errors;
}

export interface ReviewMatrixCheck {
  ok: boolean;
  errors: string[];
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
  }
  return { ok: errors.length === 0, errors };
}
