import type { StateCreator } from 'zustand';
import type { ContinuityStoreSlices, HistorySliceState } from './types';
import { getSharedContinuityState, pickSlice } from './sharedStore';

const HISTORY_PICK = [
  'buildHistoryPast',
  'buildHistoryFuture',
  'buildHistoryBatchDepth',
  'buildHistoryBatchCaptured',
  'buildHistoryCoalesceActive',
  'shotCameraHistoryByShotId',
  'shotCameraHistoryBatchDepth',
  'shotCameraHistoryBatchCaptured',
  'shotCameraHistoryRestoreGeneration',
  'beginBuildHistoryBatch',
  'endBuildHistoryBatch',
  'undoBuild',
  'redoBuild',
  'canUndoBuild',
  'canRedoBuild',
  'beginShotCameraHistoryBatch',
  'endShotCameraHistoryBatch',
  'canUndoShotCamera',
  'canRedoShotCamera',
  'undoShotCamera',
  'redoShotCamera',
] as const satisfies readonly (keyof HistorySliceState)[];

/** Domain slice: build + shot-camera undo/redo. */
export const createHistorySlice: StateCreator<
  ContinuityStoreSlices,
  [],
  [],
  HistorySliceState
> = (set, get) => pickSlice(getSharedContinuityState(set, get), HISTORY_PICK);
