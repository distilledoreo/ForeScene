/**
 * Rigid transforms for logical object groups — preserves member offsets relative to pivot.
 */

import type { SceneObject, Transform, Vec3 } from '../../domain/types';
import { selectionBounds } from '../buildSelection';

export function groupPivotFromObjects(objects: SceneObject[]): Vec3 {
  if (objects.length === 0) return [0, 0, 0];
  const box = selectionBounds(objects);
  return [
    (box.min.x + box.max.x) / 2,
    (box.min.y + box.max.y) / 2,
    (box.min.z + box.max.z) / 2,
  ];
}

function rotateYawYUp(offset: Vec3, yawDegrees: number): Vec3 {
  const rad = (yawDegrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    offset[0] * c + offset[2] * s,
    offset[1],
    -offset[0] * s + offset[2] * c,
  ];
}

/**
 * Apply a rigid group transform: members move/rotate/scale relative to the group pivot.
 */
export function computeRigidGroupMemberTransforms(
  members: SceneObject[],
  pivot: Vec3,
  groupTransform: Transform,
): Map<string, Transform> {
  const results = new Map<string, Transform>();
  const yaw = groupTransform.rotation[1] ?? 0;
  const scale = groupTransform.scale;

  for (const member of members) {
    const rel: Vec3 = [
      member.transform.position[0] - pivot[0],
      member.transform.position[1] - pivot[1],
      member.transform.position[2] - pivot[2],
    ];
    const scaled: Vec3 = [
      rel[0] * scale[0],
      rel[1] * scale[1],
      rel[2] * scale[2],
    ];
    const rotated = rotateYawYUp(scaled, yaw);
    const newPosition: Vec3 = [
      groupTransform.position[0] + rotated[0],
      groupTransform.position[1] + rotated[1],
      groupTransform.position[2] + rotated[2],
    ];
    results.set(member.id, {
      position: newPosition,
      rotation: [
        member.transform.rotation[0] + (groupTransform.rotation[0] - 0),
        member.transform.rotation[1] + (groupTransform.rotation[1] - 0),
        member.transform.rotation[2] + (groupTransform.rotation[2] - 0),
      ],
      scale: [
        member.transform.scale[0] * scale[0],
        member.transform.scale[1] * scale[1],
        member.transform.scale[2] * scale[2],
      ],
    });
  }
  return results;
}
