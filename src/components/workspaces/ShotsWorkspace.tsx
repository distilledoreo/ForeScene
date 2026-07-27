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
  DEFAULT_CAMERA_MOVE_DURATION_SECONDS,
  MAX_CAMERA_MOVE_DURATION_SECONDS,
  MIN_CAMERA_MOVE_DURATION_SECONDS,
  CAMERA_KEYFRAME_EASING_OPTIONS,
  CameraMoveKeyframeSlot,
  VideoCaptureState,
  appendSequentialCameraKeyframe,
  getCameraMoveDurationSeconds,
  getSortedCameraKeyframes,
  hasManualCameraKeyframeTiming,
  hasRenderableCameraMove,
  insertCameraKeyframeInSegment,
  interpolateCameraKeyframes,
  recaptureCameraKeyframe,
  removeIntermediateCameraKeyframe,
  setTwoPointCameraKeyframe,
  updateCameraKeyframeEasing,
  updateCameraMoveDuration,
  updateIntermediateCameraKeyframeTime,
} from '../../engine/cameraKeyframes';
import { KeyframeStrip } from './KeyframeStrip';
import { runSettledSequentially } from '../../engine/asyncJobs';
import {
  getCameraMoveDownloadName,
  getProjectedCameraMoveDownloadName,
  getProjectedStillDownloadName,
  getViewportStillDownloadName,
} from '../../engine/exportNaming';
import { downloadBlob, downloadDataUrl } from '../../engine/fileTransfers';
import {
  canUseRenderMp4Export,
  getSupportedCameraMoveMp4MimeType,
  renderShotCameraMoveMp4,
  renderShotFrame,
  renderShotProjectedFrame,
  renderViewportProjected,
  type CameraMoveExportProgress,
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
import { getPeopleRenderVariants, getPeopleVariantPath } from '../../engine/peopleExport';
import {
  createCameraMoveExportPasses,
  getCameraMoveExportCompletionMessage,
  runCameraMoveExportPasses,
} from '../../engine/cameraMoveExportPasses';
import {
  interpolateObjectOverrides,
  snapshotStageableObjectOverrides,
} from '../../engine/objectKeyframes';
import {
  type ShotStillViewSelection,
} from '../../domain/shotStillViews';
import type { GizmoMode } from '../../engine/transformGizmo';
import { AppearanceModeToggle } from '../common/AppearanceModeToggle';
import { FullBleedLayout } from './WorkspaceShell';
import {
  getShotPrimaryLabel,
  hasCustomShotTitle,
  normalizeProductionShotId,
  normalizeShotTitle,
} from '../../domain/shotIdentity';

const statuses: ShotStatus[] = ['planned', 'exported', 'needs_fix', 'approved', 'rejected'];
const STATUS_LABELS: Record<ShotStatus, string> = {
  planned: 'Planned',
  exported: 'Exported',
  needs_fix: 'Needs fix',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Compact chrome slider range: 1–20s in whole-second steps. */
const VIDEO_DURATION_UI_MIN_SECONDS = 1;
const VIDEO_DURATION_UI_MAX_SECONDS = 20;

type CaptureMode = 'still' | 'video';
/** Simple = two-pose finish path; Pro = full multi-keyframe strip. */
type VideoAuthoringMode = 'simple' | 'pro';

function clampVideoDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_CAMERA_MOVE_DURATION_SECONDS;
  return Math.min(
    MAX_CAMERA_MOVE_DURATION_SECONDS,
    Math.max(MIN_CAMERA_MOVE_DURATION_SECONDS, seconds),
  );
}

/** Round to whole seconds for the chrome slider (1–20). */
function clampVideoDurationUiSeconds(seconds: number): number {
  const rounded = Math.round(clampVideoDuration(seconds));
  return Math.min(
    VIDEO_DURATION_UI_MAX_SECONDS,
    Math.max(VIDEO_DURATION_UI_MIN_SECONDS, rounded),
  );
}

/** Derive authoring capture state from keyframe count when restoring a shot. */
function captureStateFromKeyframes(keyframes: readonly unknown[]): VideoCaptureState {
  if (keyframes.length === 0) return 'empty';
  if (keyframes.length === 1) return 'capturing';
  return 'finished';
}

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
    attachCameraMoveVideoToShot,
    attachViewportRenderToShot,
    setWorkspace,
    setActivePano,
    beginShotCameraHistoryBatch,
    endShotCameraHistoryBatch,
    undoShotCamera,
    redoShotCamera,
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
    attachCameraMoveVideoToShot: state.attachCameraMoveVideoToShot,
    attachViewportRenderToShot: state.attachViewportRenderToShot,
    setWorkspace: state.setWorkspace,
    setActivePano: state.setActivePano,
    beginShotCameraHistoryBatch: state.beginShotCameraHistoryBatch,
    endShotCameraHistoryBatch: state.endShotCameraHistoryBatch,
    undoShotCamera: state.undoShotCamera,
    redoShotCamera: state.redoShotCamera,
  })));
  const flushProject = useProjectSafetyStore((state) => state.flushProject);
  const runDestructiveProjectMutation = useProjectSafetyStore((state) => state.runDestructiveProjectMutation);
  const shotCameraHistoryRestoreGeneration = useContinuityStore(
    (state) => state.shotCameraHistoryRestoreGeneration,
  );
  const [stagingMode, setStagingMode] = useState(false);
  const [stagingGizmoMode, setStagingGizmoMode] = useState<GizmoMode>('translate');
  const [stagedObjectId, setStagedObjectId] = useState<string>();
  const [showPeopleInViewport, setShowPeopleInViewport] = useState(true);
  const selectedShot = project.shots.find((shot) => shot.id === selectedShotId) ?? project.shots[0];
  /**
   * Transient object overrides for keyframe inspection / move preview.
   * Not written to the shot until Update pose (or staging edits) commits them.
   */
  const [viewportObjectOverrides, setViewportObjectOverrides] = useState<
    ShotObjectOverrides | undefined
  >(undefined);
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
  const draftCameraRef = useRef<CameraData | undefined>();
  const shotCameraFlyingRef = useRef(shotCameraFlying);
  shotCameraFlyingRef.current = shotCameraFlying;
  const handledRestoreGenerationRef = useRef(shotCameraHistoryRestoreGeneration);
  const finalizeShotFovWheelBatchRef = useRef<() => void>(() => {});
  /** Transient live previews keyed by shot id — never reuse across shots. */
  const [framePreviewByShotId, setFramePreviewByShotId] = useState<Record<string, string>>({});
  const framePreviewUrl = selectedShot ? framePreviewByShotId[selectedShot.id] : undefined;
  const [isRenderingFrame, setIsRenderingFrame] = useState(false);
  const [isExportingFrame, setIsExportingFrame] = useState(false);
  const [cameraMovePreviewUrl, setCameraMovePreviewUrl] = useState<string | undefined>();
  const [isExportingCameraMove, setIsExportingCameraMove] = useState(false);
  const [cameraMoveProgress, setCameraMoveProgress] = useState(0);
  const [cameraMoveProgressMessage, setCameraMoveProgressMessage] = useState('Preparing scene');
  const [cameraMoveError, setCameraMoveError] = useState<string | undefined>();
  const [cameraMoveNotice, setCameraMoveNotice] = useState<string | undefined>();
  const [snapshotError, setSnapshotError] = useState<string | undefined>();
  const cameraMoveAbortRef = useRef<{ cancelled: boolean; abort?: () => void }>({ cancelled: false });
  const [videoExportMode, setVideoExportMode] = useState<'render' | 'quickPreview'>('render');
  const [videoResolutionPreset, setVideoResolutionPreset] = useState<VideoResolutionPresetId>('1080p');
  const [canRenderMp4, setCanRenderMp4] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [shotPendingDelete, setShotPendingDelete] = useState<Shot | null>(null);
  const [mediaModalShotId, setMediaModalShotId] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('still');
  const [appearance, setAppearance] = useState<'clay' | 'projected'>('clay');
  const [landFlash, setLandFlash] = useState(false);
  /** Pending move length — applied when end is captured (and updates existing end if present). */
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(DEFAULT_CAMERA_MOVE_DURATION_SECONDS);
  /**
   * Sequential capture authoring state (empty → capturing → finished).
   * Export progress stays on isExportingCameraMove — never overloaded into capture state.
   */
  const [videoCaptureState, setVideoCaptureState] = useState<VideoCaptureState>('empty');
  /** Simple (default): two-pose capture without timeline chrome. Pro: full keyframe strip. */
  const [videoAuthoringMode, setVideoAuthoringMode] = useState<VideoAuthoringMode>('simple');
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
  const [selectedSegmentStartId, setSelectedSegmentStartId] = useState<string | null>(null);
  const [isPreviewingCameraMove, setIsPreviewingCameraMove] = useState(false);
  const previewAbortRef = useRef<{ cancelled: boolean; frame?: number }>({ cancelled: false });
  const [framingCamera, setFramingCamera] = useState<CameraData | undefined>();
  const [focalLengthHudPulse, setFocalLengthHudPulse] = useState(0);
  const [cameraReseedGeneration, setCameraReseedGeneration] = useState(0);
  const bumpCameraReseed = useCallback(() => {
    setCameraReseedGeneration((value) => value + 1);
  }, []);

  const clearKeyframeSelection = useCallback(() => {
    setSelectedKeyframeId(null);
    setSelectedSegmentStartId(null);
  }, []);

  const getEffectiveCamera = useCallback((): CameraData | undefined => {
    if (!selectedShot) return undefined;
    return draftCameraRef.current ?? selectedShot.camera;
  }, [selectedShot]);

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

  const cameraMoveKeyframes = useMemo(
    () => getSortedCameraKeyframes(selectedShot?.cameraKeyframes ?? []),
    [selectedShot?.cameraKeyframes],
  );
  const storedCameraMoveDurationSeconds = selectedShot
    ? getCameraMoveDurationSeconds(cameraMoveKeyframes, DEFAULT_CAMERA_MOVE_DURATION_SECONDS)
    : DEFAULT_CAMERA_MOVE_DURATION_SECONDS;
  const cameraMoveDurationSeconds = captureMode === 'video'
    ? videoDurationSeconds
    : storedCameraMoveDurationSeconds;
  const cameraMoveReady = hasRenderableCameraMove(cameraMoveKeyframes);
  const cameraMoveEasing = cameraMoveKeyframes[0]?.easing ?? 'linear';
  const cameraMoveAsset = selectedShot?.assets.cameraMoveVideoAssetId
    ? project.assets.assets[selectedShot.assets.cameraMoveVideoAssetId]
    : undefined;
  const supportedMp4MimeType = getSupportedCameraMoveMp4MimeType();
  const canExportVideo = canRenderMp4 === true || Boolean(supportedMp4MimeType);

  useEffect(() => {
    let cancelled = false;
    setCanRenderMp4(null);
    void canUseRenderMp4Export(videoResolutionPreset).then((supported) => {
      if (!cancelled) setCanRenderMp4(supported);
    });
    return () => {
      cancelled = true;
    };
  }, [videoResolutionPreset]);

  // Keep the mode selector honest: if Render is confirmed unsupported for the current preset,
  // switch the control to Quick Preview when that path exists (never silently encode as preview).
  useEffect(() => {
    if (videoExportMode === 'render' && canRenderMp4 === false && supportedMp4MimeType) {
      setVideoExportMode('quickPreview');
    }
  }, [canRenderMp4, supportedMp4MimeType, videoExportMode]);

  const selectedExportModeAvailable = videoExportMode === 'render'
    ? canRenderMp4 === true
    : Boolean(supportedMp4MimeType);
  const applyExportProgress = useCallback((
    progress: number | CameraMoveExportProgress,
    mapProgress: (value: number) => number = (value) => value,
  ) => {
    if (cameraMoveAbortRef.current.cancelled) return;
    if (typeof progress === 'number') {
      setCameraMoveProgress(mapProgress(progress));
      return;
    }
    setCameraMoveProgress(mapProgress(progress.progress));
    setCameraMoveProgressMessage(progress.message);
  }, []);

  const cancelCameraMoveExport = useCallback(() => {
    cameraMoveAbortRef.current.cancelled = true;
    cameraMoveAbortRef.current.abort?.();
    setIsExportingCameraMove(false);
    setCameraMoveProgress(0);
    setCameraMoveProgressMessage('Preparing scene');
    setCameraMoveError('MP4 export was cancelled.');
    setCameraMoveNotice(undefined);
  }, []);

  const setShotFramePreview = useCallback((shotId: string, dataUrl: string) => {
    setFramePreviewByShotId((current) => ({ ...current, [shotId]: dataUrl }));
  }, []);

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

  const exportCameraFrame = useCallback(async () => {
    const previewShot = getPreviewShot();
    if (!previewShot) return;
    setIsExportingFrame(true);
    setSnapshotError(undefined);
    try {
      if (!flushProject) throw new Error('Local project recovery is still starting. Please wait before rendering a still.');
      // A downloaded still must be traceable to a durable project state, not
      // merely the transient editor state that happened to be on screen.
      updateShot(previewShot.id, { camera: previewShot.camera });
      const verified = await flushProject('Verified save before still render');
      if (!verified) throw new Error('No verified project revision is available for still rendering.');
      const renderProject = verified.project;
      const renderShot = renderProject.shots.find((shot) => shot.id === previewShot.id) ?? previewShot;
      const peopleMode = renderShot.exportSettings.peopleExportMode;
      const variants = getPeopleRenderVariants(peopleMode);
      const viewportFileName = getViewportStillDownloadName(renderShot);
      for (const variant of variants) {
        const frame = await renderShotFrame(renderProject, renderShot, { peopleVariant: variant });
        const clayName = getPeopleVariantPath(viewportFileName, variant, peopleMode);
        const stillPeople = variant === 'clean_plate' ? 'clean_plate' as const : 'with_people' as const;
        if (variant === 'with_people' || variants.length === 1) {
          setShotFramePreview(renderShot.id, frame.dataUrl);
        }
        attachViewportRenderToShot(renderShot.id, {
          name: clayName,
          dataUrl: frame.dataUrl,
          width: frame.width,
          height: frame.height,
          stillView: { appearance: 'clay', people: stillPeople },
        });
        downloadDataUrl(frame.dataUrl, clayName);
        if (canUseProjectedAppearance(renderProject)) {
          try {
            const projected = await renderShotProjectedFrame(renderProject, renderShot, { peopleVariant: variant });
            const baseProjectedName = getProjectedStillDownloadName(renderShot);
            const projectedName = getPeopleVariantPath(baseProjectedName, variant, peopleMode);
            attachViewportRenderToShot(renderShot.id, {
              name: projectedName,
              dataUrl: projected.dataUrl,
              width: projected.width,
              height: projected.height,
              stillView: { appearance: 'projected', people: stillPeople },
            });
            downloadDataUrl(projected.dataUrl, projectedName);
          } catch {
            // Soft-fail projected companion; clay already succeeded.
          }
        }
      }
      if (!shotCameraFlying) updateShot(renderShot.id, { status: 'exported' });
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : 'Could not save the project before rendering this still.');
    } finally {
      setIsExportingFrame(false);
    }
  }, [
    attachViewportRenderToShot,
    flushProject,
    getPreviewShot,
    setShotFramePreview,
    shotCameraFlying,
    updateShot,
  ]);

  const updateCameraMoveKeyframes = useCallback((keyframes: typeof cameraMoveKeyframes) => {
    if (!selectedShot) return;
    updateShot(selectedShot.id, {
      cameraKeyframes: keyframes,
      assets: {
        ...selectedShot.assets,
        cameraMoveVideoAssetId: undefined,
      },
    });
    setCameraMovePreviewUrl(undefined);
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);
  }, [selectedShot, updateShot]);

  const captureCameraMoveKeyframe = useCallback((slot: CameraMoveKeyframeSlot) => {
    if (!selectedShot) return;
    const camera = getEffectiveCamera();
    if (!camera) return;
    const latest = useContinuityStore.getState().project;
    const latestShot = latest.shots.find((item) => item.id === selectedShot.id) ?? selectedShot;
    const nextKeyframes = setTwoPointCameraKeyframe({
      keyframes: latestShot.cameraKeyframes,
      slot,
      camera,
      durationSeconds: cameraMoveDurationSeconds,
      objectOverrides: snapshotStageableObjectOverrides(latest, latestShot),
    });
    updateCameraMoveKeyframes(nextKeyframes);
    // Advanced drawer fallback: mirror sequential authoring state from keyframe count.
    setVideoCaptureState(captureStateFromKeyframes(nextKeyframes));
    clearKeyframeSelection();
  }, [
    cameraMoveDurationSeconds,
    clearKeyframeSelection,
    getEffectiveCamera,
    selectedShot,
    updateCameraMoveKeyframes,
  ]);

  const changeCameraMoveEasing = useCallback((easing: CameraKeyframeEasing) => {
    if (!selectedShot) return;
    updateCameraMoveKeyframes(updateCameraKeyframeEasing(selectedShot.cameraKeyframes, easing));
  }, [selectedShot, updateCameraMoveKeyframes]);

  const stopCameraMovePreview = useCallback(() => {
    previewAbortRef.current.cancelled = true;
    if (previewAbortRef.current.frame != null) {
      cancelAnimationFrame(previewAbortRef.current.frame);
      previewAbortRef.current.frame = undefined;
    }
    setIsPreviewingCameraMove(false);
  }, []);

  const clearViewportObjectInspection = useCallback(() => {
    setViewportObjectOverrides(undefined);
  }, []);

  useEffect(() => () => {
    previewAbortRef.current.cancelled = true;
    if (previewAbortRef.current.frame != null) {
      cancelAnimationFrame(previewAbortRef.current.frame);
    }
  }, []);

  const changeIntermediateCameraMoveKeyframeTime = useCallback((keyframeId: string, timeSeconds: number) => {
    if (!selectedShot) return;
    stopCameraMovePreview();
    updateCameraMoveKeyframes(updateIntermediateCameraKeyframeTime(
      selectedShot.cameraKeyframes,
      keyframeId,
      timeSeconds,
    ));
  }, [selectedShot, stopCameraMovePreview, updateCameraMoveKeyframes]);

  const deleteIntermediateCameraMoveKeyframe = useCallback((keyframeId: string) => {
    if (!selectedShot) return;
    stopCameraMovePreview();
    updateCameraMoveKeyframes(removeIntermediateCameraKeyframe(
      selectedShot.cameraKeyframes,
      keyframeId,
    ));
    if (selectedKeyframeId === keyframeId) {
      clearKeyframeSelection();
      clearViewportObjectInspection();
    }
  }, [
    clearKeyframeSelection,
    clearViewportObjectInspection,
    selectedKeyframeId,
    selectedShot,
    stopCameraMovePreview,
    updateCameraMoveKeyframes,
  ]);

  const changeCameraMoveDuration = useCallback((durationSeconds: number) => {
    if (!selectedShot) return;
    const next = clampVideoDuration(durationSeconds);
    setVideoDurationSeconds(next);
    // Only rewrite keyframes when an end pose already exists; otherwise the
    // pending duration is applied on the next end capture.
    if (hasRenderableCameraMove(selectedShot.cameraKeyframes)) {
      updateCameraMoveKeyframes(updateCameraMoveDuration(selectedShot.cameraKeyframes, next));
    }
  }, [selectedShot, updateCameraMoveKeyframes]);

  const exportCameraMoveVideo = useCallback(async () => {
    if (!selectedShot) return;
    if (!canExportVideo) {
      setCameraMoveError('MP4 export is not supported in this browser. Try Chrome or Edge.');
      return;
    }
    if (!hasRenderableCameraMove(selectedShot.cameraKeyframes)) {
      setCameraMoveError('Capture start and end camera keyframes before exporting MP4.');
      return;
    }
    if (videoExportMode === 'render' && canRenderMp4 !== true) {
      setCameraMoveError(
        `Render MP4 is unavailable for ${videoResolutionPreset === '4k' ? '4K' : '1080p'} in this browser. Choose Quick Preview, or try Chrome/Edge.`,
      );
      return;
    }
    if (videoExportMode === 'quickPreview' && !supportedMp4MimeType) {
      setCameraMoveError('Quick Preview MP4 is not supported in this browser.');
      return;
    }

    const shotId = selectedShot.id;
    const abortController = new AbortController();
    cameraMoveAbortRef.current = { cancelled: false, abort: () => abortController.abort() };
    setIsExportingCameraMove(true);
    setCameraMoveProgress(0);
    setCameraMoveProgressMessage('Preparing scene');
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);

    try {
      if (!flushProject) throw new Error('Local project recovery is still starting. Please wait before rendering MP4.');
      // Lock the render inputs to a verified local revision before expensive
      // encoding begins. The generated video can then be reproduced after a
      // reload from the same saved controls and source media.
      const verified = await flushProject('Verified save before video render');
      if (!verified) throw new Error('No verified project revision is available for MP4 rendering.');
      const renderProject = verified.project;
      const renderShot = renderProject.shots.find((shot) => shot.id === shotId);
      if (!renderShot) throw new Error('The selected shot changed before MP4 rendering could begin.');
      const variants = getPeopleRenderVariants(renderShot.exportSettings.peopleExportMode);
      const passes = createCameraMoveExportPasses(
        variants,
        canUseProjectedAppearance(renderProject),
      );
      const totalPasses = passes.length;
      const results = await runCameraMoveExportPasses(
        passes,
        async (pass, passIndex) => {
          const video = await renderShotCameraMoveMp4(renderProject, renderShot, {
            mode: videoExportMode,
            resolutionPreset: videoResolutionPreset,
            frameRate: 30,
            appearance: pass.appearance,
            peopleVariant: pass.peopleVariant,
            occlusionFilter: pass.appearance === 'projected' && videoExportMode === 'render' ? 'fast' : undefined,
            includeDataUrl: pass.appearance === 'clay',
            signal: abortController.signal,
            onProgress: (progress) => {
              const value = typeof progress === 'number' ? progress : progress.progress;
              const message = typeof progress === 'number'
                ? `Rendering ${pass.appearance} motion`
                : progress.message;
              setCameraMoveProgress((passIndex + value) / totalPasses);
              setCameraMoveProgressMessage(message);
            },
          });
          if (cameraMoveAbortRef.current.cancelled) return video;

          if (pass.appearance === 'clay') {
            if (!video.dataUrl) throw new Error('Camera move export did not produce a persistable video URI.');
            const clayName = getPeopleVariantPath(
              getCameraMoveDownloadName(renderShot),
              pass.peopleVariant,
              renderShot.exportSettings.peopleExportMode,
            );
            if (pass.peopleVariant === 'with_people' || variants.length === 1) {
              const asset = attachCameraMoveVideoToShot(renderShot.id, {
                name: clayName,
                dataUrl: video.dataUrl,
                mimeType: video.mimeType,
                width: video.width,
                height: video.height,
                durationSeconds: video.durationSeconds,
                frameRate: video.frameRate,
                encodeMode: video.encodeMode ?? videoExportMode,
                codecString: video.codecString,
                frameCount: video.frameCount,
                resolutionPreset: videoResolutionPreset,
              });
              setCameraMovePreviewUrl(asset.uri);
            }
            downloadBlob(video.blob, clayName);
          } else {
            downloadBlob(
              video.blob,
              getPeopleVariantPath(
                getProjectedCameraMoveDownloadName(renderShot),
                pass.peopleVariant,
                renderShot.exportSettings.peopleExportMode,
              ),
            );
          }
          setCameraMoveProgress((passIndex + 1) / totalPasses);
          return video;
        },
        () => cameraMoveAbortRef.current.cancelled || abortController.signal.aborted,
      );
      if (results.cancelled) return;

      const completionMessage = getCameraMoveExportCompletionMessage(
        results.completed.length,
        totalPasses,
        results.failures,
      );
      setCameraMoveProgress(1);
      if (results.failures.length === 0) {
        setCameraMoveProgressMessage('Complete');
      } else if (results.completed.length === 0) {
        setCameraMoveProgressMessage(completionMessage);
        setCameraMoveError(completionMessage);
      } else {
        setCameraMoveProgressMessage(completionMessage);
        setCameraMoveNotice(completionMessage);
      }
    } catch (error) {
      if (!cameraMoveAbortRef.current.cancelled) {
        setCameraMoveError(error instanceof Error ? error.message : 'MP4 export failed.');
      }
    } finally {
      if (!cameraMoveAbortRef.current.cancelled) setIsExportingCameraMove(false);
    }
  }, [
    attachCameraMoveVideoToShot,
    canExportVideo,
    canRenderMp4,
    flushProject,
    selectedShot,
    supportedMp4MimeType,
    videoExportMode,
    videoResolutionPreset,
  ]);

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

    if (!selectedShot) return;

    draftCameraRef.current = selectedShot.camera;
    setFramingCamera(selectedShot.camera);
    bumpCameraReseed();
  }, [bumpCameraReseed, shotCameraHistoryRestoreGeneration, selectedShot?.id]);

  const pulseFocalLengthHud = useCallback(() => {
    setFocalLengthHudPulse((value) => value + 1);
  }, []);

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
    setCameraMovePreviewUrl(cameraMoveAsset?.uri);
  }, [cameraMoveAsset?.uri, selectedShot?.id]);

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

  const startFlyCamera = useCallback((options?: { clearFramingAcceptance?: boolean }) => {
    // Seed from the stored shot only when entering fly — never clobber a live draft pose.
    if (selectedShot && !shotCameraFlying) {
      draftCameraRef.current = selectedShot.camera;
      setFramingCamera(selectedShot.camera);
      bumpCameraReseed();
    }
    setShotCameraFlying(true, options);
  }, [bumpCameraReseed, selectedShot, setShotCameraFlying, shotCameraFlying]);

  const snapshotPreview = useCallback((shot: { id: string; name?: string; exportSettings: { width: number; height: number }; camera: CameraData }, camera: CameraData) => {
    // Use latest project from the store so freshly created shots are not missing
    // from a stale React closure after addCamera.
    const latestProject = useContinuityStore.getState().project;
    const latestShot = latestProject.shots.find((item) => item.id === shot.id) ?? shot;
    const previewShot = {
      ...latestShot,
      camera: {
        ...camera,
        position: [...camera.position] as CameraData['position'],
        target: [...camera.target] as CameraData['target'],
      },
    };
    setSnapshotError(undefined);
    const shotForNaming = previewShot as typeof latestProject.shots[number];
    const viewportFileName = getViewportStillDownloadName(shotForNaming);
    const attach = useContinuityStore.getState().attachViewportRenderToShot;

    const attachStillView = async (
      selection: ShotStillViewSelection,
      dataUrl: string,
      width: number,
      height: number,
      fileName: string,
    ) => {
      attach(shot.id, {
        name: fileName,
        dataUrl,
        width,
        height,
        stillView: selection,
      });
    };

    void renderShotFrame(latestProject, shotForNaming, { peopleVariant: 'with_people' })
      .then(async (frame) => {
        setShotFramePreview(shot.id, frame.dataUrl);
        await attachStillView(
          { appearance: 'clay', people: 'with_people' },
          frame.dataUrl,
          frame.width,
          frame.height,
          viewportFileName,
        );

        // Capture companion stills for camera-roll view toggles (projection × people).
        const companionJobs: Array<() => Promise<void>> = [
          () => renderShotFrame(latestProject, shotForNaming, { peopleVariant: 'clean_plate' })
            .then((clean) => attachStillView(
              { appearance: 'clay', people: 'clean_plate' },
              clean.dataUrl,
              clean.width,
              clean.height,
              getPeopleVariantPath(viewportFileName, 'clean_plate', 'both'),
            )),
        ];

        if (canUseProjectedAppearance(latestProject)) {
          const projectedBaseName = getProjectedStillDownloadName(shotForNaming);
          companionJobs.push(
            () => renderShotProjectedFrame(latestProject, shotForNaming, { peopleVariant: 'with_people' })
              .then(async (projected) => {
                await attachStillView(
                  { appearance: 'projected', people: 'with_people' },
                  projected.dataUrl,
                  projected.width,
                  projected.height,
                  projectedBaseName,
                );
              }),
            () => renderShotProjectedFrame(latestProject, shotForNaming, { peopleVariant: 'clean_plate' })
              .then((projectedClean) => attachStillView(
                { appearance: 'projected', people: 'clean_plate' },
                projectedClean.dataUrl,
                projectedClean.width,
                projectedClean.height,
                getPeopleVariantPath(projectedBaseName, 'clean_plate', 'both'),
              )),
          );
        }

        await runSettledSequentially(companionJobs);
      })
      .catch(() => {
        setSnapshotError('Could not save the shot preview. Try Capture again.');
      });
  }, [setShotFramePreview]);

  /**
   * Still capture = iPhone shutter: commit pose to gallery, keep viewfinder live.
   * First press fills the active unlanded shot; later presses create new gallery shots.
   */
  const captureStill = useCallback(() => {
    if (!selectedShot) {
      addCamera();
      return;
    }
    const camera = draftCameraRef.current ?? selectedShot.camera;
    const alreadyCaptured = isShotFramingAccepted(
      useContinuityStore.getState().project,
      selectedShot.id,
    );

    let targetShot = selectedShot;
    if (alreadyCaptured) {
      targetShot = addCamera({ navigateToShots: false });
    }

    landShotFraming(targetShot.id, camera, { keepFlying: true });
    // Stay live at the same pose — do not clear draft / freeze the viewfinder.
    draftCameraRef.current = {
      ...camera,
      position: [...camera.position] as CameraData['position'],
      target: [...camera.target] as CameraData['target'],
    };
    snapshotPreview(targetShot, camera);
    setLandFlash(true);
    window.setTimeout(() => setLandFlash(false), 700);
  }, [addCamera, landShotFraming, selectedShot, snapshotPreview]);

  const appendSequentialCapture = useCallback(() => {
    if (!selectedShot) return;
    if (videoCaptureState === 'finished') return;
    stopCameraMovePreview();
    const camera = getEffectiveCamera();
    if (!camera) return;
    const latest = useContinuityStore.getState().project;
    const latestShot = latest.shots.find((item) => item.id === selectedShot.id) ?? selectedShot;
    const wasEmpty = latestShot.cameraKeyframes.length === 0;
    const duration = cameraMoveDurationSeconds;
    const preserveManualTiming = hasManualCameraKeyframeTiming(latestShot.cameraKeyframes, duration);
    const pose: CameraData = {
      ...camera,
      position: [...camera.position] as CameraData['position'],
      target: [...camera.target] as CameraData['target'],
    };
    const nextKeyframes = appendSequentialCameraKeyframe({
      keyframes: latestShot.cameraKeyframes,
      camera: pose,
      durationSeconds: duration,
      objectOverrides: snapshotStageableObjectOverrides(latest, latestShot),
      easing: cameraMoveEasing,
      preserveManualTiming,
    });
    // Persist live pose so chrome re-renders cannot reseat the camera at an old origin.
    updateShot(selectedShot.id, {
      camera: pose,
      cameraKeyframes: nextKeyframes,
      assets: {
        ...latestShot.assets,
        cameraMoveVideoAssetId: undefined,
      },
    });
    setCameraMovePreviewUrl(undefined);
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);
    draftCameraRef.current = pose;
    clearKeyframeSelection();
    clearViewportObjectInspection();
    landShotFraming(selectedShot.id, pose, { keepFlying: true });
    // Simple mode: two poses complete the move automatically so finish is always obvious.
    // Pro mode stays in capturing until Finish capture.
    const simpleComplete = videoAuthoringMode === 'simple' && nextKeyframes.length >= 2;
    if (simpleComplete) {
      setVideoCaptureState('finished');
      snapshotPreview(selectedShot, pose);
    } else {
      setVideoCaptureState('capturing');
      // Thumbnail only on first Start — intermediate Pro appends stay light.
      if (wasEmpty) {
        snapshotPreview(selectedShot, pose);
      }
    }
    setLandFlash(true);
    window.setTimeout(() => setLandFlash(false), 500);
  }, [
    cameraMoveDurationSeconds,
    cameraMoveEasing,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    getEffectiveCamera,
    landShotFraming,
    selectedShot,
    snapshotPreview,
    stopCameraMovePreview,
    updateShot,
    videoAuthoringMode,
    videoCaptureState,
  ]);

  const finishSequentialCapture = useCallback(() => {
    if (!hasRenderableCameraMove(cameraMoveKeyframes)) return;
    stopCameraMovePreview();
    setVideoCaptureState('finished');
    clearKeyframeSelection();
    clearViewportObjectInspection();
    // Refresh gallery thumbnail once the authored move is finished.
    const camera = getEffectiveCamera();
    if (selectedShot && camera) {
      snapshotPreview(selectedShot, camera);
    }
  }, [
    cameraMoveKeyframes,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    getEffectiveCamera,
    selectedShot,
    snapshotPreview,
    stopCameraMovePreview,
  ]);

  const continueSequentialCapture = useCallback(() => {
    if (!hasRenderableCameraMove(cameraMoveKeyframes)) return;
    stopCameraMovePreview();
    setVideoCaptureState('capturing');
    clearKeyframeSelection();
    clearViewportObjectInspection();
  }, [
    cameraMoveKeyframes,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    stopCameraMovePreview,
  ]);

  const insertInSelectedSegment = useCallback(() => {
    if (!selectedShot || !selectedSegmentStartId) return;
    stopCameraMovePreview();
    const camera = getEffectiveCamera();
    if (!camera) return;
    const latest = useContinuityStore.getState().project;
    const latestShot = latest.shots.find((item) => item.id === selectedShot.id) ?? selectedShot;
    const beforeIds = new Set(latestShot.cameraKeyframes.map((keyframe) => keyframe.id));
    const nextKeyframes = insertCameraKeyframeInSegment({
      keyframes: latestShot.cameraKeyframes,
      afterKeyframeId: selectedSegmentStartId,
      camera,
      objectOverrides: snapshotStageableObjectOverrides(latest, latestShot),
      easing: cameraMoveEasing,
    });
    if (nextKeyframes.length === latestShot.cameraKeyframes.length) {
      return;
    }
    updateCameraMoveKeyframes(nextKeyframes);
    const inserted = nextKeyframes.find((keyframe) => !beforeIds.has(keyframe.id));
    setSelectedSegmentStartId(null);
    if (inserted) {
      setSelectedKeyframeId(inserted.id);
      // Inspect the newly inserted pose's object snapshot without binding the camera.
      if (inserted.objectOverrides !== undefined) {
        setViewportObjectOverrides(structuredClone(inserted.objectOverrides));
      } else {
        clearViewportObjectInspection();
      }
    }
  }, [
    cameraMoveEasing,
    clearViewportObjectInspection,
    getEffectiveCamera,
    selectedSegmentStartId,
    selectedShot,
    stopCameraMovePreview,
    updateCameraMoveKeyframes,
  ]);

  const updateSelectedKeyframePose = useCallback((keyframeId: string) => {
    if (!selectedShot) return;
    stopCameraMovePreview();
    const camera = getEffectiveCamera();
    if (!camera) return;
    const latest = useContinuityStore.getState().project;
    const latestShot = latest.shots.find((item) => item.id === selectedShot.id) ?? selectedShot;
    // Prefer live viewport inspection overrides when the user staged objects after selection.
    const objectSnapshot = viewportObjectOverrides !== undefined
      ? structuredClone(viewportObjectOverrides)
      : snapshotStageableObjectOverrides(latest, latestShot);
    const next = recaptureCameraKeyframe({
      keyframes: latestShot.cameraKeyframes,
      keyframeId,
      camera,
      objectOverrides: objectSnapshot,
    });
    updateCameraMoveKeyframes(next);
    setViewportObjectOverrides(objectSnapshot);
  }, [
    getEffectiveCamera,
    selectedShot,
    stopCameraMovePreview,
    updateCameraMoveKeyframes,
    viewportObjectOverrides,
  ]);

  const selectKeyframeNode = useCallback((keyframeId: string | null) => {
    stopCameraMovePreview();
    setSelectedSegmentStartId(null);
    setSelectedKeyframeId(keyframeId);
    if (!keyframeId || !selectedShot) {
      clearViewportObjectInspection();
      return;
    }
    const keyframe = getSortedCameraKeyframes(selectedShot.cameraKeyframes)
      .find((item) => item.id === keyframeId);
    if (!keyframe) {
      clearViewportObjectInspection();
      return;
    }
    // One-time jump to the stored pose, then leave the camera free.
    const pose: CameraData = {
      ...keyframe.camera,
      position: [...keyframe.camera.position] as CameraData['position'],
      target: [...keyframe.camera.target] as CameraData['target'],
    };
    draftCameraRef.current = pose;
    setFramingCamera(pose);
    bumpCameraReseed();
    // Restore stored object snapshot for inspection (viewport-only, not committed).
    if (keyframe.objectOverrides !== undefined) {
      setViewportObjectOverrides(structuredClone(keyframe.objectOverrides));
    } else {
      clearViewportObjectInspection();
    }
    if (!shotCameraFlying) {
      setShotCameraFlying(true);
    }
  }, [
    bumpCameraReseed,
    clearViewportObjectInspection,
    selectedShot,
    setShotCameraFlying,
    shotCameraFlying,
    stopCameraMovePreview,
  ]);

  const previewCameraMove = useCallback(() => {
    if (!selectedShot || !hasRenderableCameraMove(cameraMoveKeyframes)) return;
    stopCameraMovePreview();
    clearKeyframeSelection();
    const keyframes = getSortedCameraKeyframes(cameraMoveKeyframes);
    const duration = getCameraMoveDurationSeconds(keyframes, cameraMoveDurationSeconds);
    const startTime = performance.now();
    const latestProject = useContinuityStore.getState().project;
    const latestShot = latestProject.shots.find((item) => item.id === selectedShot.id) ?? selectedShot;
    previewAbortRef.current = { cancelled: false };
    setIsPreviewingCameraMove(true);
    startFlyCamera({ clearFramingAcceptance: false });

    const tick = (now: number) => {
      if (previewAbortRef.current.cancelled) return;
      const elapsed = (now - startTime) / 1000;
      const t = Math.min(elapsed, duration);
      const firstTime = keyframes[0].timeSeconds;
      const sampleTime = firstTime + t;
      const camera = interpolateCameraKeyframes(keyframes, sampleTime);
      const pose: CameraData = {
        ...camera,
        position: [...camera.position] as CameraData['position'],
        target: [...camera.target] as CameraData['target'],
      };
      draftCameraRef.current = pose;
      setFramingCamera(pose);
      bumpCameraReseed();
      setViewportObjectOverrides(interpolateObjectOverrides(
        keyframes,
        sampleTime,
        latestShot.objectOverrides,
        latestProject.scene.objects,
      ));
      if (elapsed < duration) {
        previewAbortRef.current.frame = requestAnimationFrame(tick);
        return;
      }
      setIsPreviewingCameraMove(false);
      // Leave the end pose; clear transient inspection overrides so live staging returns.
      setViewportObjectOverrides(undefined);
    };
    previewAbortRef.current.frame = requestAnimationFrame(tick);
  }, [
    bumpCameraReseed,
    cameraMoveDurationSeconds,
    cameraMoveKeyframes,
    clearKeyframeSelection,
    selectedShot,
    startFlyCamera,
    stopCameraMovePreview,
  ]);

  const enterVideoMode = useCallback(() => {
    if (!selectedShot) return;
    const existing = selectedShot.cameraKeyframes;
    const duration = clampVideoDuration(
      getCameraMoveDurationSeconds(existing, videoDurationSeconds),
    );
    setVideoDurationSeconds(duration);
    setCaptureMode('video');
    // Preserve authored keyframes when re-entering Video (e.g. after shot switch forces Still).
    // Only Retake / explicit clear wipes the sequence — never auto-capture Start here.
    setVideoCaptureState(captureStateFromKeyframes(existing));
    clearKeyframeSelection();
    clearViewportObjectInspection();
    stopCameraMovePreview();
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);
    startFlyCamera({ clearFramingAcceptance: false });
  }, [
    clearKeyframeSelection,
    clearViewportObjectInspection,
    selectedShot,
    startFlyCamera,
    stopCameraMovePreview,
    videoDurationSeconds,
  ]);

  const enterStillMode = useCallback(() => {
    setCaptureMode('still');
    setVideoCaptureState('empty');
    clearKeyframeSelection();
    clearViewportObjectInspection();
    stopCameraMovePreview();
    // Still camera is always live — like a phone camera app.
    startFlyCamera({ clearFramingAcceptance: false });
  }, [clearKeyframeSelection, clearViewportObjectInspection, startFlyCamera, stopCameraMovePreview]);

  const setMode = useCallback((mode: CaptureMode) => {
    if (mode === captureMode) return;
    if (mode === 'video') enterVideoMode();
    else enterStillMode();
  }, [captureMode, enterStillMode, enterVideoMode]);

  const retakeVideoMove = useCallback(() => {
    if (!selectedShot) return;
    updateCameraMoveKeyframes([]);
    setVideoCaptureState('empty');
    clearKeyframeSelection();
    clearViewportObjectInspection();
    stopCameraMovePreview();
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);
    startFlyCamera({ clearFramingAcceptance: false });
  }, [
    clearKeyframeSelection,
    clearViewportObjectInspection,
    selectedShot,
    startFlyCamera,
    stopCameraMovePreview,
    updateCameraMoveKeyframes,
  ]);

  const onCapture = useCallback(() => {
    if (!selectedShot) {
      addCamera();
      return;
    }
    if (captureMode === 'video') {
      // Shutter shares sequential append; never becomes Export after the second pose.
      if (videoCaptureState === 'finished') return;
      appendSequentialCapture();
      return;
    }
    captureStill();
  }, [
    addCamera,
    appendSequentialCapture,
    captureMode,
    captureStill,
    selectedShot,
    videoCaptureState,
  ]);

  const enterStagingMode = useCallback(() => {
    if (!selectedShot) return;
    stopCameraMovePreview();
    clearViewportObjectInspection();
    const camera = getEffectiveCamera();
    landShotFraming(selectedShot.id, camera);
    setStagingMode(true);
    setStagedObjectId(undefined);
  }, [
    clearViewportObjectInspection,
    getEffectiveCamera,
    landShotFraming,
    selectedShot,
    stopCameraMovePreview,
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
    updateShot(selectedShot.id, {
      objectOverrides: updateShotObjectOverrides(selectedShot, baseObject, { transform }),
    });
  }, [project.scene.objects, selectedShot, updateShot]);

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
    updateShot(selectedShot.id, {
      objectOverrides: updateShotObjectOverrides(selectedShot, baseObject, { visible: !stagedObject.visible }),
    });
  }, [project.scene.objects, selectedShot, stagedObject, updateShot]);

  const resetStagedObject = useCallback(() => {
    if (!selectedShot || !stagedObjectId) return;
    updateShot(selectedShot.id, {
      objectOverrides: clearShotObjectOverride(selectedShot, stagedObjectId),
    });
  }, [selectedShot, stagedObjectId, updateShot]);

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

  useEffect(() => {
    setCaptureMode('still');
    setLibraryOpen(false);
    setVideoCaptureState(captureStateFromKeyframes(selectedShot?.cameraKeyframes ?? []));
    clearKeyframeSelection();
    clearViewportObjectInspection();
    stopCameraMovePreview();
    setStagedObjectId(undefined);
    if (selectedShot) {
      setVideoDurationSeconds(
        getCameraMoveDurationSeconds(selectedShot.cameraKeyframes, DEFAULT_CAMERA_MOVE_DURATION_SECONDS),
      );
    }
  }, [clearKeyframeSelection, clearViewportObjectInspection, selectedShot?.id, stopCameraMovePreview]);

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

  const isProVideo = videoAuthoringMode === 'pro';
  const simpleHasIntermediates = !isProVideo && cameraMoveKeyframes.length > 2;

  const captureLabel = !selectedShot
    ? 'Add shot'
    : captureMode === 'video'
      ? (videoCaptureState === 'empty'
        ? 'Capture start'
        : videoCaptureState === 'capturing'
          ? (isProVideo
            ? 'Capture next pose'
            : (cameraMoveKeyframes.length < 1 ? 'Capture start' : 'Capture end'))
          : isExportingCameraMove
            ? `${cameraMoveProgressMessage} · ${Math.round(cameraMoveProgress * 100)}%`
            : isPreviewingCameraMove
              ? 'Previewing move'
              : 'Move finished')
      : 'Capture';

  const captureHint = captureMode === 'video'
    ? (videoCaptureState === 'empty'
      ? 'Pose the first camera position · capture start'
      : videoCaptureState === 'capturing'
        ? (isProVideo
          ? (cameraMoveKeyframes.length < 2
            ? 'Move to the next pose · capture again'
            : 'Capture another pose or finish the move')
          : 'Fly to the end pose · capture end')
        : (isProVideo
          ? 'Move finished · preview, edit timeline, or export'
          : 'Move ready · preview or export'))
    : 'Capture adds a shot — viewfinder stays live';

  const captureFlashLabel = captureMode === 'video'
    ? (cameraMoveKeyframes.length <= 1
      ? 'Start set'
      : (videoAuthoringMode === 'simple' && cameraMoveKeyframes.length === 2
        ? 'End set · ready'
        : 'Pose captured'))
    : 'Captured';

  const setVideoAuthoringModeSafe = useCallback((mode: VideoAuthoringMode) => {
    if (mode === videoAuthoringMode) return;
    stopCameraMovePreview();
    clearKeyframeSelection();
    clearViewportObjectInspection();
    setVideoAuthoringMode(mode);
    // Never wipe keyframes on mode switch — only Retake clears.
    // Multi-keyframe moves stay intact; Simple simply hides the timeline chrome.
    if (mode === 'simple' && cameraMoveKeyframes.length >= 2) {
      setVideoCaptureState('finished');
    }
  }, [
    cameraMoveKeyframes.length,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    stopCameraMovePreview,
    videoAuthoringMode,
  ]);

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
            <p className="max-w-[14rem] text-right text-[10px] font-medium text-white/55" data-shots-dual-output-hint>
              {canUseProjectedAppearance(project)
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

        {/* Library sheet (opened from thumbnail) */}
        {libraryOpen && (
          <div
            className="absolute inset-0 z-40 flex flex-col justify-end bg-black/50 backdrop-blur-[2px]"
            data-shots-library
            onClick={() => setLibraryOpen(false)}
          >
            <div
              className="rounded-t-3xl border border-white/10 bg-zinc-950/95 px-4 pb-8 pt-3 shadow-soft"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Shots</h2>
                <button
                  type="button"
                  onClick={() => setLibraryOpen(false)}
                  className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
                  aria-label="Close shot library"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {project.shots.map((shot) => {
                  const selected = shot.id === selectedShot?.id;
                  const landed = isShotFramingAccepted(project, shot.id);
                  const canDelete = project.shots.length > 1;
                  return (
                    <React.Fragment key={shot.id}>
                      <ShotsLibraryCard
                        project={project}
                        shot={shot}
                        selected={selected}
                        landed={landed}
                        canDelete={canDelete}
                        sheetOpen={libraryOpen}
                        onOpenMedia={setMediaModalShotId}
                        onOpenShot={handleOpenShotFromLibrary}
                        onRename={handleLibraryRename}
                        onRequestDelete={handleRequestDeleteShot}
                      />
                    </React.Fragment>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    addCamera();
                    setLibraryOpen(false);
                  }}
                  className="inline-flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/25 text-white/80 transition hover:border-[var(--accent)] hover:text-accent"
                >
                  <Plus className="h-5 w-5" />
                  <span className="text-[10px] font-semibold">New</span>
                </button>
              </div>
            </div>
          </div>
        )}

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

        {/* Bottom camera chrome */}
        <div
          data-shots-camera-chrome
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-4 pb-6 pt-10"
          style={{
            background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.35) 55%, transparent 100%)',
          }}
        >
          {/* Mode switcher */}
          <div
            data-shots-mode-switcher
            className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/40 p-1 backdrop-blur-md"
          >
            <ModePill
              label="Still"
              active={captureMode === 'still'}
              onClick={() => setMode('still')}
            />
            <ModePill
              label="Video"
              active={captureMode === 'video'}
              onClick={() => setMode('video')}
            />
          </div>

          {captureMode === 'video' && (
            <div className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-2">
              <div
                data-shots-video-authoring-mode
                data-shots-video-authoring-mode-value={videoAuthoringMode}
                className="flex items-center gap-1 rounded-full bg-black/40 p-0.5 backdrop-blur-md"
                role="group"
                aria-label="Video authoring complexity"
              >
                <button
                  type="button"
                  data-shots-video-mode-simple
                  onClick={() => setVideoAuthoringModeSafe('simple')}
                  className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wide transition ${
                    videoAuthoringMode === 'simple'
                      ? 'bg-white text-zinc-900'
                      : 'text-white/65 hover:text-white'
                  }`}
                >
                  Simple
                </button>
                <button
                  type="button"
                  data-shots-video-mode-pro
                  onClick={() => setVideoAuthoringModeSafe('pro')}
                  className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wide transition ${
                    videoAuthoringMode === 'pro'
                      ? 'bg-white text-zinc-900'
                      : 'text-white/65 hover:text-white'
                  }`}
                >
                  Pro
                </button>
              </div>

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

              {/* Simple: two-pose chrome without timeline complexity */}
              {videoAuthoringMode === 'simple' && (
                <div
                  className="flex w-full flex-col items-center gap-2"
                  data-shots-video-simple-chrome
                >
                  {simpleHasIntermediates && (
                    <p
                      className="max-w-sm text-center text-[10px] text-amber-100/90"
                      data-shots-video-simple-pro-hint
                    >
                      This move has {cameraMoveKeyframes.length} poses.
                      {' '}
                      <button
                        type="button"
                        className="font-semibold underline underline-offset-2"
                        onClick={() => setVideoAuthoringModeSafe('pro')}
                      >
                        Open Pro
                      </button>
                      {' '}
                      to edit the timeline.
                    </p>
                  )}
                  {videoCaptureState === 'empty' && (
                    <p className="text-[11px] text-white/55">No camera move captured</p>
                  )}
                  {videoCaptureState === 'capturing' && cameraMoveKeyframes.length === 1 && (
                    <p className="text-[11px] font-medium text-white/80" data-shots-video-simple-start-set>
                      Start set · fly to end and capture
                    </p>
                  )}
                  {videoCaptureState === 'finished' && cameraMoveReady && (
                    <div className="flex flex-wrap items-center justify-center gap-2" data-shots-video-simple-finished>
                      {isPreviewingCameraMove ? (
                        <button
                          type="button"
                          data-camera-keyframe-stop-preview
                          onClick={() => {
                            stopCameraMovePreview();
                            clearViewportObjectInspection();
                          }}
                          className="rounded-full bg-white px-3 py-1.5 text-[11px] font-semibold text-black transition hover:bg-white/90"
                        >
                          Stop preview
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-camera-keyframe-preview
                          data-shots-video-preview
                          onClick={previewCameraMove}
                          className="rounded-full bg-white px-3 py-1.5 text-[11px] font-semibold text-black transition hover:bg-white/90"
                        >
                          Preview move
                        </button>
                      )}
                      <button
                        type="button"
                        data-shots-video-export
                        onClick={() => void exportCameraMoveVideo()}
                        disabled={isExportingCameraMove || !canExportVideo || !selectedExportModeAvailable || isPreviewingCameraMove}
                        className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
                      >
                        {isExportingCameraMove
                          ? `${Math.round(cameraMoveProgress * 100)}%`
                          : videoExportMode === 'quickPreview'
                            ? 'Quick Preview MP4'
                            : 'Export MP4'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Pro: full multi-keyframe strip */}
              {videoAuthoringMode === 'pro' && (
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

              {/* Finished Pro also gets an obvious export control outside the strip */}
              {videoAuthoringMode === 'pro' && videoCaptureState === 'finished' && cameraMoveReady && !isExportingCameraMove && (
                <button
                  type="button"
                  data-shots-video-export
                  onClick={() => void exportCameraMoveVideo()}
                  disabled={!canExportVideo || !selectedExportModeAvailable || isPreviewingCameraMove}
                  className="rounded-full bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
                >
                  {videoExportMode === 'quickPreview' ? 'Quick Preview MP4' : 'Export MP4'}
                </button>
              )}

              {(videoCaptureState === 'finished' || cameraMoveKeyframes.length > 0) && !isExportingCameraMove && (
                <div className="flex items-center gap-3">
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
                        if (selectedShot && camera) snapshotPreview(selectedShot, camera);
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

          {/* Shutter row */}
          <div className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-4 px-2">
            {/* Last / library thumbnail */}
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

            {/* Capture shutter */}
            <button
              type="button"
              onClick={onCapture}
              disabled={
                captureMode === 'video'
                && (videoCaptureState === 'finished' || isExportingCameraMove || isPreviewingCameraMove)
              }
              className="group relative flex h-[4.75rem] w-[4.75rem] shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
              aria-label={captureLabel}
              data-shots-shutter
              data-shots-video-capture-state={captureMode === 'video' ? videoCaptureState : undefined}
              title={captureHint}
            >
              <span className="absolute inset-0 rounded-full border-[3px] border-white/90" />
              <span
                className={`h-[3.65rem] w-[3.65rem] rounded-full transition ${
                  captureMode === 'video'
                    ? (videoCaptureState === 'finished'
                      ? 'bg-white/30'
                      : 'bg-red-500 group-active:scale-95')
                    : 'bg-white group-active:scale-90'
                }`}
              />
            </button>

            {/* Adjacent shot nav (keeps layout balanced; light affordance) */}
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
          </div>

          <p className="pointer-events-none text-center text-[11px] font-medium text-white/70">
            {captureHint}
            {shotCameraFlying ? ' · WASD / mouse' : ''}
          </p>
        </div>
      </div>

      <PrecisionDrawer
        open={settingsOpen && Boolean(selectedShot)}
        title="Camera Settings"
        onClose={() => setSettingsOpen(false)}
      >
        {selectedShot && (
          <div className="space-y-4" data-shots-advanced-settings>
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

            <Field label="Name">
              <TextInput value={selectedShot.name} onChange={(event) => updateShot(selectedShot.id, { name: event.target.value })} />
            </Field>
            <Field label="Status">
              <Select value={selectedShot.status} onChange={(event) => updateShot(selectedShot.id, { status: event.target.value as ShotStatus })}>
                {statuses.map((status) => (
                  <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Description">
              <TextArea value={selectedShot.description} onChange={(event) => updateShot(selectedShot.id, { description: event.target.value })} />
            </Field>
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
            <Field label="People export" hint="Clean plate keeps the same camera and staging but hides every object classified as a person.">
              <Select
                value={selectedShot.exportSettings.peopleExportMode ?? 'with_people'}
                onChange={(event) => updateShot(selectedShot.id, {
                  exportSettings: {
                    ...selectedShot.exportSettings,
                    peopleExportMode: event.target.value as PeopleExportMode,
                  },
                })}
                data-shots-people-export-mode
              >
                <option value="with_people">With people</option>
                <option value="clean_plate">Clean plate</option>
                <option value="both">Both</option>
              </Select>
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
          </div>
        )}
      </PrecisionDrawer>
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
