import { CameraData, LocationProject, PanoCropSettings, PanoReference, PanoViewState, ProjectSettings, Shot, Vec3 } from '../domain/types';

export interface CameraOrbitState {
  yaw: number;
  pitch: number;
  distance: number;
  target: Vec3;
}

export interface FlyCameraState {
  position: Vec3;
  yawDegrees: number;
  pitchDegrees: number;
}

export interface ExportFrameLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function multiplyScalar(value: Vec3, scalar: number): Vec3 {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

export function length(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

export function normalize(value: Vec3): Vec3 {
  const distance = length(value);
  if (distance === 0) return [0, 0, 1];
  return [value[0] / distance, value[1] / distance, value[2] / distance];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function directionToYawPitch(direction: Vec3): { yawDegrees: number; pitchDegrees: number } {
  const dir = normalize(direction);
  const yaw = Math.atan2(dir[0], dir[2]);
  const pitch = Math.asin(clamp(dir[1], -1, 1));
  return {
    yawDegrees: radiansToDegrees(yaw),
    pitchDegrees: radiansToDegrees(pitch),
  };
}

export function yawPitchToDirection(yawDegrees: number, pitchDegrees: number): Vec3 {
  const yaw = degreesToRadians(yawDegrees);
  const pitch = degreesToRadians(pitchDegrees);
  const cosPitch = Math.cos(pitch);
  return normalize([
    Math.sin(yaw) * cosPitch,
    Math.sin(pitch),
    Math.cos(yaw) * cosPitch,
  ]);
}

export function cameraForward(camera: CameraData): Vec3 {
  return normalize(subtract(camera.target, camera.position));
}

export function cameraOrbitFromCamera(camera: CameraData): CameraOrbitState {
  const target: Vec3 = [...camera.target];
  const offset = subtract(camera.position, target);
  const distance = Math.max(length(offset), 0.1);
  const pitch = radiansToDegrees(Math.asin(clamp(offset[1] / distance, -1, 1)));
  const yaw = radiansToDegrees(Math.atan2(offset[0], offset[2]));
  return { yaw, pitch, distance, target };
}

export function cameraFromOrbit(
  orbit: CameraOrbitState,
  fovDegrees: number,
  aspectRatio: number,
  near = 0.1,
  far = 100,
): CameraData {
  const yawRad = degreesToRadians(orbit.yaw);
  const pitchRad = degreesToRadians(orbit.pitch);
  const cosPitch = Math.cos(pitchRad);
  const offset: Vec3 = [
    Math.sin(yawRad) * cosPitch * orbit.distance,
    Math.sin(pitchRad) * orbit.distance,
    Math.cos(yawRad) * cosPitch * orbit.distance,
  ];
  return {
    position: add(orbit.target, offset),
    target: [...orbit.target],
    fovDegrees,
    aspectRatio,
    near,
    far,
  };
}

export function threeJsDirectionFromYawPitch(yawDegrees: number, pitchDegrees: number): Vec3 {
  const yawRad = degreesToRadians(yawDegrees);
  const pitchRad = degreesToRadians(pitchDegrees);
  const cosPitch = Math.cos(pitchRad);
  return normalize([
    -Math.sin(yawRad) * cosPitch,
    Math.sin(pitchRad),
    -Math.cos(yawRad) * cosPitch,
  ]);
}

export function yawPitchFromThreeJsDirection(direction: Vec3): { yawDegrees: number; pitchDegrees: number } {
  const dir = normalize(direction);
  return {
    yawDegrees: radiansToDegrees(Math.atan2(-dir[0], -dir[2])),
    pitchDegrees: radiansToDegrees(Math.asin(clamp(dir[1], -1, 1))),
  };
}

export function computeExportFrameLayout(
  containerWidth: number,
  containerHeight: number,
  exportAspect: number,
): ExportFrameLayout {
  const viewportAspect = containerWidth / containerHeight;
  if (viewportAspect > exportAspect) {
    const width = containerHeight * exportAspect;
    return {
      left: (containerWidth - width) / 2,
      top: 0,
      width,
      height: containerHeight,
    };
  }
  const height = containerWidth / exportAspect;
  return {
    left: 0,
    top: (containerHeight - height) / 2,
    width: containerWidth,
    height,
  };
}

export function flyCameraFromCamera(camera: CameraData): FlyCameraState {
  const { yawDegrees, pitchDegrees } = yawPitchFromThreeJsDirection(cameraForward(camera));
  return {
    position: [...camera.position],
    yawDegrees,
    pitchDegrees,
  };
}

export function cameraFromFlyState(
  fly: FlyCameraState,
  fovDegrees: number,
  aspectRatio: number,
  near = 0.1,
  far = 100,
  targetDistance = 10,
): CameraData {
  const forward = threeJsDirectionFromYawPitch(fly.yawDegrees, fly.pitchDegrees);
  return {
    position: [...fly.position],
    target: add(fly.position, multiplyScalar(forward, targetDistance)),
    fovDegrees,
    aspectRatio,
    near,
    far,
  };
}

export function horizontalFlyDirections(yawDegrees: number): { forward: Vec3; right: Vec3 } {
  const yawRad = degreesToRadians(yawDegrees);
  return {
    forward: [-Math.sin(yawRad), 0, -Math.cos(yawRad)],
    right: [Math.cos(yawRad), 0, -Math.sin(yawRad)],
  };
}

export function panoViewFromCamera(camera: CameraData): PanoViewState {
  const { yawDegrees, pitchDegrees } = directionToYawPitch(cameraForward(camera));
  return {
    yawDegrees,
    pitchDegrees,
    fovDegrees: camera.fovDegrees,
  };
}

export function panoYawPitchFromCamera(camera: CameraData): { yawDegrees: number; pitchDegrees: number } {
  return directionToYawPitch(cameraForward(camera));
}

export function panoYawToThreeJsYawDegrees(yawDegrees: number): number {
  // Inward SphereGeometry UVs start from the +X seam; app pano yaw uses +Z as zero.
  return 90 - yawDegrees;
}

export function getCanonicalPano(project: LocationProject): PanoReference | undefined {
  return project.panoRefs.find((pano) => pano.isCanonical) ?? project.panoRefs[0];
}

/** True when the shot was explicitly unlinked and must not inherit canonical. */
export function isShotPanoramaExplicitlyUnlinked(shot: Shot): boolean {
  return shot.linkedPanoId === null;
}

/** Persist a durable unlink (`linkedPanoId: null`) instead of a missing field. */
export function unlinkShotPano(shot: Shot): Shot {
  return {
    ...shot,
    linkedPanoId: null,
    panoCrop: undefined,
  };
}

export function resolveShotLinkedPano(project: LocationProject, shot: Shot): PanoReference | undefined {
  if (shot.linkedPanoId === null) return undefined;
  if (shot.linkedPanoId) {
    return project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
  }
  return getCanonicalPano(project);
}

export function withShotPanoLink(project: LocationProject, shot: Shot, pano?: PanoReference): Shot {
  if (isShotPanoramaExplicitlyUnlinked(shot) && !pano) return unlinkShotPano(shot);
  const linkedPano = pano ?? resolveShotLinkedPano(project, shot);
  if (!linkedPano) return shot;
  return {
    ...shot,
    linkedPanoId: linkedPano.id,
    panoCrop: getPanoCropSettingsForShot(
      shot.camera,
      linkedPano,
      shot.exportSettings.width,
      shot.exportSettings.height,
    ),
  };
}

/**
 * Inherit the canonical panorama for shots that are unset (`undefined`) or
 * whose assigned panorama no longer exists. Explicit unlinks (`linkedPanoId: null`)
 * and explicit assignments to a still-present panorama are preserved.
 */
export function linkAllShotsToCanonicalPano(project: LocationProject): LocationProject {
  const canonical = getCanonicalPano(project);
  if (!canonical) return project;
  return {
    ...project,
    shots: project.shots.map((shot) => {
      if (isShotPanoramaExplicitlyUnlinked(shot)) return unlinkShotPano(shot);
      if (shot.linkedPanoId) {
        const existing = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
        if (existing) return withShotPanoLink(project, shot, existing);
      }
      return withShotPanoLink(project, shot, canonical);
    }),
  };
}

/**
 * Explicit force-relink: every shot, including previously unlinked shots,
 * is assigned the canonical panorama. Callers must opt into this.
 */
export function forceLinkAllShotsToCanonicalPano(project: LocationProject): LocationProject {
  const canonical = getCanonicalPano(project);
  if (!canonical) return project;
  return {
    ...project,
    shots: project.shots.map((shot) => withShotPanoLink(project, shot, canonical)),
  };
}

/**
 * Relink unset shots and followers of a replaced canonical panorama.
 * Explicit unlinks and assignments to any other still-present panorama stay put.
 */
export function relinkCanonicalFollowers(
  project: LocationProject,
  previousCanonicalId?: string,
): LocationProject {
  const canonical = getCanonicalPano(project);
  if (!canonical) return project;
  return {
    ...project,
    shots: project.shots.map((shot) => {
      if (isShotPanoramaExplicitlyUnlinked(shot)) return unlinkShotPano(shot);
      if (shot.linkedPanoId && shot.linkedPanoId !== previousCanonicalId) {
        const existing = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
        if (existing) return withShotPanoLink(project, shot, existing);
      }
      return withShotPanoLink(project, shot, canonical);
    }),
  };
}

/** Preserve explicit per-shot pano assignments when hydrating an opened project. */
export function preserveShotPanoLinks(project: LocationProject): LocationProject {
  const canonical = getCanonicalPano(project);
  return {
    ...project,
    shots: project.shots.map((shot) => {
      if (isShotPanoramaExplicitlyUnlinked(shot)) {
        return unlinkShotPano(shot);
      }
      const explicitPanoId = shot.linkedPanoId ?? shot.panoCrop?.panoId;
      const linkedPano = explicitPanoId
        ? project.panoRefs.find((pano) => pano.id === explicitPanoId)
        : undefined;
      if (linkedPano) return withShotPanoLink(project, shot, linkedPano);
      // Legacy shots with no explicit assignment still inherit canonical.
      if (!canonical) return shot;
      return withShotPanoLink(project, shot, canonical);
    }),
  };
}

export function getPanoCropSettingsForShot(
  shotCamera: CameraData,
  pano: PanoReference,
  width: number,
  height: number,
): PanoCropSettings {
  const { yawDegrees, pitchDegrees } = panoYawPitchFromCamera(shotCamera);
  return {
    panoId: pano.id,
    yawDegrees,
    pitchDegrees,
    rollDegrees: 0,
    fovDegrees: shotCamera.fovDegrees,
    aspectRatio: shotCamera.aspectRatio,
    width,
    height,
  };
}

export function createCameraFromPanoView(params: {
  pano: PanoReference;
  yawDegrees: number;
  pitchDegrees: number;
  fovDegrees: number;
  aspectRatio: number;
}): CameraData {
  const direction = yawPitchToDirection(params.yawDegrees, params.pitchDegrees);
  const target = add(params.pano.origin, multiplyScalar(direction, 10));
  return {
    position: [...params.pano.origin],
    target,
    fovDegrees: params.fovDegrees,
    aspectRatio: params.aspectRatio,
    near: 0.1,
    far: 100,
  };
}

export function getPanoMatchQuality(
  camera: CameraData,
  pano: PanoReference,
  settings: Pick<ProjectSettings, 'panoGoodMatchMeters' | 'panoModerateMatchMeters'>,
): { quality: 'good' | 'moderate' | 'poor'; distanceMeters: number } {
  const distanceMeters = length(subtract(camera.position, pano.origin));
  if (distanceMeters <= settings.panoGoodMatchMeters) {
    return { quality: 'good', distanceMeters };
  }
  if (distanceMeters <= settings.panoModerateMatchMeters) {
    return { quality: 'moderate', distanceMeters };
  }
  return { quality: 'poor', distanceMeters };
}

export function degreesToRadians(value: number): number {
  return value * (Math.PI / 180);
}

export function radiansToDegrees(value: number): number {
  return value * (180 / Math.PI);
}
