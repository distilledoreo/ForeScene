import * as THREE from 'three';
import type { HumanJointId, QuaternionTuple } from '../../domain/types';
import { HUMAN_JOINT_IDS } from '../humanPose';
import { resolveRootRelativeNodePath } from './bonePaths';

function tuple(quaternion: THREE.Quaternion): QuaternionTuple {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function firstBoneChild(bone: THREE.Bone): THREE.Bone | undefined {
  return bone.children.find((child) => child instanceof THREE.Bone) as THREE.Bone | undefined;
}

function worldDirection(from: THREE.Object3D, to: THREE.Object3D): THREE.Vector3 {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  from.getWorldPosition(a);
  to.getWorldPosition(b);
  return b.sub(a);
}

function fallbackPrimaryDirection(bone: THREE.Bone, hips: THREE.Bone | undefined): THREE.Vector3 {
  const child = firstBoneChild(bone);
  if (child) return worldDirection(bone, child);
  if (bone.parent instanceof THREE.Bone) return worldDirection(bone.parent, bone);
  if (hips && hips !== bone) return worldDirection(hips, bone);
  return new THREE.Vector3(0, 1, 0);
}

/**
 * Calculate a stable semantic frame for every mapped source bone. The frame is
 * derived from the final Three.js rest pose, so FBX pre-rotations remain part
 * of the captured rest transform rather than being decoded separately.
 */
export function calculateCanonicalPoseBases(params: {
  root: THREE.Object3D;
  boneMap: Partial<Record<HumanJointId, string>>;
}): Partial<Record<HumanJointId, QuaternionTuple>> {
  params.root.updateMatrixWorld(true);
  const resolved = new Map<HumanJointId, THREE.Bone>();
  for (const jointId of HUMAN_JOINT_IDS) {
    const path = params.boneMap[jointId];
    const node = path ? resolveRootRelativeNodePath(params.root, path) : undefined;
    if (node instanceof THREE.Bone) resolved.set(jointId, node);
  }
  const hips = resolved.get('hips');
  const left = resolved.get('leftUpperArm') ?? resolved.get('leftUpperLeg');
  const right = resolved.get('rightUpperArm') ?? resolved.get('rightUpperLeg');
  const characterUp = hips && resolved.get('head')
    ? worldDirection(hips, resolved.get('head')!).normalize()
    : new THREE.Vector3(0, 1, 0);
  const characterLeft = left && right
    ? worldDirection(right, left).normalize()
    : new THREE.Vector3(1, 0, 0);
  const result: Partial<Record<HumanJointId, QuaternionTuple>> = {};

  for (const [jointId, bone] of resolved) {
    const primary = fallbackPrimaryDirection(bone, hips).normalize();
    if (primary.lengthSq() < 1e-8) continue;
    let xAxis = characterLeft.clone().sub(primary.clone().multiplyScalar(characterLeft.dot(primary)));
    if (xAxis.lengthSq() < 1e-8) {
      xAxis = characterUp.clone().sub(primary.clone().multiplyScalar(characterUp.dot(primary)));
    }
    if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
    xAxis.normalize();
    const zAxis = xAxis.clone().cross(primary).normalize();
    xAxis.copy(primary).cross(zAxis).normalize();

    const anatomicalWorld = new THREE.Matrix4().makeBasis(xAxis, primary, zAxis);
    const anatomicalWorldQuaternion = new THREE.Quaternion().setFromRotationMatrix(anatomicalWorld);
    const parentWorldQuaternion = bone.parent
      ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const localFrame = parentWorldQuaternion.invert().multiply(anatomicalWorldQuaternion).normalize();
    result[jointId] = tuple(localFrame);
  }
  return result;
}

export function validateCanonicalPoseBases(
  bases: Partial<Record<HumanJointId, QuaternionTuple>>,
): string[] {
  const warnings: string[] = [];
  for (const [jointId, value] of Object.entries(bases) as Array<[HumanJointId, QuaternionTuple]>) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
      warnings.push(`Canonical frame for ${jointId} is invalid.`);
      continue;
    }
    const length = Math.hypot(...value);
    if (Math.abs(length - 1) > 1e-3) warnings.push(`Canonical frame for ${jointId} is not normalized.`);
  }
  return warnings;
}
