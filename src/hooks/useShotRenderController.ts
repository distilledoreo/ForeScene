import { useCallback, useRef, useState } from 'react';
import type { VideoResolutionPresetId } from '../engine/videoPresets';

/**
 * Still + camera-move render progress, cancellation, and preview URLs.
 */
export function useShotRenderController() {
  const [framePreviewByShotId, setFramePreviewByShotId] = useState<Record<string, string>>({});
  const [isRenderingFrame, setIsRenderingFrame] = useState(false);
  const [isExportingFrame, setIsExportingFrame] = useState(false);
  const [cameraMovePreviewUrl, setCameraMovePreviewUrl] = useState<string | undefined>();
  const [isExportingCameraMove, setIsExportingCameraMove] = useState(false);
  const [cameraMoveProgress, setCameraMoveProgress] = useState(0);
  const [cameraMoveProgressMessage, setCameraMoveProgressMessage] = useState('Preparing scene');
  const [cameraMoveError, setCameraMoveError] = useState<string | undefined>();
  const [cameraMoveNotice, setCameraMoveNotice] = useState<string | undefined>();
  const [snapshotError, setSnapshotError] = useState<string | undefined>();
  const [videoExportMode, setVideoExportMode] = useState<'render' | 'quickPreview'>('render');
  const [videoResolutionPreset, setVideoResolutionPreset] = useState<VideoResolutionPresetId>('1080p');
  const [canRenderMp4, setCanRenderMp4] = useState<boolean | null>(null);
  const cameraMoveAbortRef = useRef<{ cancelled: boolean; abort?: () => void }>({ cancelled: false });

  const setShotFramePreview = useCallback((shotId: string, dataUrl: string) => {
    setFramePreviewByShotId((current) => (
      current[shotId] === dataUrl ? current : { ...current, [shotId]: dataUrl }
    ));
  }, []);

  const cancelCameraMoveExport = useCallback(() => {
    cameraMoveAbortRef.current.cancelled = true;
    cameraMoveAbortRef.current.abort?.();
  }, []);

  const applyExportProgress = useCallback((
    progress: number,
    message?: string,
  ) => {
    setCameraMoveProgress(progress);
    if (message) setCameraMoveProgressMessage(message);
  }, []);

  return {
    framePreviewByShotId,
    setFramePreviewByShotId,
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
    cancelCameraMoveExport,
    applyExportProgress,
  };
}
