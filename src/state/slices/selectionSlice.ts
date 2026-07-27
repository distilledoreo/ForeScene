import type { StateCreator } from 'zustand';
import type { ContinuityStoreSlices, SelectionSliceState } from './types';
import { getSharedContinuityState, pickSlice } from './sharedStore';

const SELECTION_PICK = [
  'selectedObjectIds',
  'buildClipboard',
  'buildClipboardPasteCount',
  'selectedShotId',
  'selectedLandmarkId',
  'activePanoId',
  'buildMode',
  'activePrimitive',
  'gridSnap',
  'buildTransformPivot',
  'setBuildMode',
  'setActivePrimitive',
  'setGridSnap',
  'selectObject',
  'selectObjectRange',
  'selectAllObjects',
  'clearObjectSelection',
  'setBuildClipboard',
  'selectShot',
  'setActivePano',
] as const satisfies readonly (keyof SelectionSliceState)[];

/** Domain slice: editor selection + build mode chrome. */
export const createSelectionSlice: StateCreator<
  ContinuityStoreSlices,
  [],
  [],
  SelectionSliceState
> = (set, get) => pickSlice(getSharedContinuityState(set, get), SELECTION_PICK);
