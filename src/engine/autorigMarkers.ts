import * as THREE from 'three';
import type { AutorigMarker, HumanJointId, PoseableRigAsset, Vec3 } from '../domain/types';
import { createId } from '../utils/ids';
import { HUMAN_JOINT_PARENT } from './humanoidSkeleton';
import { HUMAN_JOINT_IDS, HUMAN_JOINT_LABELS } from './humanPose';
import { CURRENT_AUTORIG_RIG_GENERATION_VERSION } from './poseableRigNormalize';

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

/**
 * Joints whose semantic pose deltas are expressed in the fitted joint frame
 * (arm chains). All other joints use character-space deltas (see fitSkeletonFromMarkers).
 */
export const AUTORIG_LOCAL_DELTA_JOINTS: ReadonlySet<HumanJointId> = new Set<HumanJointId>([
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
]);

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

/** Drop null/undefined/malformed entries so UI/load never crash on `.jointId`. */
export function isValidAutorigMarker(value: unknown): value is AutorigMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<AutorigMarker>;
  if (typeof marker.jointId !== 'string') return false;
  if (!(HUMAN_JOINT_IDS as readonly string[]).includes(marker.jointId)) return false;
  if (!Array.isArray(marker.position) || marker.position.length < 3) return false;
  const x = Number(marker.position[0]);
  const y = Number(marker.position[1]);
  const z = Number(marker.position[2]);
  return [x, y, z].every(Number.isFinite);
}

export function sanitizeAutorigMarkers(
  markers: readonly unknown[] | null | undefined,
): AutorigMarker[] {
  if (!Array.isArray(markers)) return [];
  const out: AutorigMarker[] = [];
  for (const value of markers) {
    if (!isValidAutorigMarker(value)) continue;
    out.push({
      id: typeof value.id === 'string' && value.id ? value.id : createId(`marker_${value.jointId}`),
      jointId: value.jointId,
      position: [
        Number(value.position[0]),
        Number(value.position[1]),
        Number(value.position[2]),
      ] as Vec3,
    });
  }
  return out;
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

export interface AutorigMarkerDepthResult {
  markers: AutorigMarker[];
  centeredJointIds: HumanJointId[];
  /** True when the inferred marker set contains meaningful out-of-plane spread. */
  meaningfulDepth: boolean;
}

/** Guard used before baking weights; a mostly-flat marker set is not a valid bind. */
export function areAutorigMarkersSuspiciouslyPlanar(
  markers: readonly AutorigMarker[],
  toleranceMeters = 0.015,
): boolean {
  const safe = sanitizeAutorigMarkers(markers);
  if (safe.length < 6) return false;
  const depths = safe.map((marker) => marker.position[2]);
  const spread = Math.max(...depths) - Math.min(...depths);
  if (spread < Math.max(0.08, toleranceMeters * 4)) return true;
  const meaningful = safe.filter((marker) => Math.abs(marker.position[2]) > toleranceMeters).length;
  return meaningful / safe.length <= 0.5;
}

/**
 * Center markers through the canonical mesh thickness. Front uses X/Y and
 * infers Z; side uses Z/Y and infers X. A marker with no surface at its
 * projected location is left untouched so stylized or incomplete meshes can
 * still be corrected manually.
 */
export function centerAutorigMarkersDepth(
  markers: readonly AutorigMarker[],
  canonicalMesh: THREE.Object3D,
  view: 'front' | 'side' = 'front',
  /** Restrict raycasts to one marker (cheap per-drag-end recentering). */
  onlyJointId?: HumanJointId,
): AutorigMarkerDepthResult {
  const safeMarkers = sanitizeAutorigMarkers(markers);
  canonicalMesh.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(canonicalMesh);
  const meshes: THREE.Object3D[] = [];
  const meshBounds: THREE.Box3[] = [];
  canonicalMesh.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      mesh.updateMatrixWorld(true);
      meshes.push(mesh);
      meshBounds.push(new THREE.Box3().setFromObject(mesh));
    }
  });
  const raycaster = new THREE.Raycaster();
  const centeredJointIds: HumanJointId[] = [];
  const frontView = view === 'front';
  const next = safeMarkers.map((marker) => {
    if (onlyJointId && marker.jointId !== onlyJointId) return marker;
    const position = new THREE.Vector3(...marker.position);
    const padding = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.05, 0.05);
    const origin = frontView
      ? new THREE.Vector3(position.x, position.y, bounds.max.z + padding)
      : new THREE.Vector3(bounds.min.x - padding, position.y, position.z);
    const direction = frontView ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(1, 0, 0);
    raycaster.set(origin, direction);
    let hits = raycaster.intersectObjects(meshes, true);
    let depths = hits.map((hit) => (frontView ? hit.point.z : hit.point.x)).filter(Number.isFinite);
    if (depths.length < 2) {
      const boundsDepths: number[] = [];
      for (const meshBox of meshBounds) {
        const inProjectedColumn = (frontView
          ? position.x >= meshBox.min.x && position.x <= meshBox.max.x
          : position.z >= meshBox.min.z && position.z <= meshBox.max.z);
        if (inProjectedColumn
          && position.y >= meshBox.min.y && position.y <= meshBox.max.y) {
          boundsDepths.push(frontView ? meshBox.min.z : meshBox.min.x, frontView ? meshBox.max.z : meshBox.max.x);
        }
      }
      if (boundsDepths.length >= 2) depths = boundsDepths;
    }
    if (depths.length < 2) return marker;
    centeredJointIds.push(marker.jointId);
    const midpoint = (Math.min(...depths) + Math.max(...depths)) * 0.5;
    return { ...marker, position: frontView
      ? [marker.position[0], marker.position[1], midpoint] as Vec3
      : [midpoint, marker.position[1], marker.position[2]] as Vec3 };
  });
  const depthValues = next.map((marker) => marker.position[2]);
  const meaningfulDepth = Math.max(...depthValues) - Math.min(...depthValues) > 0.02;
  return { markers: next, centeredJointIds, meaningfulDepth };
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
  for (const marker of sanitizeAutorigMarkers(markers)) map.set(marker.jointId, marker);
  return map;
}

export function upsertMarker(
  markers: readonly AutorigMarker[],
  jointId: HumanJointId,
  position: Vec3,
): AutorigMarker[] {
  const safe = sanitizeAutorigMarkers(markers);
  const existing = safe.find((marker) => marker.jointId === jointId);
  if (existing) {
    return safe.map((marker) => (
      marker.jointId === jointId ? { ...marker, position: [...position] as Vec3 } : marker
    ));
  }
  return [...safe, { id: createId(`marker_${jointId}`), jointId, position: [...position] as Vec3 }];
}

export function mirrorMarkerAcrossSagittal(
  markers: readonly AutorigMarker[],
  jointId: HumanJointId,
): AutorigMarker[] {
  const safe = sanitizeAutorigMarkers(markers);
  const source = safe.find((marker) => marker.jointId === jointId);
  const mirrorId = AUTORIG_MARKER_MIRROR[jointId];
  if (!source || !mirrorId) return safe;
  const mirrored: Vec3 = [-source.position[0], source.position[1], source.position[2]];
  return upsertMarker(safe, mirrorId, mirrored);
}

export function mirrorAllMarkers(markers: readonly AutorigMarker[]): AutorigMarker[] {
  const safe = sanitizeAutorigMarkers(markers);
  let next = [...safe];
  for (const marker of safe) {
    if (!isLeftMarker(marker.jointId)) continue;
    next = mirrorMarkerAcrossSagittal(next, marker.jointId);
  }
  return next;
}

export interface AutorigMarkerIssue {
  code: 'missing' | 'crossed' | 'ordering' | 'asymmetric' | 'planar';
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
  const safe = sanitizeAutorigMarkers(markers);
  const map = markersToMap(safe);
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
  if (required.every((jointId) => map.has(jointId)) && areAutorigMarkersSuspiciouslyPlanar(safe)) {
    issues.push({
      code: 'planar',
      message: 'Most joints are nearly planar. Center depth or refine the Side view before generating weights.',
    });
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
  let next = sanitizeAutorigMarkers(markers);
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

export function canonicalJointFrame(from: Vec3, to: Vec3, forward: Vec3 = [0, 0, 1]): THREE.Matrix4 {
  // Canonical frame: +Y follows the bone, +Z follows character front, +X is
  // the resulting lateral axis. If front is nearly parallel, use world +X.
  const fx = to[0] - from[0];
  const fy = to[1] - from[1];
  const fz = to[2] - from[2];
  const len = Math.hypot(fx, fy, fz) || 1;
  const y = new THREE.Vector3(fx / len, fy / len, fz / len);
  const z = new THREE.Vector3(...forward).normalize();
  if (Math.abs(y.dot(z)) > 0.98) z.set(1, 0, 0);
  z.addScaledVector(y, -y.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(from[0], from[1], from[2]);
}

export interface FittedPoseableSkeleton {
  markers: AutorigMarker[];
  /** World/bind matrices keyed by semantic joint (column-major 16). */
  bindMatrices: Partial<Record<HumanJointId, number[]>>;
  canonicalPoseBases: Partial<Record<HumanJointId, number[]>>;
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
  const completed = completeAutorigMarkers(sanitizeAutorigMarkers(markers), mode);
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
  const canonicalPoseBases: Partial<Record<HumanJointId, number[]>> = {};
  for (const jointId of HUMAN_JOINT_IDS) {
    const from = jointPositions[jointId];
    if (!from) continue;
    const tipId = childOf[jointId];
    const tip = tipId ? jointPositions[tipId] : undefined;
    const to: Vec3 = tip ?? [from[0], from[1] + 0.08, from[2]];
    const frame = canonicalJointFrame(from, to);
    bindMatrices[jointId] = frame.toArray();
    // Retarget basis for semantic pose deltas (see applySemanticPoseToBones):
    // - Arm chains: identity, so deltas apply in the fitted joint frame whose X axis
    //   is the anatomical flexion axis (bone × forward). Elbows/wrists curl forward
    //   and shoulders flex forward regardless of T- or A-pose arm direction.
    // - Torso + legs: the bind world rotation, so deltas apply as character-space
    //   rotations (X = lateral, Z = forward). Knees flex backward, hips hinge forward,
    //   and left/right spread mirrors across the sagittal plane.
    canonicalPoseBases[jointId] = AUTORIG_LOCAL_DELTA_JOINTS.has(jointId)
      ? [0, 0, 0, 1]
      : new THREE.Quaternion().setFromRotationMatrix(frame).toArray();
  }

  return { markers: completed, bindMatrices, canonicalPoseBases, jointPositions };
}

export function applyFittedSkeletonToRig(
  rig: PoseableRigAsset,
  fitted: FittedPoseableSkeleton,
): PoseableRigAsset {
  return {
    ...rig,
    markers: fitted.markers,
    bindMatrices: fitted.bindMatrices,
    canonicalPoseBases: fitted.canonicalPoseBases,
    skeletonJoints: [...HUMAN_JOINT_IDS],
    rigGenerationVersion: Math.max(CURRENT_AUTORIG_RIG_GENERATION_VERSION, (rig.rigGenerationVersion ?? 0) + 1),
    requiresRerigging: false,
  };
}
