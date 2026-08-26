import * as THREE from 'three';
import type { Vec3 } from '../domain/types';

/** Skip tiny props; character-scale meshes use a declared-dimension foot pivot. */
export const GROUND_PIVOT_MIN_HEIGHT_METERS = 0.4;

const footLocal = new THREE.Vector3();
const footEuler = new THREE.Euler();
const boundsHalfExtents = new THREE.Vector3();

/**
 * World position of a SceneObject origin so a point at local (0, -height/2, 0)
 * stays on the unrotated foot plane after the authored Euler XYZ rotation.
 * Only Y is corrected so travel paths and camera solves keep their centroids.
 */
export function centerTransformForFootPlant(
  center: Vec3,
  rotationDegrees: Vec3,
  heightMeters: number,
): Vec3 {
  if (heightMeters < GROUND_PIVOT_MIN_HEIGHT_METERS) return center;
  const half = heightMeters / 2;
  footEuler.set(
    (rotationDegrees[0] * Math.PI) / 180,
    (rotationDegrees[1] * Math.PI) / 180,
    (rotationDegrees[2] * Math.PI) / 180,
    'XYZ',
  );
  const footY = footLocal.set(0, -half, 0).applyEuler(footEuler).y;
  return [center[0], center[1] - half - footY, center[2]];
}

/** Ground a rotated semantic bound while preserving its authored floor plane. */
export function centerTransformForBoundsPlant(
  center: Vec3,
  rotationDegrees: Vec3,
  dimensions: Vec3,
): Vec3 {
  if (dimensions[1] < GROUND_PIVOT_MIN_HEIGHT_METERS) return center;
  footEuler.set(
    (rotationDegrees[0] * Math.PI) / 180,
    (rotationDegrees[1] * Math.PI) / 180,
    (rotationDegrees[2] * Math.PI) / 180,
    'XYZ',
  );
  boundsHalfExtents.set(dimensions[0] / 2, dimensions[1] / 2, dimensions[2] / 2);
  const matrix = new THREE.Matrix4().makeRotationFromEuler(footEuler).elements;
  const rotatedHalfY = (
    Math.abs(matrix[1]!) * boundsHalfExtents.x
    + Math.abs(matrix[5]!) * boundsHalfExtents.y
    + Math.abs(matrix[9]!) * boundsHalfExtents.z
  );
  const authoredFloorY = center[1] - dimensions[1] / 2;
  return [center[0], authoredFloorY + rotatedHalfY, center[2]];
}
