import * as THREE from 'three';
import { DEFAULT_SHOT_NEAR_CLIP_METERS } from './cameraClipping';
import type { FlyCameraState } from './sync';

/**
 * Applies the Build fly-camera state without pulling the offline renderer
 * bundle into an interactive viewport.
 */
export function applyFlyCameraToPerspectiveCamera(
  camera: THREE.PerspectiveCamera,
  fly: FlyCameraState,
  fovDegrees: number,
  aspect: number,
  near = DEFAULT_SHOT_NEAR_CLIP_METERS,
  far = 200,
) {
  camera.fov = fovDegrees;
  camera.aspect = aspect;
  camera.near = near;
  camera.far = far;
  camera.position.set(fly.position[0], fly.position[1], fly.position[2]);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = THREE.MathUtils.degToRad(fly.yawDegrees);
  camera.rotation.x = THREE.MathUtils.degToRad(fly.pitchDegrees);
  camera.rotation.z = 0;
  camera.updateProjectionMatrix();
}
