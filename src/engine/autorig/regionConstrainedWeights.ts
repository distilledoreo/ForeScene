import type { HumanJointId, Vec3 } from '../../domain/types';
import { HUMAN_JOINT_IDS } from '../humanPose';
import {
  AUTORIG_REGION_CODE,
  AUTORIG_REGION_ID_BY_CODE,
  REGION_BONES,
  type AutorigBodyRegionId,
  type AutorigRegionCode,
  isValidRegionCode,
} from './regions';
import type { CanonicalAutorigTopology } from './topology';
import {
  buildSkinBoneSegments,
  estimateMeshCapsuleRadii,
  type SkinBoneSegment,
  type SkinWeightBuffers,
} from '../autorigSkinWeights';
import {
  extractPartialSkinUpdate,
  type PartialSkinWeightUpdate,
} from './partialSkinUpdate';
import {
  buildDirtyVertexSet,
  createRegionEditFromLabels,
  type AutorigRegionEdit,
} from './dirtyRegionSet';

const INFLUENCES_PER_VERTEX = 4;

/** Bones permitted for each broad body region (hard gate). */
export const BINDER_V2_ALLOWED_BONES: Record<AutorigBodyRegionId, readonly HumanJointId[]> = {
  head: REGION_BONES.head,
  torso: [...REGION_BONES.torso, 'neck'],
  leftArm: REGION_BONES.leftArm,
  rightArm: REGION_BONES.rightArm,
  leftLeg: REGION_BONES.leftLeg,
  rightLeg: REGION_BONES.rightLeg,
};

/** Extra bones allowed only inside anatomical seam bands. */
const SEAM_EXTRA_BONES: Record<string, readonly HumanJointId[]> = {
  'head|torso': ['upperSpine', 'neck', 'head'],
  'torso|head': ['upperSpine', 'neck', 'head'],
  'torso|leftArm': ['upperSpine', 'leftClavicle', 'leftUpperArm', 'leftUpperArmTwist'],
  'leftArm|torso': ['upperSpine', 'leftClavicle', 'leftUpperArm', 'leftUpperArmTwist'],
  'torso|rightArm': ['upperSpine', 'rightClavicle', 'rightUpperArm', 'rightUpperArmTwist'],
  'rightArm|torso': ['upperSpine', 'rightClavicle', 'rightUpperArm', 'rightUpperArmTwist'],
  'torso|leftLeg': ['hips', 'leftUpperLeg', 'leftUpperLegTwist'],
  'leftLeg|torso': ['hips', 'leftUpperLeg', 'leftUpperLegTwist'],
  'torso|rightLeg': ['hips', 'rightUpperLeg', 'rightUpperLegTwist'],
  'rightLeg|torso': ['hips', 'rightUpperLeg', 'rightUpperLegTwist'],
};

function falloffWeight(distance: number, radius: number): number {
  const t = Math.max(0, 1 - distance / Math.max(radius, 1e-4));
  return t * t;
}

function buildAllowedMask(
  jointOrder: HumanJointId[],
  region: AutorigBodyRegionId,
  extra?: ReadonlySet<HumanJointId>,
): Uint8Array {
  const allowed = new Set<HumanJointId>(BINDER_V2_ALLOWED_BONES[region]);
  if (extra) {
    for (const bone of extra) allowed.add(bone);
  }
  const mask = new Uint8Array(jointOrder.length);
  for (let i = 0; i < jointOrder.length; i += 1) {
    if (allowed.has(jointOrder[i]!)) mask[i] = 1;
  }
  return mask;
}

/**
 * Graph distance (in vertices) from each vertex to the nearest cross-region seam edge.
 * Non-seam vertices get a large sentinel.
 */
export function computeSeamDistances(params: {
  topology: CanonicalAutorigTopology;
  labels: Uint8Array;
}): { distance: Float32Array; seamPairKey: Array<string | null> } {
  const { topology, labels } = params;
  const vertexCount = labels.length;
  const distance = new Float32Array(vertexCount);
  distance.fill(1e9);
  const seamPairKey: Array<string | null> = new Array(vertexCount).fill(null);
  const queue: number[] = [];

  for (let v = 0; v < vertexCount; v += 1) {
    const code = labels[v]!;
    if (!isValidRegionCode(code)) continue;
    const region = AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode]!;
    const start = topology.adjacencyOffsets[v]!;
    const end = topology.adjacencyOffsets[v + 1]!;
    for (let ai = start; ai < end; ai += 1) {
      const n = topology.adjacencyVertices[ai]!;
      const nCode = labels[n]!;
      if (!isValidRegionCode(nCode) || nCode === code) continue;
      const other = AUTORIG_REGION_ID_BY_CODE[nCode as AutorigRegionCode]!;
      const key = `${region}|${other}`;
      if (!SEAM_EXTRA_BONES[key]) continue;
      if (distance[v]! > 0) {
        distance[v] = 0;
        seamPairKey[v] = key;
        queue.push(v);
      }
      break;
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const v = queue[qi++]!;
    const d = distance[v]!;
    const key = seamPairKey[v];
    const start = topology.adjacencyOffsets[v]!;
    const end = topology.adjacencyOffsets[v + 1]!;
    for (let ai = start; ai < end; ai += 1) {
      const n = topology.adjacencyVertices[ai]!;
      if (labels[n] !== labels[v]) continue; // stay inside the same region band
      if (distance[n]! <= d + 1) continue;
      distance[n] = d + 1;
      seamPairKey[n] = key;
      queue.push(n);
    }
  }

  return { distance, seamPairKey };
}

function insertTop4(
  topJoints: Uint16Array,
  topWeights: Float32Array,
  topN: number,
  joint: number,
  weight: number,
): number {
  if (topN < INFLUENCES_PER_VERTEX || weight > topWeights[INFLUENCES_PER_VERTEX - 1]!) {
    let slot = Math.min(topN, INFLUENCES_PER_VERTEX - 1);
    while (slot > 0 && topWeights[slot - 1]! < weight) {
      topWeights[slot] = topWeights[slot - 1]!;
      topJoints[slot] = topJoints[slot - 1]!;
      slot -= 1;
    }
    topWeights[slot] = weight;
    topJoints[slot] = joint;
    if (topN < INFLUENCES_PER_VERTEX) return topN + 1;
  }
  return topN;
}

function writeNormalizedInfluences(
  indices: Uint16Array,
  weights: Float32Array,
  v: number,
  topJoints: Uint16Array,
  topWeights: Float32Array,
  topN: number,
): void {
  let sum = 0;
  for (let i = 0; i < topN; i += 1) sum += topWeights[i]!;
  if (sum < 1e-8) {
    topWeights[0] = 1;
    sum = 1;
    topN = Math.max(topN, 1);
  }
  const base = v * INFLUENCES_PER_VERTEX;
  for (let i = 0; i < INFLUENCES_PER_VERTEX; i += 1) {
    indices[base + i] = i < topN ? topJoints[i]! : 0;
    weights[base + i] = i < topN ? topWeights[i]! / sum : 0;
  }
}

function dominantBoneForRegion(
  region: AutorigBodyRegionId,
  jointOrder: HumanJointId[],
): number {
  const preferred: HumanJointId[] = region === 'head'
    ? ['head', 'neck']
    : region === 'torso'
      ? ['spine', 'chest', 'hips', 'upperSpine']
      : region === 'leftArm'
        ? ['leftUpperArm', 'leftLowerArm', 'leftHand']
        : region === 'rightArm'
          ? ['rightUpperArm', 'rightLowerArm', 'rightHand']
          : region === 'leftLeg'
            ? ['leftUpperLeg', 'leftLowerLeg', 'leftFoot']
            : ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
  for (const bone of preferred) {
    const index = jointOrder.indexOf(bone);
    if (index >= 0) return index;
  }
  const allowed = BINDER_V2_ALLOWED_BONES[region];
  for (const bone of allowed) {
    const index = jointOrder.indexOf(bone);
    if (index >= 0) return index;
  }
  return Math.max(0, jointOrder.indexOf('hips'));
}

/**
 * Region-constrained Binder V2.
 * Capsule distances only among bones allowed by the vertex's six-region label
 * (plus a short anatomical seam band). Never falls back to hips for non-torso.
 */
export function generateRegionConstrainedSkinWeights(params: {
  positions: ArrayLike<number>;
  regionLabels: Uint8Array;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  topology?: CanonicalAutorigTopology | null;
  topologyIndices?: ArrayLike<number>;
  heightMeters?: number;
  meshSize?: Vec3;
  /** Seam blend width in adjacency hops (derived from bone length when omitted). */
  seamHopWidth?: number;
}): SkinWeightBuffers {
  const height = params.heightMeters ?? 1.75;
  const meshThickness = params.meshSize
    ? Math.min(params.meshSize[0], params.meshSize[2])
    : height * 0.3;
  const leftShoulderX = Math.abs(params.jointPositions.leftUpperArm?.[0] ?? 0);
  const rightShoulderX = Math.abs(params.jointPositions.rightUpperArm?.[0] ?? 0);
  const shoulderX = Math.max(leftShoulderX, rightShoulderX, meshThickness * 0.35);
  const hipY = params.jointPositions.hips?.[1]
    ?? params.jointPositions.spine?.[1]
    ?? height * 0.5;
  const segments = buildSkinBoneSegments(params.jointPositions);
  const jointOrder = HUMAN_JOINT_IDS.filter((id) => params.jointPositions[id]);
  const vertexCount = Math.floor(params.positions.length / 3);
  const labels = params.regionLabels.length === vertexCount
    ? params.regionLabels
    : new Uint8Array(vertexCount).fill(AUTORIG_REGION_CODE.torso);

  const indices = new Uint16Array(vertexCount * INFLUENCES_PER_VERTEX);
  const weights = new Float32Array(vertexCount * INFLUENCES_PER_VERTEX);
  const warnings: string[] = [];
  let fallbackVertexCount = 0;

  const meshRadii = estimateMeshCapsuleRadii({
    positions: params.positions,
    segments,
    height,
    meshThickness,
    shoulderX,
    hipY,
    torsoHalfWidth: shoulderX,
  });

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
  const segRegion = new Array<AutorigBodyRegionId>(segCount);
  let meanBoneLength = 0;
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
    const lenSq = Math.max(abx * abx + aby * aby + abz * abz, 1e-12);
    segLenSq[s] = lenSq;
    meanBoneLength += Math.sqrt(lenSq);
    const radius = meshRadii[s]!;
    segRadius[s] = radius;
    segRadiusSq[s] = radius * radius;
    segJoint[s] = segment.jointIndex;
    segRegion[s] = segment.region as AutorigBodyRegionId;
  }
  meanBoneLength = segCount > 0 ? meanBoneLength / segCount : height * 0.1;
  const seamHopWidth = params.seamHopWidth
    ?? Math.max(2, Math.round((meanBoneLength * 0.35) / Math.max(meanBoneLength * 0.08, 1e-3)));

  const regionMasks: Record<AutorigBodyRegionId, Uint8Array> = {
    head: buildAllowedMask(jointOrder, 'head'),
    torso: buildAllowedMask(jointOrder, 'torso'),
    leftArm: buildAllowedMask(jointOrder, 'leftArm'),
    rightArm: buildAllowedMask(jointOrder, 'rightArm'),
    leftLeg: buildAllowedMask(jointOrder, 'leftLeg'),
    rightLeg: buildAllowedMask(jointOrder, 'rightLeg'),
  };

  let seamDistance: Float32Array | null = null;
  let seamPairKey: Array<string | null> | null = null;
  if (params.topology && params.topology.adjacencyOffsets.length === vertexCount + 1) {
    const seam = computeSeamDistances({ topology: params.topology, labels });
    seamDistance = seam.distance;
    seamPairKey = seam.seamPairKey;
  }

  const seamMaskCache = new Map<string, Uint8Array>();
  const getSeamMask = (region: AutorigBodyRegionId, pairKey: string | null): Uint8Array => {
    if (!pairKey) return regionMasks[region];
    const cacheKey = `${region}::${pairKey}`;
    const cached = seamMaskCache.get(cacheKey);
    if (cached) return cached;
    const extra = SEAM_EXTRA_BONES[pairKey];
    const mask = buildAllowedMask(
      jointOrder,
      region,
      extra ? new Set(extra) : undefined,
    );
    seamMaskCache.set(cacheKey, mask);
    return mask;
  };

  const topJoints = new Uint16Array(INFLUENCES_PER_VERTEX);
  const topWeights = new Float32Array(INFLUENCES_PER_VERTEX);
  const hipsIndex = Math.max(0, jointOrder.indexOf('hips'));

  for (let v = 0; v < vertexCount; v += 1) {
    const code = labels[v]!;
    const region = (isValidRegionCode(code)
      ? AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode]
      : 'torso') ?? 'torso';
    const inSeam = seamDistance != null
      && seamDistance[v]! <= seamHopWidth
      && seamPairKey?.[v] != null;
    const allowedMask = inSeam
      ? getSeamMask(region, seamPairKey![v]!)
      : regionMasks[region];

    const px = params.positions[v * 3]!;
    const py = params.positions[v * 3 + 1]!;
    const pz = params.positions[v * 3 + 2]!;
    let topN = 0;

    for (let s = 0; s < segCount; s += 1) {
      const jointIndex = segJoint[s]!;
      if (!allowedMask[jointIndex]) continue;
      const apx = px - segStartX[s]!;
      const apy = py - segStartY[s]!;
      const apz = pz - segStartZ[s]!;
      let t = (apx * segABX[s]! + apy * segABY[s]! + apz * segABZ[s]!) / segLenSq[s]!;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = apx - segABX[s]! * t;
      const dy = apy - segABY[s]! * t;
      const dz = apz - segABZ[s]! * t;
      const distSq = dx * dx + dy * dy + dz * dz;
      // Outside capsule: still allow a weak nearest-chain contribution so we
      // never need a hips fallback for limb vertices.
      let weight: number;
      if (distSq < segRadiusSq[s]!) {
        weight = falloffWeight(Math.sqrt(distSq), segRadius[s]!);
        if (t < 0.04 || t > 0.96) weight *= 0.35;
      } else {
        const dist = Math.sqrt(distSq);
        weight = 0.02 / (1 + dist / Math.max(segRadius[s]!, 1e-3));
      }
      if (weight <= 1e-6) continue;
      topN = insertTop4(topJoints, topWeights, topN, jointIndex, weight);
    }

    if (topN === 0) {
      fallbackVertexCount += 1;
      const fallbackJoint = region === 'torso'
        ? hipsIndex
        : dominantBoneForRegion(region, jointOrder);
      topJoints[0] = fallbackJoint;
      topWeights[0] = 1;
      topN = 1;
    }

    writeNormalizedInfluences(indices, weights, v, topJoints, topWeights, topN);
  }

  // Same-region (and seam-band) adjacency smoothing.
  const topology = params.topology;
  if (topology && topology.adjacencyOffsets.length === vertexCount + 1) {
    const jointCount = jointOrder.length;
    const jointAllowedByRegion: Record<AutorigBodyRegionId, Uint8Array> = regionMasks;
    const nbrSeen = new Int32Array(vertexCount);
    const candStamp = new Int32Array(jointCount);
    const candSum = new Float32Array(jointCount);
    const ownStamp = new Int32Array(jointCount);
    const ownWeight = new Float32Array(jointCount);
    const candList = new Int32Array(jointCount);
    let generation = 0;

    for (let v = 0; v < vertexCount; v += 1) {
      const code = labels[v]!;
      const region = (isValidRegionCode(code)
        ? AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode]
        : 'torso') ?? 'torso';
      const inSeam = seamDistance != null
        && seamDistance[v]! <= seamHopWidth
        && seamPairKey?.[v] != null;
      const allowedMask = inSeam
        ? getSeamMask(region, seamPairKey![v]!)
        : jointAllowedByRegion[region];
      const component = topology.vertexComponent[v]!;
      const start = topology.adjacencyOffsets[v]!;
      const end = topology.adjacencyOffsets[v + 1]!;
      if (start === end) continue;

      generation += 1;
      let candN = 0;
      const vBase = v * INFLUENCES_PER_VERTEX;
      for (let slot = 0; slot < INFLUENCES_PER_VERTEX; slot += 1) {
        const w = weights[vBase + slot]!;
        if (w <= 0) continue;
        const j = indices[vBase + slot]!;
        if (j >= jointCount || !allowedMask[j]) continue;
        ownStamp[j] = generation;
        ownWeight[j] = w;
        if (candStamp[j] !== generation) {
          candStamp[j] = generation;
          candSum[j] = 0;
          candList[candN++] = j;
        }
      }

      let dedupCount = 0;
      for (let ai = start; ai < end; ai += 1) {
        const u = topology.adjacencyVertices[ai]!;
        if (nbrSeen[u] === generation) continue;
        nbrSeen[u] = generation;
        if (topology.vertexComponent[u] !== component) continue;
        const uCode = labels[u]!;
        const sameRegion = uCode === code;
        const uInSeam = seamDistance != null
          && seamDistance[u]! <= seamHopWidth
          && seamPairKey?.[u] != null
          && seamPairKey[u] === seamPairKey[v];
        if (!sameRegion && !(inSeam && uInSeam)) continue;
        dedupCount += 1;
        const uBase = u * INFLUENCES_PER_VERTEX;
        for (let slot = 0; slot < INFLUENCES_PER_VERTEX; slot += 1) {
          const w = weights[uBase + slot]!;
          if (w <= 0) continue;
          const j = indices[uBase + slot]!;
          if (j >= jointCount || !allowedMask[j]) continue;
          if (candStamp[j] !== generation) {
            candStamp[j] = generation;
            candSum[j] = 0;
            candList[candN++] = j;
          }
          candSum[j] = candSum[j]! + w;
        }
      }
      if (dedupCount === 0) continue;

      let topN = 0;
      for (let c = 0; c < candN; c += 1) {
        const j = candList[c]!;
        if (!allowedMask[j]) continue;
        const own = ownStamp[j] === generation ? ownWeight[j]! : 0;
        const smoothed = own * 0.5 + (candSum[j]! / dedupCount) * 0.5;
        if (smoothed <= 1e-6) continue;
        topN = insertTop4(topJoints, topWeights, topN, j, smoothed);
      }
      if (topN === 0) continue;
      writeNormalizedInfluences(indices, weights, v, topJoints, topWeights, topN);
    }
  }

  if (fallbackVertexCount > 0) {
    warnings.push(
      `${fallbackVertexCount} vertices used nearest region-bone fallback (no capsule hit).`,
    );
  }

  return {
    influencesPerVertex: INFLUENCES_PER_VERTEX,
    indices,
    weights,
    jointOrder,
    fallbackVertexCount,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Regenerate Binder V2 weights and return only the dirty vertex slice.
 * Uses a full regeneration under the hood so dirty vertices match a complete
 * rebind byte-for-byte; GPU updates then patch only those vertices.
 */
export function generatePartialRegionConstrainedSkinWeights(params: {
  positions: ArrayLike<number>;
  regionLabels: Uint8Array;
  previousRegionLabels?: Uint8Array | null;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  topology: CanonicalAutorigTopology;
  heightMeters?: number;
  meshSize?: Vec3;
  seamHopWidth?: number;
  revision: number;
  /** Explicit dirty vertices; derived from label diff when omitted. */
  dirtyVertices?: Uint32Array | null;
  edit?: AutorigRegionEdit | null;
}): PartialSkinWeightUpdate {
  const full = generateRegionConstrainedSkinWeights({
    positions: params.positions,
    regionLabels: params.regionLabels,
    jointPositions: params.jointPositions,
    topology: params.topology,
    heightMeters: params.heightMeters,
    meshSize: params.meshSize,
    seamHopWidth: params.seamHopWidth,
  });

  let dirty = params.dirtyVertices ?? null;
  if (!dirty) {
    const edit = params.edit ?? (
      params.previousRegionLabels
        ? createRegionEditFromLabels({
          previousLabels: params.previousRegionLabels,
          nextLabels: params.regionLabels,
        })
        : null
    );
    if (edit) {
      dirty = buildDirtyVertexSet({
        topology: params.topology,
        edit,
      });
    }
  }
  if (!dirty || dirty.length === 0) {
    // Nothing dirty — return empty update (caller keeps previous deformation).
    return {
      revision: params.revision,
      vertexIndices: new Uint32Array(0),
      skinIndices: new Uint16Array(0),
      skinWeights: new Float32Array(0),
      warnings: [],
      fallbackVertexCount: full.fallbackVertexCount,
    };
  }

  return extractPartialSkinUpdate({
    buffers: full,
    vertexIndices: dirty,
    revision: params.revision,
    warnings: full.warnings,
  });
}

/** True when every influence on a vertex is in the region's allowed set (incl. seam extras). */
export function assertNoForbiddenInfluences(params: {
  indices: Uint16Array;
  weights: Float32Array;
  jointOrder: HumanJointId[];
  regionLabels: Uint8Array;
  influencesPerVertex?: number;
}): { ok: boolean; violations: number } {
  const ipv = params.influencesPerVertex ?? INFLUENCES_PER_VERTEX;
  const vertexCount = params.regionLabels.length;
  let violations = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    const code = params.regionLabels[v]!;
    const region = (isValidRegionCode(code)
      ? AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode]
      : 'torso') ?? 'torso';
    const allowed = new Set(BINDER_V2_ALLOWED_BONES[region]);
    // Seam extras are also valid — admit all documented seam bones for the region.
    for (const [key, bones] of Object.entries(SEAM_EXTRA_BONES)) {
      if (key.startsWith(`${region}|`) || key.endsWith(`|${region}`)) {
        for (const bone of bones) allowed.add(bone);
      }
    }
    const base = v * ipv;
    for (let i = 0; i < ipv; i += 1) {
      const w = params.weights[base + i]!;
      if (w <= 1e-6) continue;
      const joint = params.jointOrder[params.indices[base + i]!]!;
      if (!allowed.has(joint)) violations += 1;
    }
  }
  return { ok: violations === 0, violations };
}

export type { SkinBoneSegment, AutorigRegionEdit, PartialSkinWeightUpdate };
