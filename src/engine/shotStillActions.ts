/**
 * User/agent actions for prepared stills: regenerate, retry failed, cancel queued work.
 */

import type { LocationProject, Shot } from '../domain/types';
import {
  materializeShotStills,
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
  getLiveProject?: () => LocationProject;
  commitLiveProject?: (
    updater: (live: LocationProject) => LocationProject,
  ) => LocationProject;
  onProjectCommit?: (project: LocationProject) => LocationProject;
  render?: StillActionRender;
}

function bindController(shotId: string): AbortController {
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

  const cancelledQueueItems = shotId
    ? renderWorkCoordinator.cancelByOwner(shotId)
    : renderWorkCoordinator.cancelQueued((entry) => (
      entry.priority === 'capture-primary-still'
      || entry.priority === 'capture-secondary-still'
      || entry.priority === 'edit-primary-still'
      || entry.priority === 'edit-secondary-still'
    ));

  return { cancelledShotIds, cancelledQueueItems };
}

/** Force-regenerate every currently configured reference, even when fingerprints are current. */
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
      force: true,
      signal: controller.signal,
      getLiveProject: params.getLiveProject,
      commitLiveProject: params.commitLiveProject,
      onProjectCommit: params.onProjectCommit,
      render: params.render,
    });
  } finally {
    releaseController(params.shotId, controller);
  }
}

/** Retry exactly the runtime failed/missing/stale references, forcing those keys only. */
export async function retryFailedShotStills(
  params: ShotStillActionParams,
): Promise<ShotStillMaterializationResult> {
  const controller = bindController(params.shotId);
  try {
    const status = inspectShotStillRuntime(params.project, params.shotId);
    const retryKeys = new Set(
      status.artifacts
        .filter((artifact) => (
          artifact.status === 'failed'
          || artifact.status === 'missing'
          || artifact.status === 'stale'
        ))
        .map((artifact) => artifact.key),
    );

    for (const key of retryKeys) {
      setStillArtifactJobStatus(params.shotId, key, 'queued');
      setStillArtifactError(params.shotId, key, null);
    }

    if (retryKeys.size === 0) {
      return {
        project: params.getLiveProject?.() ?? params.project,
        shotId: params.shotId,
        primaryStillAssetId: status.primary?.assetId,
        status: 'ready',
        artifacts: [],
        warnings: [],
      };
    }

    return await materializeShotStills({
      project: params.project,
      shotId: params.shotId,
      reason: 'manual',
      scope: 'stale-only',
      artifactKeys: retryKeys,
      force: true,
      signal: controller.signal,
      getLiveProject: params.getLiveProject,
      commitLiveProject: params.commitLiveProject,
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