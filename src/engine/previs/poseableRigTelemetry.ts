import * as THREE from 'three';
import type {
  AssetRegistry,
  HumanJointId,
  SceneObject,
  Vec3,
} from '../../domain/types';
import { HUMAN_JOINT_IDS } from '../humanPose';
import {
  getPoseableCharacterInstance,
  resolvePoseableCharacterForObject,
} from '../poseableCharacter';
import { resolvePoseableRigForObject } from '../poseableRigPackage';
import type { HumanLandmark } from './framingProfiles';

export type RigTelemetryLandmarkSource = 'evaluated_joint' | 'rig_marker' | 'persisted_anchor' | 'bounds_fallback';

export type RigTelemetryPositionKey = HumanJointId | HumanLandmark;

export interface PoseableRigTelemetry {
  /** Current world-space semantic joints plus derived framing landmarks. */
  positions: Partial<Record<RigTelemetryPositionKey, Vec3>>;
  source: Exclude<RigTelemetryLandmarkSource, 'bounds_fallback'>;
  confidence: number;
  /** A derived hand position is an attachment/reference anchor, not geometry. */
  attachmentJoints?: HumanJointId[];
}

interface RawRigPositions {
  positions: Partial<Record<HumanJointId, Vec3>>;
  markerCount: number;
  bindCount: number;
}

function finiteVec3(value: unknown): value is Vec3 {
  return Array.isArray(value)
    && value.length >= 3
    && value.slice(0, 3).every((entry) => Number.isFinite(Number(entry)));
}

function cloneVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function multiply(a: Vec3, scalar: number): Vec3 {
  return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

function length(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function average(values: Vec3[]): Vec3 | undefined {
  if (values.length === 0) return undefined;
  return multiply(values.reduce((sum, value) => add(sum, value), [0, 0, 0]), 1 / values.length);
}

function objectLocalToWorld(object: SceneObject, local: Vec3): Vec3 {
  const point = new THREE.Vector3(
    local[0] * object.transform.scale[0],
    local[1] * object.transform.scale[1],
    local[2] * object.transform.scale[2],
  );
  point.applyEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(object.transform.rotation[0]),
    THREE.MathUtils.degToRad(object.transform.rotation[1]),
    THREE.MathUtils.degToRad(object.transform.rotation[2]),
    'XYZ',
  ));
  point.add(new THREE.Vector3(...object.transform.position));
  return [point.x, point.y, point.z];
}

function usablePositions(positions: Partial<Record<HumanJointId, Vec3>>): boolean {
  const count = Object.keys(positions).length;
  return count >= 2 && Boolean(
    positions.hips
    || positions.spine
    || positions.chest
    || positions.neck
    || positions.head
    || positions.leftFoot
    || positions.rightFoot,
  );
}

function evaluatedJointPositions(object: SceneObject): Partial<Record<HumanJointId, Vec3>> | undefined {
  const registered = getPoseableCharacterInstance(object.id);
  if (!registered) return undefined;
  try {
    registered.character.bindInstance(registered.instance);
    registered.instance.updateMatrixWorld(true);
    const positions: Partial<Record<HumanJointId, Vec3>> = {};
    for (const joint of registered.character.getJoints(registered.instance)) {
      const point = joint.node.getWorldPosition(new THREE.Vector3());
      const value: Vec3 = [point.x, point.y, point.z];
      if (finiteVec3(value)) positions[joint.id] = value;
    }
    return usablePositions(positions) ? positions : undefined;
  } catch {
    return undefined;
  }
}

function rigPositions(rig: NonNullable<ReturnType<typeof resolvePoseableRigForObject>>['rig']): RawRigPositions {
  const positions: Partial<Record<HumanJointId, Vec3>> = {};
  let markerCount = 0;
  let bindCount = 0;
  for (const marker of rig.markers ?? []) {
    if (!marker || !HUMAN_JOINT_IDS.includes(marker.jointId) || !finiteVec3(marker.position)) continue;
    positions[marker.jointId] = [Number(marker.position[0]), Number(marker.position[1]), Number(marker.position[2])];
    markerCount += 1;
  }
  for (const jointId of HUMAN_JOINT_IDS) {
    if (positions[jointId]) continue;
    const matrix = rig.bindMatrices?.[jointId];
    if (!Array.isArray(matrix) || matrix.length < 16) continue;
    const point = [Number(matrix[12]), Number(matrix[13]), Number(matrix[14])] as Vec3;
    if (!finiteVec3(point)) continue;
    positions[jointId] = point;
    bindCount += 1;
  }
  return { positions, markerCount, bindCount };
}

function persistedAnchorPositions(object: SceneObject): Partial<Record<RigTelemetryPositionKey, Vec3>> | undefined {
  const metadata = object.metadata?.humanoidTelemetry;
  if (!metadata || typeof metadata !== 'object' || (metadata as { jointsReliable?: unknown }).jointsReliable !== true) {
    return undefined;
  }
  const raw = (metadata as { reliableJointPositions?: unknown }).reliableJointPositions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const positions: Partial<Record<RigTelemetryPositionKey, Vec3>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!finiteVec3(value) || ![...HUMAN_JOINT_IDS, 'feet', 'knees', 'waist', 'chest', 'shoulders', 'chin', 'eyes', 'headTop'].includes(key)) continue;
    positions[key as RigTelemetryPositionKey] = objectLocalToWorld(object, [
      Number(value[0]),
      Number(value[1]),
      Number(value[2]),
    ]);
  }
  return Object.keys(positions).length > 0 ? positions : undefined;
}

function deriveLandmarks(
  source: Partial<Record<HumanJointId, Vec3>>,
  initial: Partial<Record<RigTelemetryPositionKey, Vec3>> = {},
): { positions: Partial<Record<RigTelemetryPositionKey, Vec3>>; attachmentJoints: HumanJointId[] } {
  const positions: Partial<Record<RigTelemetryPositionKey, Vec3>> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value) positions[key as HumanJointId] = cloneVec3(value);
  }
  for (const [key, value] of Object.entries(initial)) {
    if (value) positions[key as RigTelemetryPositionKey] = cloneVec3(value);
  }

  const hips = source.hips;
  const neck = source.neck;
  const head = source.head ?? neck;
  const headAxis = head && neck ? subtract(head, neck) : undefined;
  const headLength = headAxis ? length(headAxis) : 0;
  const headDirection = headAxis && headLength > 1e-6 ? multiply(headAxis, 1 / headLength) : undefined;
  const set = (key: HumanLandmark, value: Vec3 | undefined) => {
    if (!positions[key] && value) positions[key] = value;
  };

  set('feet', average([source.leftFoot, source.rightFoot].filter((value): value is Vec3 => Boolean(value))));
  set('knees', average([source.leftUpperLeg, source.rightUpperLeg].filter((value): value is Vec3 => Boolean(value))));
  set('waist', hips);
  set('chest', source.chest ?? source.upperSpine ?? source.spine ?? hips);
  set('shoulders', average([
    source.leftClavicle,
    source.rightClavicle,
    source.leftUpperArm,
    source.rightUpperArm,
  ].filter((value): value is Vec3 => Boolean(value))) ?? source.chest ?? source.upperSpine);
  set('chin', head && headDirection ? add(head, multiply(headDirection, -Math.max(0.08, headLength * 0.35))) : head);
  set('eyes', head && headDirection ? add(head, multiply(headDirection, Math.max(0.04, headLength * 0.22))) : head);
  set('headTop', head && headDirection ? add(head, multiply(headDirection, Math.max(0.12, headLength * 0.75))) : head);

  const attachmentJoints: HumanJointId[] = [];
  for (const side of ['left', 'right'] as const) {
    const hand = `${side}Hand` as HumanJointId;
    const lowerArm = `${side}LowerArm` as HumanJointId;
    const upperArm = `${side}UpperArm` as HumanJointId;
    if (source[hand]) continue;
    const lower = source[lowerArm];
    if (!lower) continue;
    const upper = source[upperArm];
    positions[hand] = upper ? add(lower, multiply(subtract(lower, upper), 0.25)) : cloneVec3(lower);
    attachmentJoints.push(hand);
  }

  return { positions, attachmentJoints };
}

export function resolvePoseableHumanoidTelemetry(params: {
  object: SceneObject;
  assets: AssetRegistry;
}): PoseableRigTelemetry | undefined {
  const source = params.object.poseableCharacter?.kind;
  if (source !== 'autorigged' && source !== 'importedRig') return undefined;

  const evaluated = evaluatedJointPositions(params.object);
  if (evaluated) {
    const derived = deriveLandmarks(evaluated);
    return {
      positions: derived.positions,
      source: 'evaluated_joint',
      confidence: 1,
      ...(derived.attachmentJoints.length > 0 ? { attachmentJoints: derived.attachmentJoints } : {}),
    };
  }

  const resolvedRig = resolvePoseableRigForObject(params.object, params.assets);
  if (resolvedRig) {
    const raw = rigPositions(resolvedRig.rig);
    if (usablePositions(raw.positions)) {
      const world = Object.fromEntries(
        Object.entries(raw.positions).map(([key, value]) => [key, objectLocalToWorld(params.object, value!)]),
      ) as Partial<Record<HumanJointId, Vec3>>;
      const derived = deriveLandmarks(world);
      return {
        positions: derived.positions,
        source: 'rig_marker',
        confidence: raw.markerCount > 0 ? 0.9 : 0.75,
        ...(derived.attachmentJoints.length > 0 ? { attachmentJoints: derived.attachmentJoints } : {}),
      };
    }
  }

  const persisted = persistedAnchorPositions(params.object);
  if (!persisted) return undefined;
  const semantic = Object.fromEntries(
    Object.entries(persisted).filter(([key]) => HUMAN_JOINT_IDS.includes(key as HumanJointId)),
  ) as Partial<Record<HumanJointId, Vec3>>;
  const derived = deriveLandmarks(semantic, persisted);
  return {
    positions: derived.positions,
    source: 'persisted_anchor',
    confidence: 0.7,
    ...(derived.attachmentJoints.length > 0 ? { attachmentJoints: derived.attachmentJoints } : {}),
  };
}
