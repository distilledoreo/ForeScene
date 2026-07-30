import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CameraData, CameraKeyframe, Shot, ShotObjectOverrides } from '../../domain/types';
import {
  getCameraMoveDurationSeconds,
  getSortedCameraKeyframes,
  hasRenderableCameraMove,
  interpolateCameraKeyframes,
} from '../../engine/cameraKeyframes';
import { interpolateObjectOverrides } from '../../engine/objectKeyframes';
import { useProjectStore } from '../../state/useProjectStore';
import type { useVideoAuthoringController } from '../../hooks/useVideoAuthoringController';

type VideoAuthoringApi = ReturnType<typeof useVideoAuthoringController>;

export type CameraMovePreviewControllerOptions = {
  selectedShot: Shot | undefined;
  draftCameraRef: MutableRefObject<CameraData | undefined>;
  videoAuthoring: VideoAuthoringApi;
  startFlyCamera: (options?: { clearFramingAcceptance?: boolean }) => void;
  clearKeyframeSelection: () => void;
  clearViewportObjectInspection: () => void;
  setSelectedKeyframeId: Dispatch<SetStateAction<string | null>>;
  setSelectedSegmentStartId: Dispatch<SetStateAction<string | null>>;
  setFramingCamera: Dispatch<SetStateAction<CameraData | undefined>>;
  bumpCameraReseed: () => void;
  setViewportObjectOverrides: Dispatch<SetStateAction<ShotObjectOverrides | undefined>>;
  setShotCameraFlying: (flying: boolean, options?: { clearFramingAcceptance?: boolean }) => void;
  shotCameraFlying: boolean;
  /**
   * Optional late-bound move source (keyframes + duration) from the camera-move
   * controller. When omitted, keyframes are read from the selected shot and
   * duration is derived from keyframe times (equivalent for 2+ keyframes).
   */
  getMovePreviewSource?: () => {
    keyframes: readonly CameraKeyframe[];
    durationSeconds: number;
  };
};

/**
 * Camera-move live preview + timeline-open coordination for Shots.
 * Owns RAF playback lifecycle and keyframe-node selection (jump-to-pose).
 * videoAuthoring remains SoT for isPreviewing / timelineOpen.
 */
export function useCameraMovePreviewController(options: CameraMovePreviewControllerOptions) {
  const {
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
    getMovePreviewSource,
  } = options;

  const previewAbortRef = useRef<{ cancelled: boolean; frame?: number }>({ cancelled: false });

  const setTimelineOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof open === 'function' ? open(videoAuthoring.timelineOpen) : open;
    videoAuthoring.dispatch({ type: resolved ? 'OPEN_TIMELINE' : 'CLOSE_TIMELINE' });
  }, [videoAuthoring]);

  const setIsPreviewingCameraMove = useCallback((
    value: boolean | ((prev: boolean) => boolean),
  ) => {
    const resolved = typeof value === 'function' ? value(videoAuthoring.isPreviewing) : value;
    const result = videoAuthoring.tryDispatch({ type: resolved ? 'START_PREVIEW' : 'STOP_PREVIEW' });
    if (!result.ok && resolved) {
      // Illegal START_PREVIEW — leave machine state unchanged.
      return;
    }
  }, [videoAuthoring]);

  const stopCameraMovePreview = useCallback(() => {
    previewAbortRef.current.cancelled = true;
    if (previewAbortRef.current.frame != null) {
      cancelAnimationFrame(previewAbortRef.current.frame);
      previewAbortRef.current.frame = undefined;
    }
    setIsPreviewingCameraMove(false);
  }, [setIsPreviewingCameraMove]);

  // Cancel in-flight RAF on unmount (temporary preview invalidation).
  useEffect(() => () => {
    previewAbortRef.current.cancelled = true;
    if (previewAbortRef.current.frame != null) {
      cancelAnimationFrame(previewAbortRef.current.frame);
    }
  }, []);

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
    draftCameraRef,
    selectedShot,
    setFramingCamera,
    setSelectedKeyframeId,
    setSelectedSegmentStartId,
    setShotCameraFlying,
    setViewportObjectOverrides,
    shotCameraFlying,
    stopCameraMovePreview,
  ]);

  const previewCameraMove = useCallback(() => {
    const source = getMovePreviewSource?.();
    const rawKeyframes = source?.keyframes
      ?? selectedShot?.cameraKeyframes
      ?? [];
    if (!selectedShot || !hasRenderableCameraMove(rawKeyframes)) return;
    stopCameraMovePreview();
    clearKeyframeSelection();
    const keyframes = getSortedCameraKeyframes(rawKeyframes);
    const durationFallback = source?.durationSeconds
      ?? getCameraMoveDurationSeconds(keyframes);
    const duration = getCameraMoveDurationSeconds(keyframes, durationFallback);
    const startTime = performance.now();
    const latestProject = useProjectStore.getState().project;
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
    clearKeyframeSelection,
    draftCameraRef,
    getMovePreviewSource,
    selectedShot,
    setFramingCamera,
    setIsPreviewingCameraMove,
    setViewportObjectOverrides,
    startFlyCamera,
    stopCameraMovePreview,
  ]);

  return {
    previewAbortRef,
    setTimelineOpen,
    stopCameraMovePreview,
    previewCameraMove,
    selectKeyframeNode,
  };
}
