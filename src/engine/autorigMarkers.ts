import type { AutorigMarker, HumanJointId, PoseableRigAsset, Vec3 } from '../domain/types';
import { createId } from '../utils/ids';
import { HUMAN_JOINT_PARENT } from './humanoidSkeleton';
import { HUMAN_JOINT_IDS, HUMAN_JOINT_LABELS } from './humanPose';

/** Placement markers required for full guided autorig (13). */
export const AUTORIG_REQUIRED_MARKER_JOINTS = [
  'head',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'hips',
  'leftLowerLeg',
  'rightLowerLeg',
  'leftFoot',
  'rightFoot',
  // Chin/top-of-head is represented by head; neck is inferred. Include chest as optional inferred.
] as const satisfies readonly HumanJointId[];

/** Simplified mode (~9): shoulders and ankles are inferred. */
export const AUTORIG_SIMPLE_MARKER_JOINTS = [
  'head',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'hips',
  'leftLowerLeg',
  'rightLowerLeg',
  // ankles inferred from knees + ground
] as const satisfies readonly HumanJointId[];

export type AutorigMarkerMode = 'full' | 'simple';

export const AUTORIG_MARKER_MIRROR: Partial<Record<HumanJointId, HumanJointId>> = {
  leftUpperArm: 'rightUpperArm',
  rightUpperArm: 'leftUpperArm',
  leftLowerArm: 'rightLowerArm',
  rightLowerArm: 'leftLowerArm',
  leftHand: 'rightHand',
  rightHand: 'leftHand',
  leftLowerLeg: 'rightLowerLeg',
  rightLowerLeg: 'leftLowerLeg',
  leftFoot: 'rightFoot',
  rightFoot: 'leftFoot',
  leftUpperLeg: 'rightUpperLeg',
  rightUpperLeg: 'leftUpperLeg',
};

export function markerJointsForMode(mode: AutorigMarkerMode): readonly HumanJointId[] {
  return mode === 'simple' ? AUTORIG_SIMPLE_MARKER_JOINTS : AUTORIG_REQUIRED_MARKER_JOINTS;
}

export function isLeftMarker(jointId: HumanJointId): boolean {
  return jointId.startsWith('left');
}

export function isRightMarker(jointId: HumanJointId): boolean {
  return jointId.startsWith('right');
}

export function markerColor(jointId: HumanJointId): string {
  if (isLeftMarker(jointId)) return '#3b82f6'; // blue
  if (isRightMarker(jointId)) return '#f59e0b'; // amber
  return '#22c55e'; // green midline
}

export interface AutorigMarkerSuggestionContext {
  /** Character-local axis-aligned size after orientation (meters). */
  size: Vec3;
  /** Approximate height in meters. */
  heightMeters: number;
  groundLevelMeters?: number;
}

/** Deterministic suggested marker positions from character bounds (A/T-pose prior). */
export function suggestAutorigMarkers(context: AutorigMarkerSuggestionContext): AutorigMarker[] {
  const height = Math.max(context.heightMeters, context.size[1], 0.5);
  const width = Math.max(context.size[0], height * 0.35);
  const ground = context.groundLevelMeters ?? 0;
  const hipY = ground + height * 0.52;
  const shoulderY = ground + height * 0.78;
  const headY = ground + height * 0.96;
  const elbowY = ground + height * 0.62;
  const wristY = ground + height * 0.48;
  const kneeY = ground + height * 0.28;
  const ankleY = ground + height * 0.04;
  const shoulderX = width * 0.22;
  const elbowX = width * 0.38;
  const wristX = width * 0.48;
  const hipX = width * 0.08;
  const kneeX = width * 0.1;
  const ankleX = width * 0.09;

  const place = (jointId: HumanJointId, position: Vec3): AutorigMarker => ({
    id: createId(`marker_${jointId}`),
    jointId,
    position,
  });

  return [
    place('head', [0, headY, 0]),
    place('hips', [0, hipY, 0]),
    place('leftUpperArm', [shoulderX, shoulderY, 0]),
    place('rightUpperArm', [-shoulderX, shoulderY, 0]),
    place('leftLowerArm', [elbowX, elbowY, 0.02]),
    place('rightLowerArm', [-elbowX, elbowY, 0.02]),
    place('leftHand', [wristX, wristY, 0.04]),
    place('rightHand', [-wristX, wristY, 0.04]),
    place('leftLowerLeg', [kneeX, kneeY, 0.02]),
    place('rightLowerLeg', [-kneeX, kneeY, 0.02]),
    place('leftFoot', [ankleX, ankleY, 0.06]),
    place('rightFoot', [-ankleX, ankleY, 0.06]),
    // Upper legs sit between hips and knees for skeleton fitting even if not manually placed.
    place('leftUpperLeg', [hipX, (hipY + kneeY) / 2, 0]),
    place('rightUpperLeg', [-hipX, (hipY + kneeY) / 2, 0]),
  ];
}

export function markersToMap(markers: readonly AutorigMarker[]): Map<HumanJointId, AutorigMarker> {
  const map = new Map<HumanJointId, AutorigMarker>();
  for (const marker of markers) map.set(marker.jointId, marker);
  return map;
}

export function upsertMarker(
  markers: readonly AutorigMarker[],
  jointId: HumanJointId,
  position: Vec3,
): AutorigMarker[] {
  const existing = markers.find((marker) => marker.jointId === jointId);
  if (existing) {
    return markers.map((marker) => (
      marker.jointId === jointId ? { ...marker, position: [...position] as Vec3 } : marker
    ));
  }
  return [...markers, { id: createId(`marker_${jointId}`), jointId, position: [...position] as Vec3 }];
}

export function mirrorMarkerAcrossSagittal(
  markers: readonly AutorigMarker[],
  jointId: HumanJointId,
): AutorigMarker[] {
  const source = markers.find((marker) => marker.jointId === jointId);
  const mirrorId = AUTORIG_MARKER_MIRROR[jointId];
  if (!source || !mirrorId) return [...markers];
  const mirrored: Vec3 = [-source.position[0], source.position[1], source.position[2]];
  return upsertMarker(markers, mirrorId, mirrored);
}

export function mirrorAllMarkers(markers: readonly AutorigMarker[]): AutorigMarker[] {
  let next = [...markers];
  for (const marker of markers) {
    if (!isLeftMarker(marker.jointId)) continue;
    next = mirrorMarkerAcrossSagittal(next, marker.jointId);
  }
  return next;
}

export interface AutorigMarkerIssue {
  code: 'missing' | 'crossed' | 'ordering' | 'asymmetric';
  message: string;
  jointIds?: HumanJointId[];
}

function getPos(map: Map<HumanJointId, AutorigMarker>, id: HumanJointId): Vec3 | undefined {
  return map.get(id)?.position;
}

/** Validate marker anatomy for crossed limbs / impossible ordering. */
export function validateAutorigMarkers(
  markers: readonly AutorigMarker[],
  mode: AutorigMarkerMode = 'full',
): AutorigMarkerIssue[] {
  const map = markersToMap(markers);
  const issues: AutorigMarkerIssue[] = [];
  const required = markerJointsForMode(mode);
  for (const jointId of required) {
    if (!map.has(jointId)) {
      issues.push({
        code: 'missing',
        message: `Missing ${HUMAN_JOINT_LABELS[jointId]} marker.`,
        jointIds: [jointId],
      });
    }
  }

  const hips = getPos(map, 'hips');
  const head = getPos(map, 'head');
  if (hips && head && head[1] <= hips[1]) {
    issues.push({
      code: 'ordering',
      message: 'Head marker must be above the pelvis.',
      jointIds: ['head', 'hips'],
    });
  }

  const checkArm = (side: 'left' | 'right') => {
    const shoulder = getPos(map, `${side}UpperArm` as HumanJointId);
    const elbow = getPos(map, `${side}LowerArm` as HumanJointId);
    const wrist = getPos(map, `${side}Hand` as HumanJointId);
    if (shoulder && elbow && wrist) {
      const se = Math.hypot(elbow[0] - shoulder[0], elbow[1] - shoulder[1], elbow[2] - shoulder[2]);
      const ew = Math.hypot(wrist[0] - elbow[0], wrist[1] - elbow[1], wrist[2] - elbow[2]);
      if (se < 0.05 || ew < 0.05) {
        issues.push({
          code: 'ordering',
          message: `${side === 'left' ? 'Left' : 'Right'} arm markers are too close together.`,
          jointIds: [
            `${side}UpperArm` as HumanJointId,
            `${side}LowerArm` as HumanJointId,
            `${side}Hand` as HumanJointId,
          ],
        });
      }
    }
    if (elbow && wrist && hips) {
      // Wrist should generally be farther from midline than shoulder for A/T pose,
      // but only warn when clearly crossed past the opposite side.
      if (side === 'left' && wrist[0] < -0.05 && elbow[0] < -0.05) {
        issues.push({
          code: 'crossed',
          message: 'Left arm markers appear on the right side of the body.',
          jointIds: ['leftLowerArm', 'leftHand'],
        });
      }
      if (side === 'right' && wrist[0] > 0.05 && elbow[0] > 0.05) {
        issues.push({
          code: 'crossed',
          message: 'Right arm markers appear on the left side of the body.',
          jointIds: ['rightLowerArm', 'rightHand'],
        });
      }
    }
  };
  checkArm('left');
  checkArm('right');

  const checkLeg = (side: 'left' | 'right') => {
    const knee = getPos(map, `${side}LowerLeg` as HumanJointId);
    const ankle = getPos(map, `${side}Foot` as HumanJointId);
    if (knee && hips && knee[1] >= hips[1]) {
      issues.push({
        code: 'ordering',
        message: `${side === 'left' ? 'Left' : 'Right'} knee must be below the pelvis.`,
        jointIds: [`${side}LowerLeg` as HumanJointId, 'hips'],
      });
    }
    if (knee && ankle && ankle[1] > knee[1]) {
      issues.push({
        code: 'ordering',
        message: `${side === 'left' ? 'Left' : 'Right'} ankle must be below the knee.`,
        jointIds: [`${side}LowerLeg` as HumanJointId, `${side}Foot` as HumanJointId],
      });
    }
    if (knee && side === 'left' && knee[0] < -0.02) {
      issues.push({
        code: 'crossed',
        message: 'Left knee marker appears on the right side.',
        jointIds: ['leftLowerLeg'],
      });
    }
    if (knee && side === 'right' && knee[0] > 0.02) {
      issues.push({
        code: 'crossed',
        message: 'Right knee marker appears on the left side.',
        jointIds: ['rightLowerLeg'],
      });
    }
  };
  checkLeg('left');
  checkLeg('right');

  return issues;
}

/**
 * Infer missing joints (spine/chest/neck/shoulders/ankles/upper legs) from placed markers.
 * Returns a complete marker map suitable for skeleton fitting.
 */
export function completeAutorigMarkers(
  markers: readonly AutorigMarker[],
  mode: AutorigMarkerMode = 'full',
): AutorigMarker[] {
  let next = [...markers];
  const map = () => markersToMap(next);
  const ensure = (jointId: HumanJointId, position: Vec3) => {
    if (!map().has(jointId)) next = upsertMarker(next, jointId, position);
  };

  const hips = map().get('hips')?.position;
  const head = map().get('head')?.position;
  if (hips && head) {
    ensure('spine', [
      hips[0] * 0.7 + head[0] * 0.3,
      hips[1] + (head[1] - hips[1]) * 0.25,
      hips[2] * 0.7 + head[2] * 0.3,
    ]);
    ensure('chest', [
      hips[0] * 0.35 + head[0] * 0.65,
      hips[1] + (head[1] - hips[1]) * 0.55,
      hips[2] * 0.35 + head[2] * 0.65,
    ]);
    ensure('neck', [
      hips[0] * 0.15 + head[0] * 0.85,
      hips[1] + (head[1] - hips[1]) * 0.82,
      hips[2] * 0.15 + head[2] * 0.85,
    ]);
  }

  if (mode === 'simple' && hips) {
    const leftElbow = map().get('leftLowerArm')?.position;
    const rightElbow = map().get('rightLowerArm')?.position;
    const chestY = map().get('chest')?.position[1] ?? hips[1] + 0.3;
    if (leftElbow) {
      ensure('leftUpperArm', [
        leftElbow[0] * 0.55,
        chestY,
        leftElbow[2] * 0.4,
      ]);
    }
    if (rightElbow) {
      ensure('rightUpperArm', [
        rightElbow[0] * 0.55,
        chestY,
        rightElbow[2] * 0.4,
      ]);
    }
    const leftKnee = map().get('leftLowerLeg')?.position;
    const rightKnee = map().get('rightLowerLeg')?.position;
    if (leftKnee) {
      ensure('leftFoot', [leftKnee[0] * 0.9, Math.min(leftKnee[1] * 0.15, leftKnee[1] - 0.2), leftKnee[2] + 0.04]);
      ensure('leftUpperLeg', [
        (hips[0] + leftKnee[0]) / 2,
        (hips[1] + leftKnee[1]) / 2,
        (hips[2] + leftKnee[2]) / 2,
      ]);
    }
    if (rightKnee) {
      ensure('rightFoot', [rightKnee[0] * 0.9, Math.min(rightKnee[1] * 0.15, rightKnee[1] - 0.2), rightKnee[2] + 0.04]);
      ensure('rightUpperLeg', [
        (hips[0] + rightKnee[0]) / 2,
        (hips[1] + rightKnee[1]) / 2,
        (hips[2] + rightKnee[2]) / 2,
      ]);
    }
  }

  // Upper legs from hips→knees when still missing.
  for (const side of ['left', 'right'] as const) {
    const knee = map().get(`${side}LowerLeg` as HumanJointId)?.position;
    if (hips && knee) {
      ensure(`${side}UpperLeg` as HumanJointId, [
        (hips[0] + knee[0]) / 2,
        (hips[1] + knee[1]) / 2,
        (hips[2] + knee[2]) / 2,
      ]);
    }
  }

  return next;
}

function lookRotation(from: Vec3, to: Vec3, up: Vec3 = [0, 1, 0]): number[] {
  // Column-major 4x4: translate to `from`, rotate so +Y aims toward `to` (bone length axis).
  const fx = to[0] - from[0];
  const fy = to[1] - from[1];
  const fz = to[2] - from[2];
  const len = Math.hypot(fx, fy, fz) || 1;
  const y = [fx / len, fy / len, fz / len];
  // x = normalize(cross(up, y)); if parallel, pick another up
  let ux = up[0];
  let uy = up[1];
  let uz = up[2];
  if (Math.abs(y[0] * ux + y[1] * uy + y[2] * uz) > 0.99) {
    ux = 1; uy = 0; uz = 0;
  }
  let x = [
    uy * y[2] - uz * y[1],
    uz * y[0] - ux * y[2],
    ux * y[1] - uy * y[0],
  ];
  const xLen = Math.hypot(x[0], x[1], x[2]) || 1;
  x = [x[0] / xLen, x[1] / xLen, x[2] / xLen];
  const z = [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  // Column-major
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    from[0], from[1], from[2], 1,
  ];
}

export interface FittedPoseableSkeleton {
  markers: AutorigMarker[];
  /** World/bind matrices keyed by semantic joint (column-major 16). */
  bindMatrices: Partial<Record<HumanJointId, number[]>>;
  /** Child joint positions used for bone visualization. */
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
}

/**
 * Fit the canonical semantic skeleton to completed marker positions.
 * Produces bind matrices without deforming the mesh (display-only until 2C).
 */
export function fitSkeletonFromMarkers(
  markers: readonly AutorigMarker[],
  mode: AutorigMarkerMode = 'full',
): FittedPoseableSkeleton {
  const completed = completeAutorigMarkers(markers, mode);
  const map = markersToMap(completed);
  const jointPositions: Partial<Record<HumanJointId, Vec3>> = {};
  for (const marker of completed) {
    jointPositions[marker.jointId] = [...marker.position] as Vec3;
  }

  // Prefer child joint as bone tip when available.
  const childOf: Partial<Record<HumanJointId, HumanJointId>> = {};
  for (const [child, parent] of Object.entries(HUMAN_JOINT_PARENT) as Array<[HumanJointId, HumanJointId]>) {
    if (!childOf[parent]) childOf[parent] = child;
  }
  // Prefer more specific tips for chains.
  childOf.hips = 'spine';
  childOf.spine = 'chest';
  childOf.chest = 'neck';
  childOf.neck = 'head';
  childOf.leftUpperArm = 'leftLowerArm';
  childOf.leftLowerArm = 'leftHand';
  childOf.rightUpperArm = 'rightLowerArm';
  childOf.rightLowerArm = 'rightHand';
  childOf.leftUpperLeg = 'leftLowerLeg';
  childOf.leftLowerLeg = 'leftFoot';
  childOf.rightUpperLeg = 'rightLowerLeg';
  childOf.rightLowerLeg = 'rightFoot';

  const bindMatrices: Partial<Record<HumanJointId, number[]>> = {};
  for (const jointId of HUMAN_JOINT_IDS) {
    const from = jointPositions[jointId];
    if (!from) continue;
    const tipId = childOf[jointId];
    const tip = tipId ? jointPositions[tipId] : undefined;
    const to: Vec3 = tip ?? [from[0], from[1] + 0.08, from[2]];
    bindMatrices[jointId] = lookRotation(from, to);
  }

  return { markers: completed, bindMatrices, jointPositions };
}

export function applyFittedSkeletonToRig(
  rig: PoseableRigAsset,
  fitted: FittedPoseableSkeleton,
): PoseableRigAsset {
  return {
    ...rig,
    markers: fitted.markers,
    bindMatrices: fitted.bindMatrices,
    skeletonJoints: [...HUMAN_JOINT_IDS],
    rigGenerationVersion: Math.max(1, (rig.rigGenerationVersion ?? 0) + 1),
  };
}
