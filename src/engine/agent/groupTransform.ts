/**
 * Rigid transforms for logical object groups — preserves member offsets relative to pivot.
 */

import * as THREE from 'three';
import type { SceneObject, Transform, Vec3 } from '../../domain/types';
import { selectionBounds } from '../buildSelection';
import { degreesToRadians } from '../sync';

export function groupPivotFromObjects(objects: SceneObject[]): Vec3 {
  if (objects.length === 0) return [0, 0, 0];
  const box = selectionBounds(objects);
  return [
    (box.min.x + box.max.x) / 2,
    (box.min.y + box.max.y) / 2,
    (box.min.z + box.max.z) / 2,
  ];
}

function transformOffset(offset: Vec3, rotationDegrees: Vec3, scale: Vec3): Vec3 {
  const vector = new THREE.Vector3(
    offset[0] * scale[0],
    offset[1] * scale[1],
    offset[2] * scale[2],
  );
  const euler = new THREE.Euler(
    degreesToRadians(rotationDegrees[0]),
    degreesToRadians(rotationDegrees[1]),
    degreesToRadians(rotationDegrees[2]),
    'XYZ',
  );
  vector.applyEuler(euler);
  return [vector.x, vector.y, vector.z];
}

function composeEulerDegrees(memberRotation: Vec3, groupRotation: Vec3): Vec3 {
  const memberQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    degreesToRadians(memberRotation[0]),
    degreesToRadians(memberRotation[1]),
    degreesToRadians(memberRotation[2]),
    'XYZ',
  ));
  const groupQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    degreesToRadians(groupRotation[0]),
    degreesToRadians(groupRotation[1]),
    degreesToRadians(groupRotation[2]),
    'XYZ',
  ));
  const composed = groupQuat.multiply(memberQuat);
  const euler = new THREE.Euler().setFromQuaternion(composed, 'XYZ');
  return [
    (euler.x * 180) / Math.PI,
    (euler.y * 180) / Math.PI,
    (euler.z * 180) / Math.PI,
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
  const scale = groupTransform.scale;

  for (const member of members) {
    const rel: Vec3 = [
      member.transform.position[0] - pivot[0],
      member.transform.position[1] - pivot[1],
      member.transform.position[2] - pivot[2],
    ];
    const rotated = transformOffset(rel, groupTransform.rotation, scale);
    const newPosition: Vec3 = [
      groupTransform.position[0] + rotated[0],
      groupTransform.position[1] + rotated[1],
      groupTransform.position[2] + rotated[2],
    ];
    results.set(member.id, {
      position: newPosition,
      rotation: composeEulerDegrees(member.transform.rotation, groupTransform.rotation),
      scale: [
        member.transform.scale[0] * scale[0],
        member.transform.scale[1] * scale[1],
        member.transform.scale[2] * scale[2],
      ],
    });
  }
  return results;
}
