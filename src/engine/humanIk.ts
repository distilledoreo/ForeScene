import type { HumanJointId, HumanPose, QuaternionTuple, Vec3 } from '../domain/types';
import { IDENTITY_QUATERNION } from './humanPose';

/**
 * Minimal two-bone IK for arms/legs (Milestone A optional helper).
 * Full target gizmos arrive with later posing UX; this solver is shared by
 * builtin and future autorigged characters.
 */
export function solveTwoBoneIk(params: {
  root: Vec3;
  mid: Vec3;
  tip: Vec3;
  target: Vec3;
  pole?: Vec3;
}): { mid: Vec3; tip: Vec3 } | undefined {
  const upperLen = distance(params.root, params.mid);
  const lowerLen = distance(params.mid, params.tip);
  const total = upperLen + lowerLen;
  if (total < 1e-6) return undefined;

  const toTarget = subtract(params.target, params.root);
  const targetDist = Math.min(length(toTarget), total - 1e-4);
  if (targetDist < 1e-6) {
    return { mid: [...params.mid] as Vec3, tip: [...params.root] as Vec3 };
  }

  const dir = normalize(toTarget);
  // Law of cosines for the mid joint bend.
  const cosMid = clamp(
    (upperLen * upperLen + lowerLen * lowerLen - targetDist * targetDist)
      / (2 * upperLen * lowerLen),
    -1,
    1,
  );
  const midAngle = Math.acos(cosMid);
  const cosRoot = clamp(
    (upperLen * upperLen + targetDist * targetDist - lowerLen * lowerLen)
      / (2 * upperLen * targetDist),
    -1,
    1,
  );
  const rootAngle = Math.acos(cosRoot);

  const pole = params.pole ?? add(params.mid, [0, 1, 0]);
  const poleDir = normalize(cross(dir, subtract(pole, params.root)));
  const bendAxis = length(poleDir) > 1e-6 ? poleDir : orthogonal(dir);

  const midDir = rotateAround(dir, bendAxis, rootAngle);
  const mid = add(params.root, scale(midDir, upperLen));
  // Keep tip on the target line for a stable reach.
  const tip = add(params.root, scale(dir, targetDist));
  void midAngle;
  return { mid, tip };
}

/** Convert a world-space look direction into a local rotation delta quaternion. */
export function lookRotationDelta(
  from: Vec3,
  to: Vec3,
  restDirection: Vec3 = [0, 0, 1],
): QuaternionTuple {
  const desired = normalize(subtract(to, from));
  const rest = normalize(restDirection);
  const axis = cross(rest, desired);
  const axisLen = length(axis);
  const dot = clamp(rest[0] * desired[0] + rest[1] * desired[1] + rest[2] * desired[2], -1, 1);
  if (axisLen < 1e-6) {
    return dot < 0 ? [0, 1, 0, 0] : [...IDENTITY_QUATERNION];
  }
  const angle = Math.acos(dot);
  const n = scale(axis, 1 / axisLen);
  const s = Math.sin(angle / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}

export type IkEndEffector = 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot' | 'head';

export const IK_CHAIN: Record<IkEndEffector, { root: HumanJointId; mid?: HumanJointId; tip: HumanJointId }> = {
  leftHand: { root: 'leftUpperArm', mid: 'leftLowerArm', tip: 'leftHand' },
  rightHand: { root: 'rightUpperArm', mid: 'rightLowerArm', tip: 'rightHand' },
  leftFoot: { root: 'leftUpperLeg', mid: 'leftLowerLeg', tip: 'leftFoot' },
  rightFoot: { root: 'rightUpperLeg', mid: 'rightLowerLeg', tip: 'rightFoot' },
  head: { root: 'neck', tip: 'head' },
};

/** Placeholder: apply IK targets into a HumanPose once interactive targets exist. */
export function applyIkTargetsToPose(
  pose: HumanPose,
  _targets: Partial<Record<IkEndEffector, Vec3>>,
): HumanPose {
  return pose;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a: Vec3): Vec3 {
  const len = length(a) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function orthogonal(a: Vec3): Vec3 {
  return Math.abs(a[1]) < 0.9 ? normalize(cross(a, [0, 1, 0])) : normalize(cross(a, [1, 0, 0]));
}

function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [x, y, z] = axis;
  return [
    (c + x * x * (1 - c)) * v[0] + (x * y * (1 - c) - z * s) * v[1] + (x * z * (1 - c) + y * s) * v[2],
    (y * x * (1 - c) + z * s) * v[0] + (c + y * y * (1 - c)) * v[1] + (y * z * (1 - c) - x * s) * v[2],
    (z * x * (1 - c) - y * s) * v[0] + (z * y * (1 - c) + x * s) * v[1] + (c + z * z * (1 - c)) * v[2],
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
