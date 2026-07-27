/**
 * Domain-focused Continuity store slices.
 * Implementations live in `useContinuityStore`; these modules define the contracts
 * and re-export helpers used when composing/testing slices.
 */

export type {
  BuildMode,
  ContinuityStoreSlices,
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
