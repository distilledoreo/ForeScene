import { create } from 'zustand';
import { disposeBackgroundVideoService, forgetBackgroundVideosForShot } from '../engine/backgroundVideoService';
import { bindLiveProjectAccess } from '../engine/liveProjectAccess';
import {
  releaseProjectAssetMemoryForProject,
  setProjectAssetMemoryActiveProject,
  synchronizeAuthoritativeProjectAssetKeys,
} from '../engine/projectAssetStore';
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

bindLiveProjectAccess({
  getProject: () => useProjectStore.getState().project,
  commitProject: (updater) => {
    useProjectStore.setState((state) => ({
      project: updater(state.project),
    }));
    return useProjectStore.getState().project;
  },
});

const reconciliationOptions = () => ({
  getProject: () => useProjectStore.getState().project,
  setProject: (project: ProjectStore['project']) => useProjectStore.setState({ project }),
});

function protectProjectAssets(project: ProjectStore['project']): void {
  void synchronizeAuthoritativeProjectAssetKeys(project).catch((error: unknown) => {
    // A damaged history must not become an unhandled startup rejection. The
    // synchronizer remains fail-closed: it never removes existing protections.
    console.warn('Could not synchronize retained project asset protection.', error);
  });
}

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
    releaseProjectAssetMemoryForProject(previous.id);
    setProjectAssetMemoryActiveProject(next.id);
    protectProjectAssets(next);
    return;
  }

  if (previous.assets !== next.assets) {
    protectProjectAssets(next);
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

// Keep the currently open project's decoded media warm while allowing
// temporary/imported/agent payloads to be reclaimed by the asset-store LRU.
setProjectAssetMemoryActiveProject(useProjectStore.getState().project.id);
protectProjectAssets(useProjectStore.getState().project);
