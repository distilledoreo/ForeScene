import type {
  HumanJointId,
  HumanJointPose,
  HumanPose,
  PoseableCharacterSource,
  QuaternionTuple,
  Vec3,
} from '../domain/types';

export const HUMAN_JOINT_IDS: readonly HumanJointId[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'leftHandEnd',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'rightHandEnd',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToeBase',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToeBase',
] as const;

export const HUMAN_JOINT_LABELS: Record<HumanJointId, string> = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Chest',
  neck: 'Neck',
  head: 'Head',
  leftUpperArm: 'Left upper arm',
  leftLowerArm: 'Left lower arm',
  leftHand: 'Left hand',
  leftHandEnd: 'Left hand tip',
  rightUpperArm: 'Right upper arm',
  rightLowerArm: 'Right lower arm',
  rightHand: 'Right hand',
  rightHandEnd: 'Right hand tip',
  leftUpperLeg: 'Left hip',
  leftLowerLeg: 'Left lower leg',
  leftFoot: 'Left foot',
  leftToeBase: 'Left toes',
  rightUpperLeg: 'Right hip',
  rightLowerLeg: 'Right lower leg',
  rightFoot: 'Right foot',
  rightToeBase: 'Right toes',
};

/** Left/right pairs for mirror. */
export const HUMAN_JOINT_MIRROR: Partial<Record<HumanJointId, HumanJointId>> = {
  leftUpperArm: 'rightUpperArm',
  leftLowerArm: 'rightLowerArm',
  leftHand: 'rightHand',
  leftHandEnd: 'rightHandEnd',
  rightUpperArm: 'leftUpperArm',
  rightLowerArm: 'leftLowerArm',
  rightHand: 'leftHand',
  rightHandEnd: 'leftHandEnd',
  leftUpperLeg: 'rightUpperLeg',
  leftLowerLeg: 'rightLowerLeg',
  leftFoot: 'rightFoot',
  leftToeBase: 'rightToeBase',
  rightUpperLeg: 'leftUpperLeg',
  rightLowerLeg: 'leftLowerLeg',
  rightFoot: 'leftFoot',
  rightToeBase: 'leftToeBase',
};

export const IDENTITY_QUATERNION: QuaternionTuple = [0, 0, 0, 1];

export function createEmptyHumanPose(presetId?: string): HumanPose {
  return {
    version: 1,
    joints: {},
    ...(presetId ? { presetId } : {}),
  };
}

export function cloneHumanPose(pose: HumanPose | undefined): HumanPose | undefined {
  if (!pose) return undefined;
  const joints: HumanPose['joints'] = {};
  for (const [jointId, jointPose] of Object.entries(pose.joints) as Array<[HumanJointId, HumanJointPose]>) {
    joints[jointId] = cloneHumanJointPose(jointPose);
  }
  return {
    version: 1,
    joints,
    ...(pose.presetId ? { presetId: pose.presetId } : {}),
  };
}

export function cloneHumanJointPose(pose: HumanJointPose): HumanJointPose {
  return {
    rotation: [...pose.rotation] as QuaternionTuple,
    ...(pose.position ? { position: [...pose.position] as Vec3 } : {}),
  };
}

export function humanPosesEqual(
  a: HumanPose | undefined,
  b: HumanPose | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.presetId !== b.presetId) return false;
  const ids = new Set([
    ...Object.keys(a.joints),
    ...Object.keys(b.joints),
  ] as HumanJointId[]);
  for (const id of ids) {
    if (!jointPosesEqual(a.joints[id], b.joints[id])) return false;
  }
  return true;
}

function jointPosesEqual(
  a: HumanJointPose | undefined,
  b: HumanJointPose | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (!quatNearlyEqual(a.rotation, b.rotation)) return false;
  if (!!a.position !== !!b.position) return false;
  if (a.position && b.position) {
    return a.position[0] === b.position[0]
      && a.position[1] === b.position[1]
      && a.position[2] === b.position[2];
  }
  return true;
}

function quatNearlyEqual(a: QuaternionTuple, b: QuaternionTuple, epsilon = 1e-5): boolean {
  // Quaternions q and -q represent the same rotation.
  const same = Math.abs(a[0] - b[0]) <= epsilon
    && Math.abs(a[1] - b[1]) <= epsilon
    && Math.abs(a[2] - b[2]) <= epsilon
    && Math.abs(a[3] - b[3]) <= epsilon;
  if (same) return true;
  return Math.abs(a[0] + b[0]) <= epsilon
    && Math.abs(a[1] + b[1]) <= epsilon
    && Math.abs(a[2] + b[2]) <= epsilon
    && Math.abs(a[3] + b[3]) <= epsilon;
}

export function normalizeHumanPose(value: unknown): HumanPose | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<HumanPose> & { joints?: Record<string, unknown>; version?: unknown };
  const joints: HumanPose['joints'] = {};
  if (raw.joints && typeof raw.joints === 'object') {
    for (const jointId of HUMAN_JOINT_IDS) {
      const joint = normalizeHumanJointPose(raw.joints[jointId]);
      if (joint) joints[jointId] = joint;
    }
  }
  const presetId = typeof raw.presetId === 'string' && raw.presetId.length > 0
    ? raw.presetId
    : undefined;
  const hasVersion = raw.version === 1;
  // Explicit empty `{ version: 1, joints: {} }` is a neutral pose — keep it.
  if (Object.keys(joints).length === 0 && !presetId && !hasVersion) return undefined;
  return {
    version: 1,
    joints,
    ...(presetId ? { presetId } : {}),
  };
}

function normalizeHumanJointPose(value: unknown): HumanJointPose | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as { rotation?: unknown; position?: unknown };
  const rotation = normalizeQuaternion(raw.rotation);
  if (!rotation) return undefined;
  const position = Array.isArray(raw.position) && raw.position.length === 3
    ? [
      Number(raw.position[0]) || 0,
      Number(raw.position[1]) || 0,
      Number(raw.position[2]) || 0,
    ] as Vec3
    : undefined;
  return {
    rotation,
    ...(position ? { position } : {}),
  };
}

export function normalizeQuaternion(value: unknown): QuaternionTuple | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  const w = Number(value[3]);
  if (![x, y, z, w].every(Number.isFinite)) return undefined;
  const length = Math.hypot(x, y, z, w);
  if (length < 1e-8) return [...IDENTITY_QUATERNION];
  return [x / length, y / length, z / length, w / length];
}

export function normalizePoseableCharacterSource(
  value: unknown,
  objectType?: string,
): PoseableCharacterSource | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Partial<PoseableCharacterSource> & { kind?: string };
    if (raw.kind === 'builtin') {
      const characterId = raw.characterId === 'adult-female' ? 'adult-female' : 'adult-male';
      return { kind: 'builtin', characterId };
    }
    if (
      raw.kind === 'autorigged'
      && typeof (raw as { assetId?: unknown }).assetId === 'string'
      && typeof (raw as { rigId?: unknown }).rigId === 'string'
    ) {
      return {
        kind: 'autorigged',
        assetId: (raw as { assetId: string }).assetId,
        rigId: (raw as { rigId: string }).rigId,
      };
    }
  }
  // Legacy human_dummy objects without an explicit source are the builtin mannequin.
  if (objectType === 'human_dummy') {
    return { kind: 'builtin', characterId: 'adult-male' };
  }
  return undefined;
}

export function isPoseableSceneObject(
  object: { type?: string; poseableCharacter?: PoseableCharacterSource },
): boolean {
  return Boolean(normalizePoseableCharacterSource(object.poseableCharacter, object.type));
}

/**
 * Interpolate two poses for keyframe animation.
 *
 * `undefined` on a side means "inherit the character base pose".
 * An explicit empty pose (`{ version: 1, joints: {} }`) means neutral identity
 * deltas and must NOT fall back to the live base pose per joint — that would
 * break neutral→posed keyframe pairs after the base character is edited.
 */
export function interpolateHumanPose(
  basePose: HumanPose | undefined,
  startPose: HumanPose | undefined,
  endPose: HumanPose | undefined,
  t: number,
): HumanPose | undefined {
  if (startPose === undefined && endPose === undefined && !basePose) return undefined;
  if (t <= 0) return cloneHumanPose(startPose ?? basePose);
  if (t >= 1) return cloneHumanPose(endPose ?? basePose);

  const joints: HumanPose['joints'] = {};
  const ids = new Set([
    ...Object.keys(startPose?.joints ?? {}),
    ...Object.keys(endPose?.joints ?? {}),
    ...Object.keys(basePose?.joints ?? {}),
  ] as HumanJointId[]);

  for (const id of ids) {
    const a = resolveJointForInterpolation(startPose, basePose, id);
    const b = resolveJointForInterpolation(endPose, basePose, id);
    if (!a && !b) continue;
    const from = a ?? { rotation: IDENTITY_QUATERNION };
    const to = b ?? { rotation: IDENTITY_QUATERNION };
    joints[id] = {
      rotation: slerpQuaternion(from.rotation, to.rotation, t),
      ...((from.position || to.position)
        ? {
          position: lerpVec3(
            from.position ?? [0, 0, 0],
            to.position ?? from.position ?? [0, 0, 0],
            t,
          ),
        }
        : {}),
    };
  }

  return { version: 1, joints };
}

function resolveJointForInterpolation(
  pose: HumanPose | undefined,
  basePose: HumanPose | undefined,
  id: HumanJointId,
): HumanJointPose | undefined {
  if (pose !== undefined) {
    // Explicit pose (including empty): missing joint → identity, never live base.
    return pose.joints[id] ?? { rotation: IDENTITY_QUATERNION };
  }
  return basePose?.joints[id];
}

export function mirrorHumanPose(pose: HumanPose): HumanPose {
  const joints: HumanPose['joints'] = {};
  for (const [jointId, jointPose] of Object.entries(pose.joints) as Array<[HumanJointId, HumanJointPose]>) {
    const mirroredId = HUMAN_JOINT_MIRROR[jointId] ?? jointId;
    // Reflect local rotation across the character sagittal (YZ) plane.
    // For Y-up humanoids with conventional Mixamo-style local axes, conjugating
    // by the X-reflection maps as (x, y, z, w) → (x, -y, -z, w).
    const [x, y, z, w] = jointPose.rotation;
    joints[mirroredId] = {
      rotation: [x, -y, -z, w],
      ...(jointPose.position
        ? { position: [-jointPose.position[0], jointPose.position[1], jointPose.position[2]] as Vec3 }
        : {}),
    };
  }
  return {
    version: 1,
    joints,
    ...(pose.presetId ? { presetId: pose.presetId } : {}),
  };
}

export function resetHumanJoint(
  pose: HumanPose | undefined,
  jointId: HumanJointId,
): HumanPose {
  const next = cloneHumanPose(pose) ?? createEmptyHumanPose();
  delete next.joints[jointId];
  delete next.presetId;
  return next;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function slerpQuaternion(
  a: QuaternionTuple,
  b: QuaternionTuple,
  t: number,
): QuaternionTuple {
  let ax = a[0];
  let ay = a[1];
  let az = a[2];
  let aw = a[3];
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];

  let cosTheta = ax * bx + ay * by + az * bz + aw * bw;
  if (cosTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosTheta = -cosTheta;
  }

  if (cosTheta > 0.9995) {
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    const w = aw + (bw - aw) * t;
    const length = Math.hypot(x, y, z, w) || 1;
    return [x / length, y / length, z / length, w / length];
  }

  const theta = Math.acos(Math.min(1, Math.max(-1, cosTheta)));
  const sinTheta = Math.sin(theta);
  const w1 = Math.sin((1 - t) * theta) / sinTheta;
  const w2 = Math.sin(t * theta) / sinTheta;
  return [
    ax * w1 + bx * w2,
    ay * w1 + by * w2,
    az * w1 + bz * w2,
    aw * w1 + bw * w2,
  ];
}

/** Build a local rotation delta from Euler degrees (XYZ order). */
export function eulerDegreesToQuaternion(
  xDegrees: number,
  yDegrees: number,
  zDegrees: number,
): QuaternionTuple {
  const x = (xDegrees * Math.PI) / 180;
  const y = (yDegrees * Math.PI) / 180;
  const z = (zDegrees * Math.PI) / 180;
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);
  // XYZ intrinsic
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}
