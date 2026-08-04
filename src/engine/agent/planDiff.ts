/**
 * Diff / fingerprint helpers for prepared agent plans.
 */

import type { LocationProject, Workspace } from '../../domain/types';
import type { AgentPlanDiff, AgentPlanSummary, AgentEntityReference } from './protocol';

export interface AgentSelectionState {
  selectedObjectIds: string[];
  selectedShotId?: string;
  workspace: Workspace;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function fingerprintHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function projectFingerprint(project: LocationProject): string {
  // Keep the readable structural prefix for diagnostics, then include a
  // content fingerprint so same-millisecond camera/staging edits invalidate
  // stale plans and still-layout approvals as well.
  const objectIds = project.scene.objects.map((object) => object.id).join(',');
  const shotIds = project.shots.map((shot) => shot.id).join(',');
  const landmarkIds = project.landmarks.map((landmark) => landmark.id).join(',');
  const stateHash = fingerprintHash(stableSerialize(project));
  return [
    project.id,
    project.updatedAt,
    project.name,
    String(project.scene.objects.length),
    String(project.shots.length),
    String(project.landmarks.length),
    objectIds,
    shotIds,
    landmarkIds,
    `state:${stateHash}`,
  ].join('|');
}

export function emptyPlanDiff(): AgentPlanDiff {
  return {
    objectsCreated: [],
    objectsUpdated: [],
    objectsDeleted: [],
    shotsCreated: [],
    shotsUpdated: [],
    shotsDeleted: [],
    landmarksCreated: [],
    landmarksUpdated: [],
    landmarksDeleted: [],
    selectionChanged: false,
    workspaceChanged: false,
    projectInfoChanged: false,
    exportConfigurationChanged: false,
  };
}

export function buildPlanSummary(params: {
  commandCount: number;
  description?: string;
  refs: Record<string, AgentEntityReference>;
  diff: AgentPlanDiff;
}): AgentPlanSummary {
  const affectedObjectIds = unique([
    ...params.diff.objectsCreated,
    ...params.diff.objectsUpdated,
    ...params.diff.objectsDeleted,
  ]);
  const affectedShotIds = unique([
    ...params.diff.shotsCreated,
    ...params.diff.shotsUpdated,
    ...params.diff.shotsDeleted,
  ]);
  const affectedLandmarkIds = unique([
    ...params.diff.landmarksCreated,
    ...params.diff.landmarksUpdated,
    ...params.diff.landmarksDeleted,
  ]);
  return {
    commandCount: params.commandCount,
    affectedObjectIds,
    affectedShotIds,
    affectedLandmarkIds,
    createdRefs: { ...params.refs },
    description: params.description,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function selectionChanged(
  before: AgentSelectionState,
  after: AgentSelectionState,
): boolean {
  if (before.selectedShotId !== after.selectedShotId) return true;
  if (before.selectedObjectIds.length !== after.selectedObjectIds.length) return true;
  const beforeSet = new Set(before.selectedObjectIds);
  return after.selectedObjectIds.some((id) => !beforeSet.has(id));
}
