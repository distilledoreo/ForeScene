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

export function buildSkinBoneSegments(
  jointPositions: Partial<Record<HumanJointId, Vec3>>,
): SkinBoneSegment[] {
  const jointOrder = HUMAN_JOINT_IDS.filter((id) => jointPositions[id]);
  const indexOf = new Map(jointOrder.map((id, index) => [id, index] as const));
  const childOf = new Map<HumanJointId, HumanJointId>();
  for (const [child, parent] of Object.entries(HUMAN_JOINT_PARENT) as Array<[HumanJointId, HumanJointId]>) {
    if (!childOf.has(parent)) childOf.set(parent, child);
  }
  const segments: SkinBoneSegment[] = [];
  for (const jointId of jointOrder) {
    const start = jointPositions[jointId];
    if (!start) continue;
    // Prefer a child tip; otherwise a short stub along +Y.
    const child = childOf.get(jointId);
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

function isLimbRegion(region: AutorigBodyRegion): boolean {
  return region === 'leftArm' || region === 'rightArm' || region === 'leftLeg' || region === 'rightLeg';
}

function capsuleRadius(
  segment: SkinBoneSegment,
  height: number,
  meshThickness: number,
  /** Half-width of the torso from fitted shoulders; keeps midline bones spanning the chest. */
  torsoHalfWidth: number,
): number {
  const length = Math.hypot(
    segment.end[0] - segment.start[0],
    segment.end[1] - segment.start[1],
    segment.end[2] - segment.start[2],
  );
  // Limbs: length-scaled radius with a small height floor (~5cm at 1.75m).
  // Do NOT floor on meshThickness — that value is sized for the torso and
  // inflates arm/leg capsules to ~16cm, letting them claim chest vertices.
  if (isLimbRegion(segment.region)) {
    return Math.max(height * 0.03, Math.min(height * 0.16, length * 0.25));
  }
  // Torso/head need wide capsules so midline bones reach the body surface out
  // to the shoulders (meshThickness alone is often the depth, not the width).
  const anatomical = segment.region === 'torso' ? length * 0.32 : length * 0.5;
  const bodyFloor = Math.max(meshThickness * 0.45, torsoHalfWidth * 0.95);
  return Math.max(0.025, Math.min(height * 0.22, Math.max(bodyFloor, anatomical)));
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
  // Shoulder lateral extent from fitted joints — sizes torso capsules and gates
  // limb influence so arm bones cannot claim vertices still inside the chest.
  const leftShoulderX = Math.abs(params.jointPositions.leftUpperArm?.[0] ?? 0);
  const rightShoulderX = Math.abs(params.jointPositions.rightUpperArm?.[0] ?? 0);
  const shoulderX = Math.max(leftShoulderX, rightShoulderX, meshThickness * 0.35);
  const torsoHalfWidth = shoulderX;
  const torsoLateralExtent = shoulderX * 0.9;
  const segments = buildSkinBoneSegments(params.jointPositions);
  const jointOrder = HUMAN_JOINT_IDS.filter((id) => params.jointPositions[id]);
  const vertexCount = Math.floor(params.positions.length / 3);
  const indices = new Uint16Array(vertexCount * INFLUENCES_PER_VERTEX);
  const weights = new Float32Array(vertexCount * INFLUENCES_PER_VERTEX);
  const fallbackVertices: number[] = [];
  const warnings: string[] = [];

  // Flatten segment data once so the per-vertex loop is a tight typed-array scan
  // (capsule radii and segment vectors are vertex-invariant).
  const segCount = segments.length;
  const segStartX = new Float32Array(segCount);
  const segStartY = new Float32Array(segCount);
  const segStartZ = new Float32Array(segCount);
  const segABX = new Float32Array(segCount);
  const segABY = new Float32Array(segCount);
  const segABZ = new Float32Array(segCount);
  const segLenSq = new Float32Array(segCount);
  const segRadius = new Float32Array(segCount);
  const segRadiusSq = new Float32Array(segCount);
  const segJoint = new Uint16Array(segCount);
  /** -1 = left limb, +1 = right limb, 0 = midline (no cross-side penalty). */
  const segSide = new Int8Array(segCount);
  for (let s = 0; s < segCount; s += 1) {
    const segment = segments[s]!;
    const abx = segment.end[0] - segment.start[0];
    const aby = segment.end[1] - segment.start[1];
    const abz = segment.end[2] - segment.start[2];
    segStartX[s] = segment.start[0];
    segStartY[s] = segment.start[1];
    segStartZ[s] = segment.start[2];
    segABX[s] = abx;
    segABY[s] = aby;
    segABZ[s] = abz;
    segLenSq[s] = Math.max(abx * abx + aby * aby + abz * abz, 1e-12);
    const radius = capsuleRadius(segment, height, meshThickness, torsoHalfWidth);
    segRadius[s] = radius;
    segRadiusSq[s] = radius * radius;
    segJoint[s] = segment.jointIndex;
    segSide[s] = segment.region === 'leftArm' || segment.region === 'leftLeg'
      ? -1
      : segment.region === 'rightArm' || segment.region === 'rightLeg'
        ? 1
        : 0;
  }

  const hipsIndex = Math.max(0, jointOrder.indexOf('hips'));
  // Reusable top-4 scratch (no per-vertex allocations / sorts).
  const topJoints = new Uint16Array(INFLUENCES_PER_VERTEX);
  const topWeights = new Float32Array(INFLUENCES_PER_VERTEX);
  for (let v = 0; v < vertexCount; v += 1) {
    const px = params.positions[v * 3]!;
    const py = params.positions[v * 3 + 1]!;
    const pz = params.positions[v * 3 + 2]!;
    let topN = 0;
    for (let s = 0; s < segCount; s += 1) {
      const apx = px - segStartX[s]!;
      const apy = py - segStartY[s]!;
      const apz = pz - segStartZ[s]!;
      let t = (apx * segABX[s]! + apy * segABY[s]! + apz * segABZ[s]!) / segLenSq[s]!;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = apx - segABX[s]! * t;
      const dy = apy - segABY[s]! * t;
      const dz = apz - segABZ[s]! * t;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq >= segRadiusSq[s]!) continue; // zero falloff — skip the sqrt.
      let weight = falloffWeight(Math.sqrt(distSq), segRadius[s]!);
      if (weight <= 1e-5) continue;
      // Distance is authoritative; neighboring regions are penalized instead
      // of being broadly admitted by fixed world-space X/Y thresholds.
      const side = segSide[s]!;
      if ((side < 0 && px < -meshThickness) || (side > 0 && px > meshThickness)) weight *= 0.08;
      // Torso protection: limb bones must not claim vertices still inside the
      // torso's lateral extent (even if within a shrunken capsule at the shoulder).
      if (side !== 0 && Math.abs(px) < torsoLateralExtent) weight *= 0.05;
      // Stable descending insertion into the fixed top-4 (matches sort+slice).
      if (topN < INFLUENCES_PER_VERTEX || weight > topWeights[INFLUENCES_PER_VERTEX - 1]!) {
        let slot = Math.min(topN, INFLUENCES_PER_VERTEX - 1);
        while (slot > 0 && topWeights[slot - 1]! < weight) {
          topWeights[slot] = topWeights[slot - 1]!;
          topJoints[slot] = topJoints[slot - 1]!;
          slot -= 1;
        }
        topWeights[slot] = weight;
        topJoints[slot] = segJoint[s]!;
        if (topN < INFLUENCES_PER_VERTEX) topN += 1;
      }
    }

    // Ensure at least hips influence if nothing matched (clothing outliers).
    if (topN === 0) {
      topJoints[0] = hipsIndex;
      topWeights[0] = 1;
      topN = 1;
      fallbackVertices.push(v);
    }
    let sum = 0;
    for (let i = 0; i < topN; i += 1) sum += topWeights[i]!;
    if (sum < 1e-8) {
      topWeights[0] = 1;
      sum = 1;
    }
    for (let i = 0; i < INFLUENCES_PER_VERTEX; i += 1) {
      indices[v * INFLUENCES_PER_VERTEX + i] = i < topN ? topJoints[i]! : 0;
      weights[v * INFLUENCES_PER_VERTEX + i] = i < topN ? topWeights[i]! / sum : 0;
    }
  }

  // Laplacian smoothing over triangle adjacency (when provided) softens region seams.
  // Sparse implementation: only joints present in a vertex's own or its neighbors'
  // top-4 slots are touched — no dense V×J matrices and no per-vertex Sets.
  if (params.topologyIndices && params.topologyIndices.length >= 3 && vertexCount > 0) {
    const topo = params.topologyIndices;
    const triCount = Math.floor(topo.length / 3);
    const tris = new Int32Array(triCount * 3);
    let keptTris = 0;
    for (let i = 0; i + 2 < topo.length; i += 3) {
      const a = Number(topo[i]);
      const b = Number(topo[i + 1]);
      const c = Number(topo[i + 2]);
      if (![a, b, c].every((value) => Number.isInteger(value) && value >= 0 && value < vertexCount)) continue;
      tris[keptTris * 3] = a;
      tris[keptTris * 3 + 1] = b;
      tris[keptTris * 3 + 2] = c;
      keptTris += 1;
    }
    // CSR adjacency (directed, with duplicate edges; dedup happens per vertex below).
    const offsets = new Int32Array(vertexCount + 1);
    for (let i = 0; i < keptTris * 3; i += 1) offsets[tris[i]! + 1] += 2;
    for (let v = 0; v < vertexCount; v += 1) offsets[v + 1] += offsets[v]!;
    const neighbors = new Int32Array(offsets[vertexCount]!);
    const cursor = new Int32Array(vertexCount);
    for (let i = 0; i < keptTris; i += 1) {
      const a = tris[i * 3]!;
      const b = tris[i * 3 + 1]!;
      const c = tris[i * 3 + 2]!;
      neighbors[offsets[a]! + cursor[a]!] = b; cursor[a] += 1;
      neighbors[offsets[a]! + cursor[a]!] = c; cursor[a] += 1;
      neighbors[offsets[b]! + cursor[b]!] = a; cursor[b] += 1;
      neighbors[offsets[b]! + cursor[b]!] = c; cursor[b] += 1;
      neighbors[offsets[c]! + cursor[c]!] = a; cursor[c] += 1;
      neighbors[offsets[c]! + cursor[c]!] = b; cursor[c] += 1;
    }

    const jointCount = jointOrder.length;
    // Region groups for smoothing: 0 = torso/head, 1 = limb. Neighbor joints
    // from a different group are ignored so residual arm weight cannot smear
    // into the chest (and vice versa) across the shoulder seam.
    const jointRegionGroup = new Int8Array(jointCount);
    for (let j = 0; j < jointCount; j += 1) {
      const region = BONE_REGION[jointOrder[j]!] ?? 'torso';
      jointRegionGroup[j] = isLimbRegion(region) ? 1 : 0;
    }
    const nbrSeen = new Int32Array(vertexCount); // per-vertex neighbor dedup stamps
    const candStamp = new Int32Array(jointCount);
    const candSum = new Float32Array(jointCount);
    const ownStamp = new Int32Array(jointCount);
    const ownWeight = new Float32Array(jointCount);
    const candList = new Int32Array(jointCount);
    let generation = 0;
    for (let v = 0; v < vertexCount; v += 1) {
      const start = offsets[v]!;
      const end = offsets[v + 1]!;
      if (start === end) continue;
      generation += 1;
      let candN = 0;
      const vBase = v * INFLUENCES_PER_VERTEX;
      // Top influence (weights are already sorted descending from the score pass).
      const topJoint = indices[vBase]!;
      const ownGroup = topJoint < jointCount ? jointRegionGroup[topJoint]! : 0;
      for (let slot = 0; slot < INFLUENCES_PER_VERTEX; slot += 1) {
        const w = weights[vBase + slot]!;
        if (w <= 0) continue;
        const j = indices[vBase + slot]!;
        if (j >= jointCount) continue;
        ownStamp[j] = generation;
        ownWeight[j] = w;
        if (candStamp[j] !== generation) {
          candStamp[j] = generation;
          candSum[j] = 0;
          candList[candN] = j;
          candN += 1;
        }
      }
      let dedupCount = 0;
      for (let k = start; k < end; k += 1) {
        const u = neighbors[k]!;
        if (nbrSeen[u] === generation) continue;
        nbrSeen[u] = generation;
        dedupCount += 1;
        const uBase = u * INFLUENCES_PER_VERTEX;
        for (let slot = 0; slot < INFLUENCES_PER_VERTEX; slot += 1) {
          const w = weights[uBase + slot]!;
          if (w <= 0) continue;
          const j = indices[uBase + slot]!;
          if (j >= jointCount) continue;
          // Skip cross-group neighbor influences (limb ↔ torso/head).
          if (jointRegionGroup[j] !== ownGroup) continue;
          if (candStamp[j] !== generation) {
            candStamp[j] = generation;
            candSum[j] = 0;
            candList[candN] = j;
            candN += 1;
          }
          candSum[j] = candSum[j]! + w;
        }
      }
      if (dedupCount === 0) continue;
      // smoothed = own * 0.5 + (neighbor average) * 0.5 → re-rank top-4 (>1e-6).
      let topN = 0;
      for (let c = 0; c < candN; c += 1) {
        const j = candList[c]!;
        const own = ownStamp[j] === generation ? ownWeight[j]! : 0;
        const smoothed = own * 0.5 + (candSum[j]! / dedupCount) * 0.5;
        if (smoothed <= 1e-6) continue;
        if (topN < INFLUENCES_PER_VERTEX || smoothed > topWeights[INFLUENCES_PER_VERTEX - 1]!) {
          let slot = Math.min(topN, INFLUENCES_PER_VERTEX - 1);
          while (slot > 0 && topWeights[slot - 1]! < smoothed) {
            topWeights[slot] = topWeights[slot - 1]!;
            topJoints[slot] = topJoints[slot - 1]!;
            slot -= 1;
          }
          topWeights[slot] = smoothed;
          topJoints[slot] = j;
          if (topN < INFLUENCES_PER_VERTEX) topN += 1;
        }
      }
      let sum = 0;
      for (let i = 0; i < topN; i += 1) sum += topWeights[i]!;
      for (let slot = 0; slot < INFLUENCES_PER_VERTEX; slot += 1) {
        indices[vBase + slot] = slot < topN ? topJoints[slot]! : 0;
        weights[vBase + slot] = slot < topN ? topWeights[slot]! / Math.max(sum, 1e-8) : 0;
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
