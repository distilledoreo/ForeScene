import type { StateCreator } from 'zustand';
import type { ContinuityStoreSlices, SessionSliceState } from './types';
import { getSharedContinuityState, pickSlice } from './sharedStore';

const SESSION_PICK = [
  'panoView',
  'isRenderingGraybox',
  'isExportingPackage',
  'shotCameraFlying',
  'pendingSecondCapturePlan',
  'projectedOcclusionStatus',
  'setPanoView',
  'setShotCameraFlying',
  'lockShotCamera',
  'landShotFraming',
  'setExportingPackage',
  'setPendingSecondCapturePlan',
  'setProjectedOcclusionStatus',
] as const satisfies readonly (keyof SessionSliceState)[];

/** Domain slice: transient session UI (fly mode, export flags, pano view). */
export const createSessionSlice: StateCreator<
  ContinuityStoreSlices,
  [],
  [],
  SessionSliceState
> = (set, get) => pickSlice(getSharedContinuityState(set, get), SESSION_PICK);
