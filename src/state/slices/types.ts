/**
 * Domain-focused project store slice contracts.
 * The composed store (`useProjectStore`) implements all slices together.
 */

import type {
  CameraData,
  Landmark,
  LocationProject,
  PanoReference,
  PanoViewState,
  ProjectAsset,
  SceneObject,
  SceneObjectType,
  Shot,
  Vec3,
  Workspace,
  Euler,
} from '../../domain/types';
import type { ShotStillViewSelection } from '../../domain/shotStillViews';
import type { BuildClipboardPayload } from '../../engine/buildClipboard';
import type { BuildHistoryMode, BuildHistorySnapshot } from '../../engine/buildHistory';
import type { ShotCameraHistoryByShotId } from '../../engine/shotCameraHistory';
import type { SelectionMode } from '../../engine/buildSelectionMath';
import type { PendingSecondCapturePlan } from '../../engine/panoProjectionCore';

export type BuildMode = 'select' | 'place' | 'pano_origin';
export type ShotCameraHistoryMode = 'step' | 'batch' | 'silent';

/** Persistent project document + project mutations. */
export interface ProjectSliceState {
  project: LocationProject;
  setProject: (project: LocationProject) => void;
  updateProjectInfo: (updates: Pick<LocationProject, 'name'> | Partial<Pick<LocationProject, 'name' | 'description'>>) => void;
  updateProjectSettings: (updates: Partial<LocationProject['settings']>) => void;
  addObject: (type: SceneObjectType) => void;
  addImportedModel: (result: { asset: ProjectAsset; object: SceneObject }) => SceneObject;
  addImportedModels: (results: Array<{ asset: ProjectAsset; object: SceneObject }>) => SceneObject[];
  addPoseableCharacterImport: (result: {
    sourceAsset: ProjectAsset;
    rigAsset: ProjectAsset;
    object: SceneObject;
  }) => SceneObject;
  updatePoseableRigAsset: (assetId: string, rig: import('../../domain/types').PoseableRigAsset) => void;
  placeObject: (type: SceneObjectType, point: Vec3) => SceneObject;
  updateObject: (id: string, updates: Partial<SceneObject>, options?: { history?: BuildHistoryMode }) => void;
  moveObjectToGroundPoint: (id: string, point: Vec3) => void;
  moveObjectPosition: (id: string, point: Vec3) => void;
  duplicateObject: (id: string) => SceneObject | undefined;
  duplicateSelectedObjects: () => SceneObject[];
  pasteBuildObjects: (payload: BuildClipboardPayload, options?: { inPlace?: boolean }) => SceneObject[];
  removeSelectedObjects: () => boolean;
  nudgeSelectedObjects: (delta: Vec3) => boolean;
  translateSelectedObjectsBy: (delta: Vec3, options?: { history?: BuildHistoryMode }) => boolean;
  rotateSelectedObjectsBy: (axis: 'x' | 'y' | 'z', degrees: number, options?: { history?: BuildHistoryMode }) => boolean;
  scaleSelectedObjectsBy: (factors: Vec3, options?: { history?: BuildHistoryMode }) => boolean;
  toggleSelectedVisibility: () => boolean;
  toggleSelectedLocked: () => boolean;
  showAllObjects: () => boolean;
  toggleObjectVisibility: (id: string) => void;
  toggleObjectLocked: (id: string) => void;
  removeObject: (id: string) => void;
  setPanoOrigin: (origin: Vec3) => void;
  setPanoRotation: (rotation: Euler) => void;
  renderGrayboxPano: () => Promise<PanoReference>;
  importCanonicalPano: (params: { name: string; dataUrl: string; width?: number; height?: number; importNote?: string }) => void;
  importStyledPano: (params: { name: string; dataUrl: string; width?: number; height?: number; importNote?: string }) => 'first' | 'replace' | 'add_secondary';
  removePanoReference: (id: string) => void;
  updatePanoReference: (id: string, updates: Partial<PanoReference>) => void;
  addCamera: (options?: { navigateToShots?: boolean }) => Shot;
  updateShot: (id: string, updates: Partial<Shot>, options?: { cameraHistory?: ShotCameraHistoryMode }) => void;
  setSceneExportDefaults: (defaults: import('../../domain/types').ShotExportSettings) => void;
  patchSceneExportDefaults: (patch: Partial<import('../../domain/types').ShotExportSettings>) => void;
  setShotExportOverride: (shotId: string, patch: import('../../domain/types').ExportSettingsOverride) => void;
  resetShotExportField: (shotId: string, path: import('../../engine/exportConfiguration').ExportSettingFieldPath) => void;
  resetShotExportOverrides: (shotId: string) => void;
  copyShotExportOverrides: (fromShotId: string, toShotIds: string[]) => void;
  promoteShotExportToSceneDefaults: (shotId: string) => void;
  removeShot: (id: string) => void;
  reorderShots: (shotId: string, targetIndex: number) => void;
  copyStagingToNextShot: (sourceShotId: string) => void;
  attachCameraMoveVideoToShot: (shotId: string, params: {
    name: string;
    dataUrl: string;
    mimeType: string;
    width: number;
    height: number;
    durationSeconds: number;
    frameRate: number;
    encodeMode?: 'render' | 'quickPreview';
    codecString?: string;
    frameCount?: number;
    resolutionPreset?: string;
    validated?: boolean;
  }) => ProjectAsset;
  attachViewportRenderToShot: (shotId: string, params: {
    name: string;
    dataUrl: string;
    width: number;
    height: number;
    stillView?: ShotStillViewSelection;
  }) => ProjectAsset;
  attachAiResultFrameToShot: (shotId: string, params: { name: string; dataUrl: string; width?: number; height?: number }) => ProjectAsset;
  attachKeyframePreviewToShot: (shotId: string, keyframeId: string, dataUrl: string) => ProjectAsset | undefined;
  addLandmark: () => Landmark;
  updateLandmark: (id: string, updates: Partial<Landmark>) => void;
  toggleShotLandmark: (shotId: string, landmarkId: string) => void;
}

/** Editor selection + build mode chrome. */
export interface SelectionSliceState {
  selectedObjectIds: string[];
  buildClipboard?: BuildClipboardPayload;
  buildClipboardPasteCount: number;
  selectedShotId?: string;
  selectedLandmarkId?: string;
  activePanoId?: string;
  buildMode: BuildMode;
  activePrimitive: SceneObjectType;
  gridSnap: boolean;
  buildTransformPivot?: Vec3;
  setBuildMode: (mode: BuildMode) => void;
  setActivePrimitive: (type: SceneObjectType) => void;
  setGridSnap: (value: boolean) => void;
  selectObject: (id?: string, mode?: SelectionMode) => void;
  selectObjectRange: (id: string) => void;
  selectAllObjects: () => void;
  clearObjectSelection: () => void;
  setBuildClipboard: (payload?: BuildClipboardPayload) => void;
  selectShot: (id?: string) => void;
  setActivePano: (id?: string) => void;
}

/** Build + shot-camera undo/redo history. */
export interface HistorySliceState {
  buildHistoryPast: BuildHistorySnapshot[];
  buildHistoryFuture: BuildHistorySnapshot[];
  buildHistoryBatchDepth: number;
  buildHistoryBatchCaptured: boolean;
  buildHistoryCoalesceActive: boolean;
  shotCameraHistoryByShotId: ShotCameraHistoryByShotId;
  shotCameraHistoryBatchDepth: number;
  shotCameraHistoryBatchCaptured: boolean;
  shotCameraHistoryRestoreGeneration: number;
  beginBuildHistoryBatch: () => void;
  endBuildHistoryBatch: () => void;
  undoBuild: () => boolean;
  redoBuild: () => boolean;
  canUndoBuild: () => boolean;
  canRedoBuild: () => boolean;
  beginShotCameraHistoryBatch: () => void;
  endShotCameraHistoryBatch: () => void;
  canUndoShotCamera: () => boolean;
  canRedoShotCamera: () => boolean;
  undoShotCamera: () => boolean;
  redoShotCamera: () => boolean;
}

/** Workflow coaching + objective modals (session + project workflow stamps). */
export interface WorkflowSliceState {
  workspace: Workspace;
  dismissedWorkflowAdvanceKeys: string[];
  seenObjectiveWorkspaces: Workspace[];
  objectiveModalRequest: number;
  alignmentIntroRequest: number;
  alignmentRetryModalRequest: number;
  seenAlignmentIntroForPanoId?: string;
  setWorkspace: (workspace: Workspace) => void;
  approveGrayboxForReference: () => void;
  acceptReferenceAlignment: () => void;
  acceptShotFraming: (shotId: string) => void;
  markAiBriefSent: (shotId: string) => void;
  markFinalPackageExported: (shotId: string) => void;
  dismissWorkflowAdvance: (promptKey: string) => void;
  markObjectiveSeen: (workspace: Workspace) => void;
  requestObjectiveModal: () => void;
  requestAlignmentIntro: () => void;
  requestAlignmentRetryModal: () => void;
  markAlignmentIntroSeen: (panoId: string) => void;
  resetWorkflowSession: () => void;
}

/** Transient session UI (export flags, fly mode, occlusion status, pano view). */
export interface SessionSliceState {
  panoView: PanoViewState;
  isRenderingGraybox: boolean;
  isExportingPackage: boolean;
  shotCameraFlying: boolean;
  pendingSecondCapturePlan: PendingSecondCapturePlan | undefined;
  projectedOcclusionStatus: 'disabled' | 'generating' | 'ready' | 'failed';
  setPanoView: (updates: Partial<PanoViewState>) => void;
  setShotCameraFlying: (value: boolean, options?: { clearFramingAcceptance?: boolean }) => void;
  lockShotCamera: () => void;
  landShotFraming: (shotId: string, camera?: CameraData, options?: { keepFlying?: boolean }) => void;
  setExportingPackage: (value: boolean) => void;
  setPendingSecondCapturePlan: (plan: PendingSecondCapturePlan | undefined) => void;
  setProjectedOcclusionStatus: (status: 'disabled' | 'generating' | 'ready' | 'failed') => void;
}

export type ProjectStoreSlices =
  & ProjectSliceState
  & SelectionSliceState
  & HistorySliceState
  & WorkflowSliceState
  & SessionSliceState;

export type {
  BuildHistoryMode,
  BuildHistorySnapshot,
  ShotCameraHistoryByShotId,
};
