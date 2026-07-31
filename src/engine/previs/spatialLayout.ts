/**
 * Deterministic spatial layout helpers for multi-location graybox zones.
 */

import { PREVIS_MANIFEST_LIMITS } from './manifest';
import type { Vec3 } from '../../domain/types';

/** Location N origin: [N * spacing, 0, 0]. */
export function locationZoneOrigin(locationIndex: number): Vec3 {
  const spacing = PREVIS_MANIFEST_LIMITS.locationZoneSpacingMeters;
  return [locationIndex * spacing, 0, 0];
}

export function offsetByOrigin(local: Vec3, origin: Vec3): Vec3 {
  return [local[0] + origin[0], local[1] + origin[1], local[2] + origin[2]];
}

export function distanceXZ(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.hypot(dx, dz);
}

/** Yaw degrees so +Z local forward faces from `from` toward `to` (XZ). */
export function yawFacing(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return 0;
  // Three.js Object3D rotation.y: 0 looks down -Z in some conventions;
  // ForeScene human dummies use rotation.y as yaw where 0 faces +Z locally via mesh.
  // Match existing starter dummy facing: use atan2(dx, dz) in degrees.
  return (Math.atan2(dx, dz) * 180) / Math.PI;
}

export function addXZ(position: Vec3, offset: { x?: number; z?: number }): Vec3 {
  return [position[0] + (offset.x ?? 0), position[1], position[2] + (offset.z ?? 0)];
}

/** Push `subject` away from `other` on XZ if closer than minDistance. */
export function separateOnGround(
  subject: Vec3,
  other: Vec3,
  minDistance: number,
): Vec3 {
  const dx = subject[0] - other[0];
  const dz = subject[2] - other[2];
  const dist = Math.hypot(dx, dz);
  if (dist >= minDistance) return subject;
  if (dist < 1e-6) {
    return [subject[0] + minDistance, subject[1], subject[2]];
  }
  const scale = minDistance / dist;
  return [other[0] + dx * scale, subject[1], other[2] + dz * scale];
}

export function sceneExtentWithinLimits(origins: Vec3[]): boolean {
  if (origins.length === 0) return true;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const origin of origins) {
    minX = Math.min(minX, origin[0]);
    maxX = Math.max(maxX, origin[0]);
    minZ = Math.min(minZ, origin[2]);
    maxZ = Math.max(maxZ, origin[2]);
  }
  const extent = Math.max(maxX - minX, maxZ - minZ);
  return extent <= PREVIS_MANIFEST_LIMITS.maxSceneExtentMeters;
}
