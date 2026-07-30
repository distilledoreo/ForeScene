import type { StateCreator } from 'zustand';
import { panoViewFromCamera } from '../../engine/sync';
import {
  toggleSelectedId,
} from '../../engine/buildSelectionMath';
import type { ProjectStoreSlices, SelectionSliceState } from './types';
import { initialContinuityProject } from './initialProject';

/**
 * Selection domain slice: editor selection, build mode chrome, clipboard, active pano/shot.
 * Owns its initial state and actions via the Zustand creator closure — not key-picked from the monolith.
 * May read project (and other domains) via get(); document mutations stay in project/session slices.
 */
export const createSelectionSlice: StateCreator<
  ProjectStoreSlices,
  [],
  [],
  SelectionSliceState
> = (set, get) => ({
  selectedObjectIds: [],
  buildClipboard: undefined,
  buildClipboardPasteCount: 0,
  selectedShotId: initialContinuityProject.shots[0]?.id,
  selectedLandmarkId: undefined,
  activePanoId: undefined,
  buildMode: 'select',
  activePrimitive: 'box',
  gridSnap: true,
  buildTransformPivot: undefined,

  setBuildMode: (buildMode) => set({ buildMode }),

  setActivePrimitive: (activePrimitive) => set({
    activePrimitive,
    buildMode: 'place',
    selectedObjectIds: [],
  }),

  setGridSnap: (gridSnap) => set({ gridSnap }),

  selectObject: (id, mode = 'replace') => set((state) => {
    if (!id) return { selectedObjectIds: [] };
    if (!state.project.scene.objects.some((object) => object.id === id)) return state;
    if (mode === 'toggle') return { selectedObjectIds: toggleSelectedId(state.selectedObjectIds, id) };
    return { selectedObjectIds: [id] };
  }),

  selectObjectRange: (id) => set((state) => {
    const objects = state.project.scene.objects;
    const targetIndex = objects.findIndex((object) => object.id === id);
    if (targetIndex < 0) return state;
    const anchorId = state.selectedObjectIds.at(-1);
    const anchorIndex = anchorId ? objects.findIndex((object) => object.id === anchorId) : targetIndex;
    const start = Math.min(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex);
    const end = Math.max(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex);
    const range = objects.slice(start, end + 1).map((object) => object.id);
    return { selectedObjectIds: [...new Set([...state.selectedObjectIds, ...range])] };
  }),

  selectAllObjects: () => set((state) => ({
    selectedObjectIds: state.project.scene.objects
      .filter((object) => object.visible && !object.locked)
      .map((object) => object.id),
  })),

  clearObjectSelection: () => set({ selectedObjectIds: [] }),

  setBuildClipboard: (buildClipboard) => set((state) => ({
    buildClipboard,
    buildClipboardPasteCount: state.buildClipboard?.copiedAt === buildClipboard?.copiedAt
      ? state.buildClipboardPasteCount
      : 0,
  })),

  selectShot: (id) => set((state) => {
    const shot = state.project.shots.find((item) => item.id === id);
    if (!shot) return { selectedShotId: id, shotCameraFlying: true };
    return {
      selectedShotId: id,
      activePanoId: shot.linkedPanoId ?? state.activePanoId,
      panoView: panoViewFromCamera(shot.camera),
      // Keep the viewfinder live when switching shots (review via library thumbnails).
      shotCameraFlying: true,
    };
  }),

  setActivePano: (id) => set({ activePanoId: id }),
});
