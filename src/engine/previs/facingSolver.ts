/**
 * Facing / yaw solver for blocking.
 */

import type { Vec3 } from '../../domain/types';
import { yawFacing } from './spatialLayout';

export function resolveFacingYaw(params: {
  from: Vec3;
  faceTarget?: Vec3;
  fallbackYaw?: number;
}): number {
  if (params.faceTarget) {
    return yawFacing(params.from, params.faceTarget);
  }
  return params.fallbackYaw ?? 0;
}
