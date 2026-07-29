import type { HumanJointId, PoseableRigAsset, Vec3 } from '../domain/types';
import { HUMAN_JOINT_IDS } from './humanPose';
import { HUMAN_JOINT_PARENT } from './humanoidSkeleton';
import { createId } from '../utils/ids';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { putModelAsset } from './modelAssetStore';
import { CURRENT_AUTORIG_RIG_GENERATION_VERSION } from './poseableRigNormalize';

const INFLUENCES_PER_VERTEX = 4;

export type AutorigBodyRegion =
  | 'head'
  | 'torso'
  | 'leftArm'
  | 'rightArm'
  | 'leftLeg'
  | 'rightLeg';

const REGION_BONES: Record<AutorigBodyRegion, readonly HumanJointId[]> = {
  head: ['neck', 'head'],
  torso: ['hips', 'spine', 'chest'],
  leftArm: ['leftUpperArm', 'leftLowerArm', 'leftHand'],
  rightArm: ['rightUpperArm', 'rightLowerArm', 'rightHand'],
  leftLeg: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'],
  rightLeg: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'],
};

const BONE_REGION: Partial<Record<HumanJointId, AutorigBodyRegion>> = Object.fromEntries(
  (Object.entries(REGION_BONES) as Array<[AutorigBodyRegion, readonly HumanJointId[]]>)
    .flatMap(([region, bones]) => bones.map((bone) => [bone, region])),
);

export interface SkinBoneSegment {
  jointId: HumanJointId;
  jointIndex: number;
  start: Vec3;
  end: Vec3;
  region: AutorigBodyRegion;
}

export interface SkinWeightBuffers {
  influencesPerVertex: number;
  /** Flattened length = vertexCount * influencesPerVertex */
  indices: Uint16Array;
  weights: Float32Array;
  jointOrder: HumanJointId[];
  warnings?: string[];
}

function distancePointToSegment(point: Vec3, start: Vec3, end: Vec3): number {
  const ab: Vec3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const ap: Vec3 = [point[0] - start[0], point[1] - start[1], point[2] - start[2]];
  const abLenSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (abLenSq < 1e-12) {
    return Math.hypot(ap[0], ap[1], ap[2]);
  }
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / abLenSq));
  const closest: Vec3 = [start[0] + ab[0] * t, start[1] + ab[1] * t, start[2] + ab[2] * t];
  return Math.hypot(point[0] - closest[0], point[1] - closest[1], point[2] - closest[2]);
}

export function buildSkinBoneSegments(
  jointPositions: Partial<Record<HumanJointId, Vec3>>,
): SkinBoneSegment[] {
  const jointOrder = HUMAN_JOINT_IDS.filter((id) => jointPositions[id]);
  const indexOf = new Map(jointOrder.map((id, index) => [id, index] as const));
  const segments: SkinBoneSegment[] = [];
  for (const jointId of jointOrder) {
    const start = jointPositions[jointId];
    if (!start) continue;
    // Prefer a child tip; otherwise a short stub along +Y.
    const child = (Object.entries(HUMAN_JOINT_PARENT) as Array<[HumanJointId, HumanJointId]>)
      .find(([, parent]) => parent === jointId)?.[0];
    const end = (child && jointPositions[child]) || [start[0], start[1] + 0.08, start[2]] as Vec3;
    const region = BONE_REGION[jointId] ?? 'torso';
    segments.push({
      jointId,
      jointIndex: indexOf.get(jointId) ?? 0,
      start,
      end,
      region,
    });
  }
  return segments;
}

function falloffWeight(distance: number, radius: number): number {
  const t = Math.max(0, 1 - distance / Math.max(radius, 1e-4));
  return t * t;
}

function capsuleRadius(segment: SkinBoneSegment, height: number, meshThickness: number): number {
  const length = Math.hypot(
    segment.end[0] - segment.start[0],
    segment.end[1] - segment.start[1],
    segment.end[2] - segment.start[2],
  );
  const anatomical = segment.region === 'torso'
    ? length * 0.32
    : segment.region === 'head'
      ? length * 0.5
      : length * 0.22;
  return Math.max(0.025, Math.min(height * 0.16, Math.max(meshThickness * 0.45, anatomical)));
}

/**
 * Deterministic geometric skin weights:
 * distance to bone segments → region gates → joint blend → top-4 normalize.
 */
export function generateDeterministicSkinWeights(params: {
  positions: ArrayLike<number>;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  /** Soft influence radius scale relative to character height. */
  heightMeters?: number;
  /** Canonical mesh thickness used to size capsules without fixed X thresholds. */
  meshSize?: Vec3;
  /** Flattened triangle indices in the same traversal order as positions. */
  topologyIndices?: ArrayLike<number>;
}): SkinWeightBuffers {
  const height = params.heightMeters ?? 1.75;
  const meshThickness = params.meshSize
    ? Math.min(params.meshSize[0], params.meshSize[2])
    : height * 0.3;
  const segments = buildSkinBoneSegments(params.jointPositions);
  const jointOrder = HUMAN_JOINT_IDS.filter((id) => params.jointPositions[id]);
  const vertexCount = Math.floor(params.positions.length / 3);
  const indices = new Uint16Array(vertexCount * INFLUENCES_PER_VERTEX);
  const weights = new Float32Array(vertexCount * INFLUENCES_PER_VERTEX);
  const fallbackVertices: number[] = [];
  const warnings: string[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    const point: Vec3 = [
      params.positions[v * 3]!,
      params.positions[v * 3 + 1]!,
      params.positions[v * 3 + 2]!,
    ];
    const scored: Array<{ jointIndex: number; weight: number }> = [];
    for (const segment of segments) {
      const radius = capsuleRadius(segment, height, meshThickness);
      const distance = distancePointToSegment(point, segment.start, segment.end);
      let weight = falloffWeight(distance, radius);
      if (weight <= 1e-5) continue;
      // Distance is authoritative; neighboring regions are penalized instead
      // of being broadly admitted by fixed world-space X/Y thresholds.
      const sideMismatch = (segment.region === 'leftArm' || segment.region === 'leftLeg') && point[0] < -meshThickness
        || (segment.region === 'rightArm' || segment.region === 'rightLeg') && point[0] > meshThickness;
      if (sideMismatch) weight *= 0.08;
      scored.push({ jointIndex: segment.jointIndex, weight });
    }

    scored.sort((a, b) => b.weight - a.weight);
    const top = scored.slice(0, INFLUENCES_PER_VERTEX);
    // Ensure at least hips influence if nothing matched (clothing outliers).
    if (top.length === 0) {
      const hipsIndex = jointOrder.indexOf('hips');
      top.push({ jointIndex: Math.max(0, hipsIndex), weight: 1 });
      fallbackVertices.push(v);
    }
    let sum = top.reduce((acc, item) => acc + item.weight, 0);
    if (sum < 1e-8) {
      top[0]!.weight = 1;
      sum = 1;
    }
    for (let i = 0; i < INFLUENCES_PER_VERTEX; i += 1) {
      const item = top[i];
      indices[v * INFLUENCES_PER_VERTEX + i] = item?.jointIndex ?? 0;
      weights[v * INFLUENCES_PER_VERTEX + i] = item ? item.weight / sum : 0;
    }
  }

  // Smooth by joint identity across actual triangle adjacency. Disconnected
  // components never share neighbors, so clothing or hair cannot borrow a
  // neighboring component's assignment accidentally.
  if (params.topologyIndices && params.topologyIndices.length >= 3 && jointOrder.length > 0) {
    const adjacency = Array.from({ length: vertexCount }, () => new Set<number>());
    for (let i = 0; i + 2 < params.topologyIndices.length; i += 3) {
      const a = Number(params.topologyIndices[i]);
      const b = Number(params.topologyIndices[i + 1]);
      const c = Number(params.topologyIndices[i + 2]);
      if (![a, b, c].every((value) => Number.isInteger(value) && value >= 0 && value < vertexCount)) continue;
      adjacency[a]!.add(b); adjacency[a]!.add(c);
      adjacency[b]!.add(a); adjacency[b]!.add(c);
      adjacency[c]!.add(a); adjacency[c]!.add(b);
    }
    const dense = new Float32Array(vertexCount * jointOrder.length);
    for (let v = 0; v < vertexCount; v += 1) {
      for (let slot = 0; slot < INFLUENCES_PER_VERTEX; slot += 1) {
        const jointIndex = indices[v * INFLUENCES_PER_VERTEX + slot]!;
        if (jointIndex < jointOrder.length) dense[v * jointOrder.length + jointIndex] += weights[v * INFLUENCES_PER_VERTEX + slot]!;
      }
    }
    const smoothed = new Float32Array(dense);
    for (let v = 0; v < vertexCount; v += 1) {
      const neighbors = adjacency[v]!;
      if (neighbors.size === 0) continue;
      for (let jointIndex = 0; jointIndex < jointOrder.length; jointIndex += 1) {
        let neighborAverage = 0;
        for (const neighbor of neighbors) neighborAverage += dense[neighbor * jointOrder.length + jointIndex]!;
        smoothed[v * jointOrder.length + jointIndex] = dense[v * jointOrder.length + jointIndex]! * 0.5
          + (neighborAverage / neighbors.size) * 0.5;
      }
    }
    for (let v = 0; v < vertexCount; v += 1) {
      const ranked = Array.from({ length: jointOrder.length }, (_, jointIndex) => ({
        jointIndex,
        weight: smoothed[v * jointOrder.length + jointIndex]!,
      })).filter((item) => item.weight > 1e-6).sort((a, b) => b.weight - a.weight).slice(0, INFLUENCES_PER_VERTEX);
      const sum = ranked.reduce((total, item) => total + item.weight, 0);
      for (let slot = 0; slot < INFLUENCES_PER_VERTEX; slot += 1) {
        const item = ranked[slot];
        indices[v * INFLUENCES_PER_VERTEX + slot] = item?.jointIndex ?? 0;
        weights[v * INFLUENCES_PER_VERTEX + slot] = item ? item.weight / Math.max(sum, 1e-8) : 0;
      }
    }
  }
  if (fallbackVertices.length > 0) {
    warnings.push(`${fallbackVertices.length} vertices could not be assigned confidently and use hips fallback.`);
  }

  return {
    influencesPerVertex: INFLUENCES_PER_VERTEX,
    indices,
    weights,
    jointOrder,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Pack skin buffers into a binary asset payload (indices u16 + weights f32). */
export async function writeSkinWeightBinaryAsset(
  buffers: SkinWeightBuffers,
): Promise<{ assetId: string; uri: string; byteLength: number }> {
  const indexBytes = buffers.indices.byteLength;
  const weightBytes = buffers.weights.byteLength;
  const header = new Uint32Array([
    1, // version
    buffers.influencesPerVertex,
    buffers.indices.length,
    buffers.weights.length,
    indexBytes,
    weightBytes,
  ]);
  const bytes = new Uint8Array(header.byteLength + indexBytes + weightBytes);
  bytes.set(new Uint8Array(header.buffer), 0);
  bytes.set(new Uint8Array(buffers.indices.buffer, buffers.indices.byteOffset, indexBytes), header.byteLength);
  bytes.set(new Uint8Array(buffers.weights.buffer, buffers.weights.byteOffset, weightBytes), header.byteLength + indexBytes);

  const assetId = createId('poseable_skin');
  const key = `poseable-skin-${assetId}`;
  await putModelAsset(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return {
    assetId,
    uri: `${MODEL_ASSET_URI_PREFIX}${key}`,
    byteLength: bytes.byteLength,
  };
}

/**
 * Tiny inline fixtures only. Production skin always uses `skinAssetId` binary storage.
 * Values above this budget in project JSON defeat the purpose of poseable-skin-*.bin.
 */
export const MAX_INLINE_SKIN_INFLUENCE_ENTRIES = 64;

/** Compact skin metadata stored in project JSON when a binary asset exists. */
export function compactPoseableSkinMetadata(skin: NonNullable<PoseableRigAsset['skin']>): NonNullable<PoseableRigAsset['skin']> {
  if (skin.skinAssetId) {
    return {
      influencesPerVertex: skin.influencesPerVertex || 4,
      skinAssetId: skin.skinAssetId,
    };
  }
  return {
    influencesPerVertex: skin.influencesPerVertex || 4,
    ...(skin.indices ? { indices: skin.indices } : {}),
    ...(skin.weights ? { weights: skin.weights } : {}),
  };
}

/** True when poseable_rig metadata embeds large weight tables (should be binary-only). */
export function poseableSkinExceedsInlineBudget(skin: PoseableRigAsset['skin'] | undefined): boolean {
  if (!skin) return false;
  if (skin.skinAssetId && (skin.indices || skin.weights)) return true;
  const indexLen = skin.indices?.length ?? 0;
  const weightLen = skin.weights?.length ?? 0;
  return indexLen > MAX_INLINE_SKIN_INFLUENCE_ENTRIES || weightLen > MAX_INLINE_SKIN_INFLUENCE_ENTRIES;
}

export function assertCompactPoseableSkin(skin: PoseableRigAsset['skin'] | undefined): void {
  if (!skin) return;
  if (skin.skinAssetId && (skin.indices || skin.weights)) {
    throw new Error('poseable_rig skin must not embed indices/weights when skinAssetId is set');
  }
  if (poseableSkinExceedsInlineBudget(skin)) {
    throw new Error(
      `poseable_rig skin inline arrays exceed fixture budget (${MAX_INLINE_SKIN_INFLUENCE_ENTRIES}); use skinAssetId binary storage`,
    );
  }
}

/** Strip inline indices/weights from a rig when a binary skin asset id is present. */
export function stripInlineSkinArraysFromRig(rig: PoseableRigAsset): PoseableRigAsset {
  if (!rig.skin?.skinAssetId) return rig;
  if (!rig.skin.indices && !rig.skin.weights) return rig;
  return {
    ...rig,
    skin: compactPoseableSkinMetadata(rig.skin),
  };
}

export function applySkinBuffersToRig(
  rig: PoseableRigAsset,
  buffers: SkinWeightBuffers,
  skinAssetId?: string,
): PoseableRigAsset {
  return {
    ...rig,
    skin: skinAssetId
      ? {
        influencesPerVertex: buffers.influencesPerVertex,
        skinAssetId,
      }
      : {
        influencesPerVertex: buffers.influencesPerVertex,
        // Tiny fixtures / tests only — production always passes skinAssetId.
        indices: Array.from(buffers.indices),
        weights: Array.from(buffers.weights),
      },
    rigGenerationVersion: Math.max(CURRENT_AUTORIG_RIG_GENERATION_VERSION, (rig.rigGenerationVersion ?? 0) + 1),
    requiresRerigging: false,
  };
}

/** Reference poses used to sanity-check a generated rig in the wizard. */
export const AUTORIG_TEST_POSE_IDS = [
  'armsRaised',
  'elbowsBent',
  'walking',
  'sitting',
  'crouching',
  'reachingLeft',
  'reachingRight',
] as const;

export type AutorigTestPoseId = typeof AUTORIG_TEST_POSE_IDS[number];
