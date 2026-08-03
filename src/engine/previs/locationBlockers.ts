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
    blockers.push({
      objectId: primitive.ref ?? `loc_${location.id}_blocker_${index}`,
      type: primitive.type,
      min: [cx - hx, Math.max(0, centerY - hy), cz - hz],
      max: [cx + hx, centerY + hy, cz + hz],
    });
  }
  void location;
  return blockers;
}
