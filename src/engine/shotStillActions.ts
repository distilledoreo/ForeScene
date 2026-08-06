/**
 * User/agent actions for prepared stills: regenerate, retry failed, cancel queued work.
 */

import type { LocationProject, Shot } from '../domain/types';
import {
  materializeShotStills,
  type MaterializeShotStillsParams,
  type ShotStillMaterializationResult,
} from './materializeShotStills';
import { renderWorkCoordinator } from './renderWorkCoordinator';
import {
  clearStillArtifactRuntime,
  inspectShotStillRuntime,
  setStillArtifactError,
  setStillArtifactJobStatus,
} from './stillArtifactRuntime';
import type { RenderedStillArtifact } from './stillArtifactRender';
import type { StillArtifactSpecification } from './stillArtifactTypes';

/** Active abort controllers for in-flight shot materialization batches. */
const shotControllers = new Map<string, AbortController>();

export type StillActionRender = (params: {
  project: LocationProject;
  shot: Shot;
  specification: StillArtifactSpecification;
  signal?: AbortSignal;
}) => Promise<RenderedStillArtifact>;

export interface ShotStillActionParams {
  project: LocationProject;
  shotId: string;
  onProjectCommit?: (project: LocationProject) => LocationProject;
  render?: StillActionRender;
}

function bindController(shotId: string): AbortController {
  // Supersede any prior batch for this shot.
  const existing = shotControllers.get(shotId);
  existing?.abort();
  const controller = new AbortController();
  shotControllers.set(shotId, controller);
  return controller;
}

function releaseController(shotId: string, controller: AbortController): void {
  if (shotControllers.get(shotId) === controller) {
    shotControllers.delete(shotId);
  }
}

/**
 * Cancel queued/in-flight still preparation for a shot (or all shots).
 * Does not delete already-committed artifacts.
 */
export function cancelShotStillPreparation(shotId?: string): {
  cancelledShotIds: string[];
  cancelledQueueItems: number;
} {
  const cancelledShotIds: string[] = [];
  if (shotId) {
    const controller = shotControllers.get(shotId);
    if (controller) {
      controller.abort();
      shotControllers.delete(shotId);
      cancelledShotIds.push(shotId);
    }
    clearStillArtifactRuntime(shotId);
  } else {
    for (const [id, controller] of shotControllers) {
      controller.abort();
      cancelledShotIds.push(id);
      clearStillArtifactRuntime(id);
    }
    shotControllers.clear();
  }

  // Drop queued (not yet running) interactive still work from the coordinator.
  const cancelledQueueItems = renderWorkCoordinator.cancelQueued((priority) => {
    return (
      priority === 'capture-primary-still'
      || priority === 'capture-secondary-still'
      || priority === 'edit-primary-still'
      || priority === 'edit-secondary-still'
    );
  });

  return { cancelledShotIds, cancelledQueueItems };
}

/**
 * Regenerate all configured stills for a shot (force re-materialize stale + missing).
 */
export async function regenerateShotStills(
  params: ShotStillActionParams,
): Promise<ShotStillMaterializationResult> {
  const controller = bindController(params.shotId);
  try {
    const status = inspectShotStillRuntime(params.project, params.shotId);
    for (const artifact of status.artifacts) {
      setStillArtifactJobStatus(params.shotId, artifact.key, 'queued');
      setStillArtifactError(params.shotId, artifact.key, null);
    }
    return await materializeShotStills({
      project: params.project,
      shotId: params.shotId,
      reason: 'manual',
      scope: 'all-configured',
      signal: controller.signal,
      onProjectCommit: params.onProjectCommit,
      render: params.render,
    });
  } finally {
    releaseController(params.shotId, controller);
  }
}

/**
 * Retry only failed / missing / stale stills for a shot.
 */
export async function retryFailedShotStills(
  params: ShotStillActionParams,
): Promise<ShotStillMaterializationResult> {
  const controller = bindController(params.shotId);
  try {
    const status = inspectShotStillRuntime(params.project, params.shotId);
    for (const artifact of status.artifacts) {
      if (
        artifact.status === 'failed'
        || artifact.status === 'missing'
        || artifact.status === 'stale'
      ) {
        setStillArtifactJobStatus(params.shotId, artifact.key, 'queued');
        setStillArtifactError(params.shotId, artifact.key, null);
      }
    }
    return await materializeShotStills({
      project: params.project,
      shotId: params.shotId,
      reason: 'manual',
      scope: 'stale-only',
      signal: controller.signal,
      onProjectCommit: params.onProjectCommit,
      render: params.render,
    });
  } finally {
    releaseController(params.shotId, controller);
  }
}

/** Test helper: active shot preparation controllers. */
export function inspectShotStillActionsForTests() {
  return {
    activeShots: [...shotControllers.keys()],
  };
}

export function resetShotStillActionsForTests(): void {
  for (const controller of shotControllers.values()) controller.abort();
  shotControllers.clear();
}
