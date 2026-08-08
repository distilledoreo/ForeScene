import { create } from 'zustand';
import { disposeBackgroundVideoService, forgetBackgroundVideosForShot } from '../engine/backgroundVideoService';
import { releaseProjectAssetMemoryForProject } from '../engine/projectAssetStore';
import { cancelShotStillPreparation } from '../engine/shotStillActions';
import { clearStillArtifactRuntime } from '../engine/stillArtifactRuntime';
import type { ProjectStoreSlices } from './slices/types';
import { createProjectSlice } from './slices/projectSlice';
import { createSelectionSlice } from './slices/selectionSlice';
import { createHistorySlice } from './slices/historySlice';
import { createWorkflowSlice } from './slices/workflowSlice';
import { createSessionSlice } from './slices/sessionSlice';
import {
  cancelStillReconciliationForShot,
  ensureStillReconciliationBound,
  rebindStillReconciliation,
  scheduleStillReconciliationAfterProjectChange,
} from './stillReconciliationBridge';

export type {
  BuildMode,
  ProjectStoreSlices,
  ShotCameraHistoryMode,
} from './slices/types';
export type { BuildHistoryMode } from '../engine/buildHistory';
export {
  PROJECT_SLICE_KEYS,
  SELECTION_SLICE_KEYS,
  HISTORY_SLICE_KEYS,
  WORKFLOW_SLICE_KEYS,
  SESSION_SLICE_KEYS,
} from './slices';

export {
  createProjectSlice,
  createSelectionSlice,
  createHistorySlice,
  createWorkflowSlice,
  createSessionSlice,
};

type ProjectStore = ProjectStoreSlices;

export const useProjectStore = create<ProjectStore>((...args) => ({
  ...createProjectSlice(...args),
  ...createSelectionSlice(...args),
  ...createHistorySlice(...args),
  ...createWorkflowSlice(...args),
  ...createSessionSlice(...args),
}));

const reconciliationOptions = () => ({
  getProject: () => useProjectStore.getState().project,
  setProject: (project: ProjectStore['project']) => useProjectStore.setState({ project }),
});

/**
 * Narrow store-level lifecycle bridge for mutations that bypass updateShot/build-scene wrappers.
 * We intentionally watch export configuration and project/shot identity only — not arbitrary
 * camera/object pointer-move state — so interactive authoring does not gain a global watcher.
 */
useProjectStore.subscribe((state, previousState) => {
  const previous = previousState.project;
  const next = state.project;
  if (previous === next) return;

  if (previous.id !== next.id) {
    cancelShotStillPreparation();
    clearStillArtifactRuntime();
    disposeBackgroundVideoService();
    rebindStillReconciliation(reconciliationOptions());
    // Drop only RAM/object-URL residency for the departed project. Durable local
    // bytes remain in IndexedDB so reopening stays instant and local-first.
    releaseProjectAssetMemoryForProject(previous.id);
    return;
  }

  const nextShotIds = new Set(next.shots.map((shot) => shot.id));
  for (const previousShot of previous.shots) {
    if (nextShotIds.has(previousShot.id)) continue;
    cancelShotStillPreparation(previousShot.id);
    clearStillArtifactRuntime(previousShot.id);
    forgetBackgroundVideosForShot(previousShot.id);
    cancelStillReconciliationForShot(previousShot.id);
  }

  if (previous.exportConfiguration !== next.exportConfiguration) {
    ensureStillReconciliationBound(reconciliationOptions());
    scheduleStillReconciliationAfterProjectChange(previous, next);
  }
});