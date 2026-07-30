/**
 * Domain-focused project store slices.
 * Real StateCreator modules compose into `useProjectStore`.
 */

export type {
  BuildMode,
  ProjectStoreSlices,
  HistorySliceState,
  ProjectSliceState,
  SelectionSliceState,
  SessionSliceState,
  ShotCameraHistoryMode,
  WorkflowSliceState,
} from './types';

export {
  PROJECT_SLICE_KEYS,
  SELECTION_SLICE_KEYS,
  HISTORY_SLICE_KEYS,
  WORKFLOW_SLICE_KEYS,
  SESSION_SLICE_KEYS,
} from './keys';

export { createProjectSlice } from './projectSlice';
export { createSelectionSlice } from './selectionSlice';
export { createHistorySlice } from './historySlice';
export { createWorkflowSlice } from './workflowSlice';
export { createSessionSlice } from './sessionSlice';
