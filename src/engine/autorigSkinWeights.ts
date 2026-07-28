import type { HumanJointId, PoseableRigAsset, Vec3 } from '../domain/types';
import { HUMAN_JOINT_IDS } from './humanPose';
import { HUMAN_JOINT_PARENT } from './humanoidSkeleton';
import { createId } from '../utils/ids';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { putModelAsset } from './modelAssetStore';

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

function classifyVertexRegion(point: Vec3, hips: Vec3 | undefined, chest: Vec3 | undefined): AutorigBodyRegion {
  const hipY = hips?.[1] ?? 0.9;
  const chestY = chest?.[1] ?? hipY + 0.35;
  if (point[1] >= chestY + 0.12) return 'head';
  if (point[1] < hipY - 0.02) {
    return point[0] >= 0 ? 'leftLeg' : 'rightLeg';
  }
  // Arms: outside torso X band around shoulder height
  if (point[1] > hipY + 0.05 && Math.abs(point[0]) > 0.18) {
    return point[0] >= 0 ? 'leftArm' : 'rightArm';
  }
  return 'torso';
}

function regionAllowsBone(region: AutorigBodyRegion, boneRegion: AutorigBodyRegion): boolean {
  if (region === boneRegion) return true;
  // Limited torso reach for arm/leg attachment bones.
  if (region === 'torso' && (boneRegion === 'leftArm' || boneRegion === 'rightArm')) return true;
  if (region === 'torso' && (boneRegion === 'leftLeg' || boneRegion === 'rightLeg')) return true;
  if (region === 'head' && boneRegion === 'torso') return true;
  if ((region === 'leftArm' || region === 'rightArm') && boneRegion === 'torso') return true;
  if ((region === 'leftLeg' || region === 'rightLeg') && boneRegion === 'torso') return true;
  return false;
}

function falloffWeight(distance: number, radius: number): number {
  const t = Math.max(0, 1 - distance / Math.max(radius, 1e-4));
  return t * t;
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
}): SkinWeightBuffers {
  const height = params.heightMeters ?? 1.75;
  const radius = Math.max(0.12, height * 0.12);
  const segments = buildSkinBoneSegments(params.jointPositions);
  const jointOrder = HUMAN_JOINT_IDS.filter((id) => params.jointPositions[id]);
  const vertexCount = Math.floor(params.positions.length / 3);
  const indices = new Uint16Array(vertexCount * INFLUENCES_PER_VERTEX);
  const weights = new Float32Array(vertexCount * INFLUENCES_PER_VERTEX);
  const hips = params.jointPositions.hips;
  const chest = params.jointPositions.chest;

  for (let v = 0; v < vertexCount; v += 1) {
    const point: Vec3 = [
      params.positions[v * 3]!,
      params.positions[v * 3 + 1]!,
      params.positions[v * 3 + 2]!,
    ];
    const region = classifyVertexRegion(point, hips, chest);
    const scored: Array<{ jointIndex: number; weight: number }> = [];
    for (const segment of segments) {
      if (!regionAllowsBone(region, segment.region)) continue;
      // Hard prevent opposite-limb influence.
      if (region === 'leftArm' && segment.region === 'rightArm') continue;
      if (region === 'rightArm' && segment.region === 'leftArm') continue;
      if (region === 'leftLeg' && segment.region === 'rightLeg') continue;
      if (region === 'rightLeg' && segment.region === 'leftLeg') continue;
      if (region === 'head' && (segment.region === 'leftLeg' || segment.region === 'rightLeg')) continue;
      if ((region === 'leftLeg' || region === 'rightLeg') && segment.region === 'head') continue;

      let distance = distancePointToSegment(point, segment.start, segment.end);
      // Shoulder / hip attachment soften: pull torso vertices slightly toward limb roots.
      if (region === 'torso' && (segment.jointId === 'leftUpperArm' || segment.jointId === 'rightUpperArm')) {
        distance *= 0.85;
      }
      if (region === 'torso' && (segment.jointId === 'leftUpperLeg' || segment.jointId === 'rightUpperLeg')) {
        distance *= 0.85;
      }
      const weight = falloffWeight(distance, radius);
      if (weight <= 1e-5) continue;
      scored.push({ jointIndex: segment.jointIndex, weight });
    }

    scored.sort((a, b) => b.weight - a.weight);
    const top = scored.slice(0, INFLUENCES_PER_VERTEX);
    // Ensure at least hips influence if nothing matched (clothing outliers).
    if (top.length === 0) {
      const hipsIndex = jointOrder.indexOf('hips');
      top.push({ jointIndex: Math.max(0, hipsIndex), weight: 1 });
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

  return {
    influencesPerVertex: INFLUENCES_PER_VERTEX,
    indices,
    weights,
    jointOrder,
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
    rigGenerationVersion: Math.max(1, (rig.rigGenerationVersion ?? 0) + 1),
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
