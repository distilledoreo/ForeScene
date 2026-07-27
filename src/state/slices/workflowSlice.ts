import type { StateCreator } from 'zustand';
import type { ContinuityStoreSlices, WorkflowSliceState } from './types';
import { getSharedContinuityState, pickSlice } from './sharedStore';

const WORKFLOW_PICK = [
  'workspace',
  'dismissedWorkflowAdvanceKeys',
  'seenObjectiveWorkspaces',
  'objectiveModalRequest',
  'alignmentIntroRequest',
  'alignmentRetryModalRequest',
  'seenAlignmentIntroForPanoId',
  'setWorkspace',
  'approveGrayboxForReference',
  'acceptReferenceAlignment',
  'acceptShotFraming',
  'markAiBriefSent',
  'markFinalPackageExported',
  'dismissWorkflowAdvance',
  'markObjectiveSeen',
  'requestObjectiveModal',
  'requestAlignmentIntro',
  'requestAlignmentRetryModal',
  'markAlignmentIntroSeen',
  'resetWorkflowSession',
] as const satisfies readonly (keyof WorkflowSliceState)[];

/** Domain slice: workspace rail + coaching / objective modals. */
export const createWorkflowSlice: StateCreator<
  ContinuityStoreSlices,
  [],
  [],
  WorkflowSliceState
> = (set, get) => pickSlice(getSharedContinuityState(set, get), WORKFLOW_PICK);
