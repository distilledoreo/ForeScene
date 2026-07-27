import { create } from 'zustand';
import type { ContinuityStoreSlices } from './slices/types';
import { createProjectSlice } from './slices/projectSlice';
import { createSelectionSlice } from './slices/selectionSlice';
import { createHistorySlice } from './slices/historySlice';
import { createWorkflowSlice } from './slices/workflowSlice';
import { createSessionSlice } from './slices/sessionSlice';

export type {
  BuildMode,
  ContinuityStoreSlices,
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

type ContinuityStore = ContinuityStoreSlices;

/**
 * Continuity store composed from domain-focused slice creators:
 * project / selection / history / workflow / session.
 */
export const useContinuityStore = create<ContinuityStore>((...args) => ({
  ...createProjectSlice(...args),
  ...createSelectionSlice(...args),
  ...createHistorySlice(...args),
  ...createWorkflowSlice(...args),
  ...createSessionSlice(...args),
}));
