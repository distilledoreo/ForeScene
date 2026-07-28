import type { StateCreator } from 'zustand';
import type { CameraData } from '../../domain/types';
import { withShotPanoLink } from '../../engine/sync';
import type { ContinuityStoreSlices, SessionSliceState } from './types';

function touchProjectUpdatedAt<T extends { updatedAt: string }>(project: T): T {
  return { ...project, updatedAt: new Date().toISOString() };
}

/**
 * Session domain slice: transient UI (pano view, fly mode, export flags, second-capture plan).
 * Owns its initial state and actions via the Zustand creator closure — not key-picked from the monolith.
 */
export const createSessionSlice: StateCreator<
  ContinuityStoreSlices,
  [],
  [],
  SessionSliceState
> = (set, get) => ({
  panoView: {
    yawDegrees: 0,
    pitchDegrees: 0,
    fovDegrees: 65,
  },
  isRenderingGraybox: false,
  isExportingPackage: false,
  shotCameraFlying: false,
  pendingSecondCapturePlan: undefined,
  projectedOcclusionStatus: 'disabled',

  setPanoView: (updates) => set((state) => ({
    panoView: { ...state.panoView, ...updates },
  })),

  setShotCameraFlying: (value, options) => set((state) => {
    if (!value) return { shotCameraFlying: false };
    const shotId = state.selectedShotId;
    if (!shotId) return { shotCameraFlying: true };
    // Adjusting a still clears acceptance; camera-move end posing can keep it.
    if (options?.clearFramingAcceptance === false) {
      return { shotCameraFlying: true };
    }
    const accepted = { ...state.project.workflow.shotFramingAcceptedAtByShotId };
    delete accepted[shotId];
    return {
      shotCameraFlying: true,
      project: touchProjectUpdatedAt({
        ...state.project,
        workflow: { ...state.project.workflow, shotFramingAcceptedAtByShotId: accepted },
      }),
    };
  }),

  lockShotCamera: () => {
    if (typeof document !== 'undefined' && document.pointerLockElement) {
      document.exitPointerLock();
    }
    set({ shotCameraFlying: false });
  },

  landShotFraming: (shotId, camera, options) => {
    const keepFlying = options?.keepFlying === true;
    // Continuous capture (still camera) stays in fly — don't drop pointer lock.
    if (
      !keepFlying
      && typeof document !== 'undefined'
      && document.pointerLockElement
    ) {
      document.exitPointerLock();
    }
    set((state) => {
      const shot = state.project.shots.find((item) => item.id === shotId);
      if (!shot) return state;
      const nextCamera: CameraData = camera ?? shot.camera;
      return {
        shotCameraFlying: keepFlying ? true : false,
        project: touchProjectUpdatedAt({
          ...state.project,
          shots: state.project.shots.map((item) => {
            if (item.id !== shotId) return item;
            return withShotPanoLink(state.project, {
              ...item,
              camera: nextCamera,
              updatedAt: new Date().toISOString(),
            });
          }),
          workflow: {
            ...state.project.workflow,
            shotFramingAcceptedAtByShotId: {
              ...state.project.workflow.shotFramingAcceptedAtByShotId,
              [shotId]: new Date().toISOString(),
            },
          },
        }),
      };
    });
  },

  setExportingPackage: (value) => set({ isExportingPackage: value }),

  setPendingSecondCapturePlan: (plan) => set({ pendingSecondCapturePlan: plan }),

  setProjectedOcclusionStatus: (status) => set({ projectedOcclusionStatus: status }),
});
