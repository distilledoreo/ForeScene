import { useCallback, useRef, useState } from 'react';
import type { CameraData } from '../domain/types';

/**
 * Framing / fly-camera local state for the Shots workspace.
 * Store-level land/fly and history remain on useContinuityStore.
 */
export function useShotCameraController(initialCamera?: CameraData) {
  const draftCameraRef = useRef<CameraData | undefined>(initialCamera);
  const [framingCamera, setFramingCamera] = useState<CameraData | undefined>(initialCamera);
  const [cameraReseedGeneration, setCameraReseedGeneration] = useState(0);
  const [focalLengthHudPulse, setFocalLengthHudPulse] = useState(0);
  const [landFlash, setLandFlash] = useState(false);

  const bumpCameraReseed = useCallback(() => {
    setCameraReseedGeneration((value) => value + 1);
  }, []);

  const pulseFocalLengthHud = useCallback(() => {
    setFocalLengthHudPulse((value) => value + 1);
  }, []);

  const setDraftCamera = useCallback((camera: CameraData | undefined) => {
    draftCameraRef.current = camera;
  }, []);

  const getEffectiveCamera = useCallback((stored?: CameraData): CameraData | undefined => {
    return draftCameraRef.current ?? stored;
  }, []);

  const reseedFromStored = useCallback((camera: CameraData) => {
    draftCameraRef.current = camera;
    setFramingCamera(camera);
    bumpCameraReseed();
  }, [bumpCameraReseed]);

  const triggerLandFlash = useCallback(() => {
    setLandFlash(true);
    window.setTimeout(() => setLandFlash(false), 280);
  }, []);

  return {
    draftCameraRef,
    framingCamera,
    setFramingCamera,
    cameraReseedGeneration,
    bumpCameraReseed,
    focalLengthHudPulse,
    pulseFocalLengthHud,
    landFlash,
    setDraftCamera,
    getEffectiveCamera,
    reseedFromStored,
    triggerLandFlash,
  };
}
