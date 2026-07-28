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

/** Soft per-joint Euler limits used by the pose editor and future IK. */
export const HUMAN_JOINT_LIMITS_DEGREES: Record<HumanJointId, HumanJointEulerLimits> = {
  hips: { min: [-45, -180, -45], max: [45, 180, 45] },
  spine: { min: [-35, -40, -30], max: [45, 40, 30] },
  chest: { min: [-30, -45, -35], max: [40, 45, 35] },
  neck: { min: [-40, -60, -40], max: [40, 60, 40] },
  head: { min: [-45, -70, -45], max: [35, 70, 45] },
  leftUpperArm: { min: [-90, -90, -110], max: [90, 90, 90] },
  leftLowerArm: { min: [0, -20, -10], max: [150, 20, 10] },
  leftHand: { min: [-40, -40, -50], max: [40, 40, 50] },
  rightUpperArm: { min: [-90, -90, -90], max: [90, 90, 110] },
  rightLowerArm: { min: [0, -20, -10], max: [150, 20, 10] },
  rightHand: { min: [-40, -40, -50], max: [40, 40, 50] },
  leftUpperLeg: { min: [-30, -45, -80], max: [120, 45, 40] },
  leftLowerLeg: { min: [-140, -15, -15], max: [5, 15, 15] },
  leftFoot: { min: [-40, -30, -25], max: [40, 30, 45] },
  rightUpperLeg: { min: [-30, -45, -40], max: [120, 45, 80] },
  rightLowerLeg: { min: [-140, -15, -15], max: [5, 15, 15] },
  rightFoot: { min: [-40, -30, -45], max: [40, 30, 25] },
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
