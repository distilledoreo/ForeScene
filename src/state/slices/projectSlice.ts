import type { StateCreator } from 'zustand';
import type { ContinuityStoreSlices, ProjectSliceState } from './types';
import { getSharedContinuityState, pickSlice } from './sharedStore';

const PROJECT_PICK = [
  'project',
  'setProject',
  'updateProjectInfo',
  'updateProjectSettings',
  'addObject',
  'addImportedModel',
  'addImportedModels',
  'placeObject',
  'updateObject',
  'moveObjectToGroundPoint',
  'moveObjectPosition',
  'duplicateObject',
  'duplicateSelectedObjects',
  'pasteBuildObjects',
  'removeSelectedObjects',
  'nudgeSelectedObjects',
  'translateSelectedObjectsBy',
  'rotateSelectedObjectsBy',
  'scaleSelectedObjectsBy',
  'toggleSelectedVisibility',
  'toggleSelectedLocked',
  'showAllObjects',
  'toggleObjectVisibility',
  'toggleObjectLocked',
  'removeObject',
  'setPanoOrigin',
  'setPanoRotation',
  'renderGrayboxPano',
  'importCanonicalPano',
  'importStyledPano',
  'removePanoReference',
  'updatePanoReference',
  'addCamera',
  'updateShot',
  'removeShot',
  'reorderShots',
  'copyStagingToNextShot',
  'attachCameraMoveVideoToShot',
  'attachViewportRenderToShot',
  'attachAiResultFrameToShot',
  'attachKeyframePreviewToShot',
  'addLandmark',
  'updateLandmark',
  'toggleShotLandmark',
] as const satisfies readonly (keyof ProjectSliceState)[];

/** Domain slice: persistent project document + mutations. */
export const createProjectSlice: StateCreator<
  ContinuityStoreSlices,
  [],
  [],
  ProjectSliceState
> = (set, get) => pickSlice(getSharedContinuityState(set, get), PROJECT_PICK);
