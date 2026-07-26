import { create } from 'zustand';
import {
  CameraData,
  Euler,
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
} from '../domain/types';
import { shotStillViewAssetKey, type ShotStillViewSelection } from '../domain/shotStillViews';
import {
  createDefaultProject,
  createLandmark,
  createOriginShot,
  createPanoAsset,
  createPanoReference,
  createSceneObject,
  createShot,
  createVideoAsset,
  DEFAULT_GRAYBOX_PANO_HEIGHT,
  DEFAULT_GRAYBOX_PANO_WIDTH,
  normalizeProjectSettings,
  normalizeProjectedStyleSettings,
} from '../domain/defaults';
import {
  isCaptureOriginNearPano,
  primaryStyledPano,
  resolveStyledImportMode,
  type PendingSecondCapturePlan,
} from '../engine/panoProjectionCore';
import { findGrayboxNearOrigin } from '../domain/selectors';
import {
  getCanonicalPano,
  getPanoCropSettingsForShot,
  linkAllShotsToCanonicalPano,
  panoViewFromCamera,
  withShotPanoLink,
  yawPitchToDirection,
  add,
  multiplyScalar,
} from '../engine/sync';
import { pruneUnreferencedProjectAssets } from '../engine/projectAssets';
import { storeProjectAssetBlob, storeProjectAssetDataUrl } from '../engine/projectAssetStore';
import {
  BUILD_HISTORY_COALESCE_MS,
  type BuildHistoryMode,
  type BuildHistorySnapshot,
  buildSnapshotsEqual,
  captureBuildSnapshot,
  clearBuildHistory,
  pushBuildHistoryPast,
  redoBuildHistory,
  undoBuildHistory,
  vec3NearlyEqual,
} from '../engine/buildHistory';
import {
  cameraDataEqual,
  clearAllShotCameraHistory,
  getShotCameraHistoryStacks,
  pushShotCameraHistoryPast,
  redoShotCameraHistory,
  undoShotCameraHistory,
  withShotCameraHistoryStacks,
  type ShotCameraHistoryByShotId,
} from '../engine/shotCameraHistory';

import { useThemeStore } from './useThemeStore';
import { createPlacedSceneObject, duplicateSceneObject, getGroundPlacementPosition, snapBuildPoint } from '../engine/sandboxCore';
import { normalizeWorkspace } from '../engine/workflow';
import {
  BuildClipboardPayload,
  pasteBuildClipboardObjects,
  pasteBuildClipboardObjectsWithAssets,
} from '../engine/buildClipboard';
import {
  normalizeSelectedIds,
  rotateSelectedObjects,
  scaleSelectedObjects,
  selectionPivot,
  SelectionMode,
  toggleSelectedId,
  translateSelectedObjects,
} from '../engine/buildSelectionMath';

export type BuildMode = 'select' | 'place' | 'pano_origin';
export type { BuildHistoryMode };
export type ShotCameraHistoryMode = 'step' | 'batch' | 'silent';

/** Only the coalesce timer stays outside the store (cannot serialize Timeout handles cleanly). */
let buildHistoryCoalesceTimer: ReturnType<typeof setTimeout> | undefined;
let buildHistoryRestoring = false;
let shotCameraHistoryRestoring = false;

function clearBuildHistoryCoalesceTimer() {
  if (buildHistoryCoalesceTimer) {
    clearTimeout(buildHistoryCoalesceTimer);
    buildHistoryCoalesceTimer = undefined;
  }
}

interface ContinuityStore {
  project: LocationProject;
  workspace: Workspace;
  selectedObjectIds: string[];
  buildClipboard?: BuildClipboardPayload;
  buildClipboardPasteCount: number;
  selectedShotId?: string;
  selectedLandmarkId?: string;
  activePanoId?: string;
  panoView: PanoViewState;
  buildMode: BuildMode;
  activePrimitive: SceneObjectType;
  gridSnap: boolean;
  isRenderingGraybox: boolean;
  isExportingPackage: boolean;
  shotCameraFlying: boolean;
  buildHistoryPast: BuildHistorySnapshot[];
  buildHistoryFuture: BuildHistorySnapshot[];
  buildHistoryBatchDepth: number;
  buildHistoryBatchCaptured: boolean;
  buildHistoryCoalesceActive: boolean;
  buildTransformPivot?: Vec3;
  shotCameraHistoryByShotId: ShotCameraHistoryByShotId;
  shotCameraHistoryBatchDepth: number;
  shotCameraHistoryBatchCaptured: boolean;
  /** Bumps on undo/redo so live framing can reseed from the restored stored pose. */
  shotCameraHistoryRestoreGeneration: number;
  setWorkspace: (workspace: Workspace) => void;
  setProject: (project: LocationProject) => void;
  updateProjectInfo: (updates: Pick<LocationProject, 'name'> | Partial<Pick<LocationProject, 'name' | 'description'>>) => void;
  updateProjectSettings: (updates: Partial<LocationProject['settings']>) => void;
  setBuildMode: (mode: BuildMode) => void;
  setActivePrimitive: (type: SceneObjectType) => void;
  setGridSnap: (value: boolean) => void;
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
  addObject: (type: SceneObjectType) => void;
  addImportedModel: (result: { asset: ProjectAsset; object: SceneObject }) => SceneObject;
  addImportedModels: (results: Array<{ asset: ProjectAsset; object: SceneObject }>) => SceneObject[];
  placeObject: (type: SceneObjectType, point: Vec3) => SceneObject;
  selectObject: (id?: string, mode?: SelectionMode) => void;
  selectObjectRange: (id: string) => void;
  selectAllObjects: () => void;
  clearObjectSelection: () => void;
  setBuildClipboard: (payload?: BuildClipboardPayload) => void;
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
  /** Capture-origin yaw/orientation for new graybox captures (does not rewrite existing panos). */
  setPanoRotation: (rotation: Euler) => void;
  renderGrayboxPano: () => Promise<PanoReference>;
  importCanonicalPano: (params: { name: string; dataUrl: string; width?: number; height?: number; importNote?: string }) => void;
  /** Origin-aware import: replace at same capture, or add a secondary blend partner when origin moved. */
  importStyledPano: (params: { name: string; dataUrl: string; width?: number; height?: number; importNote?: string }) => 'first' | 'replace' | 'add_secondary';
  /**
   * Frozen plan for the next secondary styled import (suggest or manual place).
   * Forces add_secondary and stamps the secondary with plan.origin / plan.rotation.
   */
  pendingSecondCapturePlan: PendingSecondCapturePlan | undefined;
  setPendingSecondCapturePlan: (plan: PendingSecondCapturePlan | undefined) => void;
  removePanoReference: (id: string) => void;
  setActivePano: (id?: string) => void;
  updatePanoReference: (id: string, updates: Partial<PanoReference>) => void;
  setPanoView: (updates: Partial<PanoViewState>) => void;
  addCamera: (options?: { navigateToShots?: boolean }) => Shot;
  selectShot: (id?: string) => void;
  setShotCameraFlying: (value: boolean, options?: { clearFramingAcceptance?: boolean }) => void;
  lockShotCamera: () => void;
  /** Commit framing: exit fly mode and mark shot framing accepted. */
  /** Commit camera + framing acceptance. By default exits fly; pass keepFlying for continuous capture. */
  landShotFraming: (shotId: string, camera?: CameraData, options?: { keepFlying?: boolean }) => void;
  updateShot: (id: string, updates: Partial<Shot>, options?: { cameraHistory?: ShotCameraHistoryMode }) => void;
  removeShot: (id: string) => void;
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
    /** Which still view slot to fill; defaults to clay with people. */
    stillView?: ShotStillViewSelection;
  }) => ProjectAsset;
  attachAiResultFrameToShot: (shotId: string, params: { name: string; dataUrl: string; width?: number; height?: number }) => ProjectAsset;
  addLandmark: () => Landmark;
  updateLandmark: (id: string, updates: Partial<Landmark>) => void;
  toggleShotLandmark: (shotId: string, landmarkId: string) => void;
  setExportingPackage: (value: boolean) => void;
  approveGrayboxForReference: () => void;
  acceptReferenceAlignment: () => void;
  acceptShotFraming: (shotId: string) => void;
  markAiBriefSent: (shotId: string) => void;
  markFinalPackageExported: (shotId: string) => void;
  dismissedWorkflowAdvanceKeys: string[];
  seenObjectiveWorkspaces: Workspace[];
  objectiveModalRequest: number;
  alignmentIntroRequest: number;
  alignmentRetryModalRequest: number;
  seenAlignmentIntroForPanoId?: string;
  /** Live projected-style occlusion status reported by the viewport. */
  projectedOcclusionStatus: 'disabled' | 'generating' | 'ready' | 'failed';
  setProjectedOcclusionStatus: (status: 'disabled' | 'generating' | 'ready' | 'failed') => void;
  dismissWorkflowAdvance: (promptKey: string) => void;
  markObjectiveSeen: (workspace: Workspace) => void;
  requestObjectiveModal: () => void;
  requestAlignmentIntro: () => void;
  requestAlignmentRetryModal: () => void;
  markAlignmentIntroSeen: (panoId: string) => void;
  resetWorkflowSession: () => void;
}

const initialProject = createDefaultProject();

export const useContinuityStore = create<ContinuityStore>((set, get) => ({
  project: initialProject,
  workspace: 'build',
  selectedObjectIds: [],
  buildClipboard: undefined,
  buildClipboardPasteCount: 0,
  selectedShotId: initialProject.shots[0]?.id,
  selectedLandmarkId: undefined,
  activePanoId: undefined,
  panoView: {
    yawDegrees: 0,
    pitchDegrees: 0,
    fovDegrees: 65,
  },
  buildMode: 'select',
  activePrimitive: 'box',
  gridSnap: true,
  isRenderingGraybox: false,
  isExportingPackage: false,
  shotCameraFlying: false,
  buildHistoryPast: [],
  buildHistoryFuture: [],
  buildHistoryBatchDepth: 0,
  buildHistoryBatchCaptured: false,
  buildHistoryCoalesceActive: false,
  buildTransformPivot: undefined,
  shotCameraHistoryByShotId: {},
  shotCameraHistoryBatchDepth: 0,
  shotCameraHistoryBatchCaptured: false,
  shotCameraHistoryRestoreGeneration: 0,
  dismissedWorkflowAdvanceKeys: [],
  seenObjectiveWorkspaces: [],
  objectiveModalRequest: 0,
  alignmentIntroRequest: 0,
  alignmentRetryModalRequest: 0,
  seenAlignmentIntroForPanoId: undefined,
  pendingSecondCapturePlan: undefined,
  setPendingSecondCapturePlan: (plan) => set({ pendingSecondCapturePlan: plan }),

  projectedOcclusionStatus: 'disabled',
  setProjectedOcclusionStatus: (status) => set({ projectedOcclusionStatus: status }),

  beginBuildHistoryBatch: () => set((state) => {
    const nextDepth = state.buildHistoryBatchDepth + 1;
    if (nextDepth === 1) {
      clearBuildHistoryCoalesceTimer();
      return {
        buildHistoryBatchDepth: nextDepth,
        buildHistoryBatchCaptured: false,
        buildHistoryCoalesceActive: false,
        buildTransformPivot: selectionPivot(
          state.project.scene.objects.filter((object) => state.selectedObjectIds.includes(object.id)),
        ),
      };
    }
    return { buildHistoryBatchDepth: nextDepth };
  }),
  endBuildHistoryBatch: () => set((state) => {
    const nextDepth = Math.max(0, state.buildHistoryBatchDepth - 1);
    return {
      buildHistoryBatchDepth: nextDepth,
      buildHistoryBatchCaptured: nextDepth === 0 ? false : state.buildHistoryBatchCaptured,
      buildTransformPivot: nextDepth === 0 ? undefined : state.buildTransformPivot,
    };
  }),
  canUndoBuild: () => get().buildHistoryPast.length > 0,
  canRedoBuild: () => get().buildHistoryFuture.length > 0,
  undoBuild: () => {
    const state = get();
    const result = undoBuildHistory(
      { past: state.buildHistoryPast, future: state.buildHistoryFuture },
      captureCurrentBuildSnapshot(state),
    );
    if (!result) return false;
    applyBuildSnapshot(result.restored, result.stacks.past, result.stacks.future);
    return true;
  },
  redoBuild: () => {
    const state = get();
    const result = redoBuildHistory(
      { past: state.buildHistoryPast, future: state.buildHistoryFuture },
      captureCurrentBuildSnapshot(state),
    );
    if (!result) return false;
    applyBuildSnapshot(result.restored, result.stacks.past, result.stacks.future);
    return true;
  },
  beginShotCameraHistoryBatch: () => set((state) => {
    const nextDepth = state.shotCameraHistoryBatchDepth + 1;
    if (nextDepth === 1) {
      return {
        shotCameraHistoryBatchDepth: nextDepth,
        shotCameraHistoryBatchCaptured: false,
      };
    }
    return { shotCameraHistoryBatchDepth: nextDepth };
  }),
  endShotCameraHistoryBatch: () => set((state) => {
    const nextDepth = Math.max(0, state.shotCameraHistoryBatchDepth - 1);
    return {
      shotCameraHistoryBatchDepth: nextDepth,
      shotCameraHistoryBatchCaptured: nextDepth === 0 ? false : state.shotCameraHistoryBatchCaptured,
    };
  }),
  canUndoShotCamera: () => {
    const state = get();
    if (!state.selectedShotId) return false;
    return getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, state.selectedShotId).past.length > 0;
  },
  canRedoShotCamera: () => {
    const state = get();
    if (!state.selectedShotId) return false;
    return getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, state.selectedShotId).future.length > 0;
  },
  undoShotCamera: () => {
    const state = get();
    const shot = state.project.shots.find((item) => item.id === state.selectedShotId);
    if (!shot) return false;
    const currentStacks = getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, shot.id);
    const result = undoShotCameraHistory(currentStacks, shot.camera);
    if (!result) return false;
    shotCameraHistoryRestoring = true;
    get().updateShot(shot.id, { camera: result.restored }, { cameraHistory: 'silent' });
    shotCameraHistoryRestoring = false;
    set({
      shotCameraHistoryByShotId: withShotCameraHistoryStacks(
        state.shotCameraHistoryByShotId,
        shot.id,
        result.stacks,
      ),
      shotCameraHistoryRestoreGeneration: state.shotCameraHistoryRestoreGeneration + 1,
    });
    return true;
  },
  redoShotCamera: () => {
    const state = get();
    const shot = state.project.shots.find((item) => item.id === state.selectedShotId);
    if (!shot) return false;
    const currentStacks = getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, shot.id);
    const result = redoShotCameraHistory(currentStacks, shot.camera);
    if (!result) return false;
    shotCameraHistoryRestoring = true;
    get().updateShot(shot.id, { camera: result.restored }, { cameraHistory: 'silent' });
    shotCameraHistoryRestoring = false;
    set({
      shotCameraHistoryByShotId: withShotCameraHistoryStacks(
        state.shotCameraHistoryByShotId,
        shot.id,
        result.stacks,
      ),
      shotCameraHistoryRestoreGeneration: state.shotCameraHistoryRestoreGeneration + 1,
    });
    return true;
  },

  setWorkspace: (workspace) => {
    workspace = normalizeWorkspace(workspace);
    const state = get();
    let clearExportingPackage = false;
    if (
      state.isExportingPackage
      && state.workspace === 'export'
      && workspace !== 'export'
    ) {
      // Catch nav chrome, workflow guidance, and any other setWorkspace callers.
      const confirmed = typeof globalThis.confirm === 'function'
        && globalThis.confirm('An export is currently running. Cancel it and leave?');
      if (!confirmed) return;
      clearExportingPackage = true;
    }

    set((current) => {
      if (workspace !== 'shots') {
        return {
          workspace,
          ...(clearExportingPackage ? { isExportingPackage: false } : {}),
        };
      }
      const project = ensureProjectHasCamera(current.project);
      const shot = project.shots.find((item) => item.id === current.selectedShotId)
        ?? project.shots[0];
      return {
        workspace,
        project,
        selectedShotId: shot.id,
        activePanoId: shot.linkedPanoId ?? current.activePanoId,
        panoView: panoViewFromCamera(shot.camera),
        // Still camera is always live (phone-camera style); capture does not freeze.
        shotCameraFlying: true,
        ...(clearExportingPackage ? { isExportingPackage: false } : {}),
      };
    });
  },
  setProject: (project) => {
    const linkedProject = pruneUnreferencedProjectAssets(linkAllShotsToCanonicalPano(project));
    const canonical = linkedProject.panoRefs.find((pano) => pano.isCanonical) ?? linkedProject.panoRefs[0];
    const firstShot = linkedProject.shots[0];
    const cleared = clearBuildHistory();
    clearBuildHistoryCoalesceTimer();
    set({
      project: linkedProject,
      activePanoId: canonical?.id,
      selectedObjectIds: project.scene.objects[0] ? [project.scene.objects[0].id] : [],
      selectedShotId: firstShot?.id,
      selectedLandmarkId: linkedProject.landmarks[0]?.id,
      buildMode: 'select',
      activePrimitive: 'box',
      gridSnap: true,
      // Full session reset so import never inherits fly/busy state from the previous project.
      shotCameraFlying: false,
      isRenderingGraybox: false,
      isExportingPackage: false,
      buildHistoryPast: cleared.past,
      buildHistoryFuture: cleared.future,
      buildHistoryBatchDepth: 0,
      buildHistoryBatchCaptured: false,
      buildHistoryCoalesceActive: false,
      buildTransformPivot: undefined,
      buildClipboardPasteCount: 0,
      panoView: firstShot
        ? panoViewFromCamera(firstShot.camera)
        : { yawDegrees: 0, pitchDegrees: 0, fovDegrees: 65 },
      dismissedWorkflowAdvanceKeys: [],
      seenObjectiveWorkspaces: [],
      objectiveModalRequest: 0,
      alignmentIntroRequest: 0,
      alignmentRetryModalRequest: 0,
      seenAlignmentIntroForPanoId: undefined,
      pendingSecondCapturePlan: undefined,
      shotCameraHistoryByShotId: clearAllShotCameraHistory(),
      shotCameraHistoryBatchDepth: 0,
      shotCameraHistoryBatchCaptured: false,
      shotCameraHistoryRestoreGeneration: 0,
    });
  },
  updateProjectInfo: (updates) => set((state) => ({
    project: touchProject({ ...state.project, ...updates }),
  })),
  updateProjectSettings: (updates) => set((state) => ({
    project: touchProject({
      ...state.project,
      settings: normalizeProjectSettings({
        ...state.project.settings,
        ...updates,
        projectedStyle: updates.projectedStyle !== undefined
          ? updates.projectedStyle
          : state.project.settings.projectedStyle,
      }),
    }),
  })),
  setBuildMode: (buildMode) => set({ buildMode }),
  setActivePrimitive: (activePrimitive) => set({
    activePrimitive,
    buildMode: 'place',
    selectedObjectIds: [],
  }),
  setGridSnap: (gridSnap) => set({ gridSnap }),
  addObject: (type) => set((state) => {
    const count = state.project.scene.objects.filter((object) => object.type === type).length + 1;
    const object = createSceneObject(type, count);
    const objects = [...state.project.scene.objects, object];
    return applyBuildSceneChange(state, {
      objects,
      selectedObjectIds: [object.id],
      history: 'step',
    });
  }),
  addImportedModel: ({ asset, object }) => {
    set((state) => applyBuildSceneChange(state, {
      objects: [...state.project.scene.objects, object],
      assets: {
        assets: {
          ...state.project.assets.assets,
          [asset.id]: asset,
        },
      },
      selectedObjectIds: [object.id],
      history: 'step',
      extra: { buildMode: 'select' },
    }));
    return object;
  },
  addImportedModels: (results) => {
    if (results.length === 0) return [];
    set((state) => {
      const nextAssets: Record<string, ProjectAsset> = { ...state.project.assets.assets };
      const nextObjects: SceneObject[] = [...state.project.scene.objects];
      for (const { asset, object } of results) {
        nextAssets[asset.id] = asset;
        nextObjects.push(object);
      }
      return applyBuildSceneChange(state, {
        objects: nextObjects,
        assets: { assets: nextAssets },
        selectedObjectIds: results.map((r) => r.object.id),
        history: 'step',
        extra: { buildMode: 'select' },
      });
    });
    return results.map((r) => r.object);
  },
  placeObject: (type, point) => {
    const state = get();
    const count = state.project.scene.objects.filter((object) => object.type === type).length + 1;
    const object = createPlacedSceneObject({
      type,
      index: count,
      point,
      snapToGrid: state.gridSnap,
    });
    set((current) => applyBuildSceneChange(current, {
      objects: [...current.project.scene.objects, object],
      history: 'step',
      extra: { buildMode: 'place' },
    }));
    return object;
  },
  selectObject: (id, mode = 'replace') => set((state) => {
    if (!id) return { selectedObjectIds: [] };
    if (!state.project.scene.objects.some((object) => object.id === id)) return state;
    if (mode === 'toggle') return { selectedObjectIds: toggleSelectedId(state.selectedObjectIds, id) };
    return { selectedObjectIds: [id] };
  }),
  selectObjectRange: (id) => set((state) => {
    const objects = state.project.scene.objects;
    const targetIndex = objects.findIndex((object) => object.id === id);
    if (targetIndex < 0) return state;
    const anchorId = state.selectedObjectIds.at(-1);
    const anchorIndex = anchorId ? objects.findIndex((object) => object.id === anchorId) : targetIndex;
    const start = Math.min(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex);
    const end = Math.max(anchorIndex < 0 ? targetIndex : anchorIndex, targetIndex);
    const range = objects.slice(start, end + 1).map((object) => object.id);
    return { selectedObjectIds: [...new Set([...state.selectedObjectIds, ...range])] };
  }),
  selectAllObjects: () => set((state) => ({
    selectedObjectIds: state.project.scene.objects
      .filter((object) => object.visible && !object.locked)
      .map((object) => object.id),
  })),
  clearObjectSelection: () => set({ selectedObjectIds: [] }),
  setBuildClipboard: (buildClipboard) => set((state) => ({
    buildClipboard,
    buildClipboardPasteCount: state.buildClipboard?.copiedAt === buildClipboard?.copiedAt
      ? state.buildClipboardPasteCount
      : 0,
  })),
  updateObject: (id, updates, options) => set((state) => {
    const existing = state.project.scene.objects.find((object) => object.id === id);
    if (!existing) return state;
    const nextObject = { ...existing, ...updates };
    if (JSON.stringify(existing) === JSON.stringify(nextObject)) return state;
    const objects = state.project.scene.objects.map((object) => (
      object.id === id ? nextObject : object
    ));
    return applyBuildSceneChange(state, {
      objects,
      history: options?.history ?? 'step',
    });
  }),
  moveObjectToGroundPoint: (id, point) => set((state) => {
    const object = state.project.scene.objects.find((item) => item.id === id);
    if (!object || object.locked) return state;
    const position = getGroundPlacementPosition(object, point, state.gridSnap);
    if (vec3NearlyEqual(object.transform.position, position)) return state;
    const objects = state.project.scene.objects.map((item) => item.id === id
      ? { ...item, transform: { ...item.transform, position } }
      : item);
    return applyBuildSceneChange(state, { objects, history: 'step' });
  }),
  moveObjectPosition: (id, point) => set((state) => {
    const object = state.project.scene.objects.find((item) => item.id === id);
    if (!object || object.locked) return state;
    const snapped = state.gridSnap
      ? [snapBuildPoint(point, true)[0], point[1], snapBuildPoint(point, true)[2]] as Vec3
      : point;
    if (vec3NearlyEqual(object.transform.position, snapped)) return state;
    const objects = state.project.scene.objects.map((item) => item.id === id
      ? { ...item, transform: { ...item.transform, position: snapped } }
      : item);
    return applyBuildSceneChange(state, { objects, history: 'step' });
  }),
  duplicateObject: (id) => {
    const state = get();
    const object = state.project.scene.objects.find((item) => item.id === id);
    if (!object) return undefined;
    const count = state.project.scene.objects.filter((item) => item.type === object.type).length + 1;
    const duplicate = duplicateSceneObject(object, count, state.gridSnap);
    set((current) => applyBuildSceneChange(current, {
      objects: [...current.project.scene.objects, duplicate],
      selectedObjectIds: [duplicate.id],
      history: 'step',
      extra: { buildMode: 'select' },
    }));
    return duplicate;
  },
  duplicateSelectedObjects: () => {
    const state = get();
    const selected = state.project.scene.objects.filter((object) => state.selectedObjectIds.includes(object.id));
    if (selected.length === 0) return [];
    const payload: BuildClipboardPayload = {
      kind: 'panoref/build-objects',
      version: 2 as any,
      sourceProjectId: state.project.id,
      copiedAt: new Date().toISOString(),
      anchor: [0, 0, 0],
      objects: selected,
    };
    const duplicates = pasteBuildClipboardObjects({
      payload,
      existingObjects: state.project.scene.objects,
      existingAssets: state.project.assets,
      pasteIndex: 1,
      snapToGrid: state.gridSnap,
    });
    set((current) => applyBuildSceneChange(current, {
      objects: [...current.project.scene.objects, ...duplicates],
      selectedObjectIds: duplicates.map((object) => object.id),
      history: 'step',
      extra: { buildMode: 'select' },
    }));
    return duplicates;
  },
  pasteBuildObjects: (payload, options) => {
    const state = get();
    const samePayload = state.buildClipboard?.copiedAt === payload.copiedAt;
    const pasteIndex = options?.inPlace ? 0 : (samePayload ? state.buildClipboardPasteCount + 1 : 1);
    const { objects: pasted, assets: pastedAssets } = pasteBuildClipboardObjectsWithAssets({
      payload,
      existingObjects: state.project.scene.objects,
      existingAssets: state.project.assets,
      pasteIndex,
      snapToGrid: state.gridSnap,
      inPlace: options?.inPlace,
    });
    set((current) => applyBuildSceneChange(current, {
      objects: [...current.project.scene.objects, ...pasted],
      assets: pastedAssets && Object.keys(pastedAssets).length > 0
        ? { assets: { ...current.project.assets.assets, ...pastedAssets } }
        : undefined,
      selectedObjectIds: pasted.map((object) => object.id),
      history: 'step',
      extra: {
        buildMode: 'select',
        buildClipboard: payload,
        buildClipboardPasteCount: options?.inPlace
          ? (samePayload ? current.buildClipboardPasteCount : 0)
          : pasteIndex,
      },
    }));
    return pasted;
  },
  removeSelectedObjects: () => {
    const state = get();
    const selected = state.project.scene.objects.filter((object) => state.selectedObjectIds.includes(object.id));
    if (selected.length === 0 || selected.some((object) => object.locked)) return false;
    const ids = new Set(state.selectedObjectIds);
    set((current) => applyBuildSceneChange(current, {
      objects: current.project.scene.objects.filter((object) => !ids.has(object.id)),
      selectedObjectIds: [],
      history: 'step',
    }));
    return true;
  },
  nudgeSelectedObjects: (delta) => get().translateSelectedObjectsBy(delta),
  translateSelectedObjectsBy: (delta, options) => {
    const state = get();
    const selected = state.project.scene.objects.filter((object) => state.selectedObjectIds.includes(object.id));
    if (selected.length === 0 || selected.some((object) => object.locked)) return false;
    set((current) => applyBuildSceneChange(current, {
      objects: translateSelectedObjects(current.project.scene.objects, current.selectedObjectIds, delta, current.gridSnap),
      history: options?.history ?? 'step',
    }));
    return true;
  },
  rotateSelectedObjectsBy: (axis, degrees, options) => {
    const state = get();
    const selected = state.project.scene.objects.filter((object) => state.selectedObjectIds.includes(object.id));
    if (selected.length === 0 || selected.some((object) => object.locked)) return false;
    set((current) => applyBuildSceneChange(current, {
      objects: rotateSelectedObjects(
        current.project.scene.objects,
        current.selectedObjectIds,
        axis,
        degrees,
        current.buildTransformPivot,
      ),
      history: options?.history ?? 'step',
    }));
    return true;
  },
  scaleSelectedObjectsBy: (factors, options) => {
    const state = get();
    const selected = state.project.scene.objects.filter((object) => state.selectedObjectIds.includes(object.id));
    if (selected.length === 0 || selected.some((object) => object.locked)) return false;
    set((current) => applyBuildSceneChange(current, {
      objects: scaleSelectedObjects(
        current.project.scene.objects,
        current.selectedObjectIds,
        factors,
        current.buildTransformPivot,
      ),
      history: options?.history ?? 'step',
    }));
    return true;
  },
  toggleSelectedVisibility: () => {
    const state = get();
    if (state.selectedObjectIds.length === 0) return false;
    const ids = new Set(state.selectedObjectIds);
    const shouldShow = state.project.scene.objects.some((object) => ids.has(object.id) && !object.visible);
    set((current) => applyBuildSceneChange(current, {
      objects: current.project.scene.objects.map((object) => ids.has(object.id) ? { ...object, visible: shouldShow } : object),
      selectedObjectIds: shouldShow ? current.selectedObjectIds : [],
      history: 'step',
    }));
    return true;
  },
  toggleSelectedLocked: () => {
    const state = get();
    if (state.selectedObjectIds.length === 0) return false;
    const ids = new Set(state.selectedObjectIds);
    const shouldLock = state.project.scene.objects.some((object) => ids.has(object.id) && !object.locked);
    set((current) => applyBuildSceneChange(current, {
      objects: current.project.scene.objects.map((object) => ids.has(object.id) ? { ...object, locked: shouldLock } : object),
      history: 'step',
    }));
    return true;
  },
  showAllObjects: () => {
    const state = get();
    if (!state.project.scene.objects.some((object) => !object.visible)) return false;
    set((current) => applyBuildSceneChange(current, {
      objects: current.project.scene.objects.map((object) => ({ ...object, visible: true })),
      history: 'step',
    }));
    return true;
  },
  toggleObjectVisibility: (id) => set((state) => {
    const object = state.project.scene.objects.find((item) => item.id === id);
    if (!object) return state;
    const objects = state.project.scene.objects.map((item) => item.id === id
      ? { ...item, visible: !item.visible }
      : item);
    return applyBuildSceneChange(state, { objects, history: 'step' });
  }),
  toggleObjectLocked: (id) => set((state) => {
    const object = state.project.scene.objects.find((item) => item.id === id);
    if (!object) return state;
    const objects = state.project.scene.objects.map((item) => item.id === id
      ? { ...item, locked: !item.locked }
      : item);
    return applyBuildSceneChange(state, { objects, history: 'step' });
  }),
  removeObject: (id) => set((state) => {
    if (!state.project.scene.objects.some((object) => object.id === id)) return state;
    const objects = state.project.scene.objects.filter((object) => object.id !== id);
    return applyBuildSceneChange(state, {
      objects,
      selectedObjectIds: state.selectedObjectIds.filter((selectedId) => selectedId !== id),
      history: 'step',
    });
  }),
  setPanoOrigin: (origin) => set((state) => {
    if (vec3NearlyEqual(state.project.scene.panoOrigin, origin)) return state;
    const nextOrigin = [...origin] as Vec3;
    const plan = state.pendingSecondCapturePlan;
    const nextPlan = plan?.trackLiveOrigin
      ? { ...plan, origin: nextOrigin }
      : plan;
    // Scene capture origin only — never rewrite existing pano projector poses.
    return applyBuildSceneChange(state, {
      panoOrigin: nextOrigin,
      history: 'step',
      extra: nextPlan !== plan ? { pendingSecondCapturePlan: nextPlan } : undefined,
    });
  }),
  setPanoRotation: (rotation) => set((state) => {
    const current = state.project.scene.panoRotation;
    if (
      Math.abs(current[0] - rotation[0]) < 1e-6
      && Math.abs(current[1] - rotation[1]) < 1e-6
      && Math.abs(current[2] - rotation[2]) < 1e-6
    ) {
      return state;
    }
    const nextRotation = [
      rotation[0],
      rotation[1],
      rotation[2],
    ] as Euler;
    const plan = state.pendingSecondCapturePlan;
    const nextPlan = plan?.trackLiveOrigin
      ? { ...plan, rotation: nextRotation }
      : plan;
    return applyBuildSceneChange(state, {
      panoRotation: nextRotation,
      history: 'step',
      extra: nextPlan !== plan ? { pendingSecondCapturePlan: nextPlan } : undefined,
    });
  }),
  renderGrayboxPano: async () => {
    // Guard against stacked clicks while a render is already in flight.
    if (get().isRenderingGraybox) {
      throw new Error('A graybox render is already in progress.');
    }
    set({ isRenderingGraybox: true });
    try {
      // Yield so the CTA can paint "Rendering..." before the heavy WebGL work blocks the main thread.
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      const state = get();
      const theme = useThemeStore.getState().theme;
      const { renderGrayboxEquirectangularPano } = await import('../engine/renderers');
      const render = await renderGrayboxEquirectangularPano(state.project, undefined, undefined, theme);
      const asset = storeProjectAssetBlob(state.project.id, createPanoAsset({
        name: 'global_graybox.png',
        uri: '',
        width: render.width,
        height: render.height,
        metadata: { source: 'graybox_scene', theme },
      }), render.blob);
      const captureOrigin = [...state.project.scene.panoOrigin] as Vec3;
      const hadOnlyGrayboxCanonical = state.project.panoRefs.every(
        (existing) => !existing.isCanonical || existing.type === 'graybox_render',
      );
      const pano = createPanoReference({
        name: 'Graybox 360',
        assetId: asset.id,
        type: 'graybox_render',
        origin: captureOrigin,
        rotation: state.project.scene.panoRotation,
        width: render.width,
        height: render.height,
        // Stay canonical when replacing a prior graybox-only reference set.
        isCanonical: state.project.panoRefs.length === 0 || hadOnlyGrayboxCanonical,
        notes: 'Rendered from the Build workspace graybox set.',
      });

      set((current) => {
        // Only replace grayboxes captured near this origin — keep other capture grayboxes.
        const staleGrayboxes = current.project.panoRefs.filter(
          (existing) => existing.type === 'graybox_render'
            && isCaptureOriginNearPano(captureOrigin, existing),
        );
        const staleAssetIds = new Set(staleGrayboxes.map((existing) => existing.imageAssetId));
        const nextAssets = { ...current.project.assets.assets };
        for (const assetId of staleAssetIds) {
          delete nextAssets[assetId];
        }
        nextAssets[asset.id] = asset;

        const remainingPanos = current.project.panoRefs
          .filter(
            (existing) => !(existing.type === 'graybox_render'
              && isCaptureOriginNearPano(captureOrigin, existing)),
          )
          .map((existing) => (
            pano.isCanonical ? { ...existing, isCanonical: false } : existing
          ));

        return {
          project: touchProject(linkAllShotsToCanonicalPano({
            ...current.project,
            assets: { assets: nextAssets },
            panoRefs: [...remainingPanos, pano],
          })),
          activePanoId: pano.isCanonical ? pano.id : current.activePanoId,
        };
      });
      return pano;
    } finally {
      // Always re-enable the CTA so a failed or cancelled render never sticks disabled.
      set({ isRenderingGraybox: false });
    }
  },
  importCanonicalPano: (params) => set((state) => {
    const asset = storeProjectAssetDataUrl(state.project.id, createPanoAsset({
      name: params.name,
      uri: params.dataUrl,
      width: params.width ?? DEFAULT_GRAYBOX_PANO_WIDTH,
      height: params.height ?? DEFAULT_GRAYBOX_PANO_HEIGHT,
      metadata: { source: 'user_import' },
    }));
    const graybox = findGrayboxNearOrigin(state.project, state.project.scene.panoOrigin);
    const pano = createPanoReference({
      name: params.name.replace(/\.[^.]+$/, '') || 'Styled Reference',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: [...state.project.scene.panoOrigin] as Vec3,
      rotation: [...state.project.scene.panoRotation] as Euler,
      width: asset.width ?? DEFAULT_GRAYBOX_PANO_WIDTH,
      height: asset.height ?? DEFAULT_GRAYBOX_PANO_HEIGHT,
      isCanonical: true,
      sourcePanoId: graybox?.id,
      notes: params.importNote ?? 'Imported styled reference pano.',
    });
    const linkedProject = linkAllShotsToCanonicalPano({
      ...state.project,
      assets: { assets: { ...state.project.assets.assets, [asset.id]: asset } },
      panoRefs: [...state.project.panoRefs.map((existing) => ({ ...existing, isCanonical: false })), pano],
      workflow: {
        ...state.project.workflow,
        referenceAlignmentAcceptedForPanoId: undefined,
      },
    });
    return {
      project: touchProject(linkedProject),
      activePanoId: pano.id,
      alignmentIntroRequest: state.alignmentIntroRequest + 1,
      seenAlignmentIntroForPanoId: undefined,
    };
  }),
  importStyledPano: (params) => {
    const state = get();
    const mode = resolveStyledImportMode(state.project, {
      pendingSecondCapturePlan: state.pendingSecondCapturePlan,
    });
    if (mode === 'add_secondary') {
      set((current) => {
        const primary = primaryStyledPano(current.project)
          ?? current.project.panoRefs.find(
            (pano) => pano.isCanonical && pano.type !== 'graybox_render',
          )
          ?? current.project.panoRefs.find((pano) => pano.type !== 'graybox_render');
        const asset = storeProjectAssetDataUrl(current.project.id, createPanoAsset({
          name: params.name,
          uri: params.dataUrl,
          width: params.width ?? DEFAULT_GRAYBOX_PANO_WIDTH,
          height: params.height ?? DEFAULT_GRAYBOX_PANO_HEIGHT,
          metadata: { source: 'user_import' },
        }));
        const plan = current.pendingSecondCapturePlan;
        const frozenOrigin = plan
          ? [...plan.origin] as Vec3
          : [...current.project.scene.panoOrigin] as Vec3;
        const frozenRotation = plan
          ? [...plan.rotation] as Euler
          : [...current.project.scene.panoRotation] as Euler;
        const graybox = findGrayboxNearOrigin(current.project, frozenOrigin);
        const pano = createPanoReference({
          name: params.name.replace(/\.[^.]+$/, '') || 'Second Capture',
          assetId: asset.id,
          type: 'ai_global_reference',
          origin: frozenOrigin,
          rotation: frozenRotation,
          width: asset.width ?? DEFAULT_GRAYBOX_PANO_WIDTH,
          height: asset.height ?? DEFAULT_GRAYBOX_PANO_HEIGHT,
          isCanonical: false,
          sourcePanoId: graybox?.id,
          notes: params.importNote ?? 'Imported second capture for multi-origin blend.',
        });
        const projectedStyle = normalizeProjectedStyleSettings(current.project.settings.projectedStyle);
        return {
          project: touchProject({
            ...current.project,
            assets: { assets: { ...current.project.assets.assets, [asset.id]: asset } },
            panoRefs: [...current.project.panoRefs, pano],
            settings: {
              ...current.project.settings,
              projectedStyle: {
                ...projectedStyle,
                panoId: projectedStyle.panoId ?? primary?.id,
                secondaryPanoId: pano.id,
                blendMode: projectedStyle.blendMode === 'primary_only'
                  ? 'primary_dominant'
                  : projectedStyle.blendMode,
              },
            },
          }),
          // Keep the viewer on the primary reference so the second capture does not look like a replace.
          activePanoId: primary?.id ?? current.activePanoId,
          pendingSecondCapturePlan: undefined,
        };
      });
      return 'add_secondary';
    }
    get().importCanonicalPano(params);
    return mode;
  },
  setActivePano: (id) => set({ activePanoId: id }),
  removePanoReference: (id) => set((state) => {
    const target = state.project.panoRefs.find((pano) => pano.id === id);
    if (!target) return state;

    let remaining = state.project.panoRefs
      .filter((pano) => pano.id !== id)
      .map((pano) => (
        pano.sourcePanoId === id ? { ...pano, sourcePanoId: undefined } : pano
      ));

    // Keep exactly one canonical when anything remains.
    if (remaining.length > 0 && !remaining.some((pano) => pano.isCanonical)) {
      const preferred = [...remaining]
        .reverse()
        .find((pano) => pano.type !== 'graybox_render')
        ?? remaining[remaining.length - 1];
      remaining = remaining.map((pano) => ({ ...pano, isCanonical: pano.id === preferred.id }));
    } else if (remaining.length === 0) {
      remaining = [];
    }

    const assetStillReferenced = remaining.some((pano) => pano.imageAssetId === target.imageAssetId);
    const nextAssets = { ...state.project.assets.assets };
    if (!assetStillReferenced) {
      delete nextAssets[target.imageAssetId];
    }

    const workflow = { ...state.project.workflow };
    if (workflow.referenceAlignmentAcceptedForPanoId === id) {
      workflow.referenceAlignmentAcceptedForPanoId = undefined;
    }

    const projectedStyle = normalizeProjectedStyleSettings(state.project.settings.projectedStyle);
    const nextProjectedStyle = normalizeProjectedStyleSettings({
      ...projectedStyle,
      panoId: projectedStyle.panoId === id ? undefined : projectedStyle.panoId,
      secondaryPanoId: projectedStyle.secondaryPanoId === id ? undefined : projectedStyle.secondaryPanoId,
    });

    let nextProject: LocationProject = {
      ...state.project,
      panoRefs: remaining,
      assets: { assets: nextAssets },
      workflow,
      settings: {
        ...state.project.settings,
        projectedStyle: nextProjectedStyle,
      },
      shots: state.project.shots.map((shot) => {
        const linkedToRemoved = shot.linkedPanoId === id || shot.panoCrop?.panoId === id;
        if (!linkedToRemoved) return shot;
        return {
          ...shot,
          linkedPanoId: undefined,
          panoCrop: undefined,
          updatedAt: new Date().toISOString(),
        };
      }),
    };

    nextProject = linkAllShotsToCanonicalPano(nextProject);

    const nextActiveId = state.activePanoId === id
      ? (remaining.find((pano) => pano.isCanonical)?.id ?? remaining[0]?.id)
      : state.activePanoId && remaining.some((pano) => pano.id === state.activePanoId)
        ? state.activePanoId
        : remaining.find((pano) => pano.isCanonical)?.id ?? remaining[0]?.id;

    return {
      project: touchProject(nextProject),
      activePanoId: nextActiveId,
      seenAlignmentIntroForPanoId: state.seenAlignmentIntroForPanoId === id
        ? undefined
        : state.seenAlignmentIntroForPanoId,
    };
  }),
  updatePanoReference: (id, updates) => set((state) => ({
    project: touchProject({
      ...state.project,
      panoRefs: state.project.panoRefs.map((pano) => pano.id === id ? { ...pano, ...updates } : pano),
      shots: state.project.shots.map((shot) => {
        if (shot.linkedPanoId !== id) return shot;
        const linkedPano = state.project.panoRefs.find((pano) => pano.id === id);
        if (!linkedPano) return shot;
        const mergedPano = { ...linkedPano, ...updates };
        return {
          ...shot,
          panoCrop: getPanoCropSettingsForShot(
            shot.camera,
            mergedPano,
            shot.exportSettings.width,
            shot.exportSettings.height,
          ),
          updatedAt: new Date().toISOString(),
        };
      }),
    }),
  })),
  setPanoView: (updates) => set((state) => ({
    panoView: { ...state.panoView, ...updates },
  })),
  addCamera: (options) => {
    const state = get();
    const originShot = createOriginShot(state.project, state.project.shots.length + 1);
    const pano = getActivePano(state.project, state.activePanoId);
    return addShotWithCamera(originShot.camera, pano?.id, originShot.name, {
      // Shots workspace defaults to navigating into fly mode; Export can opt out.
      navigateToShots: options?.navigateToShots ?? true,
    });
  },
  selectShot: (id) => set((state) => {
    const shot = state.project.shots.find((item) => item.id === id);
    if (!shot) return { selectedShotId: id, shotCameraFlying: true };
    return {
      selectedShotId: id,
      activePanoId: shot.linkedPanoId ?? state.activePanoId,
      panoView: panoViewFromCamera(shot.camera),
      // Keep the viewfinder live when switching shots (review via library thumbnails).
      shotCameraFlying: true,
    };
  }),
  setShotCameraFlying: (value, options) => set((state) => {
    if (!value) return { shotCameraFlying: false };
    const shotId = state.selectedShotId;
    if (!shotId) return { shotCameraFlying: true };
    // Adjusting a still clears acceptance; camera-move end posing can keep it.
    if (options?.clearFramingAcceptance === false) {
      return { shotCameraFlying: true };
    }
    const accepted = { ...state.project.workflow.shotFramingAcceptedAtByShotId };
    delete accepted[shotId];
    return {
      shotCameraFlying: true,
      project: touchProject({
        ...state.project,
        workflow: { ...state.project.workflow, shotFramingAcceptedAtByShotId: accepted },
      }),
    };
  }),
  lockShotCamera: () => {
    if (document.pointerLockElement) document.exitPointerLock();
    set({ shotCameraFlying: false });
  },
  landShotFraming: (shotId, camera, options) => {
    const keepFlying = options?.keepFlying === true;
    // Continuous capture (still camera) stays in fly — don't drop pointer lock.
    if (!keepFlying && document.pointerLockElement) document.exitPointerLock();
    set((state) => {
      const shot = state.project.shots.find((item) => item.id === shotId);
      if (!shot) return state;
      const nextCamera = camera ?? shot.camera;
      return {
        shotCameraFlying: keepFlying ? true : false,
        project: touchProject({
          ...state.project,
          shots: state.project.shots.map((item) => {
            if (item.id !== shotId) return item;
            return withShotPanoLink(state.project, {
              ...item,
              camera: nextCamera,
              updatedAt: new Date().toISOString(),
            });
          }),
          workflow: {
            ...state.project.workflow,
            shotFramingAcceptedAtByShotId: {
              ...state.project.workflow.shotFramingAcceptedAtByShotId,
              [shotId]: new Date().toISOString(),
            },
          },
        }),
      };
    });
  },
  updateShot: (id, updates, options) => set((state) => {
    const shot = state.project.shots.find((item) => item.id === id);
    if (!shot) {
      return {
        project: touchProject({
          ...state.project,
          shots: state.project.shots.map((current) => {
            if (current.id !== id) return current;
            const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
            return withShotPanoLink(state.project, updated);
          }),
        }),
      };
    }

    const nextCamera = updates.camera ?? shot.camera;
    const cameraChanged = updates.camera !== undefined && !cameraDataEqual(shot.camera, nextCamera);
    let historyPatch: Partial<Pick<
      ContinuityStore,
      'shotCameraHistoryByShotId' | 'shotCameraHistoryBatchCaptured'
    >> = {};

    if (cameraChanged && !shotCameraHistoryRestoring) {
      const mode = options?.cameraHistory ?? 'step';
      if (mode !== 'silent') {
        const effectiveMode: ShotCameraHistoryMode = state.shotCameraHistoryBatchDepth > 0 ? 'batch' : mode;
        if (effectiveMode !== 'batch' || !state.shotCameraHistoryBatchCaptured) {
          const currentStacks = getShotCameraHistoryStacks(state.shotCameraHistoryByShotId, id);
          const stacks = pushShotCameraHistoryPast(currentStacks, shot.camera);
          historyPatch = {
            shotCameraHistoryByShotId: withShotCameraHistoryStacks(
              state.shotCameraHistoryByShotId,
              id,
              stacks,
            ),
            shotCameraHistoryBatchCaptured: effectiveMode === 'batch'
              ? true
              : state.shotCameraHistoryBatchCaptured,
          };
        }
      }
    }

    return {
      ...historyPatch,
      project: touchProject(pruneUnreferencedProjectAssets({
        ...state.project,
        shots: state.project.shots.map((current) => {
          if (current.id !== id) return current;
          const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
          return withShotPanoLink(state.project, updated);
        }),
      })),
    };
  }),
  removeShot: (id) => set((state) => {
    if (state.project.shots.length <= 1) return state;
    const shots = state.project.shots.filter((shot) => shot.id !== id);
    const nextSelected = state.selectedShotId === id ? shots[0]?.id : state.selectedShotId;
    const nextShot = shots.find((shot) => shot.id === nextSelected);
    return {
      project: touchProject(pruneUnreferencedProjectAssets({ ...state.project, shots })),
      selectedShotId: nextSelected,
      panoView: nextShot ? panoViewFromCamera(nextShot.camera) : state.panoView,
    };
  }),
  attachCameraMoveVideoToShot: (shotId, params) => {
    const state = get();
    const shot = state.project.shots.find((item) => item.id === shotId);
    if (!shot) throw new Error('Select a shot before exporting a camera move MP4.');
    const asset = storeProjectAssetDataUrl(state.project.id, createVideoAsset({
      name: params.name || `shot_${shot.shotNumber}_camera_move.mp4`,
      uri: params.dataUrl,
      mimeType: params.mimeType,
      width: params.width,
      height: params.height,
      metadata: {
        source: 'graybox_camera_keyframes',
        shotId: shot.id,
        durationSeconds: params.durationSeconds,
        frameRate: params.frameRate,
        ...(params.encodeMode ? { encodeMode: params.encodeMode } : {}),
        ...(params.codecString ? { codecString: params.codecString } : {}),
        ...(params.frameCount !== undefined ? { frameCount: params.frameCount } : {}),
        ...(params.resolutionPreset ? { resolutionPreset: params.resolutionPreset } : {}),
        ...(params.validated !== undefined ? { validated: params.validated } : {}),
      },
    }));
    set((current) => ({
      project: touchProject(pruneUnreferencedProjectAssets({
        ...current.project,
        assets: {
          assets: {
            ...current.project.assets.assets,
            [asset.id]: asset,
          },
        },
        shots: current.project.shots.map((item) => item.id === shot.id
          ? {
              ...item,
              assets: {
                ...item.assets,
                cameraMoveVideoAssetId: asset.id,
              },
              updatedAt: new Date().toISOString(),
            }
          : item),
      })),
    }));
    return asset;
  },
  attachViewportRenderToShot: (shotId, params) => {
    const state = get();
    const shot = state.project.shots.find((item) => item.id === shotId);
    if (!shot) throw new Error('Select a shot before attaching a viewport render.');
    const stillView = params.stillView ?? { appearance: 'clay' as const, people: 'with_people' as const };
    const assetKey = shotStillViewAssetKey(stillView);
    const asset = storeProjectAssetDataUrl(state.project.id, createPanoAsset({
      name: params.name || `shot_${shot.shotNumber}_viewport.png`,
      uri: params.dataUrl,
      width: params.width,
      height: params.height,
      metadata: {
        source: 'viewport_render',
        shotId: shot.id,
        stillAppearance: stillView.appearance,
        stillPeople: stillView.people,
      },
    }));
    set((current) => {
      const shots = current.project.shots.map((item) => item.id === shot.id
        ? {
            ...item,
            assets: {
              ...item.assets,
              [assetKey]: asset.id,
            },
            updatedAt: new Date().toISOString(),
          }
        : item);
      const assets = {
        ...current.project.assets.assets,
        [asset.id]: asset,
      };
      return {
        project: touchProject(pruneUnreferencedProjectAssets({
          ...current.project,
          assets: { assets },
          shots,
        })),
      };
    });
    return asset;
  },
  attachAiResultFrameToShot: (shotId, params) => {
    const state = get();
    const shot = state.project.shots.find((item) => item.id === shotId);
    if (!shot) throw new Error('Select a shot before importing an AI result frame.');
    const asset = storeProjectAssetDataUrl(state.project.id, createPanoAsset({
      name: params.name || `shot_${shot.shotNumber}_ai_result_frame.png`,
      uri: params.dataUrl,
      width: params.width ?? shot.exportSettings.width,
      height: params.height ?? shot.exportSettings.height,
      metadata: {
        source: 'external_ai_image_generator',
        shotId: shot.id,
      },
    }));
    set((current) => ({
      project: touchProject(pruneUnreferencedProjectAssets({
        ...current.project,
        assets: {
          assets: {
            ...current.project.assets.assets,
            [asset.id]: asset,
          },
        },
        shots: current.project.shots.map((item) => item.id === shot.id
          ? {
              ...item,
              assets: {
                ...item.assets,
                finalBaseFrameAssetId: asset.id,
                aiResultFrameAssetId: asset.id,
              },
              status: 'exported',
              updatedAt: new Date().toISOString(),
            }
          : item),
      })),
    }));
    return asset;
  },
  addLandmark: () => {
    const state = get();
    const forward = yawPitchToDirection(state.panoView.yawDegrees, state.panoView.pitchDegrees);
    const position = add(state.project.scene.panoOrigin, multiplyScalar(forward, 4));
    const landmark = createLandmark(state.project.landmarks.length + 1, position);
    set((current) => ({
      project: touchProject({
        ...current.project,
        landmarks: [...current.project.landmarks, landmark],
      }),
      selectedLandmarkId: landmark.id,
    }));
    return landmark;
  },
  updateLandmark: (id, updates) => set((state) => ({
    project: touchProject({
      ...state.project,
      landmarks: state.project.landmarks.map((landmark) => landmark.id === id ? { ...landmark, ...updates } : landmark),
    }),
  })),
  toggleShotLandmark: (shotId, landmarkId) => set((state) => ({
    project: touchProject({
      ...state.project,
      shots: state.project.shots.map((shot) => {
        if (shot.id !== shotId) return shot;
        const hasLandmark = shot.landmarkIds.includes(landmarkId);
        return {
          ...shot,
          landmarkIds: hasLandmark
            ? shot.landmarkIds.filter((id) => id !== landmarkId)
            : [...shot.landmarkIds, landmarkId],
          updatedAt: new Date().toISOString(),
        };
      }),
    }),
  })),
  setExportingPackage: (value) => set({ isExportingPackage: value }),
  approveGrayboxForReference: () => set((state) => ({
    project: touchProject({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        grayboxApprovedForReferenceAt: new Date().toISOString(),
      },
    }),
  })),
  acceptReferenceAlignment: () => set((state) => {
    const canonical = getCanonicalPano(state.project);
    if (!canonical) return state;
    return {
      project: touchProject({
        ...state.project,
        workflow: {
          ...state.project.workflow,
          referenceAlignmentAcceptedForPanoId: canonical.id,
        },
      }),
    };
  }),
  acceptShotFraming: (shotId) => set((state) => ({
    project: touchProject({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        shotFramingAcceptedAtByShotId: {
          ...state.project.workflow.shotFramingAcceptedAtByShotId,
          [shotId]: new Date().toISOString(),
        },
      },
    }),
  })),
  markAiBriefSent: (shotId) => set((state) => ({
    project: touchProject({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        aiBriefSentAtByShotId: {
          ...state.project.workflow.aiBriefSentAtByShotId,
          [shotId]: new Date().toISOString(),
        },
      },
    }),
  })),
  markFinalPackageExported: (shotId) => set((state) => ({
    project: touchProject({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        finalPackageExportedAtByShotId: {
          ...state.project.workflow.finalPackageExportedAtByShotId,
          [shotId]: new Date().toISOString(),
        },
      },
    }),
  })),
  dismissWorkflowAdvance: (promptKey) => set((state) => ({
    dismissedWorkflowAdvanceKeys: state.dismissedWorkflowAdvanceKeys.includes(promptKey)
      ? state.dismissedWorkflowAdvanceKeys
      : [...state.dismissedWorkflowAdvanceKeys, promptKey],
  })),
  markObjectiveSeen: (workspace) => set((state) => ({
    seenObjectiveWorkspaces: state.seenObjectiveWorkspaces.includes(workspace)
      ? state.seenObjectiveWorkspaces
      : [...state.seenObjectiveWorkspaces, workspace],
  })),
  requestObjectiveModal: () => set((state) => ({
    objectiveModalRequest: state.objectiveModalRequest + 1,
  })),
  requestAlignmentIntro: () => set((state) => ({
    alignmentIntroRequest: state.alignmentIntroRequest + 1,
  })),
  requestAlignmentRetryModal: () => set((state) => ({
    alignmentRetryModalRequest: state.alignmentRetryModalRequest + 1,
  })),
  markAlignmentIntroSeen: (panoId) => set({ seenAlignmentIntroForPanoId: panoId }),
  resetWorkflowSession: () => set({
    dismissedWorkflowAdvanceKeys: [],
    seenObjectiveWorkspaces: [],
    objectiveModalRequest: 0,
    alignmentIntroRequest: 0,
    alignmentRetryModalRequest: 0,
    seenAlignmentIntroForPanoId: undefined,
    pendingSecondCapturePlan: undefined,
  }),
}));

function touchProject(project: LocationProject): LocationProject {
  return { ...project, updatedAt: new Date().toISOString() };
}

type BuildHistoryStateSlice = {
  project: LocationProject;
  selectedObjectIds: string[];
  buildHistoryPast: BuildHistorySnapshot[];
  buildHistoryFuture: BuildHistorySnapshot[];
  buildHistoryBatchDepth: number;
  buildHistoryBatchCaptured: boolean;
  buildHistoryCoalesceActive: boolean;
};

function captureCurrentBuildSnapshot(state: {
  project: LocationProject;
  selectedObjectIds: string[];
}): BuildHistorySnapshot {
  return captureBuildSnapshot({
    objects: state.project.scene.objects,
    panoOrigin: state.project.scene.panoOrigin,
    panoRotation: state.project.scene.panoRotation,
    selectedObjectIds: state.selectedObjectIds,
  });
}

function scheduleCoalesceRelease() {
  clearBuildHistoryCoalesceTimer();
  buildHistoryCoalesceTimer = setTimeout(() => {
    buildHistoryCoalesceTimer = undefined;
    useContinuityStore.setState({ buildHistoryCoalesceActive: false });
  }, BUILD_HISTORY_COALESCE_MS);
}

/**
 * Record pre-mutation Build history according to mode / open drag batch.
 * Call only after confirming the mutation is a real change.
 */
function historyPatchBeforeMutation(
  state: BuildHistoryStateSlice,
  mode: BuildHistoryMode = 'step',
): Partial<Pick<
  ContinuityStore,
  | 'buildHistoryPast'
  | 'buildHistoryFuture'
  | 'buildHistoryBatchCaptured'
  | 'buildHistoryCoalesceActive'
>> {
  if (buildHistoryRestoring || mode === 'silent') return {};

  // Open drag batch always wins over per-call mode.
  const effectiveMode: BuildHistoryMode = state.buildHistoryBatchDepth > 0 ? 'batch' : mode;

  if (effectiveMode === 'batch') {
    if (state.buildHistoryBatchCaptured) return {};
  } else if (effectiveMode === 'coalesce') {
    if (state.buildHistoryCoalesceActive) {
      scheduleCoalesceRelease();
      return {};
    }
  } else {
    // step: end any open coalesce window so the next field edit starts fresh
    clearBuildHistoryCoalesceTimer();
  }

  const stacks = pushBuildHistoryPast(
    { past: state.buildHistoryPast, future: state.buildHistoryFuture },
    captureCurrentBuildSnapshot(state),
  );

  if (effectiveMode === 'batch') {
    return {
      buildHistoryPast: stacks.past,
      buildHistoryFuture: stacks.future,
      buildHistoryBatchCaptured: true,
    };
  }

  if (effectiveMode === 'coalesce') {
    scheduleCoalesceRelease();
    return {
      buildHistoryPast: stacks.past,
      buildHistoryFuture: stacks.future,
      buildHistoryCoalesceActive: true,
    };
  }

  return {
    buildHistoryPast: stacks.past,
    buildHistoryFuture: stacks.future,
    buildHistoryCoalesceActive: false,
  };
}

function applyBuildSceneChange(
  state: BuildHistoryStateSlice,
  change: {
    objects?: SceneObject[];
    assets?: LocationProject['assets'];
    panoOrigin?: Vec3;
    panoRotation?: [number, number, number];
    selectedObjectIds?: string[];
    history?: BuildHistoryMode;
    extra?: Record<string, unknown>;
  },
) {
  const objects = change.objects ?? state.project.scene.objects;
  const assets = change.assets ?? state.project.assets;
  const panoOrigin = change.panoOrigin ?? state.project.scene.panoOrigin;
  const panoRotation = change.panoRotation ?? state.project.scene.panoRotation;
  const selectedObjectIds = Object.prototype.hasOwnProperty.call(change, 'selectedObjectIds')
    ? normalizeSelectedIds(change.selectedObjectIds ?? [], objects)
    : normalizeSelectedIds(state.selectedObjectIds, objects);

  const nextSnap = captureBuildSnapshot({
    objects,
    panoOrigin,
    panoRotation,
    selectedObjectIds,
  });
  const currentSnap = captureCurrentBuildSnapshot(state);
  if (buildSnapshotsEqual(currentSnap, nextSnap)) {
    return state;
  }

  const history = historyPatchBeforeMutation(state, change.history ?? 'step');
  return {
    ...history,
    ...change.extra,
    selectedObjectIds,
    project: touchProject({
      ...state.project,
      assets,
      scene: {
        ...state.project.scene,
        objects,
        panoOrigin,
        panoRotation,
      },
    }),
  };
}

function applyBuildSnapshot(
  snapshot: BuildHistorySnapshot,
  past: BuildHistorySnapshot[],
  future: BuildHistorySnapshot[],
) {
  buildHistoryRestoring = true;
  clearBuildHistoryCoalesceTimer();
  try {
    useContinuityStore.setState((state) => ({
      buildHistoryPast: past,
      buildHistoryFuture: future,
      buildHistoryCoalesceActive: false,
      selectedObjectIds: normalizeSelectedIds(snapshot.selectedObjectIds, snapshot.objects),
      project: touchProject({
        ...state.project,
        scene: {
          ...state.project.scene,
          objects: snapshot.objects,
          panoOrigin: snapshot.panoOrigin,
          panoRotation: snapshot.panoRotation,
        },
      }),
    }));
  } finally {
    buildHistoryRestoring = false;
  }
}

function ensureProjectHasCamera(project: LocationProject): LocationProject {
  const withShots = project.shots.length > 0
    ? project
    : touchProject({ ...project, shots: [createOriginShot(project)] });
  return linkAllShotsToCanonicalPano(withShots);
}

function getActivePano(project: LocationProject, activePanoId?: string): PanoReference | undefined {
  return project.panoRefs.find((pano) => pano.id === activePanoId)
    ?? project.panoRefs.find((pano) => pano.isCanonical)
    ?? project.panoRefs[0];
}

function addShotWithCamera(
  camera: CameraData,
  linkedPanoId?: string,
  name?: string,
  options?: { navigateToShots?: boolean },
): Shot {
  const state = useContinuityStore.getState();
  const sourceShot = state.project.shots.find((item) => item.id === state.selectedShotId);
  const linkedPano = linkedPanoId
    ? state.project.panoRefs.find((pano) => pano.id === linkedPanoId)
    : getCanonicalPano(state.project);
  const shot = withShotPanoLink(
    state.project,
    createShot({
      index: state.project.shots.length + 1,
      camera,
      linkedPanoId: linkedPano?.id,
    }),
    linkedPano,
  );
  if (name) shot.name = name;
  shot.objectOverrides = structuredClone(sourceShot?.objectOverrides ?? {});

  const navigateToShots = options?.navigateToShots ?? true;
  useContinuityStore.setState((current) => ({
    project: touchProject({
      ...current.project,
      shots: [...current.project.shots, shot],
    }),
    selectedShotId: shot.id,
    ...(navigateToShots
      ? { workspace: 'shots' as const, shotCameraFlying: true }
      : {}),
  }));

  return shot;
}
