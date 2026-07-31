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

export function projectFingerprint(project: LocationProject): string {
  // Include structural tokens so same-millisecond edits still invalidate undo.
  const objectIds = project.scene.objects.map((object) => object.id).join(',');
  const shotIds = project.shots.map((shot) => shot.id).join(',');
  const landmarkIds = project.landmarks.map((landmark) => landmark.id).join(',');
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
  ].join('|');
}

export function emptyPlanDiff(): AgentPlanDiff {
  return {
    objectsCreated: [],
    objectsUpdated: [],
    objectsDeleted: [],
    shotsCreated: [],
    shotsUpdated: [],
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
