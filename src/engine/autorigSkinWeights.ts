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
  torso: ['hips', 'spine', 'chest', 'upperSpine', 'leftClavicle', 'rightClavicle'],
  leftArm: [
    'leftUpperArm',
    'leftUpperArmTwist',
    'leftLowerArm',
    'leftLowerArmTwist',
    'leftHand',
    'leftHandEnd',
  ],
  rightArm: [
    'rightUpperArm',
    'rightUpperArmTwist',
    'rightLowerArm',
    'rightLowerArmTwist',
    'rightHand',
    'rightHandEnd',
  ],
  leftLeg: [
    'leftUpperLeg',
    'leftUpperLegTwist',
    'leftLowerLeg',
    'leftLowerLegTwist',
    'leftFoot',
    'leftToeBase',
  ],
  rightLeg: [
    'rightUpperLeg',
    'rightUpperLegTwist',
    'rightLowerLeg',
    'rightLowerLegTwist',
    'rightFoot',
    'rightToeBase',
  ],
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
  /** Vertices that fell back to hips (no bone capsule hit). Present on freshly generated weights. */
  fallbackVertexCount?: number;
  warnings?: string[];
}

/** Preferred child tips so hands run through the palm and feet through the toes. */
const SEGMENT_CHILD_OVERRIDE: Partial<Record<HumanJointId, HumanJointId>> = {
  leftHand: 'leftHandEnd',
  rightHand: 'rightHandEnd',
  leftFoot: 'leftToeBase',
  rightFoot: 'rightToeBase',
  leftLowerArm: 'leftHand',
  rightLowerArm: 'rightHand',
  leftLowerArmTwist: 'leftHand',
  rightLowerArmTwist: 'rightHand',
  leftLowerLeg: 'leftFoot',
  rightLowerLeg: 'rightFoot',
  leftLowerLegTwist: 'leftFoot',
  rightLowerLegTwist: 'rightFoot',
  leftUpperArm: 'leftLowerArm',
  rightUpperArm: 'rightLowerArm',
  leftUpperArmTwist: 'leftLowerArm',
  rightUpperArmTwist: 'rightLowerArm',
  leftUpperLeg: 'leftLowerLeg',
  rightUpperLeg: 'rightLowerLeg',
  leftUpperLegTwist: 'leftLowerLeg',
  rightUpperLegTwist: 'rightLowerLeg',
  leftClavicle: 'leftUpperArm',
  rightClavicle: 'rightUpperArm',
  hips: 'spine',
  spine: 'chest',
  chest: 'upperSpine',
  upperSpine: 'neck',
  neck: 'head',
};

export function buildSkinBoneSegments(
  jointPositions: Partial<Record<HumanJointId, Vec3>>,
): SkinBoneSegment[] {
  const jointOrder = HUMAN_JOINT_IDS.filter((id) => jointPositions[id]);
  const indexOf = new Map(jointOrder.map((id, index) => [id, index] as const));
  const childOf = new Map<HumanJointId, HumanJointId>();
  for (const [child, parent] of Object.entries(HUMAN_JOINT_PARENT) as Array<[HumanJointId, HumanJointId]>) {
    if (!childOf.has(parent)) childOf.set(parent, child);
  }
  for (const [parent, child] of Object.entries(SEGMENT_CHILD_OVERRIDE) as Array<[HumanJointId, HumanJointId]>) {
    childOf.set(parent, child);
  }
  const segments: SkinBoneSegment[] = [];
  for (const jointId of jointOrder) {
    const start = jointPositions[jointId];
    if (!start) continue;
    // Skip pure tip joints as segment origins (they only exist as endpoints).
    if (
      jointId === 'leftHandEnd' || jointId === 'rightHandEnd'
      || jointId === 'leftToeBase' || jointId === 'rightToeBase'
    ) {
      continue;
    }
    const child = childOf.get(jointId);
    let end = (child && jointPositions[child]) || undefined;
    if (!end) {
      // Last-resort continuation; prefer along limb, not arbitrary +Y.
      end = [start[0], start[1] + 0.08, start[2]] as Vec3;
    }
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

function isArmRegion(region: AutorigBodyRegion): boolean {
  return region === 'leftArm' || region === 'rightArm';
}

function segmentLength(segment: SkinBoneSegment): number {
  return Math.hypot(
    segment.end[0] - segment.start[0],
    segment.end[1] - segment.start[1],
    segment.end[2] - segment.start[2],
  );
}

/**
 * Anatomical fallback when a bone has too few mesh samples (stubs, missing limbs).
 * Not used as the primary radius for real geometry.
 */
function fallbackCapsuleRadius(
  segment: SkinBoneSegment,
  height: number,
  meshThickness: number,
  torsoHalfWidth: number,
): number {
  const length = segmentLength(segment);
  if (isLimbRegion(segment.region)) {
    // Capture clothed limbs / boxy fixtures (corner radius ≈ half-extent√2)
    // without returning to the old 7–18% height balloon.
    return Math.max(height * 0.065, Math.min(height * 0.13, Math.max(length * 0.4, height * 0.065)));
  }
  const anatomical = segment.region === 'torso' ? length * 0.32 : length * 0.5;
  const bodyFloor = Math.max(meshThickness * 0.45, torsoHalfWidth * 0.95);
  return Math.max(0.025, Math.min(height * 0.22, Math.max(bodyFloor, anatomical)));
}

/**
 * Skeleton topology only — which body side a vertex may train a bone's radius.
 * Prevents chest surface samples from inflating arm capsules (and vice versa).
 */
function vertexEligibleForRadiusSample(
  px: number,
  py: number,
  region: AutorigBodyRegion,
  shoulderX: number,
  hipY: number,
): boolean {
  switch (region) {
    case 'leftArm':
      // Past the shoulder socket — chest samples must not train arm radius.
      return px >= shoulderX * 0.9;
    case 'rightArm':
      return px <= -shoulderX * 0.9;
    case 'leftLeg':
      // Below/at hips, on the left half — hip socket mixes torso samples.
      return px >= 0 && py <= hipY + Math.max(shoulderX * 0.25, 0.06);
    case 'rightLeg':
      return px <= 0 && py <= hipY + Math.max(shoulderX * 0.25, 0.06);
    case 'head':
      return Math.abs(px) <= shoulderX * 0.85 && py >= hipY;
    case 'torso':
    default:
      return Math.abs(px) <= shoulderX * 0.95;
  }
}

/** Percentile of a non-empty unsorted sample list (mutates via sort). */
function percentileSorted(samples: number[], p: number): number {
  if (samples.length === 1) return samples[0]!;
  samples.sort((a, b) => a - b);
  const idx = Math.min(samples.length - 1, Math.max(0, Math.floor((samples.length - 1) * p)));
  return samples[idx]!;
}

/**
 * Per-bone capsule radii measured from the mesh: for each segment, take vertices
 * that structurally belong to that region, project onto the bone axis, and use a
 * high percentile of radial distances (plus pad) so the capsule hugs that
 * character's actual limb/torso thickness — not a fixed cm formula.
 */
export function estimateMeshCapsuleRadii(params: {
  positions: ArrayLike<number>;
  segments: SkinBoneSegment[];
  height: number;
  meshThickness: number;
  shoulderX: number;
  hipY: number;
  torsoHalfWidth: number;
}): Float32Array {
  const {
    positions, segments, height, meshThickness, shoulderX, hipY, torsoHalfWidth,
  } = params;
  const segCount = segments.length;
  const radii = new Float32Array(segCount);
  const vertexCount = Math.floor(positions.length / 3);
  // Soft search cylinder: ignore outliers far from any bone during sampling.
  const searchRadius = Math.max(height * 0.15, meshThickness * 0.6);
  const searchRadiusSq = searchRadius * searchRadius;
  const samples: number[][] = Array.from({ length: segCount }, () => []);

  for (let s = 0; s < segCount; s += 1) {
    const segment = segments[s]!;
    const abx = segment.end[0] - segment.start[0];
    const aby = segment.end[1] - segment.start[1];
    const abz = segment.end[2] - segment.start[2];
    const lenSq = Math.max(abx * abx + aby * aby + abz * abz, 1e-12);
    const region = segment.region;
    const bucket = samples[s]!;

    for (let v = 0; v < vertexCount; v += 1) {
      const px = positions[v * 3]!;
      const py = positions[v * 3 + 1]!;
      const pz = positions[v * 3 + 2]!;
      if (!vertexEligibleForRadiusSample(px, py, region, shoulderX, hipY)) continue;

      const apx = px - segment.start[0];
      const apy = py - segment.start[1];
      const apz = pz - segment.start[2];
      let t = (apx * abx + apy * aby + apz * abz) / lenSq;
      // Prefer the shaft; joint neighborhoods mix multiple body parts.
      if (t < 0.08 || t > 0.98) continue;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = apx - abx * t;
      const dy = apy - aby * t;
      const dz = apz - abz * t;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > searchRadiusSq) continue;
      bucket.push(Math.sqrt(distSq));
    }
  }

  for (let s = 0; s < segCount; s += 1) {
    const segment = segments[s]!;
    const fallback = fallbackCapsuleRadius(segment, height, meshThickness, torsoHalfWidth);
    const bucket = samples[s]!;
    // Need a handful of surface samples; otherwise keep anatomical fallback.
    if (bucket.length < 4) {
      radii[s] = fallback;
      continue;
    }
    // Prefer measured thickness with a modest pad. Avoid the previous
    // 98th×1.65 / 18%-height ceiling that stole torso and skirt verts.
    const measured = percentileSorted(bucket, 0.94) * 1.35;
    const floor = isLimbRegion(segment.region) ? height * 0.065 : height * 0.035;
    const ceiling = isLimbRegion(segment.region) ? height * 0.13 : height * 0.22;
    // Prefer measured thickness; never collapse below a usable limb floor.
    // Also cap by bone length so a fat upper-arm capsule cannot swallow the forearm.
    const lengthCap = Math.max(segmentLength(segment) * 0.55, floor);
    radii[s] = Math.max(floor, Math.min(ceiling, lengthCap, Math.max(measured, fallback)));
  }
  return radii;
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
  // Shoulder / hip anchors from fitted joints — structural gates + radius sampling masks.
  const leftShoulderX = Math.abs(params.jointPositions.leftUpperArm?.[0] ?? 0);
  const rightShoulderX = Math.abs(params.jointPositions.rightUpperArm?.[0] ?? 0);
  const shoulderX = Math.max(leftShoulderX, rightShoulderX, meshThickness * 0.35);
  const torsoHalfWidth = shoulderX;
  // Arm↔chest gate: hard-suppress inside 95% of shoulder span (clear chest),
  // then soft-ramp through the socket out to 108% of shoulder X for the deltoid.
  // Hard zero is required because the shoulder bone is often closer to outer-chest
  // verts than the midline chest bone is — a mild multiply still loses after normalize.
  const armGateInner = shoulderX * 0.95;
  const armGateOuter = shoulderX * 1.08;
  const armGateSpan = Math.max(armGateOuter - armGateInner, 1e-4);
  const hipY = params.jointPositions.hips?.[1]
    ?? params.jointPositions.spine?.[1]
    ?? height * 0.5;
  const neckY = params.jointPositions.neck?.[1]
    ?? params.jointPositions.chest?.[1]
    ?? height * 0.85;
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
  /** 1 = arm region (eligible for torso lateral gate), 0 otherwise. */
  const segIsArm = new Uint8Array(segCount);
  /** 1 = leg region (eligible for hip-height gate), 0 otherwise. */
  const segIsLeg = new Uint8Array(segCount);
  // Mesh-driven radii: each bone's capsule hugs that character's local thickness.
  const meshRadii = estimateMeshCapsuleRadii({
    positions: params.positions,
    segments,
    height,
    meshThickness,
    shoulderX,
    hipY,
    torsoHalfWidth,
  });
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
    const radius = meshRadii[s]!;
    segRadius[s] = radius;
    segRadiusSq[s] = radius * radius;
    segJoint[s] = segment.jointIndex;
    segSide[s] = segment.region === 'leftArm' || segment.region === 'leftLeg'
      ? -1
      : segment.region === 'rightArm' || segment.region === 'rightLeg'
        ? 1
        : 0;
    segIsArm[s] = isArmRegion(segment.region) ? 1 : 0;
    segIsLeg[s] = segment.region === 'leftLeg' || segment.region === 'rightLeg' ? 1 : 0;
  }

  const hipsIndex = Math.max(0, jointOrder.indexOf('hips'));
  // Reusable top-4 scratch (no per-vertex allocations / sorts).
  const topJoints = new Uint16Array(INFLUENCES_PER_VERTEX);
  const topWeights = new Float32Array(INFLUENCES_PER_VERTEX);
  // Legs must not claim chest/forearm verts; arms must still reach A-pose wrists
  // that hang well below the pelvis.
  const legGateY = hipY + Math.max(height * 0.02, 0.03);
  const armMinY = hipY - height * 0.45;
  for (let v = 0; v < vertexCount; v += 1) {
    const px = params.positions[v * 3]!;
    const py = params.positions[v * 3 + 1]!;
    const pz = params.positions[v * 3 + 2]!;
    let topN = 0;
    for (let s = 0; s < segCount; s += 1) {
      // Height + lateral gates: thighs must not swallow A-pose forearms hanging
      // below the pelvis, and arm capsules must not claim near-midline legs.
      if (segIsLeg[s]! && py > legGateY) continue;
      if (segIsLeg[s]! && Math.abs(px) > shoulderX * 0.75) continue;
      if (segIsArm[s]! && py < armMinY) continue;
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
      // Endpoint-only hits are weak: an upper-arm capsule must not claim the
      // forearm shaft just because the elbow tip is within radius.
      if (t < 0.04 || t > 0.96) weight *= 0.3;
      // Distance is authoritative; neighboring regions are penalized instead
      // of being broadly admitted by fixed world-space X/Y thresholds.
      const side = segSide[s]!;
      if ((side < 0 && px < -meshThickness) || (side > 0 && px > meshThickness)) weight *= 0.08;
      // Torso protection (arms only): chest vertices must not pick up arm bones.
      // Legs intentionally excluded — thighs sit well inside |x| < shoulderX.
      if (
        segIsArm[s]!
        && py >= hipY - 0.05
        && py <= neckY + 0.05
      ) {
        const ax = Math.abs(px);
        if (ax < armGateInner) {
          continue; // hard reject — still clearly on the torso
        }
        if (ax < armGateOuter) {
          const u = (ax - armGateInner) / armGateSpan;
          weight *= u * u; // soft blend into the shoulder socket
        }
      }
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

  const fallbackVertexCount = fallbackVertices.length;
  if (fallbackVertexCount > 0) {
    warnings.push(`${fallbackVertexCount} vertices could not be assigned confidently and use hips fallback.`);
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
