import type { StateCreator } from 'zustand';
import {
  redoBuildHistory,
  undoBuildHistory,
} from '../../engine/buildHistory';
import {
  getShotCameraHistoryStacks,
  redoShotCameraHistory,
  undoShotCameraHistory,
  withShotCameraHistoryStacks,
} from '../../engine/shotCameraHistory';
import { selectionPivot } from '../../engine/buildSelectionMath';
import type { ContinuityStoreSlices, HistorySliceState } from './types';
import { getHistoryRuntime } from './historyRuntime';

/**
 * History domain slice: build + shot-camera undo/redo, batching, coalescing.
 * Owns history stacks/actions and per-store runtime (coalesce timer, restore flags)
 * via getHistoryRuntime(set) — not module-global restore flags or shared timers.
 */
export const createHistorySlice: StateCreator<
  ContinuityStoreSlices,
  [],
  [],
  HistorySliceState
> = (set, get) => {
  const history = getHistoryRuntime(set, get);

  return {
    buildHistoryPast: [],
    buildHistoryFuture: [],
    buildHistoryBatchDepth: 0,
    buildHistoryBatchCaptured: false,
    buildHistoryCoalesceActive: false,
    shotCameraHistoryByShotId: {},
    shotCameraHistoryBatchDepth: 0,
    shotCameraHistoryBatchCaptured: false,
    shotCameraHistoryRestoreGeneration: 0,

    beginBuildHistoryBatch: () => set((state) => {
      const nextDepth = state.buildHistoryBatchDepth + 1;
      if (nextDepth === 1) {
        history.clearBuildHistoryCoalesceTimer();
        return {
          buildHistoryBatchDepth: nextDepth,
          buildHistoryBatchCaptured: false,
          buildHistoryCoalesceActive: false,
          buildTransformPivot: selectionPivot(
            state.project.scene.objects.filter((object) => state.selectedObjectIds.includes(object.id)),
          ),
        };
      }
      return { buildHistoryBatchDepth: nextDepth };
    }),

    endBuildHistoryBatch: () => set((state) => {
      const nextDepth = Math.max(0, state.buildHistoryBatchDepth - 1);
      return {
        buildHistoryBatchDepth: nextDepth,
        buildHistoryBatchCaptured: nextDepth === 0 ? false : state.buildHistoryBatchCaptured,
        buildTransformPivot: nextDepth === 0 ? undefined : state.buildTransformPivot,
      };
    }),

    canUndoBuild: () => get().buildHistoryPast.length > 0,
    canRedoBuild: () => get().buildHistoryFuture.length > 0,

    undoBuild: () => {
      const state = get();
      const result = undoBuildHistory(
        { past: state.buildHistoryPast, future: state.buildHistoryFuture },
        history.captureCurrentBuildSnapshot(state),
      );
      if (!result) return false;
      history.applyBuildSnapshot(result.restored, result.stacks.past, result.stacks.future);
      return true;
    },

    redoBuild: () => {
      const state = get();
      const result = redoBuildHistory(
        { past: state.buildHistoryPast, future: state.buildHistoryFuture },
        history.captureCurrentBuildSnapshot(state),
      );
      if (!result) return false;
      history.applyBuildSnapshot(result.restored, result.stacks.past, result.stacks.future);
      return true;
    },

    beginShotCameraHistoryBatch: () => set((state) => {
      const nextDepth = state.shotCameraHistoryBatchDepth + 1;
      if (nextDepth === 1) {
        return {
          shotCameraHistoryBatchDepth: nextDepth,
          shotCameraHistoryBatchCaptured: false,
        };
      }
      return { shotCameraHistoryBatchDepth: nextDepth };
    }),

    endShotCameraHistoryBatch: () => set((state) => {
      const nextDepth = Math.max(0, state.shotCameraHistoryBatchDepth - 1);
      return {
        shotCameraHistoryBatchDepth: nextDepth,
        shotCameraHistoryBatchCaptured: nextDepth === 0 ? false : state.shotCameraHistoryBatchCaptured,
      };
    }),

    canUndoShotCamera: () => {
      const state = get();
      if (!state.selectedShotId) return false;
      return getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, state.selectedShotId).past.length > 0;
    },

    canRedoShotCamera: () => {
      const state = get();
      if (!state.selectedShotId) return false;
      return getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, state.selectedShotId).future.length > 0;
    },

    undoShotCamera: () => {
      const state = get();
      const shot = state.project.shots.find((item) => item.id === state.selectedShotId);
      if (!shot) return false;
      const currentStacks = getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, shot.id);
      const result = undoShotCameraHistory(currentStacks, {
        camera: shot.camera,
        cameraKeyframes: shot.cameraKeyframes,
      });
      if (!result) return false;
      history.setShotCameraHistoryRestoring(true);
      try {
        get().updateShot(shot.id, {
          camera: result.restored.camera,
          cameraKeyframes: result.restored.cameraKeyframes,
        }, { cameraHistory: 'silent' });
      } finally {
        history.setShotCameraHistoryRestoring(false);
      }
      set({
        shotCameraHistoryByShotId: withShotCameraHistoryStacks(
          state.shotCameraHistoryByShotId,
          shot.id,
          result.stacks,
        ),
        shotCameraHistoryRestoreGeneration: state.shotCameraHistoryRestoreGeneration + 1,
      });
      return true;
    },

    redoShotCamera: () => {
      const state = get();
      const shot = state.project.shots.find((item) => item.id === state.selectedShotId);
      if (!shot) return false;
      const currentStacks = getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, shot.id);
      const result = redoShotCameraHistory(currentStacks, {
        camera: shot.camera,
        cameraKeyframes: shot.cameraKeyframes,
      });
      if (!result) return false;
      history.setShotCameraHistoryRestoring(true);
      try {
        get().updateShot(shot.id, {
          camera: result.restored.camera,
          cameraKeyframes: result.restored.cameraKeyframes,
        }, { cameraHistory: 'silent' });
      } finally {
        history.setShotCameraHistoryRestoring(false);
      }
      set({
        shotCameraHistoryByShotId: withShotCameraHistoryStacks(
          state.shotCameraHistoryByShotId,
          shot.id,
          result.stacks,
        ),
        shotCameraHistoryRestoreGeneration: state.shotCameraHistoryRestoreGeneration + 1,
      });
      return true;
    },
  };
};
