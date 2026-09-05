/**
 * Location primitive blocker AABBs — browser-safe (no Node / run-state dependencies).
 */

import type { PrevisLocationDefinition } from './manifest';

export interface LocationPrimitiveBlocker {
  /**
   * Plan-local ref at compile time; resolved to the live scene-object id via entity.refs.
   */
  objectId: string;
  type: string;
  min: [number, number, number];
  max: [number, number, number];
}

export function locationPrimitiveBlockers(
  location: PrevisLocationDefinition,
  primitives: Array<{
    type: string;
    position: [number, number, number];
    dimensions?: [number, number, number];
    rotation?: [number, number, number];
    /** Plan-local ref for this primitive (required for wall-hide overrides). */
    ref?: string;
  }>,
): LocationPrimitiveBlocker[] {
  const solid = new Set([
    'wall', 'box', 'column', 'arch', 'doorway', 'stairs', 'terrain_mass', 'background_card',
  ]);
  const blockers: LocationPrimitiveBlocker[] = [];
  for (const [index, primitive] of primitives.entries()) {
    if (!solid.has(primitive.type)) continue;
    const dims = primitive.dimensions ?? [1, 1, 1];
    const hx = dims[0] / 2;
    const hy = dims[1] / 2;
    const hz = dims[2] / 2;
    const centerY = primitive.type === 'floor'
      ? primitive.position[1] - hy
      : primitive.position[1] + hy;
    const cx = primitive.position[0];
    const cz = primitive.position[2];
    const yaw = ((primitive.rotation?.[1] ?? 0) * Math.PI) / 180;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [lx, lz] of [
      [-hx, -hz],
      [hx, -hz],
      [-hx, hz],
      [hx, hz],
    ] as const) {
      const wx = cx + lx * cos + lz * sin;
      const wz = cz - lx * sin + lz * cos;
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz);
      maxZ = Math.max(maxZ, wz);
    }
    blockers.push({
      objectId: primitive.ref ?? `loc_${location.id}_blocker_${index}`,
      type: primitive.type,
      min: [minX, Math.max(0, centerY - hy), minZ],
      max: [maxX, centerY + hy, maxZ],
    });
  }
  void location;
  return blockers;
}
