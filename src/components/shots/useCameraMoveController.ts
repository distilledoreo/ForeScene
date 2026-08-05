import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useShallow } from 'zustand/shallow';
import type {
  CameraData,
  CameraKeyframe,
  CameraKeyframeEasing,
  Shot,
  ShotObjectOverrides,
} from '../../domain/types';
import {
  DEFAULT_CAMERA_MOVE_DURATION_SECONDS,
  MAX_CAMERA_MOVE_DURATION_SECONDS,
  MIN_CAMERA_MOVE_DURATION_SECONDS,
  type CameraMoveKeyframeSlot,
  appendSequentialCameraKeyframe,
  getCameraMoveDurationSeconds,
  getSortedCameraKeyframes,
  hasManualCameraKeyframeTiming,
  hasRenderableCameraMove,
  insertCameraKeyframeInSegment,
  recaptureCameraKeyframe,
  removeIntermediateCameraKeyframe,
  setTwoPointCameraKeyframe,
  updateCameraKeyframeEasing,
  updateCameraMoveDuration,
  updateIntermediateCameraKeyframeTime,
} from '../../engine/cameraKeyframes';
import {
  getCameraMoveDownloadName,
  getDepthCameraMoveDownloadName,
  getProjectedCameraMoveDownloadName,
} from '../../engine/exportNaming';
import { downloadBlob } from '../../engine/fileTransfers';
import {
  canUseRenderMp4Export,
  getSupportedCameraMoveMp4MimeType,
  renderShotCameraMoveMp4,
  renderShotFrame,
  type CameraMoveExportProgress,
} from '../../engine/renderers';
import type { VideoResolutionPresetId } from '../../engine/videoPresets';
import { resolveProjectVideoPerformance } from '../../engine/videoPerformance';
import { prepareVideoArtifact } from '../../engine/prepareVideoArtifact';
import {
  createCameraMoveExportPasses,
  getCameraMoveExportCompletionMessage,
  runCameraMoveExportPasses,
} from '../../engine/cameraMoveExportPasses';
import {
  resolveShotDepthRangeForExport,
  resolveShotDepthSettings,
  shouldExportCameraMoveDepth,
} from '../../engine/depthRender';
import { snapshotStageableObjectOverrides } from '../../engine/objectKeyframes';
import { setShotTimelineKeyframes } from '../../engine/shotTimeline';
import {
  buildKeyframeThumbCacheFromKeyframes,
  shouldCommitKeyframeThumb,
} from '../../engine/keyframePreviewThumbs';
import { canUseProjectedAppearance } from '../../engine/projectedStyle';
import { getPeopleRenderVariants, getPeopleVariantPath } from '../../engine/peopleExport';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import type { useVideoAuthoringController } from '../../hooks/useVideoAuthoringController';

/** Compact chrome slider range: 1–20s in whole-second steps. */
export const VIDEO_DURATION_UI_MIN_SECONDS = 1;
export const VIDEO_DURATION_UI_MAX_SECONDS = 20;

export function clampVideoDuration(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_CAMERA_MOVE_DURATION_SECONDS;
  return Math.min(
    MAX_CAMERA_MOVE_DURATION_SECONDS,
    Math.max(MIN_CAMERA_MOVE_DURATION_SECONDS, seconds),
  );
}

/** Round to whole seconds for the chrome slider (1–20). */
export function clampVideoDurationUiSeconds(seconds: number): number {
  const rounded = Math.round(clampVideoDuration(seconds));
  return Math.min(
    VIDEO_DURATION_UI_MAX_SECONDS,
    Math.max(VIDEO_DURATION_UI_MIN_SECONDS, rounded),
  );
}

type VideoAuthoringApi = ReturnType<typeof useVideoAuthoringController>;

type SnapshotPreviewFn = (
  shot: { id: string; name?: string; exportSettings: { width: number; height: number }; camera: CameraData },
  camera: CameraData,
  options?: { markThumbnailFreshOnSuccess?: boolean; captureGeneration?: number },
) => void;

export type CameraMoveControllerOptions = {
  selectedShot: Shot | undefined;
  draftCameraRef: MutableRefObject<CameraData | undefined>;
  getEffectiveCamera: () => CameraData | undefined;
  videoAuthoring: VideoAuthoringApi;
  /** Live preview lives in useCameraMovePreviewController — inject stop only. */
  stopCameraMovePreview: () => void;
  clearKeyframeSelection: () => void;
  clearViewportObjectInspection: () => void;
  startFlyCamera: (options?: { clearFramingAcceptance?: boolean }) => void;
  selectedKeyframeId: string | null;
  selectedSegmentStartId: string | null;
  setSelectedKeyframeId: (id: string | null) => void;
  setSelectedSegmentStartId: (id: string | null) => void;
  snapshotPreview: SnapshotPreviewFn;
  thumbnailFreshAfterFinishRef: MutableRefObject<boolean>;
  setLandFlash: (value: boolean) => void;
  viewportObjectOverrides: ShotObjectOverrides | undefined;
  setViewportObjectOverrides: (value: ShotObjectOverrides | undefined) => void;
  // Shot-render presentation state (owned by useShotRenderController).
  setCameraMovePreviewUrl: (url: string | undefined) => void;
  isExportingCameraMove: boolean;
  setIsExportingCameraMove: (value: boolean) => void;
  setCameraMoveProgress: (value: number | ((prev: number) => number)) => void;
  setCameraMoveProgressMessage: (message: string) => void;
  setCameraMoveError: (message: string | undefined) => void;
  setCameraMoveNotice: (message: string | undefined) => void;
  cameraMoveAbortRef: MutableRefObject<{ cancelled: boolean; abort?: () => void }>;
  videoExportMode: 'render' | 'quickPreview';
  setVideoExportMode: (mode: 'render' | 'quickPreview') => void;
  videoResolutionPreset: VideoResolutionPresetId;
  canRenderMp4: boolean | null;
  setCanRenderMp4: (value: boolean | null) => void;
};

/**
 * Camera-move authoring + MP4 export for Shots.
 * Dispatches into the video authoring machine (SoT); does not reimplement it.
 * Live preview (previewCameraMove / previewAbortRef) lives in useCameraMovePreviewController.
 */
export function useCameraMoveController(options: CameraMoveControllerOptions) {
  const {
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
  } = options;

  const {
    project,
    addCamera,
    applyShotTimelineProject,
    landShotFraming,
    attachCameraMoveVideoToShot,
    attachKeyframePreviewToShot,
    setShotCameraFlying,
  } = useProjectStore(useShallow((state) => ({
    project: state.project,
    addCamera: state.addCamera,
    applyShotTimelineProject: state.applyShotTimelineProject,
    landShotFraming: state.landShotFraming,
    attachCameraMoveVideoToShot: state.attachCameraMoveVideoToShot,
    attachKeyframePreviewToShot: state.attachKeyframePreviewToShot,
    setShotCameraFlying: state.setShotCameraFlying,
  })));
  const flushProject = useProjectSafetyStore((state) => state.flushProject);

  /** Pending move length — applied when end is captured (and updates existing end if present). */
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(DEFAULT_CAMERA_MOVE_DURATION_SECONDS);
  /** After "Next shot" from a finished video move, keep Video mode empty on the new shot. */
  const resumeVideoAfterNextShotRef = useRef(false);
  /** Lightweight per-keyframe stills for the move filmstrip (not the full gallery matrix). */
  const [keyframeThumbById, setKeyframeThumbById] = useState<Record<string, string>>({});
  const keyframeThumbGenerationRef = useRef(0);

  const captureMode = videoAuthoring.mode;
  const videoCaptureState = videoAuthoring.captureState;

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
  }, [setCanRenderMp4, videoResolutionPreset]);

  // Keep the mode selector honest: if Render is confirmed unsupported for the current preset,
  // switch the control to Quick Preview when that path exists (never silently encode as preview).
  useEffect(() => {
    if (videoExportMode === 'render' && canRenderMp4 === false && supportedMp4MimeType) {
      setVideoExportMode('quickPreview');
    }
  }, [canRenderMp4, setVideoExportMode, supportedMp4MimeType, videoExportMode]);

  const selectedExportModeAvailable = videoExportMode === 'render'
    ? canRenderMp4 === true
    : Boolean(supportedMp4MimeType);

  useEffect(() => {
    setCameraMovePreviewUrl(cameraMoveAsset?.uri);
  }, [cameraMoveAsset?.uri, selectedShot?.id, setCameraMovePreviewUrl]);

  const applyExportProgressMapped = useCallback((
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
  }, [cameraMoveAbortRef, setCameraMoveProgress, setCameraMoveProgressMessage]);

  const cancelCameraMoveExport = useCallback(() => {
    cameraMoveAbortRef.current.cancelled = true;
    cameraMoveAbortRef.current.abort?.();
    setIsExportingCameraMove(false);
    setCameraMoveProgress(0);
    setCameraMoveProgressMessage('Preparing scene');
    setCameraMoveError('MP4 export was cancelled.');
    setCameraMoveNotice(undefined);
  }, [
    cameraMoveAbortRef,
    setCameraMoveError,
    setCameraMoveNotice,
    setCameraMoveProgress,
    setCameraMoveProgressMessage,
    setIsExportingCameraMove,
  ]);

  const updateCameraMoveKeyframes = useCallback((keyframes: CameraKeyframe[]) => {
    if (!selectedShot) return;
    const latest = useProjectStore.getState().project;
    const nextProject = setShotTimelineKeyframes(latest, selectedShot.id, keyframes);
    const nextShot = nextProject.shots.find((shot) => shot.id === selectedShot.id);
    if (!nextShot) return;
    applyShotTimelineProject(nextProject);
    setCameraMovePreviewUrl(undefined);
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);
  }, [applyShotTimelineProject, selectedShot, setCameraMoveError, setCameraMoveNotice, setCameraMovePreviewUrl]);

  const captureCameraMoveKeyframe = useCallback((slot: CameraMoveKeyframeSlot) => {
    if (!selectedShot) return;
    const camera = getEffectiveCamera();
    if (!camera) return;
    const latest = useProjectStore.getState().project;
    const latestShot = latest.shots.find((item) => item.id === selectedShot.id) ?? selectedShot;
    const nextKeyframes = setTwoPointCameraKeyframe({
      keyframes: latestShot.cameraKeyframes,
      slot,
      camera,
      durationSeconds: cameraMoveDurationSeconds,
      objectOverrides: snapshotStageableObjectOverrides(latest, latestShot),
    });
    updateCameraMoveKeyframes(nextKeyframes);
    // Advanced drawer fallback: resync machine from keyframe count.
    videoAuthoring.dispatch({
      type: 'ENTER_VIDEO',
      keyframeCount: nextKeyframes.length,
    });
    clearKeyframeSelection();
  }, [
    cameraMoveDurationSeconds,
    clearKeyframeSelection,
    getEffectiveCamera,
    selectedShot,
    updateCameraMoveKeyframes,
    videoAuthoring,
  ]);

  const changeCameraMoveEasing = useCallback((easing: CameraKeyframeEasing) => {
    if (!selectedShot) return;
    updateCameraMoveKeyframes(updateCameraKeyframeEasing(selectedShot.cameraKeyframes, easing));
  }, [selectedShot, updateCameraMoveKeyframes]);

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
      const includeDepth = shouldExportCameraMoveDepth(
        renderShot.exportSettings.depth,
        hasRenderableCameraMove(renderShot.cameraKeyframes),
      );
      const depthSettings = resolveShotDepthSettings(renderShot);
      const depthRange = includeDepth
        ? await resolveShotDepthRangeForExport(renderProject, renderShot)
        : undefined;
      const passes = createCameraMoveExportPasses(
        variants,
        canUseProjectedAppearance(renderProject),
        includeDepth,
      );
      const totalPasses = passes.length;
      const videoPerformance = resolveProjectVideoPerformance(renderProject.exportConfiguration);
      const results = await runCameraMoveExportPasses(
        passes,
        async (pass, passIndex) => {
          const onProgress = (progress: number | CameraMoveExportProgress) => {
            const value = typeof progress === 'number' ? progress : progress.progress;
            const message = typeof progress === 'number'
              ? `Rendering ${pass.appearance} motion`
              : progress.message;
            setCameraMoveProgress((passIndex + value) / totalPasses);
            setCameraMoveProgressMessage(message);
          };
          // Deterministic Render mode goes through prepareVideoArtifact so package
          // export can reuse the same fingerprinted cache entries.
          const video = videoExportMode === 'render'
            ? await prepareVideoArtifact({
              project: renderProject,
              shotId: renderShot.id,
              specification: {
                appearance: pass.appearance,
                peopleVariant: pass.peopleVariant,
                mode: 'render',
                // Shot UI may pick a different resolution preset; frame rate / encoder
                // still follow the project video performance profile.
                resolutionPreset: videoResolutionPreset,
                frameRate: videoPerformance.frameRate,
                encoderMode: videoPerformance.encoderMode,
                occlusionFilter: pass.appearance === 'projected' ? 'fast' : undefined,
                depthRange: pass.appearance === 'depth' ? depthRange : undefined,
                depthInvert: pass.appearance === 'depth' ? depthSettings.invert === true : undefined,
              },
              performance: videoPerformance,
              includeDataUrl: pass.appearance === 'clay',
              signal: abortController.signal,
              onProgress,
            }).then((artifact) => ({
              blob: artifact.blob,
              dataUrl: artifact.dataUrl,
              width: artifact.width,
              height: artifact.height,
              durationSeconds: artifact.durationSeconds,
              frameRate: artifact.frameRate,
              mimeType: artifact.mimeType,
              fileExtension: 'mp4' as const,
              encodeMode: artifact.encodeMode,
              frameCount: artifact.frameCount,
              codecString: artifact.codecString,
              actualEncoderMode: artifact.actualEncoderMode,
              encoderModeFallback: artifact.encoderModeFallback,
            }))
            : await renderShotCameraMoveMp4(renderProject, renderShot, {
              mode: 'quickPreview',
              resolutionPreset: videoResolutionPreset,
              frameRate: videoPerformance.frameRate,
              appearance: pass.appearance,
              peopleVariant: pass.peopleVariant,
              includeDataUrl: pass.appearance === 'clay',
              depthRange: pass.appearance === 'depth' ? depthRange : undefined,
              depthInvert: pass.appearance === 'depth' ? depthSettings.invert === true : undefined,
              signal: abortController.signal,
              onProgress,
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
          } else if (pass.appearance === 'depth') {
            downloadBlob(
              video.blob,
              getPeopleVariantPath(
                getDepthCameraMoveDownloadName(renderShot),
                pass.peopleVariant,
                renderShot.exportSettings.peopleExportMode,
              ),
            );
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
    cameraMoveAbortRef,
    canExportVideo,
    canRenderMp4,
    flushProject,
    selectedShot,
    setCameraMoveError,
    setCameraMoveNotice,
    setCameraMovePreviewUrl,
    setCameraMoveProgress,
    setCameraMoveProgressMessage,
    setIsExportingCameraMove,
    supportedMp4MimeType,
    videoExportMode,
    videoResolutionPreset,
  ]);

  /**
   * Cheap clay still for the move filmstrip + camera roll (192×108).
   * Uses the target keyframe's objectOverrides so object animation is correct.
   * Persists previewUri on the keyframe (silent history) so the library can animate it.
   */
  const captureKeyframeThumb = useCallback((params: {
    keyframeId: string;
    camera: CameraData;
    objectOverrides?: ShotObjectOverrides;
    shotOverride?: Shot;
  }) => {
    const { keyframeId, camera, objectOverrides, shotOverride } = params;
    const selectedShotId = selectedShot?.id;
    const shot = shotOverride
      ?? useProjectStore.getState().project.shots.find((item) => item.id === selectedShotId)
      ?? selectedShot;
    if (!shot) return;
    const generation = keyframeThumbGenerationRef.current;
    const latestProject = useProjectStore.getState().project;
    // Prefer explicit keyframe snapshot; fall back to existing keyframe data, then shot-level.
    const keyframe = shot.cameraKeyframes.find((item) => item.id === keyframeId);
    const resolvedOverrides = objectOverrides
      ?? keyframe?.objectOverrides
      ?? shot.objectOverrides;
    const thumbShot: Shot = {
      ...shot,
      camera: {
        ...camera,
        position: [...camera.position] as CameraData['position'],
        target: [...camera.target] as CameraData['target'],
      },
      objectOverrides: resolvedOverrides !== undefined
        ? structuredClone(resolvedOverrides)
        : undefined,
      exportSettings: {
        ...shot.exportSettings,
        width: 192,
        height: 108,
      },
    };
    void renderShotFrame(latestProject, thumbShot, { peopleVariant: 'with_people' })
      .then((frame) => {
        // Drop if undo/redo (or retake/shot switch) advanced the generation while rendering.
        if (!shouldCommitKeyframeThumb({
          renderGeneration: generation,
          currentGeneration: keyframeThumbGenerationRef.current,
        })) {
          return;
        }
        setKeyframeThumbById((current) => (
          current[keyframeId] === frame.dataUrl
            ? current
            : { ...current, [keyframeId]: frame.dataUrl }
        ));
        // Re-check generation after reading live state — restore may have raced the await.
        if (!shouldCommitKeyframeThumb({
          renderGeneration: generation,
          currentGeneration: keyframeThumbGenerationRef.current,
        })) {
          return;
        }
        // Persist as content-addressed binary asset (not base64 in project JSON).
        attachKeyframePreviewToShot(shot.id, keyframeId, frame.dataUrl);
      })
      .catch(() => {
        // Filmstrip falls back to labeled placeholders.
      });
  }, [attachKeyframePreviewToShot, selectedShot]);

  const appendSequentialCapture = useCallback(() => {
    if (!selectedShot) return;
    if (videoCaptureState === 'finished') return;
    stopCameraMovePreview();
    const camera = getEffectiveCamera();
    if (!camera) return;
    const latest = useProjectStore.getState().project;
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
    const nextProject = setShotTimelineKeyframes(latest, selectedShot.id, nextKeyframes);
    const nextShot = nextProject.shots.find((item) => item.id === selectedShot.id);
    if (!nextShot) return;
    // Persist live pose and the complete timeline transaction so global asset
    // pruning from the domain service is not discarded by a shot-only update.
    applyShotTimelineProject({
      ...nextProject,
      shots: nextProject.shots.map((shot) => shot.id === selectedShot.id
        ? { ...shot, camera: pose }
        : shot),
    });
    setCameraMovePreviewUrl(undefined);
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);
    draftCameraRef.current = pose;
    clearKeyframeSelection();
    clearViewportObjectInspection();
    landShotFraming(selectedShot.id, pose, { keepFlying: true });
    // Stay capturing until Finish — second pose offers Capture next + Finish (no auto-finish).
    videoAuthoring.dispatch({ type: 'CAPTURE_POSE', keyframeCountAfter: nextKeyframes.length });
    thumbnailFreshAfterFinishRef.current = false;
    // Thumbnail only on first Start — intermediate appends stay light.
    if (wasEmpty) {
      snapshotPreview(selectedShot, pose);
    }
    // Always refresh a cheap filmstrip still for the newest pose (and keep prior thumbs).
    const newest = nextKeyframes[nextKeyframes.length - 1];
    if (newest) {
      captureKeyframeThumb({
        keyframeId: newest.id,
        camera: pose,
        objectOverrides: newest.objectOverrides,
        shotOverride: {
          ...selectedShot,
          cameraKeyframes: nextKeyframes,
        },
      });
    }
    setLandFlash(true);
    window.setTimeout(() => setLandFlash(false), 500);
  }, [
    cameraMoveDurationSeconds,
    cameraMoveEasing,
    captureKeyframeThumb,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    draftCameraRef,
    getEffectiveCamera,
    landShotFraming,
    selectedShot,
    setCameraMoveError,
    setCameraMoveNotice,
    setCameraMovePreviewUrl,
    setLandFlash,
    snapshotPreview,
    stopCameraMovePreview,
    thumbnailFreshAfterFinishRef,
    applyShotTimelineProject,
    videoAuthoring,
    videoCaptureState,
  ]);

  const finishSequentialCapture = useCallback(() => {
    if (!hasRenderableCameraMove(cameraMoveKeyframes)) return;
    stopCameraMovePreview();
    const finished = videoAuthoring.tryDispatch({ type: 'FINISH_MOVE' });
    if (!finished.ok) return;
    clearKeyframeSelection();
    clearViewportObjectInspection();
    // Refresh gallery thumbnail once when finishing; Next shot reuses only if render succeeds.
    const camera = getEffectiveCamera();
    if (selectedShot && camera) {
      snapshotPreview(selectedShot, camera, { markThumbnailFreshOnSuccess: true });
    }
    // Fill any missing filmstrip stills so finished moves always show a path preview.
    for (const keyframe of cameraMoveKeyframes) {
      if (!keyframeThumbById[keyframe.id] && !keyframe.previewUri) {
        captureKeyframeThumb({
          keyframeId: keyframe.id,
          camera: keyframe.camera,
          objectOverrides: keyframe.objectOverrides,
          shotOverride: selectedShot,
        });
      }
    }
  }, [
    cameraMoveKeyframes,
    captureKeyframeThumb,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    getEffectiveCamera,
    keyframeThumbById,
    selectedShot,
    snapshotPreview,
    stopCameraMovePreview,
    videoAuthoring,
  ]);

  const continueSequentialCapture = useCallback(() => {
    if (!hasRenderableCameraMove(cameraMoveKeyframes)) return;
    stopCameraMovePreview();
    const continued = videoAuthoring.tryDispatch({ type: 'CONTINUE_MOVE' });
    if (!continued.ok) return;
    clearKeyframeSelection();
    clearViewportObjectInspection();
    thumbnailFreshAfterFinishRef.current = false;
  }, [
    cameraMoveKeyframes,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    stopCameraMovePreview,
    thumbnailFreshAfterFinishRef,
    videoAuthoring,
  ]);

  const insertInSelectedSegment = useCallback(() => {
    if (!selectedShot || !selectedSegmentStartId) return;
    stopCameraMovePreview();
    const camera = getEffectiveCamera();
    if (!camera) return;
    const latest = useProjectStore.getState().project;
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
      captureKeyframeThumb({
        keyframeId: inserted.id,
        camera,
        objectOverrides: inserted.objectOverrides,
        shotOverride: {
          ...latestShot,
          cameraKeyframes: nextKeyframes,
        },
      });
      // Inspect the newly inserted pose's object snapshot without binding the camera.
      if (inserted.objectOverrides !== undefined) {
        setViewportObjectOverrides(structuredClone(inserted.objectOverrides));
      } else {
        clearViewportObjectInspection();
      }
    }
  }, [
    cameraMoveEasing,
    captureKeyframeThumb,
    clearViewportObjectInspection,
    getEffectiveCamera,
    selectedSegmentStartId,
    selectedShot,
    setSelectedKeyframeId,
    setSelectedSegmentStartId,
    setViewportObjectOverrides,
    stopCameraMovePreview,
    updateCameraMoveKeyframes,
  ]);

  const updateSelectedKeyframePose = useCallback((keyframeId: string) => {
    if (!selectedShot) return;
    stopCameraMovePreview();
    const camera = getEffectiveCamera();
    if (!camera) return;
    const latest = useProjectStore.getState().project;
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
    captureKeyframeThumb({
      keyframeId,
      camera,
      objectOverrides: objectSnapshot,
      shotOverride: {
        ...latestShot,
        cameraKeyframes: next,
      },
    });
  }, [
    captureKeyframeThumb,
    getEffectiveCamera,
    selectedShot,
    setViewportObjectOverrides,
    stopCameraMovePreview,
    updateCameraMoveKeyframes,
    viewportObjectOverrides,
  ]);

  const enterVideoMode = useCallback(() => {
    if (!selectedShot) return;
    const existing = selectedShot.cameraKeyframes;
    const duration = clampVideoDuration(
      getCameraMoveDurationSeconds(existing, videoDurationSeconds),
    );
    setVideoDurationSeconds(duration);
    // Preserve authored keyframes when re-entering Video (e.g. after shot switch forces Still).
    // Only Retake / explicit clear wipes the sequence — never auto-capture Start here.
    videoAuthoring.dispatch({ type: 'ENTER_VIDEO', keyframeCount: existing.length });
    if (existing.length > 2) videoAuthoring.dispatch({ type: 'OPEN_TIMELINE' });
    clearKeyframeSelection();
    clearViewportObjectInspection();
    stopCameraMovePreview();
    thumbnailFreshAfterFinishRef.current = false;
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);
    startFlyCamera({ clearFramingAcceptance: false });
  }, [
    clearKeyframeSelection,
    clearViewportObjectInspection,
    selectedShot,
    setCameraMoveError,
    setCameraMoveNotice,
    startFlyCamera,
    stopCameraMovePreview,
    thumbnailFreshAfterFinishRef,
    videoAuthoring,
    videoDurationSeconds,
  ]);

  const retakeVideoMove = useCallback(() => {
    if (!selectedShot) return;
    updateCameraMoveKeyframes([]);
    videoAuthoring.dispatch({ type: 'RETAKE' });
    clearKeyframeSelection();
    clearViewportObjectInspection();
    stopCameraMovePreview();
    thumbnailFreshAfterFinishRef.current = false;
    keyframeThumbGenerationRef.current += 1;
    setKeyframeThumbById({});
    setCameraMoveError(undefined);
    setCameraMoveNotice(undefined);
    startFlyCamera({ clearFramingAcceptance: false });
  }, [
    clearKeyframeSelection,
    clearViewportObjectInspection,
    selectedShot,
    setCameraMoveError,
    setCameraMoveNotice,
    startFlyCamera,
    stopCameraMovePreview,
    thumbnailFreshAfterFinishRef,
    updateCameraMoveKeyframes,
    videoAuthoring,
  ]);

  /**
   * Finish the current video shot and start a fresh empty video session on a new shot.
   * Export is optional — this is the primary "done, move on" path.
   */
  const completeVideoAndNextShot = useCallback(() => {
    if (!selectedShot) return;
    stopCameraMovePreview();
    clearKeyframeSelection();
    clearViewportObjectInspection();
    const camera = getEffectiveCamera() ?? selectedShot.camera;
    const pose: CameraData = {
      ...camera,
      position: [...camera.position] as CameraData['position'],
      target: [...camera.target] as CameraData['target'],
    };
    // Accept framing so the completed move appears as a landed gallery shot.
    landShotFraming(selectedShot.id, pose, { keepFlying: true });
    // Skip duplicate still-matrix work when Finish just refreshed the thumbnail.
    if (
      hasRenderableCameraMove(selectedShot.cameraKeyframes)
      && !thumbnailFreshAfterFinishRef.current
    ) {
      snapshotPreview(selectedShot, pose);
    }
    thumbnailFreshAfterFinishRef.current = false;
    videoAuthoring.dispatch({ type: 'CLOSE_TIMELINE' });
    resumeVideoAfterNextShotRef.current = true;
    addCamera({ navigateToShots: false });
    setLandFlash(true);
    window.setTimeout(() => setLandFlash(false), 500);
  }, [
    addCamera,
    clearKeyframeSelection,
    clearViewportObjectInspection,
    getEffectiveCamera,
    landShotFraming,
    selectedShot,
    setLandFlash,
    snapshotPreview,
    stopCameraMovePreview,
    thumbnailFreshAfterFinishRef,
    videoAuthoring,
  ]);

  /**
   * History restore: invalidate in-flight keyframe stills, rebuild local cache from
   * restored URIs, and keep authoring chrome consistent with restored keyframe data.
   * Callable from the workspace undo/redo restore effect.
   */
  const handleHistoryRestore = useCallback((restoredKeyframes: CameraKeyframe[]) => {
    // Invalidate in-flight keyframe stills and rebuild local cache from restored URIs.
    // Without this, a late captureKeyframeThumb can overwrite the restored previewUri.
    keyframeThumbGenerationRef.current += 1;
    setKeyframeThumbById(buildKeyframeThumbCacheFromKeyframes(restoredKeyframes));
    thumbnailFreshAfterFinishRef.current = false;

    // Keep authoring chrome consistent with restored keyframe data (undo/redo blocker).
    if (videoAuthoring.mode === 'video') {
      videoAuthoring.dispatch({
        type: 'UNDO_RESTORED',
        keyframeCount: restoredKeyframes.length,
        previousCaptureState: videoAuthoring.captureState,
      });
      clearKeyframeSelection();
      clearViewportObjectInspection();
      stopCameraMovePreview();
    }
  }, [
    clearKeyframeSelection,
    clearViewportObjectInspection,
    stopCameraMovePreview,
    thumbnailFreshAfterFinishRef,
    videoAuthoring,
  ]);

  /**
   * Shot-switch video chrome: duration, authoring machine, thumbs.
   * Presentation cleanup (library close, keyframe selection, preview stop, staging)
   * stays in the workspace effect; call this after that cleanup.
   * Returns whether Next-shot video resume took the early path.
   */
  const handleShotSwitchVideoChrome = useCallback((shot: Shot | undefined): { resumedVideo: boolean } => {
    if (shot) {
      setVideoDurationSeconds(
        getCameraMoveDurationSeconds(shot.cameraKeyframes, DEFAULT_CAMERA_MOVE_DURATION_SECONDS),
      );
    }
    // "Next shot" from a finished video move: stay in Video with an empty sequence.
    if (resumeVideoAfterNextShotRef.current) {
      resumeVideoAfterNextShotRef.current = false;
      videoAuthoring.dispatch({ type: 'NEXT_SHOT' });
      thumbnailFreshAfterFinishRef.current = false;
      setCameraMoveError(undefined);
      setCameraMoveNotice(undefined);
      setShotCameraFlying(true, { clearFramingAcceptance: false });
      return { resumedVideo: true };
    }
    const count = shot?.cameraKeyframes.length ?? 0;
    if (count > 0) {
      videoAuthoring.dispatch({ type: 'ENTER_VIDEO', keyframeCount: count });
      if (count > 2) videoAuthoring.dispatch({ type: 'OPEN_TIMELINE' });
    } else {
      videoAuthoring.dispatch({ type: 'EXIT_VIDEO' });
    }
    thumbnailFreshAfterFinishRef.current = false;
    keyframeThumbGenerationRef.current += 1;
    setKeyframeThumbById({});
    return { resumedVideo: false };
  }, [
    setCameraMoveError,
    setCameraMoveNotice,
    setShotCameraFlying,
    thumbnailFreshAfterFinishRef,
    videoAuthoring,
  ]);

  return {
    // State
    videoDurationSeconds,
    setVideoDurationSeconds,
    resumeVideoAfterNextShotRef,
    keyframeThumbById,
    keyframeThumbGenerationRef,
    // Derived
    cameraMoveKeyframes,
    cameraMoveDurationSeconds,
    cameraMoveReady,
    cameraMoveEasing,
    cameraMoveAsset,
    supportedMp4MimeType,
    canExportVideo,
    selectedExportModeAvailable,
    // Authoring actions
    updateCameraMoveKeyframes,
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
    captureKeyframeThumb,
    // Mode / complete / retake
    enterVideoMode,
    retakeVideoMove,
    completeVideoAndNextShot,
    // Export
    exportCameraMoveVideo,
    cancelCameraMoveExport,
    applyExportProgressMapped,
    isExportingCameraMove,
    // Lifecycle helpers (workspace effects)
    handleHistoryRestore,
    handleShotSwitchVideoChrome,
  };
}
