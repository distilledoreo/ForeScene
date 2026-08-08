import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useShallow } from 'zustand/shallow';
import type { CameraData, Shot } from '../../domain/types';
import type { ShotStillViewSelection } from '../../domain/shotStillViews';
import {
  getProjectedStillDownloadName,
  getViewportStillDownloadName,
} from '../../engine/exportNaming';
import { downloadDataUrl } from '../../engine/fileTransfers';
import { getPeopleRenderVariants, getPeopleVariantPath } from '../../engine/peopleExport';
import { canUseProjectedAppearance } from '../../engine/projectedStyle';
import {
  renderShotFrame,
  renderShotProjectedFrame,
} from '../../engine/renderers';
import { materializeShotAfterCapture } from '../../engine/materializeShotStills';
import { isShotFramingAccepted } from '../../engine/workflow';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';

export type StillCaptureStatus = 'idle' | 'capturing' | 'exporting' | 'error';

export type StillCaptureControllerOptions = {
  selectedShot: Shot | undefined;
  draftCameraRef: MutableRefObject<CameraData | undefined>;
  shotCameraFlying: boolean;
  setShotFramePreview: (shotId: string, dataUrl: string) => void;
  setSnapshotError: (message: string | undefined) => void;
  setIsExportingFrame: (value: boolean) => void;
  isExportingFrame: boolean;
  snapshotError: string | undefined;
};

export function useStillCaptureController(options: StillCaptureControllerOptions) {
  const {
    selectedShot,
    draftCameraRef,
    shotCameraFlying,
    setShotFramePreview,
    setSnapshotError,
    setIsExportingFrame,
    isExportingFrame,
    snapshotError,
  } = options;

  const {
    addCamera,
    landShotFraming,
    attachViewportRenderToShot,
    updateShot,
  } = useProjectStore(useShallow((state) => ({
    addCamera: state.addCamera,
    landShotFraming: state.landShotFraming,
    attachViewportRenderToShot: state.attachViewportRenderToShot,
    updateShot: state.updateShot,
  })));
  const flushProject = useProjectSafetyStore((state) => state.flushProject);

  const thumbnailFreshAfterFinishRef = useRef(false);
  const captureGenerationRef = useRef(0);
  const captureAbortControllerRef = useRef<AbortController | undefined>(undefined);
  const [landFlash, setLandFlash] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);

  // Project replacement/unmount is cancellation, not a failed capture. Abort the
  // actual materializer so queued/running prepared work cannot repopulate runtime
  // state for a departed project.
  useEffect(() => {
    const unsubscribe = useProjectStore.subscribe((state, previous) => {
      if (state.project.id === previous.project.id) return;
      captureGenerationRef.current += 1;
      captureAbortControllerRef.current?.abort();
      captureAbortControllerRef.current = undefined;
      setIsCapturing(false);
    });
    return () => {
      unsubscribe();
      captureGenerationRef.current += 1;
      captureAbortControllerRef.current?.abort();
      captureAbortControllerRef.current = undefined;
    };
  }, []);

  const triggerLandFlash = useCallback((durationMs = 700) => {
    setLandFlash(true);
    window.setTimeout(() => setLandFlash(false), durationMs);
  }, []);

  const clearThumbnailFresh = useCallback(() => {
    thumbnailFreshAfterFinishRef.current = false;
  }, []);

  const getPreviewShot = useCallback(() => {
    if (!selectedShot) return undefined;
    const camera = draftCameraRef.current ?? selectedShot.camera;
    return {
      ...selectedShot,
      camera: {
        ...camera,
        position: [...camera.position] as CameraData['position'],
        target: [...camera.target] as CameraData['target'],
      },
    };
  }, [draftCameraRef, selectedShot]);

  const exportCameraFrame = useCallback(async () => {
    const previewShot = getPreviewShot();
    if (!previewShot) return;
    setIsExportingFrame(true);
    setSnapshotError(undefined);
    try {
      if (!flushProject) throw new Error('Local project recovery is still starting. Please wait before rendering a still.');
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
        if (variant === 'with_people' || variants.length === 1) setShotFramePreview(renderShot.id, frame.dataUrl);
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
    setIsExportingFrame,
    setShotFramePreview,
    setSnapshotError,
    shotCameraFlying,
    updateShot,
  ]);

  const snapshotPreview = useCallback((
    shot: { id: string; name?: string; exportSettings: { width: number; height: number }; camera: CameraData },
    camera: CameraData,
    options?: { markThumbnailFreshOnSuccess?: boolean; captureGeneration?: number },
  ) => {
    const latestProject = useProjectStore.getState().project;
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
    if (options?.markThumbnailFreshOnSuccess) thumbnailFreshAfterFinishRef.current = false;

    const generationAtStart = options?.captureGeneration ?? captureGenerationRef.current;
    captureAbortControllerRef.current?.abort();
    const captureController = new AbortController();
    captureAbortControllerRef.current = captureController;

    setIsCapturing(true);
    void materializeShotAfterCapture({
      project: latestProject,
      shotId: shot.id,
      mode: 'await-primary',
      signal: captureController.signal,
      getLiveProject: () => useProjectStore.getState().project,
      commitLiveProject: (updater) => {
        useProjectStore.setState((current) => ({
          project: updater(current.project),
          selectedShotId: current.selectedShotId,
        }));
        return useProjectStore.getState().project;
      },
    })
      .then(async (result) => {
        if (captureController.signal.aborted || generationAtStart !== captureGenerationRef.current) return;
        if (result.status === 'failed') {
          if (options?.markThumbnailFreshOnSuccess) thumbnailFreshAfterFinishRef.current = false;
          setSnapshotError(result.warnings[0] ?? 'Could not save the shot preview. Try Capture again.');
          const live = useProjectStore.getState().project;
          const prev = live.shots.find((item) => item.id === shot.id);
          const fallbackId = prev?.assets.viewportRenderAssetId ?? result.primaryStillAssetId;
          const fallbackAsset = fallbackId ? live.assets.assets[fallbackId] : undefined;
          if (fallbackAsset?.uri) setShotFramePreview(shot.id, fallbackAsset.uri);
          return;
        }

        const liveProject = useProjectStore.getState().project;
        const primaryAsset = result.primaryStillAssetId
          ? liveProject.assets.assets[result.primaryStillAssetId]
          : undefined;
        if (primaryAsset?.uri) setShotFramePreview(shot.id, primaryAsset.uri);
        if (options?.markThumbnailFreshOnSuccess) thumbnailFreshAfterFinishRef.current = true;

        try {
          const { ensureBackgroundVideoService, queueBackgroundVideosForShot } = await import(
            '../../engine/backgroundVideoService'
          );
          ensureBackgroundVideoService(() => useProjectStore.getState().project);
          void queueBackgroundVideosForShot(shot.id);
        } catch {
          // Background video must never block capture.
        }
      })
      .catch((error) => {
        if (
          captureController.signal.aborted
          || generationAtStart !== captureGenerationRef.current
          || (error instanceof Error && error.name === 'AbortError')
        ) return;
        if (options?.markThumbnailFreshOnSuccess) thumbnailFreshAfterFinishRef.current = false;
        setSnapshotError('Could not save the shot preview. Try Capture again.');
      })
      .finally(() => {
        if (captureAbortControllerRef.current === captureController) {
          captureAbortControllerRef.current = undefined;
        }
        if (generationAtStart === captureGenerationRef.current) setIsCapturing(false);
      });
  }, [setShotFramePreview, setSnapshotError]);

  const captureStill = useCallback(() => {
    if (!selectedShot) {
      addCamera();
      return;
    }
    const camera = draftCameraRef.current ?? selectedShot.camera;
    const alreadyCaptured = isShotFramingAccepted(useProjectStore.getState().project, selectedShot.id);

    let targetShot = selectedShot;
    if (alreadyCaptured) targetShot = addCamera({ navigateToShots: false });

    captureGenerationRef.current += 1;
    captureAbortControllerRef.current?.abort();
    const generation = captureGenerationRef.current;
    landShotFraming(targetShot.id, camera, { keepFlying: true });
    draftCameraRef.current = {
      ...camera,
      position: [...camera.position] as CameraData['position'],
      target: [...camera.target] as CameraData['target'],
    };
    snapshotPreview(targetShot, camera, { captureGeneration: generation });
    triggerLandFlash(700);
  }, [addCamera, draftCameraRef, landShotFraming, selectedShot, snapshotPreview, triggerLandFlash]);

  const captureError = snapshotError;
  const captureStatus: StillCaptureStatus = captureError
    ? 'error'
    : isExportingFrame
      ? 'exporting'
      : isCapturing
        ? 'capturing'
        : 'idle';

  return {
    captureStill,
    isCapturing: isCapturing || isExportingFrame,
    captureStatus,
    captureError,
    exportCameraFrame,
    snapshotPreview,
    thumbnailFreshAfterFinishRef,
    clearThumbnailFresh,
    landFlash,
    setLandFlash,
    triggerLandFlash,
    getPreviewShot,
  };
}

type CompanionAttach = (
  selection: ShotStillViewSelection,
  dataUrl: string,
  width: number,
  height: number,
  fileName: string,
) => Promise<void>;

/**
 * Build optional companion still jobs (clean-plate + projected variants).
 * Exported for behavioral tests — production callers use snapshotPreview.
 */
export function buildStillCompanionJobs(params: {
  project: Parameters<typeof canUseProjectedAppearance>[0];
  shotForNaming: Shot;
  viewportFileName: string;
  attachStillView: CompanionAttach;
}): Array<() => Promise<void>> {
  const { project, shotForNaming, viewportFileName, attachStillView } = params;
  const companionJobs: Array<() => Promise<void>> = [
    () => renderShotFrame(project, shotForNaming, { peopleVariant: 'clean_plate' })
      .then((clean) => attachStillView(
        { appearance: 'clay', people: 'clean_plate' },
        clean.dataUrl,
        clean.width,
        clean.height,
        getPeopleVariantPath(viewportFileName, 'clean_plate', 'both'),
      )),
  ];

  if (canUseProjectedAppearance(project)) {
    const projectedBaseName = getProjectedStillDownloadName(shotForNaming);
    companionJobs.push(
      () => renderShotProjectedFrame(project, shotForNaming, { peopleVariant: 'with_people' })
        .then(async (projected) => {
          await attachStillView(
            { appearance: 'projected', people: 'with_people' },
            projected.dataUrl,
            projected.width,
            projected.height,
            projectedBaseName,
          );
        }),
      () => renderShotProjectedFrame(project, shotForNaming, { peopleVariant: 'clean_plate' })
        .then((projectedClean) => attachStillView(
          { appearance: 'projected', people: 'clean_plate' },
          projectedClean.dataUrl,
          projectedClean.width,
          projectedClean.height,
          getPeopleVariantPath(projectedBaseName, 'clean_plate', 'both'),
        )),
    );
  }

  return companionJobs;
}
