import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Film,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Plus,
  Settings2,
  Eye,
  EyeOff,
  Move3D,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import {
  CameraData,
  CameraKeyframeEasing,
  PeopleExportMode,
  SceneObject,
  Shot,
  ShotObjectOverrides,
  ShotStatus,
  Transform,
  Vec3,
} from '../../domain/types';
import {
  DEFAULT_CAMERA_LENS_MM,
  DEFAULT_CAMERA_HEIGHT_METERS,
} from '../../domain/defaults';
import {
  clampShotNearClip,
  MAX_SHOT_NEAR_CLIP_METERS,
  MIN_SHOT_NEAR_CLIP_METERS,
} from '../../engine/cameraClipping';
import { clampShotVerticalFov, verticalFovToFocalLength } from '../../engine/focalLength';
import { buildShotFovWheelBatchCommit, applyLiveShotFovWheelBatchCommit } from '../../engine/shotFovWheelBatch';
import {
  CAMERA_KEYFRAME_EASING_OPTIONS,
  getSortedCameraKeyframes,
  MAX_CAMERA_MOVE_DURATION_SECONDS,
  MIN_CAMERA_MOVE_DURATION_SECONDS,
} from '../../engine/cameraKeyframes';
import { CameraMovePreviewStrip } from './CameraMovePreviewStrip';
import { KeyframeStrip } from './KeyframeStrip';
import {
  renderShotFrame,
} from '../../engine/renderers';
import type { VideoResolutionPresetId } from '../../engine/videoPresets';
import { VIDEO_RESOLUTION_PRESETS } from '../../engine/videoPresets';
import { getCameraMoveReferenceFrames } from '../../engine/cameraKeyframes';
import { isShotFramingAccepted } from '../../engine/workflow';
import { getPanoMatchQuality, resolveShotLinkedPano } from '../../engine/sync';
import { useContinuityStore } from '../../state/useContinuityStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Field, IconButton, Panel, Select, TextArea, TextInput } from '../common/Field';
import { PrecisionDrawer } from '../common/PrecisionDrawer';
import { ShotCameraRollThumbnail } from '../common/ShotCameraRollThumbnail';
import { ShotMediaModal } from '../common/ShotMediaModal';
import { ShotsLibraryCard } from '../common/ShotsLibraryCard';
import { Vec3Input } from '../common/Vec3Input';
import { SceneViewport } from '../viewers/SceneViewport';
import { ShotPanoCropPreview } from '../viewers/ShotPanoCropPreview';
import { canUseProjectedAppearance } from '../../engine/projectedStyle';
import {
  canStageObjectPerShot,
  clearShotObjectOverride,
  getStageableObjectsForShot,
  getSceneObjectStagingRole,
  resolveProjectForShot,
  updateShotObjectOverrides,
} from '../../engine/shotSceneState';
import {
  snapshotStageableObjectOverrides,
} from '../../engine/objectKeyframes';
import { resolveKeyframePreviewUri } from '../../domain/shotMedia';
import type { GizmoMode } from '../../engine/transformGizmo';
import { AppearanceModeToggle } from '../common/AppearanceModeToggle';
import { DepthSettingsPanel } from '../common/DepthSettingsPanel';
import { normalizeShotDepthSettings, defaultShotDepthSettings } from '../../domain/defaults';
import { formatDepthRangeLegend } from '../../engine/depthRender';
import { FullBleedLayout } from './WorkspaceShell';
import {
  getShotPrimaryLabel,
  hasCustomShotTitle,
  normalizeProductionShotId,
  normalizeShotTitle,
} from '../../domain/shotIdentity';
import { useShotCameraController } from '../../hooks/useShotCameraController';
import { useShotRenderController } from '../../hooks/useShotRenderController';
import { useShotStagingController } from '../../hooks/useShotStagingController';
import { useVideoAuthoringController } from '../../hooks/useVideoAuthoringController';
import { ContinuityComparePanel } from '../shots/ContinuityComparePanel';
import { SequenceStoryboardView } from '../shots/SequenceStoryboardView';
import { ShotsCaptureChrome } from '../shots/ShotsCaptureChrome';
import { ShotsLibrary } from '../shots/ShotsLibrary';
import { ShotSettings } from '../shots/ShotSettings';
import { useStillCaptureController } from '../shots/useStillCaptureController';
import {
  clampVideoDurationUiSeconds,
  useCameraMoveController,
  VIDEO_DURATION_UI_MAX_SECONDS,
  VIDEO_DURATION_UI_MIN_SECONDS,
} from '../shots/useCameraMoveController';
import { useCameraMovePreviewController } from '../shots/useCameraMovePreviewController';

// Plan-named extractions re-exported for structural tests / composition visibility.
export {
  useShotCameraController,
  useShotRenderController,
  useShotStagingController,
  useVideoAuthoringController,
  ContinuityComparePanel,
  SequenceStoryboardView,
  ShotsCaptureChrome,
  ShotsLibrary,
  ShotSettings,
  useStillCaptureController,
  useCameraMoveController,
  useCameraMovePreviewController,
};

const statuses: ShotStatus[] = ['planned', 'exported', 'needs_fix', 'approved', 'rejected'];
const STATUS_LABELS: Record<ShotStatus, string> = {
  planned: 'Planned',
  exported: 'Exported',
  needs_fix: 'Needs fix',
  approved: 'Approved',
  rejected: 'Rejected',
};

type CaptureMode = 'still' | 'video';

export function ShotsWorkspace() {
  const {
    project,
    selectedShotId,
    addCamera,
    selectShot,
    updateShot,
    removeShot,
    toggleShotLandmark,
    shotCameraFlying,
    setShotCameraFlying,
    landShotFraming,
    setWorkspace,
    setActivePano,
    beginShotCameraHistoryBatch,
    endShotCameraHistoryBatch,
    undoShotCamera,
    redoShotCamera,
    reorderShots,
    copyStagingToNextShot,
  } = useContinuityStore(useShallow((state) => ({
    project: state.project,
    selectedShotId: state.selectedShotId,
    addCamera: state.addCamera,
    selectShot: state.selectShot,
    updateShot: state.updateShot,
    removeShot: state.removeShot,
    toggleShotLandmark: state.toggleShotLandmark,
    shotCameraFlying: state.shotCameraFlying,
    setShotCameraFlying: state.setShotCameraFlying,
    landShotFraming: state.landShotFraming,
    setWorkspace: state.setWorkspace,
    setActivePano: state.setActivePano,
    beginShotCameraHistoryBatch: state.beginShotCameraHistoryBatch,
    endShotCameraHistoryBatch: state.endShotCameraHistoryBatch,
    undoShotCamera: state.undoShotCamera,
    redoShotCamera: state.redoShotCamera,
    reorderShots: state.reorderShots,
    copyStagingToNextShot: state.copyStagingToNextShot,
  })));
  const runDestructiveProjectMutation = useProjectSafetyStore((state) => state.runDestructiveProjectMutation);
  const shotCameraHistoryRestoreGeneration = useContinuityStore(
    (state) => state.shotCameraHistoryRestoreGeneration,
  );
  const {
    stagingMode,
    setStagingMode,
    stagingGizmoMode,
    setStagingGizmoMode,
    stagedObjectId,
    setStagedObjectId,
    showPeopleInViewport,
    setShowPeopleInViewport,
    viewportObjectOverrides,
    setViewportObjectOverrides,
    clearViewportObjectInspection: clearStagingInspection,
  } = useShotStagingController();
  const shotCamera = useShotCameraController();
  const shotRender = useShotRenderController();
  const videoAuthoring = useVideoAuthoringController();
  const selectedShot = project.shots.find((shot) => shot.id === selectedShotId) ?? project.shots[0];
  const shotForViewport = useMemo(() => {
    if (!selectedShot) return undefined;
    if (viewportObjectOverrides !== undefined) {
      return { ...selectedShot, objectOverrides: viewportObjectOverrides };
    }
    return selectedShot;
  }, [selectedShot, viewportObjectOverrides]);
  const shotSceneProject = useMemo(
    () => shotForViewport
      ? resolveProjectForShot(project, shotForViewport, { hidePeople: !showPeopleInViewport })
      : project,
    [project, shotForViewport, showPeopleInViewport],
  );
  const stagedObject = stagedObjectId
    ? shotSceneProject.scene.objects.find((object) => object.id === stagedObjectId)
    : undefined;
  const stageableObjects = useMemo(
    () => getStageableObjectsForShot(shotSceneProject.scene.objects),
    [shotSceneProject.scene.objects],
  );
  const linkedPano = selectedShot ? resolveShotLinkedPano(project, selectedShot) : undefined;
  const linkedAsset = linkedPano ? project.assets.assets[linkedPano.imageAssetId] : undefined;
  const draftCameraRef = shotCamera.draftCameraRef;
  const shotCameraFlyingRef = useRef(shotCameraFlying);
  shotCameraFlyingRef.current = shotCameraFlying;
  const handledRestoreGenerationRef = useRef(shotCameraHistoryRestoreGeneration);
  const finalizeShotFovWheelBatchRef = useRef<() => void>(() => {});
  const {
    framePreviewByShotId,
    setShotFramePreview,
    isRenderingFrame,
    setIsRenderingFrame,
    isExportingFrame,
    setIsExportingFrame,
    cameraMovePreviewUrl,
    setCameraMovePreviewUrl,
    isExportingCameraMove,
    setIsExportingCameraMove,
    cameraMoveProgress,
    setCameraMoveProgress,
    cameraMoveProgressMessage,
    setCameraMoveProgressMessage,
    cameraMoveError,
    setCameraMoveError,
    cameraMoveNotice,
    setCameraMoveNotice,
    snapshotError,
    setSnapshotError,
    videoExportMode,
    setVideoExportMode,
    videoResolutionPreset,
    setVideoResolutionPreset,
    canRenderMp4,
    setCanRenderMp4,
    cameraMoveAbortRef,
  } = shotRender;
  const framePreviewUrl = selectedShot ? framePreviewByShotId[selectedShot.id] : undefined;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [showContinuityCompare, setShowContinuityCompare] = useState(false);
  const [showSequenceBoard, setShowSequenceBoard] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [shotPendingDelete, setShotPendingDelete] = useState<Shot | null>(null);
  const [mediaModalShotId, setMediaModalShotId] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<'clay' | 'projected' | 'depth'>('clay');
  const [depthPreviewRange, setDepthPreviewRange] = useState({ nearMeters: 0.1, farMeters: 100 });
  /**
   * Sequential capture authoring — videoAuthoring machine is the sole source of truth.
   * UI reads mode/captureState/isPreviewing/timelineOpen from the controller only.
   */
  const captureMode: CaptureMode = videoAuthoring.mode;
  const videoCaptureState = videoAuthoring.captureState;
  const timelineOpen = videoAuthoring.timelineOpen;
  const isPreviewingCameraMove = videoAuthoring.isPreviewing;
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
  const [selectedSegmentStartId, setSelectedSegmentStartId] = useState<string | null>(null);
  const framingCamera = shotCamera.framingCamera;
  const setFramingCamera = shotCamera.setFramingCamera;
  const focalLengthHudPulse = shotCamera.focalLengthHudPulse;
  const cameraReseedGeneration = shotCamera.cameraReseedGeneration;
  const bumpCameraReseed = shotCamera.bumpCameraReseed;

  const stillCapture = useStillCaptureController({
    selectedShot,
    draftCameraRef,
    shotCameraFlying,
    setShotFramePreview,
    setSnapshotError,
    setIsExportingFrame,
    isExportingFrame,
    snapshotError,
  });
  const {
    captureStill,
    exportCameraFrame,
    snapshotPreview,
    thumbnailFreshAfterFinishRef,
    landFlash,
    setLandFlash,
  } = stillCapture;

  const clearKeyframeSelection = useCallback(() => {
    setSelectedKeyframeId(null);
    setSelectedSegmentStartId(null);
  }, []);

  const getEffectiveCamera = useCallback((): CameraData | undefined => {
    if (!selectedShot) return undefined;
    return shotCamera.getEffectiveCamera(selectedShot.camera);
  }, [selectedShot, shotCamera]);

  const getPreviewShot = useCallback(() => {
    if (!selectedShot) return undefined;
    const camera = getEffectiveCamera();
    if (!camera) return selectedShot;
    return {
      ...selectedShot,
      camera: {
        ...camera,
        position: [...camera.position] as CameraData['position'],
        target: [...camera.target] as CameraData['target'],
      },
    };
  }, [getEffectiveCamera, selectedShot]);

  const clearViewportObjectInspection = useCallback(() => {
    clearStagingInspection();
    setViewportObjectOverrides(undefined);
  }, [clearStagingInspection, setViewportObjectOverrides]);

  const startFlyCamera = useCallback((options?: { clearFramingAcceptance?: boolean }) => {
    // Seed from the stored shot only when entering fly — never clobber a live draft pose.
    if (selectedShot && !shotCameraFlying) {
      draftCameraRef.current = selectedShot.camera;
      setFramingCamera(selectedShot.camera);
      bumpCameraReseed();
    }
    setShotCameraFlying(true, options);
  }, [bumpCameraReseed, selectedShot, setShotCameraFlying, shotCameraFlying]);

  // Preview/timeline controller first so camera-move can inject stopCameraMovePreview.
  const cameraMovePreview = useCameraMovePreviewController({
    selectedShot,
    draftCameraRef,
    videoAuthoring,
    startFlyCamera,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    setSelectedKeyframeId,
    setSelectedSegmentStartId,
    setFramingCamera,
    bumpCameraReseed,
    setViewportObjectOverrides,
    setShotCameraFlying,
    shotCameraFlying,
  });
  const {
    setTimelineOpen,
    stopCameraMovePreview,
    previewCameraMove,
    selectKeyframeNode,
  } = cameraMovePreview;

  const cameraMove = useCameraMoveController({
    selectedShot,
    draftCameraRef,
    getEffectiveCamera,
    videoAuthoring,
    stopCameraMovePreview,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    startFlyCamera,
    selectedKeyframeId,
    selectedSegmentStartId,
    setSelectedKeyframeId,
    setSelectedSegmentStartId,
    snapshotPreview,
    thumbnailFreshAfterFinishRef,
    setLandFlash,
    viewportObjectOverrides,
    setViewportObjectOverrides,
    setCameraMovePreviewUrl,
    isExportingCameraMove,
    setIsExportingCameraMove,
    setCameraMoveProgress,
    setCameraMoveProgressMessage,
    setCameraMoveError,
    setCameraMoveNotice,
    cameraMoveAbortRef,
    videoExportMode,
    setVideoExportMode,
    videoResolutionPreset,
    canRenderMp4,
    setCanRenderMp4,
  });
  const {
    videoDurationSeconds,
    resumeVideoAfterNextShotRef,
    keyframeThumbById,
    cameraMoveKeyframes,
    cameraMoveDurationSeconds,
    cameraMoveReady,
    cameraMoveEasing,
    supportedMp4MimeType,
    canExportVideo,
    selectedExportModeAvailable,
    captureCameraMoveKeyframe,
    changeCameraMoveEasing,
    changeIntermediateCameraMoveKeyframeTime,
    deleteIntermediateCameraMoveKeyframe,
    changeCameraMoveDuration,
    appendSequentialCapture,
    finishSequentialCapture,
    continueSequentialCapture,
    insertInSelectedSegment,
    updateSelectedKeyframePose,
    enterVideoMode,
    retakeVideoMove,
    completeVideoAndNextShot,
    exportCameraMoveVideo,
    cancelCameraMoveExport,
    handleHistoryRestore,
    handleShotSwitchVideoChrome,
  } = cameraMove;

  const handleLibraryRename = useCallback((shotId: string, updates: { productionShotId?: string; name: string }) => {
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return;
    updateShot(shotId, {
      productionShotId: normalizeProductionShotId(updates.productionShotId),
      name: normalizeShotTitle(shot, updates.name),
    });
  }, [project.shots, updateShot]);

  const handleOpenShotFromLibrary = useCallback((shotId: string) => {
    selectShot(shotId);
    setLibraryOpen(false);
  }, [selectShot]);

  const handleRequestDeleteShot = useCallback((shot: Shot) => {
    setShotPendingDelete(shot);
  }, []);

  const handleConfirmDeleteShot = useCallback(() => {
    if (!shotPendingDelete) return;
    if (!runDestructiveProjectMutation) {
      setSnapshotError('Local recovery is still starting. Please wait before deleting this shot.');
      return;
    }
    const shotId = shotPendingDelete.id;
    setShotPendingDelete(null);
    void runDestructiveProjectMutation('Before deleting a shot', () => {
      removeShot(shotId);
    }).catch((error) => {
      setSnapshotError(error instanceof Error ? error.message : 'Could not create a recovery point before deleting this shot.');
    });
  }, [removeShot, runDestructiveProjectMutation, shotPendingDelete]);

  const handleOpenShotFromMedia = useCallback((shotId: string) => {
    selectShot(shotId);
    setMediaModalShotId(null);
    setLibraryOpen(false);
  }, [selectShot]);

  useEffect(() => {
    if (!selectedShot) {
      setFramingCamera(undefined);
      draftCameraRef.current = undefined;
      return;
    }
    draftCameraRef.current = selectedShot.camera;
    setFramingCamera(selectedShot.camera);
    bumpCameraReseed();
  }, [bumpCameraReseed, selectedShot?.id]);

  useEffect(() => {
    if (!selectedShot || shotCameraFlyingRef.current) return;
    draftCameraRef.current = selectedShot.camera;
    setFramingCamera(selectedShot.camera);
    bumpCameraReseed();
  }, [bumpCameraReseed, selectedShot?.camera, selectedShot?.id]);

  useEffect(() => {
    if (
      shotCameraHistoryRestoreGeneration
      === handledRestoreGenerationRef.current
    ) {
      return;
    }

    handledRestoreGenerationRef.current = shotCameraHistoryRestoreGeneration;

    // Read latest shot after store restore (camera + cameraKeyframes).
    const restoredShot = useContinuityStore.getState().project.shots.find(
      (item) => item.id === selectedShotId,
    );
    if (!restoredShot) return;

    draftCameraRef.current = restoredShot.camera;
    setFramingCamera(restoredShot.camera);
    bumpCameraReseed();

    // Camera-move thumbs + authoring chrome (controller owns keyframeThumbGenerationRef).
    handleHistoryRestore(restoredShot.cameraKeyframes);
  }, [
    bumpCameraReseed,
    handleHistoryRestore,
    selectedShotId,
    shotCameraHistoryRestoreGeneration,
  ]);

  const pulseFocalLengthHud = shotCamera.pulseFocalLengthHud;

  const undoShotCameraWithActiveBatchFinalize = useCallback(() => {
    finalizeShotFovWheelBatchRef.current();
    undoShotCamera();
  }, [undoShotCamera]);

  const redoShotCameraWithActiveBatchFinalize = useCallback(() => {
    finalizeShotFovWheelBatchRef.current();
    redoShotCamera();
  }, [redoShotCamera]);

  const commitShotCamera = useCallback((camera: CameraData, options?: { cameraHistory?: 'step' | 'batch' | 'silent' }) => {
    const shotId = selectedShot?.id;
    if (!shotId) return;
    draftCameraRef.current = camera;
    setFramingCamera(camera);
    bumpCameraReseed();
    updateShot(shotId, { camera }, options);
  }, [bumpCameraReseed, selectedShot?.id, updateShot]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'i' && selectedShot && !isEditableTarget(event.target)) {
        event.preventDefault();
        setSettingsOpen((open) => !open);
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key.toLowerCase() === 'z' && event.shiftKey) {
        event.preventDefault();
        redoShotCameraWithActiveBatchFinalize();
        return;
      }
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undoShotCameraWithActiveBatchFinalize();
        return;
      }
      if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoShotCameraWithActiveBatchFinalize();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [redoShotCameraWithActiveBatchFinalize, selectedShot, undoShotCameraWithActiveBatchFinalize]);

  const framePreviewKey = useMemo(() => {
    const previewShot = getPreviewShot();
    if (!previewShot) return '';
    return JSON.stringify({
      scene: project.scene,
      camera: previewShot.camera,
      width: previewShot.exportSettings.width,
      height: previewShot.exportSettings.height,
    });
  }, [
    getPreviewShot,
    project.scene,
    selectedShot?.exportSettings.height,
    selectedShot?.exportSettings.width,
    selectedShot?.id,
  ]);

  useEffect(() => {
    if (shotCameraFlying) return;

    const previewShot = getPreviewShot();
    if (!previewShot) return;

    let cancelled = false;
    setIsRenderingFrame(true);
    // Transient preview only — do not write project assets here (would re-trigger this effect).
    void renderShotFrame(project, previewShot)
      .then((frame) => {
        if (cancelled) return;
        setShotFramePreview(previewShot.id, frame.dataUrl);
      })
      .finally(() => {
        if (!cancelled) setIsRenderingFrame(false);
      });

    return () => {
      cancelled = true;
    };
  }, [framePreviewKey, getPreviewShot, project, setShotFramePreview, shotCameraFlying]);

  const handleFramingCameraChange = useCallback((camera: CameraData) => {
    if (!selectedShot) return;
    draftCameraRef.current = camera;
    setFramingCamera(camera);
    if (shotCameraFlying) return;
    updateShot(selectedShot.id, { camera });
  }, [selectedShot?.id, shotCameraFlying, updateShot]);

  const handleShotFovWheelBatchStart = useCallback((_shotId: string) => {
    beginShotCameraHistoryBatch();
  }, [beginShotCameraHistoryBatch]);

  const handleShotFovWheelBatchEnd = useCallback((shotId: string, camera: CameraData) => {
    try {
      const state = useContinuityStore.getState();
      const shot = state.project.shots.find((item) => item.id === shotId);
      if (!shot) return;
      const nextCamera = buildShotFovWheelBatchCommit(shot.camera, camera);
      updateShot(shotId, { camera: nextCamera }, { cameraHistory: 'batch' });
      if (state.selectedShotId === shotId) {
        const liveFraming = applyLiveShotFovWheelBatchCommit(camera, nextCamera);
        draftCameraRef.current = liveFraming;
        setFramingCamera(liveFraming);
      }
    } finally {
      endShotCameraHistoryBatch();
    }
  }, [endShotCameraHistoryBatch, updateShot]);

  const handleFocalLengthHudPulse = useCallback(() => {
    pulseFocalLengthHud();
  }, [pulseFocalLengthHud]);

  const enterStillMode = useCallback(() => {
    videoAuthoring.dispatch({ type: 'EXIT_VIDEO' });
    clearKeyframeSelection();
    clearViewportObjectInspection();
    stopCameraMovePreview();
    thumbnailFreshAfterFinishRef.current = false;
    // Still camera is always live — like a phone camera app.
    startFlyCamera({ clearFramingAcceptance: false });
  }, [
    clearKeyframeSelection,
    clearViewportObjectInspection,
    startFlyCamera,
    stopCameraMovePreview,
    thumbnailFreshAfterFinishRef,
    videoAuthoring,
  ]);

  const setMode = useCallback((mode: CaptureMode) => {
    if (mode === captureMode) return;
    if (mode === 'video') enterVideoMode();
    else enterStillMode();
  }, [captureMode, enterStillMode, enterVideoMode]);

  const onCapture = useCallback(() => {
    if (!selectedShot) {
      addCamera();
      return;
    }
    if (captureMode === 'video') {
      // Finished move: shutter advances to a new empty video shot (not export).
      if (videoCaptureState === 'finished') {
        completeVideoAndNextShot();
        return;
      }
      appendSequentialCapture();
      return;
    }
    captureStill();
  }, [
    addCamera,
    appendSequentialCapture,
    captureMode,
    captureStill,
    completeVideoAndNextShot,
    selectedShot,
    videoCaptureState,
  ]);

  const enterStagingMode = useCallback(() => {
    if (!selectedShot) return;
    stopCameraMovePreview();
    // Keep keyframe object inspection so staging can edit the selected keyframe's pose.
    if (selectedKeyframeId && viewportObjectOverrides === undefined) {
      const keyframe = getSortedCameraKeyframes(selectedShot.cameraKeyframes)
        .find((item) => item.id === selectedKeyframeId);
      if (keyframe?.objectOverrides !== undefined) {
        setViewportObjectOverrides(structuredClone(keyframe.objectOverrides));
      } else {
        setViewportObjectOverrides(
          snapshotStageableObjectOverrides(
            useContinuityStore.getState().project,
            selectedShot,
          ),
        );
      }
    }
    const camera = getEffectiveCamera();
    landShotFraming(selectedShot.id, camera);
    setStagingMode(true);
    setStagedObjectId(undefined);
  }, [
    getEffectiveCamera,
    landShotFraming,
    selectedKeyframeId,
    selectedShot,
    stopCameraMovePreview,
    viewportObjectOverrides,
  ]);

  const exitStagingMode = useCallback(() => {
    setStagingMode(false);
    setStagedObjectId(undefined);
    startFlyCamera({ clearFramingAcceptance: false });
  }, [startFlyCamera]);

  const selectStagedObject = useCallback((id?: string) => {
    if (!id) {
      setStagedObjectId(undefined);
      return;
    }
    const object = shotSceneProject.scene.objects.find((item) => item.id === id);
    setStagedObjectId(object && canStageObjectPerShot(object) ? id : undefined);
  }, [shotSceneProject.scene.objects]);

  const updateStagedTransform = useCallback((objectId: string, transform: Transform) => {
    if (!selectedShot) return;
    const baseObject = project.scene.objects.find((object) => object.id === objectId);
    if (!baseObject || !canStageObjectPerShot(baseObject)) return;
    // When a keyframe is selected, stage into the transient inspection map so Recapture keyframe can commit it.
    if (selectedKeyframeId) {
      setViewportObjectOverrides((previous) => {
        const base = previous !== undefined
          ? previous
          : (selectedShot.objectOverrides ?? {});
        return updateShotObjectOverrides(
          { objectOverrides: base },
          baseObject,
          { transform },
        );
      });
      return;
    }
    updateShot(selectedShot.id, {
      objectOverrides: updateShotObjectOverrides(selectedShot, baseObject, { transform }),
    });
  }, [project.scene.objects, selectedKeyframeId, selectedShot, updateShot]);

  const moveStagedObject = useCallback((objectId: string, position: Vec3) => {
    const object = shotSceneProject.scene.objects.find((item) => item.id === objectId);
    if (!object) return;
    updateStagedTransform(objectId, { ...object.transform, position });
  }, [shotSceneProject.scene.objects, updateStagedTransform]);

  const rotateStagedObject = useCallback((objectId: string, rotation: Vec3) => {
    const object = shotSceneProject.scene.objects.find((item) => item.id === objectId);
    if (!object) return;
    updateStagedTransform(objectId, { ...object.transform, rotation });
  }, [shotSceneProject.scene.objects, updateStagedTransform]);

  const toggleStagedObjectVisibility = useCallback(() => {
    if (!selectedShot || !stagedObject) return;
    const baseObject = project.scene.objects.find((object) => object.id === stagedObject.id);
    if (!baseObject) return;
    if (selectedKeyframeId) {
      setViewportObjectOverrides((previous) => {
        const base = previous !== undefined ? previous : (selectedShot.objectOverrides ?? {});
        return updateShotObjectOverrides(
          { objectOverrides: base },
          baseObject,
          { visible: !stagedObject.visible },
        );
      });
      return;
    }
    updateShot(selectedShot.id, {
      objectOverrides: updateShotObjectOverrides(selectedShot, baseObject, { visible: !stagedObject.visible }),
    });
  }, [project.scene.objects, selectedKeyframeId, selectedShot, stagedObject, updateShot]);

  const resetStagedObject = useCallback(() => {
    if (!selectedShot || !stagedObjectId) return;
    if (selectedKeyframeId) {
      setViewportObjectOverrides((previous) => {
        const base = previous !== undefined ? previous : (selectedShot.objectOverrides ?? {});
        return clearShotObjectOverride({ objectOverrides: base }, stagedObjectId);
      });
      return;
    }
    updateShot(selectedShot.id, {
      objectOverrides: clearShotObjectOverride(selectedShot, stagedObjectId),
    });
  }, [selectedKeyframeId, selectedShot, stagedObjectId, updateShot]);

  const panoMatch = selectedShot && linkedPano
    ? getPanoMatchQuality(selectedShot.camera, linkedPano, project.settings)
    : undefined;

  const shotFraming = useMemo(() => (
    selectedShot
      ? {
        shotId: selectedShot.id,
        camera: framingCamera ?? selectedShot.camera,
        frameAspectRatio: selectedShot.exportSettings.width / selectedShot.exportSettings.height,
        frameResolutionLabel: `${selectedShot.exportSettings.width}×${selectedShot.exportSettings.height}`,
        flyActive: stagingMode ? false : shotCameraFlying,
        cameraReseedGeneration,
        focalLengthHudPulse,
        onCameraChange: handleFramingCameraChange,
        onFocalLengthHudPulse: handleFocalLengthHudPulse,
        onShotFovWheelBatchStart: handleShotFovWheelBatchStart,
        onShotFovWheelBatchEnd: handleShotFovWheelBatchEnd,
        onLockCamera: captureMode === 'video'
          ? (videoCaptureState === 'finished' ? undefined : appendSequentialCapture)
          : captureStill,
      }
      : undefined
  ), [
    appendSequentialCapture,
    captureMode,
    captureStill,
    cameraReseedGeneration,
    focalLengthHudPulse,
    framingCamera,
    handleFocalLengthHudPulse,
    handleFramingCameraChange,
    handleShotFovWheelBatchEnd,
    handleShotFovWheelBatchStart,
    selectedShot?.id,
    selectedShot?.camera,
    selectedShot?.exportSettings.height,
    selectedShot?.exportSettings.width,
    shotCameraFlying,
    stagingMode,
    videoCaptureState,
  ]);

  const framingAccepted = selectedShot ? isShotFramingAccepted(project, selectedShot.id) : false;
  const activeFramingCamera = framingCamera ?? selectedShot?.camera;
  const lensMm = activeFramingCamera
    ? Math.round(verticalFovToFocalLength(activeFramingCamera.fovDegrees, activeFramingCamera.aspectRatio))
    : (project.settings.defaultCameraLensMm ?? DEFAULT_CAMERA_LENS_MM);
  const cameraHeight = selectedShot?.camera.position[1] ?? DEFAULT_CAMERA_HEIGHT_METERS;

  // Reset chrome only when the selected shot identity changes — not when fly/camera
  // callbacks churn (that was dumping users out of Video mid-capture).
  useEffect(() => {
    setLibraryOpen(false);
    clearKeyframeSelection();
    clearViewportObjectInspection();
    stopCameraMovePreview();
    setStagedObjectId(undefined);
    const shot = useContinuityStore.getState().project.shots.find((item) => item.id === selectedShotId)
      ?? useContinuityStore.getState().project.shots[0];
    // Duration, authoring machine, thumbs — owned by camera-move controller.
    handleShotSwitchVideoChrome(shot);
    // Intentionally only selectedShotId — stable chrome reset per shot switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShotId]);

  const duplicateSelectedShot = useCallback(() => {
    if (!selectedShot) return;
    const newShot = addCamera();
    updateShot(newShot.id, {
      camera: {
        ...selectedShot.camera,
        position: [...selectedShot.camera.position] as CameraData['position'],
        target: [...selectedShot.camera.target] as CameraData['target'],
      },
      description: selectedShot.description,
      landmarkIds: [...selectedShot.landmarkIds],
      exportSettings: { ...selectedShot.exportSettings },
      cameraKeyframes: selectedShot.cameraKeyframes.map((keyframe) => ({
        ...keyframe,
        camera: {
          ...keyframe.camera,
          position: [...keyframe.camera.position] as CameraData['position'],
          target: [...keyframe.camera.target] as CameraData['target'],
        },
      })),
    });
  }, [addCamera, selectedShot, updateShot]);

  const openLinkedPanoIn360 = useCallback(() => {
    if (!linkedPano) return;
    setActivePano(linkedPano.id);
    setWorkspace('reference');
  }, [linkedPano, setActivePano, setWorkspace]);

  const selectedIndex = selectedShot
    ? project.shots.findIndex((shot) => shot.id === selectedShot.id)
    : -1;
  // iPhone-style recents: most recently captured shot (highest index with framing accepted).
  const lastCapturedShot = [...project.shots]
    .reverse()
    .find((shot) => isShotFramingAccepted(project, shot.id));
  const libraryThumbShot = lastCapturedShot
    ?? project.shots.find((shot) => shot.id !== selectedShot?.id)
    ?? selectedShot
    ?? project.shots[0];

  /** Timeline shows after third pose or explicit Edit timeline. */
  const showTimeline = timelineOpen || cameraMoveKeyframes.length > 2;
  /** Merge persisted keyframe stills (asset or URI) with in-flight local thumbs for the filmstrip. */
  const movePreviewThumbsById = useMemo(() => {
    const fromKeyframes: Record<string, string> = {};
    for (const keyframe of cameraMoveKeyframes) {
      const uri = resolveKeyframePreviewUri(project, keyframe);
      if (uri) fromKeyframes[keyframe.id] = uri;
    }
    return { ...fromKeyframes, ...keyframeThumbById };
  }, [cameraMoveKeyframes, keyframeThumbById, project]);

  const captureLabel = !selectedShot
    ? 'Add shot'
    : captureMode === 'video'
      ? (videoCaptureState === 'empty'
        ? 'Capture start'
        : videoCaptureState === 'capturing'
          ? (cameraMoveKeyframes.length < 1 ? 'Capture start' : 'Capture next pose')
          : isExportingCameraMove
            ? `${cameraMoveProgressMessage} · ${Math.round(cameraMoveProgress * 100)}%`
            : isPreviewingCameraMove
              ? 'Previewing move'
              : 'Next shot')
      : 'Capture';

  const captureHint = captureMode === 'video'
    ? (videoCaptureState === 'empty'
      ? 'Pose the first camera position · capture start'
      : videoCaptureState === 'capturing'
        ? (cameraMoveKeyframes.length < 2
          ? 'Move to the next pose · capture again'
          : 'Capture another pose or finish the move')
        : 'Move complete · next shot, preview, or export')
    : 'Capture adds a shot — viewfinder stays live';

  const captureFlashLabel = captureMode === 'video'
    ? (videoCaptureState === 'finished' || resumeVideoAfterNextShotRef.current
      ? 'Next shot'
      : cameraMoveKeyframes.length <= 1
        ? 'Start set'
        : 'Pose captured')
    : 'Captured';

  const goAdjacentShot = (direction: -1 | 1) => {
    if (selectedIndex < 0) return;
    const next = project.shots[selectedIndex + direction];
    if (next) selectShot(next.id);
  };

  return (
    <FullBleedLayout reserveHeader>
      <div className="relative h-full min-h-0 overflow-hidden bg-black" data-shots-camera-shell>
        <div className="absolute inset-0">
          <SceneViewport
            project={shotSceneProject}
            selectedObjectIds={stagedObjectId ? [stagedObjectId] : []}
            selectedShotId={selectedShot?.id}
            shotFraming={shotFraming}
            appearance={appearance}
            depthSettings={normalizeShotDepthSettings(
              selectedShot?.exportSettings.depth ?? defaultShotDepthSettings,
            )}
            onDepthRangeChange={setDepthPreviewRange}
            objectEditingActive={stagingMode}
            showTransformGizmo={stagingMode && Boolean(stagedObjectId)}
            gizmoMode={stagingGizmoMode}
            snapToGrid={false}
            onSelectObject={stagingMode ? selectStagedObject : undefined}
            onMoveObjectInSpace={stagingMode ? moveStagedObject : undefined}
            onRotateObject={stagingMode ? rotateStagedObject : undefined}
            minHeightClassName="min-h-0"
            parentFinalizeShotFovWheelBatchRef={finalizeShotFovWheelBatchRef}
            onOcclusionStatusChange={(status) => useContinuityStore.getState().setProjectedOcclusionStatus(status)}
          />
        </div>

        {/* Top chrome: shot index + settings */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 px-4 pt-[calc(var(--stage-header-safe)+0.35rem)]">
          <div className="pointer-events-auto rounded-full bg-black/45 px-3 py-1 text-xs font-semibold tabular-nums text-white/90 backdrop-blur-sm">
            {selectedShot
              ? `${selectedIndex + 1} / ${project.shots.length}`
              : 'No shots'}
          </div>
          <div className="pointer-events-auto flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowPeopleInViewport((value) => !value)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-card backdrop-blur-sm transition hover:bg-black/60"
                aria-label={showPeopleInViewport ? 'Hide people in viewport' : 'Show people in viewport'}
                title={showPeopleInViewport ? 'Hide people' : 'Show people'}
                data-shots-people-visibility
              >
                {showPeopleInViewport ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={stagingMode ? exitStagingMode : enterStagingMode}
                className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-white shadow-card backdrop-blur-sm transition ${
                  stagingMode ? 'border-white bg-white/20' : 'border-white/15 bg-black/45 hover:bg-black/60'
                }`}
                data-shots-staging-toggle
              >
                <Move3D className="h-4 w-4" />
                {stagingMode ? 'Done' : 'Stage'}
              </button>
              <AppearanceModeToggle
                value={appearance}
                projectedAvailable={canUseProjectedAppearance(project)}
                onChange={setAppearance}
                compact
                className="border-white/15 bg-black/50 text-white [&_button]:text-white/80 [&_button[aria-pressed=true]]:bg-white [&_button[aria-pressed=true]]:text-zinc-900"
              />
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-card backdrop-blur-sm transition hover:bg-black/60"
                aria-label="Camera settings"
                data-shots-settings-trigger
                title="Settings (I)"
              >
                <Settings2 className="h-4 w-4" />
              </button>
            </div>
            {appearance === 'depth' && selectedShot && (
              <div
                className="mt-1 w-72 rounded-2xl border border-white/15 bg-black/75 p-3 text-white shadow-soft backdrop-blur-md"
                data-shots-depth-settings
              >
                <DepthSettingsPanel
                  depth={normalizeShotDepthSettings(
                    selectedShot.exportSettings.depth ?? defaultShotDepthSettings,
                  )}
                  resolvedRange={depthPreviewRange}
                  onChange={(next) => updateShot(selectedShot.id, {
                    exportSettings: {
                      ...selectedShot.exportSettings,
                      depth: next,
                    },
                  })}
                  compact
                  className="[&_label]:text-white/80 [&_.text-secondary]:text-white/55 [&_.text-primary]:text-white [&_input]:bg-white/10 [&_select]:bg-white/10"
                />
              </div>
            )}
            <p className="max-w-[14rem] text-right text-[10px] font-medium text-white/55" data-shots-dual-output-hint>
              {appearance === 'depth'
                ? formatDepthRangeLegend(depthPreviewRange)
                : canUseProjectedAppearance(project)
                  ? 'View mode only · exports include clay + projected'
                  : 'View mode only · exports save clay frames'}
            </p>
          </div>
        </div>

        {stagingMode && (
          <div className="pointer-events-auto absolute left-4 top-[calc(var(--stage-header-safe)+3.25rem)] z-20 w-72 rounded-2xl border border-white/15 bg-black/70 p-3 text-white shadow-soft backdrop-blur-md" data-shots-staging-panel>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">Per-shot staging</div>
                <div className="text-[11px] text-white/60">
                  Click an object in the viewfinder, or pick one below.
                  {captureMode === 'video' ? ' Start/end keyframes freeze poses for video.' : ''}
                </div>
              </div>
              <div className="flex gap-1">
                <button type="button" onClick={() => setStagingGizmoMode('translate')} className={`rounded-lg p-2 ${stagingGizmoMode === 'translate' ? 'bg-white text-black' : 'bg-white/10 text-white'}`} title="Move"><Move3D className="h-4 w-4" /></button>
                <button type="button" onClick={() => setStagingGizmoMode('rotate')} className={`rounded-lg p-2 ${stagingGizmoMode === 'rotate' ? 'bg-white text-black' : 'bg-white/10 text-white'}`} title="Rotate"><RotateCw className="h-4 w-4" /></button>
              </div>
            </div>
            {stagedObject ? (
              <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                <div className="truncate text-xs font-semibold">{stagedObject.name}</div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={toggleStagedObjectVisibility} className="rounded-lg bg-white/10 px-2 py-2 text-xs hover:bg-white/15">{stagedObject.visible ? 'Hide in shot' : 'Show in shot'}</button>
                  <button type="button" onClick={resetStagedObject} className="rounded-lg bg-white/10 px-2 py-2 text-xs hover:bg-white/15">Reset to set</button>
                </div>
              </div>
            ) : (
              <p className="mt-3 border-t border-white/10 pt-3 text-xs text-white/60">No object selected.</p>
            )}
            {stageableObjects.length > 0 && (
              <div className="mt-3 max-h-40 space-y-1 overflow-y-auto border-t border-white/10 pt-3" data-shots-staging-object-list>
                {stageableObjects.map((object) => (
                  <button
                    key={object.id}
                    type="button"
                    onClick={() => selectStagedObject(object.id)}
                    title={object.visible ? undefined : 'Hidden in this shot'}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                      stagedObjectId === object.id ? 'bg-white text-black' : 'bg-white/5 text-white/85 hover:bg-white/10'
                    } ${object.visible ? '' : 'opacity-55'}`}
                  >
                    <span className="truncate">{object.name}</span>
                    <span className="ml-2 flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide opacity-60">
                      {!object.visible && <EyeOff className="h-3 w-3" aria-label="Hidden in this shot" />}
                      {getSceneObjectStagingRole(object)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Quiet landed flash */}
        {landFlash && (
          <div
            className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-white/10"
            data-shots-capture-flash
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-sm font-semibold text-white backdrop-blur-sm">
              <Check className="h-4 w-4 text-emerald-400" />
              {captureFlashLabel}
            </span>
          </div>
        )}

        {showCompare && selectedShot && (
          <div className="pointer-events-auto absolute inset-y-[calc(var(--stage-header-safe)+3rem)] right-3 z-20 w-72 overflow-hidden rounded-[var(--radius-card)] border border-white/10 bg-black/70 shadow-soft backdrop-blur-md">
            <ShotPanoCropPreview
              imageUrl={linkedAsset?.uri}
              crop={selectedShot.panoCrop}
              panoRotation={linkedPano?.rotation}
              label={linkedPano?.name ?? 'Pano match'}
              matchQuality={panoMatch?.quality}
              matchDistanceMeters={panoMatch?.distanceMeters}
              disabledReason={undefined}
            />
          </div>
        )}

        {showContinuityCompare && selectedShot && (
          <div className="pointer-events-auto absolute inset-y-[calc(var(--stage-header-safe)+3rem)] left-3 z-20 w-80 overflow-y-auto rounded-[var(--radius-card)] border border-white/10 bg-zinc-950/95 p-2 shadow-soft backdrop-blur-md">
            <ContinuityComparePanel
              project={project}
              currentShot={selectedShot}
              previousPreviewUri={
                (() => {
                  const prev = project.shots[project.shots.findIndex((s) => s.id === selectedShot.id) - 1];
                  if (!prev) return undefined;
                  return framePreviewByShotId[prev.id]
                    ?? project.assets.assets[prev.assets.viewportRenderAssetId ?? '']?.uri;
                })()
              }
              currentPreviewUri={
                framePreviewUrl
                ?? project.assets.assets[selectedShot.assets.viewportRenderAssetId ?? '']?.uri
              }
            />
          </div>
        )}

        {showSequenceBoard && (
          <div
            data-sequence-storyboard-host
            className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 max-h-[45%] overflow-hidden rounded-t-2xl border border-white/10 bg-zinc-950/95 shadow-soft backdrop-blur-md"
          >
            <SequenceStoryboardView
              project={project}
              selectedShotId={selectedShot?.id}
              onSelectShot={(shotId) => selectShot(shotId)}
              onReorder={(shotId, targetIndex) => reorderShots(shotId, targetIndex)}
              onCopyStagingToNext={(shotId) => copyStagingToNextShot(shotId)}
              resolveThumbnailUri={(item) => {
                if (item.thumbnailAssetId) {
                  return project.assets.assets[item.thumbnailAssetId]?.uri;
                }
                return framePreviewByShotId[item.shotId];
              }}
            />
          </div>
        )}

        <ShotsLibrary
          open={libraryOpen}
          onClose={() => setLibraryOpen(false)}
          project={project}
          selectedShotId={selectedShot?.id}
          onOpenShot={handleOpenShotFromLibrary}
          onRenameShot={handleLibraryRename}
          onRequestDelete={handleRequestDeleteShot}
          onOpenMedia={setMediaModalShotId}
          onAddShot={() => {
            addCamera();
            setLibraryOpen(false);
          }}
        />

        <ConfirmDialog
          open={shotPendingDelete != null}
          title={shotPendingDelete ? `Delete ${getShotPrimaryLabel(shotPendingDelete)}?` : 'Delete shot?'}
          confirmLabel="Delete shot"
          destructive
          onCancel={() => setShotPendingDelete(null)}
          onConfirm={handleConfirmDeleteShot}
        >
          {shotPendingDelete && (
            hasCustomShotTitle(shotPendingDelete)
              ? `"${shotPendingDelete.name.trim()}" and its saved captures will be removed from this project. This cannot be undone.`
              : 'Its saved captures will be removed from this project. This cannot be undone.'
          )}
        </ConfirmDialog>

        <ShotMediaModal
          open={mediaModalShotId != null}
          project={project}
          shots={project.shots}
          shotId={mediaModalShotId}
          onClose={() => setMediaModalShotId(null)}
          onOpenShot={handleOpenShotFromMedia}
          onUpdateShot={updateShot}
          onNavigateShot={setMediaModalShotId}
        />

        <ShotsCaptureChrome
          mode={captureMode}
          captureState={videoCaptureState}
          isPreviewing={isPreviewingCameraMove}
          isExporting={isExportingCameraMove}
          landFlash={landFlash}
          onStillMode={() => setMode('still')}
          onVideoMode={() => setMode('video')}
          onShutter={onCapture}
          shutterLabel={captureLabel}
          shutterTitle={captureHint}
          error={captureMode === 'still' ? snapshotError : undefined}
          hint={`${captureHint}${shotCameraFlying ? ' · WASD / mouse' : ''}`}
          librarySlot={(
            <button
              type="button"
              onClick={() => setLibraryOpen(true)}
              className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border-2 border-white/80 bg-zinc-900 shadow-card"
              aria-label="Open shot library"
              data-shots-library-thumb
              title="Previous shots"
            >
              {libraryThumbShot ? (
                <ShotCameraRollThumbnail
                  project={project}
                  shot={libraryThumbShot}
                  overrideSrc={framePreviewByShotId[libraryThumbShot.id]}
                  allowLivePreview
                  className="h-full w-full object-cover"
                  compact
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-white/40">
                  <ImageIcon className="h-5 w-5" />
                </span>
              )}
            </button>
          )}
          navSlot={(
            <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center gap-0.5">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => goAdjacentShot(-1)}
                  disabled={selectedIndex <= 0}
                  className="rounded-full p-1.5 text-white/80 transition hover:bg-white/10 disabled:opacity-30"
                  aria-label="Previous shot"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => goAdjacentShot(1)}
                  disabled={selectedIndex < 0 || selectedIndex >= project.shots.length - 1}
                  className="rounded-full p-1.5 text-white/80 transition hover:bg-white/10 disabled:opacity-30"
                  aria-label="Next shot"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            </div>
          )}
        >
          {captureMode === 'video' && (
            <div
              className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-2"
              data-shots-video-chrome
            >
              <div className="flex items-center gap-2">
                {videoCaptureState === 'capturing' && (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full bg-red-600/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow-sm"
                    data-shots-video-rec-badge
                  >
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                    Rec
                  </span>
                )}
                <p className="text-center text-[11px] font-medium text-white/75">
                  {captureHint}
                </p>
              </div>
              <div
                data-shots-video-duration
                className="flex w-full max-w-sm items-center gap-3 rounded-full bg-black/45 px-3 py-2 backdrop-blur-md"
                role="group"
                aria-label="Video duration"
              >
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-white/55">
                  Length
                </span>
                <input
                  type="range"
                  min={VIDEO_DURATION_UI_MIN_SECONDS}
                  max={VIDEO_DURATION_UI_MAX_SECONDS}
                  step={1}
                  value={clampVideoDurationUiSeconds(videoDurationSeconds)}
                  onChange={(event) => changeCameraMoveDuration(Number(event.target.value))}
                  className="h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-red-500 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                  aria-valuemin={VIDEO_DURATION_UI_MIN_SECONDS}
                  aria-valuemax={VIDEO_DURATION_UI_MAX_SECONDS}
                  aria-valuenow={clampVideoDurationUiSeconds(videoDurationSeconds)}
                  aria-valuetext={`${clampVideoDurationUiSeconds(videoDurationSeconds)} seconds`}
                />
                <span className="min-w-[2.75rem] shrink-0 text-center text-sm font-bold tabular-nums text-white">
                  {clampVideoDurationUiSeconds(videoDurationSeconds)}s
                </span>
              </div>

              {videoCaptureState === 'empty' && (
                <p className="text-[11px] text-white/55" data-shots-video-empty-hint>
                  No camera move captured
                </p>
              )}
              {videoCaptureState === 'capturing' && cameraMoveKeyframes.length === 1 && (
                <p className="text-[11px] font-medium text-white/80" data-shots-video-start-set>
                  Start set · fly to the next pose and capture
                </p>
              )}

              {/* Keyframe filmstrip + play path (and exported MP4 when available). */}
              {cameraMoveKeyframes.length >= 2 && (
                <CameraMovePreviewStrip
                  keyframes={cameraMoveKeyframes}
                  durationSeconds={cameraMoveDurationSeconds}
                  thumbsById={movePreviewThumbsById}
                  isPreviewing={isPreviewingCameraMove}
                  exportedVideoUrl={cameraMovePreviewUrl}
                  onPreview={previewCameraMove}
                  onStopPreview={() => {
                    stopCameraMovePreview();
                    clearViewportObjectInspection();
                  }}
                  onSelectKeyframe={(id) => selectKeyframeNode(id)}
                />
              )}

              {/* Compact path after second pose: Finish + Capture next (timeline still hidden). */}
              {videoCaptureState === 'capturing' && cameraMoveKeyframes.length >= 2 && !showTimeline && (
                <div
                  className="flex flex-wrap items-center justify-center gap-2"
                  data-shots-video-compact-actions
                >
                  <button
                    type="button"
                    data-camera-keyframe-capture-next
                    data-shots-video-capture-next
                    onClick={appendSequentialCapture}
                    className="rounded-full bg-white px-3 py-1.5 text-[11px] font-semibold text-black transition hover:bg-white/90"
                  >
                    Capture next
                  </button>
                  <button
                    type="button"
                    data-camera-keyframe-finish
                    data-shots-video-finish
                    onClick={finishSequentialCapture}
                    className="rounded-full bg-white/15 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-white/25"
                  >
                    Finish capture
                  </button>
                  <button
                    type="button"
                    data-shots-video-edit-timeline
                    onClick={() => setTimelineOpen(true)}
                    className="text-[11px] font-semibold text-white/70 underline-offset-2 hover:text-white hover:underline"
                  >
                    Edit timeline
                  </button>
                </div>
              )}

              {showTimeline && (
                <KeyframeStrip
                  keyframes={cameraMoveKeyframes}
                  durationSeconds={cameraMoveDurationSeconds}
                  captureState={videoCaptureState}
                  isPreviewing={isPreviewingCameraMove}
                  selectedKeyframeId={selectedKeyframeId}
                  selectedSegmentStartId={selectedSegmentStartId}
                  onCaptureNext={appendSequentialCapture}
                  onFinishCapture={finishSequentialCapture}
                  onContinueCapture={continueSequentialCapture}
                  onPreview={previewCameraMove}
                  onStopPreview={() => {
                    stopCameraMovePreview();
                    clearViewportObjectInspection();
                  }}
                  onSelectKeyframe={selectKeyframeNode}
                  onSelectSegment={(startId) => {
                    stopCameraMovePreview();
                    setSelectedKeyframeId(null);
                    clearViewportObjectInspection();
                    setSelectedSegmentStartId(startId);
                  }}
                  onInsertInSelectedSegment={insertInSelectedSegment}
                  onUpdatePose={updateSelectedKeyframePose}
                  onChangeTime={changeIntermediateCameraMoveKeyframeTime}
                  onDelete={deleteIntermediateCameraMoveKeyframe}
                />
              )}

              {videoCaptureState === 'finished' && cameraMoveReady && (
                <div
                  className="flex w-full flex-col items-center gap-2"
                  data-shots-video-finished
                >
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      data-shots-video-next-shot
                      onClick={completeVideoAndNextShot}
                      disabled={isExportingCameraMove || isPreviewingCameraMove}
                      className="rounded-full bg-white px-4 py-2 text-[12px] font-bold text-black transition hover:bg-white/90 disabled:opacity-40"
                    >
                      Next shot
                    </button>
                    {/* Path preview lives on CameraMovePreviewStrip (Play path / native MP4 controls). */}
                    <button
                      type="button"
                      data-shots-video-export
                      onClick={() => void exportCameraMoveVideo()}
                      disabled={isExportingCameraMove || !canExportVideo || !selectedExportModeAvailable || isPreviewingCameraMove}
                      className="rounded-full bg-white/15 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-white/25 disabled:opacity-40"
                    >
                      {isExportingCameraMove
                        ? `${Math.round(cameraMoveProgress * 100)}%`
                        : 'Export MP4'}
                    </button>
                    {!showTimeline && (
                      <button
                        type="button"
                        data-shots-video-edit-timeline
                        onClick={() => setTimelineOpen(true)}
                        className="rounded-full bg-white/15 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-white/25"
                      >
                        Edit timeline
                      </button>
                    )}
                  </div>
                  <p className="text-center text-[10px] text-white/55">
                    Next shot saves this move and starts a new one · export is optional
                  </p>
                </div>
              )}

              {(videoCaptureState === 'finished' || cameraMoveKeyframes.length > 0) && !isExportingCameraMove && (
                <div className="flex items-center gap-3">
                  {videoCaptureState === 'finished' && (
                    <span className="sr-only">Move complete. Press Next shot or the shutter to continue.</span>
                  )}
                  <button
                    type="button"
                    onClick={retakeVideoMove}
                    className="text-[11px] font-semibold text-white/70 underline-offset-2 transition hover:text-white hover:underline"
                    data-shots-video-retake
                  >
                    Retake move
                  </button>
                  {cameraMoveKeyframes.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const camera = getEffectiveCamera();
                        if (selectedShot && camera) {
                          snapshotPreview(selectedShot, camera, { markThumbnailFreshOnSuccess: true });
                        }
                      }}
                      className="text-[11px] font-semibold text-white/70 underline-offset-2 transition hover:text-white hover:underline"
                      data-shots-video-refresh-thumbnail
                    >
                      Refresh thumbnail
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {captureMode === 'video' && (!canExportVideo || cameraMoveError || cameraMoveNotice) && (
            <p
              role="alert"
              data-shots-camera-move-status
              className="pointer-events-auto max-w-md rounded-lg border border-amber-200/70 bg-black/65 px-3 py-2 text-center text-xs text-amber-100 shadow-soft backdrop-blur-sm"
            >
              {cameraMoveError ?? cameraMoveNotice ?? 'MP4 export is not supported in this browser. Try Chrome or Edge.'}
            </p>
          )}

          {captureMode === 'video' && isExportingCameraMove && (
            <div
              data-shots-camera-move-progress
              className="pointer-events-auto flex max-w-md flex-col items-center gap-2 rounded-lg border border-white/15 bg-black/65 px-3 py-2 text-center shadow-soft backdrop-blur-sm"
            >
              <p className="text-xs text-white/85">{cameraMoveProgressMessage}</p>
              <div className="h-1.5 w-48 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-white/80 transition-[width]"
                  style={{ width: `${Math.round(cameraMoveProgress * 100)}%` }}
                />
              </div>
              <button
                type="button"
                onClick={cancelCameraMoveExport}
                className="text-[11px] font-semibold uppercase tracking-wide text-white/70 underline-offset-2 hover:text-white hover:underline"
              >
                Cancel
              </button>
            </div>
          )}

          {captureMode === 'still' && snapshotError && (
            <p
              role="alert"
              data-shots-snapshot-status
              className="pointer-events-auto max-w-md rounded-lg border border-red-300/70 bg-black/65 px-3 py-2 text-center text-xs text-red-100 shadow-soft backdrop-blur-sm"
            >
              {snapshotError}
            </p>
          )}

        </ShotsCaptureChrome>
      </div>

      <ShotSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        shot={selectedShot}
        onUpdate={(updates) => selectedShot && updateShot(selectedShot.id, updates)}
        peopleExportMode={selectedShot?.exportSettings.peopleExportMode ?? 'with_people'}
        onPeopleExportMode={(mode) => selectedShot && updateShot(selectedShot.id, {
          exportSettings: {
            ...selectedShot.exportSettings,
            peopleExportMode: mode,
          },
        })}
      >
        {selectedShot && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <IconButton onClick={() => addCamera()} className="w-full">
                <Plus className="h-4 w-4" />
                New shot
              </IconButton>
              <IconButton onClick={duplicateSelectedShot} className="w-full">
                <Copy className="h-4 w-4" />
                Duplicate
              </IconButton>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-lg border border-subtle px-2 py-2">
                <div className="text-muted">Lens</div>
                <div className="font-semibold text-primary">{lensMm}mm</div>
              </div>
              <div className="rounded-lg border border-subtle px-2 py-2">
                <div className="text-muted">Height</div>
                <div className="font-semibold text-primary">{cameraHeight.toFixed(1)}m</div>
              </div>
              <div className="rounded-lg border border-subtle px-2 py-2">
                <div className="text-muted">FOV</div>
                <div className="font-semibold text-primary">{selectedShot.camera.fovDegrees.toFixed(0)}°</div>
              </div>
            </div>
            <Field label="Camera Position">
              <Vec3Input
                step={0.01}
                value={selectedShot.camera.position}
                onChange={(position) => commitShotCamera({ ...selectedShot.camera, position })}
              />
            </Field>
            <Field label="Camera Target">
              <Vec3Input
                step={0.01}
                value={selectedShot.camera.target}
                onChange={(target) => commitShotCamera({ ...selectedShot.camera, target })}
              />
            </Field>
            <Field label="FOV">
              <TextInput
                type="number"
                step={0.1}
                value={selectedShot.camera.fovDegrees}
                onChange={(event) => {
                  const fovDegrees = clampShotVerticalFov(
                    Number(event.target.value),
                    selectedShot.camera.aspectRatio,
                  );
                  commitShotCamera({ ...selectedShot.camera, fovDegrees });
                  pulseFocalLengthHud();
                }}
              />
            </Field>
            <Field
              label="Near Clip (m)"
              hint="Hides geometry closer than this distance from the camera."
            >
              <TextInput
                type="number"
                min={MIN_SHOT_NEAR_CLIP_METERS}
                max={Math.min(
                  MAX_SHOT_NEAR_CLIP_METERS,
                  selectedShot.camera.far - 0.01,
                )}
                step={0.01}
                value={selectedShot.camera.near}
                onChange={(event) => {
                  const near = clampShotNearClip(
                    Number(event.target.value),
                    selectedShot.camera.far,
                  );
                  commitShotCamera({
                    ...selectedShot.camera,
                    near,
                  });
                }}
              />
            </Field>
            <Field label="Resolution">
              <div className="grid grid-cols-2 gap-2">
                <TextInput
                  type="number"
                  value={selectedShot.exportSettings.width}
                  onChange={(event) => updateShot(selectedShot.id, {
                    exportSettings: { ...selectedShot.exportSettings, width: Number(event.target.value) },
                  })}
                />
                <TextInput
                  type="number"
                  value={selectedShot.exportSettings.height}
                  onChange={(event) => updateShot(selectedShot.id, {
                    exportSettings: { ...selectedShot.exportSettings, height: Number(event.target.value) },
                  })}
                />
              </div>
            </Field>

            <Panel title="Continuity & sequence">
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  data-continuity-compare-toggle
                  className="rounded-md border border-white/10 px-3 py-2 text-left text-xs hover:bg-white/5"
                  onClick={() => setShowContinuityCompare((value) => !value)}
                >
                  {showContinuityCompare ? 'Hide shot-to-shot continuity' : 'Shot-to-shot continuity'}
                </button>
                <button
                  type="button"
                  data-sequence-storyboard-toggle
                  className="rounded-md border border-white/10 px-3 py-2 text-left text-xs hover:bg-white/5"
                  onClick={() => setShowSequenceBoard((value) => !value)}
                >
                  {showSequenceBoard ? 'Hide sequence storyboard' : 'Sequence storyboard'}
                </button>
              </div>
            </Panel>
            <Panel title="Tools">
              <div className="space-y-2">
                <IconButton
                  onClick={() => setShowCompare((value) => !value)}
                  disabled={!linkedPano}
                  className="w-full"
                >
                  <Film className="h-4 w-4" />
                  {showCompare ? 'Hide pano match' : 'Pano match'}
                </IconButton>
                {linkedPano && (
                  <IconButton onClick={openLinkedPanoIn360} className="w-full">
                    <Globe className="h-4 w-4" />
                    Open in 360
                  </IconButton>
                )}
                <IconButton
                  onClick={() => void exportCameraFrame()}
                  disabled={isExportingFrame || isRenderingFrame}
                  className="w-full"
                >
                  <Download className="h-4 w-4" />
                  {isExportingFrame ? 'Exporting...' : `Download PNG (${selectedShot.exportSettings.width}×${selectedShot.exportSettings.height})`}
                </IconButton>
              </div>
            </Panel>

            <Panel title="Landmarks">
              <div className="space-y-2">
                {project.landmarks.map((landmark) => (
                  <label key={landmark.id} className="flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedShot.landmarkIds.includes(landmark.id)}
                      onChange={() => toggleShotLandmark(selectedShot.id, landmark.id)}
                      className="accent-[var(--accent)]"
                    />
                    <span className="flex-1 text-primary">{landmark.displayName}</span>
                  </label>
                ))}
                {project.landmarks.length === 0 && (
                  <p className="text-xs text-secondary">No landmarks in this project.</p>
                )}
              </div>
            </Panel>

            <Panel title="Video mode (advanced)">
              <div className="space-y-3">
                <p className="text-xs text-secondary">
                  Prefer sequential capture on the Video chrome (Capture next → Finish). Set Start / Set End remain as temporary manual fallbacks.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <IconButton onClick={() => captureCameraMoveKeyframe('start')} className="w-full">
                    <KeyRound className="h-4 w-4" />
                    Set Start
                  </IconButton>
                  <IconButton onClick={() => captureCameraMoveKeyframe('end')} className="w-full">
                    <KeyRound className="h-4 w-4" />
                    Set End
                  </IconButton>
                </div>
                <Field
                  label="Motion easing"
                  hint="Applies the same natural timing curve between every keyframe."
                >
                  <Select
                    value={cameraMoveEasing}
                    onChange={(event) => changeCameraMoveEasing(event.target.value as CameraKeyframeEasing)}
                    data-camera-keyframe-easing
                  >
                    {CAMERA_KEYFRAME_EASING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Duration Seconds"
                  hint="Also available as quick picks on the Video camera chrome while recording."
                >
                  <TextInput
                    type="number"
                    min={MIN_CAMERA_MOVE_DURATION_SECONDS}
                    max={MAX_CAMERA_MOVE_DURATION_SECONDS}
                    step="0.5"
                    value={cameraMoveDurationSeconds}
                    onChange={(event) => changeCameraMoveDuration(Number(event.target.value))}
                  />
                </Field>
                <Field label="Export mode" hint="Render MP4 is fixed-step H.264 for Resolve. Quick Preview is real-time and may drop frames.">
                  <Select
                    value={videoExportMode}
                    onChange={(event) => setVideoExportMode(event.target.value as 'render' | 'quickPreview')}
                  >
                    <option value="render" disabled={canRenderMp4 !== true}>
                      Render MP4{canRenderMp4 === true ? '' : canRenderMp4 === false ? ' (unavailable)' : '…'}
                    </option>
                    <option value="quickPreview" disabled={!supportedMp4MimeType}>
                      Quick Preview{supportedMp4MimeType ? '' : ' (unavailable)'}
                    </option>
                  </Select>
                </Field>
                <Field label="Video resolution" hint="Stills stay at shot resolution. Video defaults to 1080p30.">
                  <Select
                    value={videoResolutionPreset}
                    onChange={(event) => setVideoResolutionPreset(event.target.value as VideoResolutionPresetId)}
                  >
                    <option value="1080p">{VIDEO_RESOLUTION_PRESETS['1080p'].label}</option>
                    <option value="4k">{VIDEO_RESOLUTION_PRESETS['4k'].label}</option>
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <IconButton
                    onClick={() => void exportCameraMoveVideo()}
                    disabled={!cameraMoveReady || isExportingCameraMove || !canExportVideo || !selectedExportModeAvailable}
                    className="w-full"
                  >
                    <Film className="h-4 w-4" />
                    {isExportingCameraMove
                      ? `${Math.round(cameraMoveProgress * 100)}%`
                      : videoExportMode === 'quickPreview'
                        ? 'Quick Preview'
                        : 'Render MP4'}
                  </IconButton>
                  <IconButton
                    onClick={cancelCameraMoveExport}
                    disabled={!isExportingCameraMove}
                    className="w-full"
                  >
                    <X className="h-4 w-4" />
                    Cancel
                  </IconButton>
                </div>
                {isExportingCameraMove && (
                  <p className="rounded-lg border border-subtle bg-panel px-3 py-2 text-xs text-muted">
                    {cameraMoveProgressMessage}
                  </p>
                )}
                {!canExportVideo && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    MP4 export is not supported in this browser.
                  </p>
                )}
                {cameraMoveError && (
                  <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{cameraMoveError}</p>
                )}
                {cameraMoveNotice && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">{cameraMoveNotice}</p>
                )}
                {cameraMovePreviewUrl && (
                  <video src={cameraMovePreviewUrl} controls className="aspect-video w-full rounded-lg border border-subtle" />
                )}
              </div>
            </Panel>

            <button
              type="button"
              onClick={() => handleRequestDeleteShot(selectedShot)}
              disabled={project.shots.length <= 1}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 transition hover:bg-red-50 disabled:opacity-45"
            >
              <Trash2 className="h-4 w-4" />
              Delete Shot
            </button>
          </>
        )}
      </ShotSettings>
    </FullBleedLayout>
  );
}

function ModePill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-11 rounded-full px-5 py-2.5 text-xs font-bold uppercase tracking-wider transition ${
        active
          ? 'bg-white text-zinc-900 shadow-sm'
          : 'text-white/70 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}
