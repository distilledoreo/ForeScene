/** Immutable still-layout approval and motion-branch isolation helpers. */

import type { LocationProject, Shot } from '../../domain/types';
import { projectFingerprint } from '../agent/planDiff';

export interface ApprovedLayoutRevision {
  revisionId: string;
  projectFingerprint: string;
  approvedShotIds: string[];
  approvedAt: string;
  reviewArtifactIds: string[];
}

export interface StillLayoutIsolationResult {
  ok: boolean;
  errors: string[];
  checkedShotIds: string[];
}

export interface MotionWorkingRevision {
  sourceRevisionId: string;
  project: LocationProject;
  approvedLayout: ApprovedLayoutRevision;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stableIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Build the immutable approval record only from a verified revision. */
export function createApprovedLayoutRevision(input: {
  revisionId: string;
  project: LocationProject;
  approvedShotIds: string[];
  reviewArtifactIds?: string[];
  approvedAt?: string;
}): ApprovedLayoutRevision {
  const approvedShotIds = stableIds(input.approvedShotIds);
  const missing = approvedShotIds.filter((shotId) => !input.project.shots.some((shot) => shot.id === shotId));
  if (approvedShotIds.length === 0) throw new Error('At least one shot must be approved.');
  if (missing.length > 0) throw new Error(`Approved shots are missing from the project: ${missing.join(', ')}.`);
  return {
    revisionId: input.revisionId,
    projectFingerprint: projectFingerprint(input.project),
    approvedShotIds,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
    reviewArtifactIds: stableIds(input.reviewArtifactIds ?? []),
  };
}

/** Ensure approval still describes the exact project revision it came from. */
export function verifyApprovedLayoutRevision(
  project: LocationProject,
  approval: ApprovedLayoutRevision,
): StillLayoutIsolationResult {
  const errors: string[] = [];
  if (projectFingerprint(project) !== approval.projectFingerprint) {
    errors.push('Project fingerprint no longer matches the approved still-layout revision.');
  }
  const missing = approval.approvedShotIds.filter((shotId) => !project.shots.some((shot) => shot.id === shotId));
  if (missing.length > 0) errors.push(`Approved shots are missing: ${missing.join(', ')}.`);
  return { ok: errors.length === 0, errors, checkedShotIds: [...approval.approvedShotIds] };
}

/**
 * Compare a motion working branch to its approved source. Approved still
 * shots may not acquire motion camera, staging, pose, or visibility changes.
 */
export function verifyStillLayoutIsolation(input: {
  approvedProject: LocationProject;
  workingProject: LocationProject;
  approvedShotIds: string[];
}): StillLayoutIsolationResult {
  const errors: string[] = [];
  const checkedShotIds = stableIds(input.approvedShotIds);
  for (const shotId of checkedShotIds) {
    const before = input.approvedProject.shots.find((shot) => shot.id === shotId);
    const after = input.workingProject.shots.find((shot) => shot.id === shotId);
    if (!before || !after) {
      errors.push(`Approved shot ${shotId} is missing from one revision.`);
      continue;
    }
    if (!sameJson(before.camera, after.camera)) errors.push(`Approved shot ${shotId} camera changed in motion branch.`);
    if (!sameJson(before.cameraKeyframes, after.cameraKeyframes)) errors.push(`Approved shot ${shotId} camera keyframes changed in motion branch.`);
    if (!sameJson(before.objectOverrides, after.objectOverrides)) errors.push(`Approved shot ${shotId} staging changed in motion branch.`);
    if (!sameJson(before.linkedPanoId, after.linkedPanoId)) errors.push(`Approved shot ${shotId} panorama changed in motion branch.`);
  }
  return { ok: errors.length === 0, errors, checkedShotIds };
}

/** Clone the approved document into a separate working revision for motion. */
export function createMotionWorkingRevision(input: {
  project: LocationProject;
  approval: ApprovedLayoutRevision;
  sourceRevisionId?: string;
}): MotionWorkingRevision {
  const verification = verifyApprovedLayoutRevision(input.project, input.approval);
  if (!verification.ok) throw new Error(verification.errors.join(' '));
  return {
    sourceRevisionId: input.sourceRevisionId ?? input.approval.revisionId,
    project: structuredClone(input.project),
    approvedLayout: structuredClone(input.approval),
  };
}

export function shotStillLayoutSnapshot(shot: Shot): Pick<Shot, 'camera' | 'cameraKeyframes' | 'objectOverrides' | 'linkedPanoId'> {
  return {
    camera: structuredClone(shot.camera),
    cameraKeyframes: structuredClone(shot.cameraKeyframes),
    objectOverrides: structuredClone(shot.objectOverrides),
    linkedPanoId: shot.linkedPanoId,
  };
}
