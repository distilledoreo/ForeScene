/** Runtime key lists used by structural tests and store selectors. */

export const PROJECT_SLICE_KEYS = [
  'project',
  'setProject',
  'updateProjectInfo',
  'updateProjectSettings',
  'updateShot',
  'setSceneExportDefaults',
  'patchSceneExportDefaults',
  'setShotExportOverride',
  'resetShotExportField',
  'resetShotExportOverrides',
  'copyShotExportOverrides',
  'promoteShotExportToSceneDefaults',
  'setProjectPackageFormat',
  'removeShot',
  'reorderShots',
  'copyStagingToNextShot',
  'attachKeyframePreviewToShot',
] as const;

export const SELECTION_SLICE_KEYS = [
  'selectedObjectIds',
  'selectedShotId',
  'buildMode',
  'selectShot',
  'selectObject',
] as const;

export const HISTORY_SLICE_KEYS = [
  'buildHistoryPast',
  'shotCameraHistoryByShotId',
  'undoBuild',
  'undoShotCamera',
  'shotCameraHistoryRestoreGeneration',
] as const;

export const WORKFLOW_SLICE_KEYS = [
  'workspace',
  'setWorkspace',
  'dismissedWorkflowAdvanceKeys',
  'requestObjectiveModal',
] as const;

export const SESSION_SLICE_KEYS = [
  'shotCameraFlying',
  'isExportingPackage',
  'panoView',
  'projectedOcclusionStatus',
] as const;
