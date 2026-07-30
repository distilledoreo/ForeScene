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
  return `${project.id}:${project.updatedAt}`;
}

export function emptyPlanDiff(): AgentPlanDiff {
  return {
    objectsCreated: [],
    objectsUpdated: [],
    objectsDeleted: [],
    shotsCreated: [],
    shotsUpdated: [],
    selectionChanged: false,
    workspaceChanged: false,
    projectInfoChanged: false,
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
  return {
    commandCount: params.commandCount,
    affectedObjectIds,
    affectedShotIds,
    affectedLandmarkIds: [],
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
