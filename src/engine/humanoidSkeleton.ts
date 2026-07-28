import type { HumanJointId, Vec3 } from '../domain/types';
import { HUMAN_JOINT_IDS, HUMAN_JOINT_LABELS } from './humanPose';

/** Soft Euler XYZ limits (degrees) relative to the character rest pose. */
export type HumanJointEulerLimits = {
  min: Vec3;
  max: Vec3;
};

export interface HumanoidSkeletonJoint {
  id: HumanJointId;
  parentId?: HumanJointId;
  displayName: string;
  limitsDegrees: HumanJointEulerLimits;
}

/**
 * Canonical humanoid hierarchy shared by builtin mannequins and autorigged imports.
 * Bone names from a specific GLB never appear here.
 */
export interface HumanoidSkeleton {
  version: 1;
  joints: readonly HumanoidSkeletonJoint[];
}

export const HUMAN_JOINT_PARENT: Partial<Record<HumanJointId, HumanJointId>> = {
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  leftUpperArm: 'chest',
  leftLowerArm: 'leftUpperArm',
  leftHand: 'leftLowerArm',
  rightUpperArm: 'chest',
  rightLowerArm: 'rightUpperArm',
  rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg',
  leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips',
  rightLowerLeg: 'rightUpperLeg',
  rightFoot: 'rightLowerLeg',
};

/**
 * Soft per-joint Euler limits used by the pose editor and future IK.
 * Calibrated to the builtin mannequin preset Euler convention (local XYZ degrees
 * relative to rest): knees flex on +X, hips sit/crouch on −X upper-leg pitch.
 */
export const HUMAN_JOINT_LIMITS_DEGREES: Record<HumanJointId, HumanJointEulerLimits> = {
  hips: { min: [-45, -180, -45], max: [45, 180, 45] },
  spine: { min: [-35, -45, -35], max: [45, 45, 35] },
  chest: { min: [-35, -50, -40], max: [45, 50, 40] },
  neck: { min: [-45, -70, -45], max: [45, 70, 45] },
  head: { min: [-50, -80, -50], max: [45, 80, 50] },
  leftUpperArm: { min: [-120, -90, -120], max: [90, 90, 100] },
  leftLowerArm: { min: [-5, -25, -20], max: [155, 25, 20] },
  leftHand: { min: [-50, -50, -60], max: [50, 50, 60] },
  rightUpperArm: { min: [-120, -90, -100], max: [90, 90, 120] },
  rightLowerArm: { min: [-5, -25, -20], max: [155, 25, 20] },
  rightHand: { min: [-50, -50, -60], max: [50, 50, 60] },
  leftUpperLeg: { min: [-120, -55, -90], max: [45, 55, 45] },
  leftLowerLeg: { min: [-5, -25, -25], max: [145, 25, 25] },
  leftFoot: { min: [-50, -40, -35], max: [50, 40, 50] },
  rightUpperLeg: { min: [-120, -55, -45], max: [45, 55, 90] },
  rightLowerLeg: { min: [-5, -25, -25], max: [145, 25, 25] },
  rightFoot: { min: [-50, -40, -50], max: [50, 40, 35] },
};

export function createCanonicalHumanoidSkeleton(): HumanoidSkeleton {
  return {
    version: 1,
    joints: HUMAN_JOINT_IDS.map((id) => ({
      id,
      parentId: HUMAN_JOINT_PARENT[id],
      displayName: HUMAN_JOINT_LABELS[id],
      limitsDegrees: HUMAN_JOINT_LIMITS_DEGREES[id],
    })),
  };
}

export function clampHumanJointEulerDegrees(
  jointId: HumanJointId,
  eulerDegrees: Vec3,
  skeleton: HumanoidSkeleton = createCanonicalHumanoidSkeleton(),
): Vec3 {
  const joint = skeleton.joints.find((item) => item.id === jointId);
  const limits = joint?.limitsDegrees ?? HUMAN_JOINT_LIMITS_DEGREES[jointId];
  return [
    clamp(eulerDegrees[0], limits.min[0], limits.max[0]),
    clamp(eulerDegrees[1], limits.min[1], limits.max[1]),
    clamp(eulerDegrees[2], limits.min[2], limits.max[2]),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
