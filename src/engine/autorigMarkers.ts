import * as THREE from 'three';
import type { AutorigMarker, HumanJointId, PoseableRigAsset, Vec3 } from '../domain/types';
import { createId } from '../utils/ids';
import { HUMAN_JOINT_PARENT } from './humanoidSkeleton';
import { HUMAN_JOINT_IDS, HUMAN_JOINT_LABELS } from './humanPose';
import { CURRENT_AUTORIG_RIG_GENERATION_VERSION } from './poseableRigNormalize';

/** Placement markers required for full guided autorig (includes editable hip sockets). */
export const AUTORIG_REQUIRED_MARKER_JOINTS = [
  'head',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'hips',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
  'leftFoot',
  'rightFoot',
  // Neck/spine/chest + hand/toe tips are inferred.
] as const satisfies readonly HumanJointId[];

/** Simplified mode (~9): shoulders, hip sockets, and ankles are inferred. */
export const AUTORIG_SIMPLE_MARKER_JOINTS = [
  'head',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'hips',
  'leftLowerLeg',
  'rightLowerLeg',
  // shoulders / hip sockets / ankles / terminals inferred
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
  'leftHandEnd',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'rightHandEnd',
]);

export const AUTORIG_MARKER_MIRROR: Partial<Record<HumanJointId, HumanJointId>> = {
  leftUpperArm: 'rightUpperArm',
  rightUpperArm: 'leftUpperArm',
  leftLowerArm: 'rightLowerArm',
  rightLowerArm: 'leftLowerArm',
  leftHand: 'rightHand',
  rightHand: 'leftHand',
  leftHandEnd: 'rightHandEnd',
  rightHandEnd: 'leftHandEnd',
  leftLowerLeg: 'rightLowerLeg',
  rightLowerLeg: 'leftLowerLeg',
  leftFoot: 'rightFoot',
  rightFoot: 'leftFoot',
  leftToeBase: 'rightToeBase',
  rightToeBase: 'leftToeBase',
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
  /** Rest pose of the source mesh; scales arm lateral reach (T wider, A lower). */
  poseHint?: 'a-pose' | 't-pose';
}

export interface AutorigMarkerDepthResult {
  markers: AutorigMarker[];
  centeredJointIds: HumanJointId[];
  /** True when the inferred marker set contains meaningful out-of-plane spread. */
  meaningfulDepth: boolean;
}

/**
 * Soft diagnostic: many joints share nearly the same Z.
 * Does **not** block validation or weight generation — a symmetric T-pose can
 * legitimately be near-planar; quality is judged by local joint placement.
 */
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

/** Hip socket Y slightly below the pelvis marker. */
export function hipSocketY(hipsY: number, heightMeters: number): number {
  return hipsY - Math.max(heightMeters * 0.015, 0.02);
}

/** Lateral hip socket from pelvis + optional knee guidance (not mid-thigh). */
export function hipSocketPosition(params: {
  side: 'left' | 'right';
  hips: Vec3;
  knee?: Vec3;
  widthMeters: number;
  heightMeters: number;
}): Vec3 {
  const sign = params.side === 'left' ? 1 : -1;
  const fromKnee = params.knee ? Math.abs(params.knee[0]) * 0.85 : 0;
  const lateral = Math.max(fromKnee, params.widthMeters * 0.1, params.heightMeters * 0.045);
  const y = hipSocketY(params.hips[1], params.heightMeters);
  const z = params.knee
    ? params.hips[2] * 0.85 + params.knee[2] * 0.15
    : params.hips[2];
  return [sign * lateral, y, z];
}

/** Palm tip continuing the forearm axis past the wrist. */
export function handEndFromArm(wrist: Vec3, elbow: Vec3, heightMeters: number): Vec3 {
  const dx = wrist[0] - elbow[0];
  const dy = wrist[1] - elbow[1];
  const dz = wrist[2] - elbow[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const palm = Math.max(heightMeters * 0.075, 0.06);
  return [wrist[0] + (dx / len) * palm, wrist[1] + (dy / len) * palm, wrist[2] + (dz / len) * palm];
}

/** Toe base forward of the ankle along character +Z (slightly down). */
export function toeBaseFromFoot(ankle: Vec3, heightMeters: number): Vec3 {
  const footLen = Math.max(heightMeters * 0.08, 0.07);
  return [ankle[0], ankle[1] - heightMeters * 0.012, ankle[2] + footLen];
}

/**
 * Center markers through local mesh thickness via bidirectional rays.
 * Front: edits Z from front+back surface hits. Side: edits X from left+right hits.
 * Uses the nearest surface from each direction (not min/max of every multi-mesh hit).
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
  const size = bounds.getSize(new THREE.Vector3());
  const padding = Math.max(size.length() * 0.05, 0.05);
  // Lateral acceptance window so clothing/hair far from the joint column is ignored.
  const lateralTol = Math.max(size.x, size.z, 0.2) * 0.12;

  const maxBodySpan = Math.max(size.x, size.z, 0.2);
  const minShell = 0.03;
  // Allow full torso width/depth for side-view hip centering through the body.
  const maxShell = Math.max(maxBodySpan * 1.05, 0.25);

  const next = safeMarkers.map((marker) => {
    if (onlyJointId && marker.jointId !== onlyJointId) return marker;
    const position = new THREE.Vector3(...marker.position);
    const currentDepth = frontView ? position.z : position.x;

    type DepthHit = { depth: number; object: THREE.Object3D };
    const filterHits = (hits: THREE.Intersection[]): DepthHit[] => {
      const out: DepthHit[] = [];
      for (const hit of hits) {
        if (!Number.isFinite(hit.point.x) || !Number.isFinite(hit.point.y) || !Number.isFinite(hit.point.z)) continue;
        if (Math.abs(hit.point.y - position.y) > lateralTol * 2) continue;
        if (frontView) {
          if (Math.abs(hit.point.x - position.x) > lateralTol) continue;
          out.push({ depth: hit.point.z, object: hit.object });
        } else {
          if (Math.abs(hit.point.z - position.z) > lateralTol) continue;
          out.push({ depth: hit.point.x, object: hit.object });
        }
      }
      return out;
    };

    /**
     * Bidirectional per-mesh shells: first hit from each side on the same object.
     * Avoids averaging coat front with torso back across empty space.
     * (Single-direction rays often only hit front faces under default materials.)
     */
    const pickShellMid = (fromA: DepthHit[], fromB: DepthHit[]): number | undefined => {
      const firstA = new Map<THREE.Object3D, number>();
      const firstB = new Map<THREE.Object3D, number>();
      for (const hit of fromA) {
        if (!firstA.has(hit.object)) firstA.set(hit.object, hit.depth);
      }
      for (const hit of fromB) {
        if (!firstB.has(hit.object)) firstB.set(hit.object, hit.depth);
      }
      let bestMid: number | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const [object, depthA] of firstA) {
        const depthB = firstB.get(object);
        if (depthB === undefined) continue;
        const thick = Math.abs(depthA - depthB);
        if (thick < minShell || thick > maxShell) continue;
        const mid = (depthA + depthB) * 0.5;
        // Prefer mid near the current joint and a body-like thickness.
        const score = Math.abs(mid - currentDepth) * 2 + Math.abs(thick - maxBodySpan * 0.3);
        if (score < bestScore) {
          bestScore = score;
          bestMid = mid;
        }
      }
      return bestMid;
    };

    let midpoint: number | undefined;
    if (frontView) {
      raycaster.set(
        new THREE.Vector3(position.x, position.y, bounds.max.z + padding),
        new THREE.Vector3(0, 0, -1),
      );
      const fromFront = filterHits(raycaster.intersectObjects(meshes, true));
      raycaster.set(
        new THREE.Vector3(position.x, position.y, bounds.min.z - padding),
        new THREE.Vector3(0, 0, 1),
      );
      const fromBack = filterHits(raycaster.intersectObjects(meshes, true));
      midpoint = pickShellMid(fromFront, fromBack);
    } else {
      raycaster.set(
        new THREE.Vector3(bounds.min.x - padding, position.y, position.z),
        new THREE.Vector3(1, 0, 0),
      );
      const fromLeft = filterHits(raycaster.intersectObjects(meshes, true));
      raycaster.set(
        new THREE.Vector3(bounds.max.x + padding, position.y, position.z),
        new THREE.Vector3(-1, 0, 0),
      );
      const fromRight = filterHits(raycaster.intersectObjects(meshes, true));
      midpoint = pickShellMid(fromLeft, fromRight);
    }

    // Per-mesh AABB fallback: component whose mid is closest to the joint.
    if (midpoint === undefined) {
      let bestMid: number | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const meshBox of meshBounds) {
        const inColumn = frontView
          ? position.x >= meshBox.min.x - lateralTol && position.x <= meshBox.max.x + lateralTol
          : position.z >= meshBox.min.z - lateralTol && position.z <= meshBox.max.z + lateralTol;
        if (!inColumn) continue;
        if (position.y < meshBox.min.y - lateralTol || position.y > meshBox.max.y + lateralTol) continue;
        const lo = frontView ? meshBox.min.z : meshBox.min.x;
        const hi = frontView ? meshBox.max.z : meshBox.max.x;
        const thick = hi - lo;
        if (thick < minShell || thick > maxShell) continue;
        const mid = (lo + hi) * 0.5;
        const score = Math.abs(mid - currentDepth) + thick * 0.05;
        if (score < bestScore) {
          bestScore = score;
          bestMid = mid;
        }
      }
      midpoint = bestMid;
    }

    if (midpoint === undefined || !Number.isFinite(midpoint)) return marker;
    centeredJointIds.push(marker.jointId);
    return {
      ...marker,
      position: frontView
        ? [marker.position[0], marker.position[1], midpoint] as Vec3
        : [midpoint, marker.position[1], marker.position[2]] as Vec3,
    };
  });
  const depthValues = next.map((marker) => marker.position[2]);
  const meaningfulDepth = depthValues.length > 0
    && Math.max(...depthValues) - Math.min(...depthValues) > 0.02;
  return { markers: next, centeredJointIds, meaningfulDepth };
}

/** Deterministic suggested marker positions from actual mesh size + A/T-pose hint. */
export function suggestAutorigMarkers(context: AutorigMarkerSuggestionContext): AutorigMarker[] {
  const height = Math.max(context.heightMeters, context.size[1], 0.5);
  // Prefer real mesh width/depth — do not collapse to a height×0.45 mannequin.
  const width = Math.max(context.size[0], height * 0.18);
  const depth = Math.max(context.size[2], height * 0.12);
  const ground = context.groundLevelMeters ?? 0;
  const poseHint = context.poseHint ?? 'a-pose';
  const isTPose = poseHint === 't-pose';

  const hipY = ground + height * 0.52;
  const shoulderY = ground + height * (isTPose ? 0.8 : 0.78);
  const headY = ground + height * 0.96;
  const kneeY = ground + height * 0.28;
  const ankleY = ground + height * 0.04;
  // T-pose: arms more horizontal / wider. A-pose: elbows lower, wrists closer to body.
  const shoulderX = width * (isTPose ? 0.24 : 0.2);
  const elbowY = ground + height * (isTPose ? 0.78 : 0.62);
  const wristY = ground + height * (isTPose ? 0.78 : 0.48);
  const elbowX = width * (isTPose ? 0.42 : 0.34);
  const wristX = width * (isTPose ? 0.58 : 0.46);
  const armZ = isTPose ? 0 : depth * 0.04;
  const kneeX = width * 0.1;
  const ankleX = width * 0.09;
  const hipSocket = (side: 'left' | 'right'): Vec3 => hipSocketPosition({
    side,
    hips: [0, hipY, 0],
    knee: [side === 'left' ? kneeX : -kneeX, kneeY, depth * 0.03],
    widthMeters: width,
    heightMeters: height,
  });

  const place = (jointId: HumanJointId, position: Vec3): AutorigMarker => ({
    id: createId(`marker_${jointId}`),
    jointId,
    position,
  });

  const leftHip = hipSocket('left');
  const rightHip = hipSocket('right');
  const leftWrist: Vec3 = [wristX, wristY, armZ + (isTPose ? 0 : 0.02)];
  const rightWrist: Vec3 = [-wristX, wristY, armZ + (isTPose ? 0 : 0.02)];
  const leftElbow: Vec3 = [elbowX, elbowY, armZ];
  const rightElbow: Vec3 = [-elbowX, elbowY, armZ];
  const leftAnkle: Vec3 = [ankleX, ankleY, depth * 0.08];
  const rightAnkle: Vec3 = [-ankleX, ankleY, depth * 0.08];

  return [
    place('head', [0, headY, 0]),
    place('hips', [0, hipY, 0]),
    place('leftUpperArm', [shoulderX, shoulderY, 0]),
    place('rightUpperArm', [-shoulderX, shoulderY, 0]),
    place('leftLowerArm', leftElbow),
    place('rightLowerArm', rightElbow),
    place('leftHand', leftWrist),
    place('rightHand', rightWrist),
    place('leftHandEnd', handEndFromArm(leftWrist, leftElbow, height)),
    place('rightHandEnd', handEndFromArm(rightWrist, rightElbow, height)),
    place('leftUpperLeg', leftHip),
    place('rightUpperLeg', rightHip),
    place('leftLowerLeg', [kneeX, kneeY, depth * 0.03]),
    place('rightLowerLeg', [-kneeX, kneeY, depth * 0.03]),
    place('leftFoot', leftAnkle),
    place('rightFoot', rightAnkle),
    place('leftToeBase', toeBaseFromFoot(leftAnkle, height)),
    place('rightToeBase', toeBaseFromFoot(rightAnkle, height)),
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

/** Validate marker anatomy for crossed limbs / impossible ordering. Planarity is not a hard fail. */
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
  // Near-planar T-pose sets are allowed; do not hard-block on global Z spread.

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
    const hipSocket = getPos(map, `${side}UpperLeg` as HumanJointId);
    const knee = getPos(map, `${side}LowerLeg` as HumanJointId);
    const ankle = getPos(map, `${side}Foot` as HumanJointId);
    if (hipSocket && hips) {
      // Hip socket should be near pelvis height, not mid-thigh.
      if (hipSocket[1] < hips[1] - 0.25) {
        issues.push({
          code: 'ordering',
          message: `${side === 'left' ? 'Left' : 'Right'} hip marker is far below the pelvis (mid-thigh).`,
          jointIds: [`${side}UpperLeg` as HumanJointId, 'hips'],
        });
      }
      if (side === 'left' && hipSocket[0] < 0.02) {
        issues.push({
          code: 'crossed',
          message: 'Left hip marker appears on the right side or midline.',
          jointIds: ['leftUpperLeg'],
        });
      }
      if (side === 'right' && hipSocket[0] > -0.02) {
        issues.push({
          code: 'crossed',
          message: 'Right hip marker appears on the left side or midline.',
          jointIds: ['rightUpperLeg'],
        });
      }
    }
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
 * Infer missing joints (spine/chest/neck/shoulders/hip sockets/terminals) from placed markers.
 * Returns a complete marker map suitable for skeleton fitting.
 */
export function completeAutorigMarkers(
  markers: readonly AutorigMarker[],
  mode: AutorigMarkerMode = 'full',
  options?: { heightMeters?: number; widthMeters?: number },
): AutorigMarker[] {
  let next = sanitizeAutorigMarkers(markers);
  const map = () => markersToMap(next);
  const ensure = (jointId: HumanJointId, position: Vec3) => {
    if (!map().has(jointId)) next = upsertMarker(next, jointId, position);
  };

  const hips = map().get('hips')?.position;
  const head = map().get('head')?.position;
  const height = options?.heightMeters
    ?? (hips && head ? Math.max(head[1] - (hips[1] - 0.5), 1) : 1.75);
  let width = options?.widthMeters ?? 0;
  if (!width) {
    for (const marker of next) {
      width = Math.max(width, Math.abs(marker.position[0]) * 2);
    }
    width = Math.max(width, height * 0.35);
  }

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
    }
    if (rightKnee) {
      ensure('rightFoot', [rightKnee[0] * 0.9, Math.min(rightKnee[1] * 0.15, rightKnee[1] - 0.2), rightKnee[2] + 0.04]);
    }
  }

  // Hip sockets at pelvis height (lateral), never mid-thigh midpoints.
  for (const side of ['left', 'right'] as const) {
    const knee = map().get(`${side}LowerLeg` as HumanJointId)?.position;
    if (hips) {
      ensure(
        `${side}UpperLeg` as HumanJointId,
        hipSocketPosition({
          side,
          hips,
          knee,
          widthMeters: width,
          heightMeters: height,
        }),
      );
    }
  }

  // Hand / toe terminals so palm and foot bones have real axes.
  for (const side of ['left', 'right'] as const) {
    const elbow = map().get(`${side}LowerArm` as HumanJointId)?.position;
    const wrist = map().get(`${side}Hand` as HumanJointId)?.position;
    if (elbow && wrist) {
      ensure(`${side}HandEnd` as HumanJointId, handEndFromArm(wrist, elbow, height));
    }
    const ankle = map().get(`${side}Foot` as HumanJointId)?.position;
    if (ankle) {
      ensure(`${side}ToeBase` as HumanJointId, toeBaseFromFoot(ankle, height));
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
  // Prefer more specific tips for chains (hands→fingers, feet→toes).
  childOf.hips = 'spine';
  childOf.spine = 'chest';
  childOf.chest = 'neck';
  childOf.neck = 'head';
  childOf.leftUpperArm = 'leftLowerArm';
  childOf.leftLowerArm = 'leftHand';
  childOf.leftHand = 'leftHandEnd';
  childOf.rightUpperArm = 'rightLowerArm';
  childOf.rightLowerArm = 'rightHand';
  childOf.rightHand = 'rightHandEnd';
  childOf.leftUpperLeg = 'leftLowerLeg';
  childOf.leftLowerLeg = 'leftFoot';
  childOf.leftFoot = 'leftToeBase';
  childOf.rightUpperLeg = 'rightLowerLeg';
  childOf.rightLowerLeg = 'rightFoot';
  childOf.rightFoot = 'rightToeBase';

  const bindMatrices: Partial<Record<HumanJointId, number[]>> = {};
  const canonicalPoseBases: Partial<Record<HumanJointId, number[]>> = {};
  for (const jointId of HUMAN_JOINT_IDS) {
    const from = jointPositions[jointId];
    if (!from) continue;
    const tipId = childOf[jointId];
    const tip = tipId ? jointPositions[tipId] : undefined;
    // Terminals without children keep a short continuation of their parent axis when possible.
    let to: Vec3 = tip ?? [from[0], from[1] + 0.08, from[2]];
    if (!tip) {
      if (jointId === 'leftHandEnd' || jointId === 'rightHandEnd') {
        const wrist = jointId === 'leftHandEnd' ? jointPositions.leftHand : jointPositions.rightHand;
        if (wrist) to = [from[0] + (from[0] - wrist[0]), from[1] + (from[1] - wrist[1]), from[2] + (from[2] - wrist[2])];
      } else if (jointId === 'leftToeBase' || jointId === 'rightToeBase') {
        to = [from[0], from[1], from[2] + 0.04];
      }
    }
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
