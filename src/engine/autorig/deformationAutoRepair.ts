/**
 * High-confidence automatic repair of isolated deformation "spike" vertices.
 *
 * Detects local edge-stretch outliers, groups them into tiny islands, and
 * proposes region-label or neighborhood-weight repairs. Callers must re-test
 * candidate repairs (validateAndApplyRepairs) so Neutral and diagnostic poses
 * only keep improvements.
 */

import type { HumanJointId, Vec3 } from '../../domain/types';
import type { SkinWeightBuffers } from '../autorigSkinWeights';
import {
  AUTORIG_REGION_CODE,
  AUTORIG_REGION_ID_BY_CODE,
  REGION_CHAINS,
  type AutorigBodyRegionId,
  type AutorigRegionCode,
  isValidRegionCode,
} from './regions';
import type { CanonicalAutorigTopology } from './topology';

export type DeformationRepairConfidence = 'automatic' | 'suggested' | 'manual';

export type DeformationPatchKind = 'spike' | 'island' | 'strip' | 'area';

export type DeformationRepairKind = 'region' | 'weights';

export interface DeformationOutlierVertex {
  vertexIndex: number;
  anomalyScore: number;
  maxEdgeStretch: number;
  medianEdgeStretch: number;
  movementDisagreement: number;
  weightDisagreement: number;
  regionDisagreement: number;
}

export interface DeformationOutlierPatch {
  vertexIndices: number[];
  kind: DeformationPatchKind;
  meanAnomalyScore: number;
  confidence: DeformationRepairConfidence;
}

export interface DeformationRepairProposal {
  patch: DeformationOutlierPatch;
  kind: DeformationRepairKind;
  confidence: DeformationRepairConfidence;
  /** Target region code when kind === 'region'. */
  newRegionCode?: AutorigRegionCode;
  /** Copied influence slots for kind === 'weights'. */
  weightPatch?: {
    vertexIndices: Uint32Array;
    indices: Uint16Array;
    weights: Float32Array;
  };
  reason: string;
}

export interface DiagnosticPoseFrame {
  poseId: string;
  positions: ArrayLike<number>;
}

export interface DeformationAutoRepairResult {
  applied: DeformationRepairProposal[];
  rejected: DeformationRepairProposal[];
  skipped: DeformationRepairProposal[];
  repairedVertexCount: number;
  regionLabels: Uint8Array;
  buffers: SkinWeightBuffers;
  iterations: number;
}

/** Extremely safe automatic thresholds (v1). */
export const DEFORMATION_AUTO_REPAIR_DEFAULTS = {
  /** Absolute edge stretch considered extreme. */
  extremeStretch: 4,
  /** maxStretch / medianNeighborStretch ratio. */
  stretchOutlierRatio: 2.75,
  /** Minimum anomaly score to consider a vertex. */
  anomalyThreshold: 0.55,
  /** Max vertices in an automatic island. */
  maxAutomaticIsland: 5,
  /** Neighbor region consensus (fraction of boundary edges). */
  majorityFraction: 0.8,
  /** Second-place region share above this → suggested, not automatic. */
  ambiguousSecondShare: 0.2,
  /** Weight L1 disagreement (0–2) to prefer weight repair. */
  weightDisagreementThreshold: 0.55,
  /** Movement disagreement relative to local median displacement. */
  movementOutlierRatio: 2.5,
  maxIterations: 3,
} as const;

const LEFT_REGIONS = new Set<AutorigBodyRegionId>(['leftArm', 'leftLeg']);
const RIGHT_REGIONS = new Set<AutorigBodyRegionId>(['rightArm', 'rightLeg']);

const REGION_COMPATIBLE: Record<AutorigBodyRegionId, ReadonlySet<AutorigBodyRegionId>> = {
  head: new Set(['head', 'torso']),
  torso: new Set(['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']),
  leftArm: new Set(['leftArm', 'torso']),
  rightArm: new Set(['rightArm', 'torso']),
  leftLeg: new Set(['leftLeg', 'torso']),
  rightLeg: new Set(['rightLeg', 'torso']),
};

function regionOf(code: number): AutorigBodyRegionId | null {
  if (!isValidRegionCode(code)) return null;
  return AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode];
}

function crossesLaterality(from: AutorigBodyRegionId, to: AutorigBodyRegionId): boolean {
  if (LEFT_REGIONS.has(from) && RIGHT_REGIONS.has(to)) return true;
  if (RIGHT_REGIONS.has(from) && LEFT_REGIONS.has(to)) return true;
  return false;
}

function anatomicallyCompatible(from: AutorigBodyRegionId, to: AutorigBodyRegionId): boolean {
  if (crossesLaterality(from, to)) return false;
  return REGION_COMPATIBLE[from]?.has(to) ?? false;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) * 0.5;
}

function cloneSkinBuffers(buffers: SkinWeightBuffers): SkinWeightBuffers {
  return {
    influencesPerVertex: buffers.influencesPerVertex,
    indices: new Uint16Array(buffers.indices),
    weights: new Float32Array(buffers.weights),
    jointOrder: buffers.jointOrder.slice(),
    fallbackVertexCount: buffers.fallbackVertexCount,
    ...(buffers.warnings ? { warnings: buffers.warnings.slice() } : {}),
  };
}

function dist3(
  positions: ArrayLike<number>,
  a: number,
  b: number,
): number {
  const ai = a * 3;
  const bi = b * 3;
  return Math.hypot(
    positions[ai]! - positions[bi]!,
    positions[ai + 1]! - positions[bi + 1]!,
    positions[ai + 2]! - positions[bi + 2]!,
  );
}

function displacement(
  rest: ArrayLike<number>,
  posed: ArrayLike<number>,
  v: number,
): [number, number, number] {
  const i = v * 3;
  return [
    posed[i]! - rest[i]!,
    posed[i + 1]! - rest[i + 1]!,
    posed[i + 2]! - rest[i + 2]!,
  ];
}

/** Dense joint-weight map for one vertex (length = jointOrder.length). */
function vertexWeightMap(
  buffers: SkinWeightBuffers,
  vertexIndex: number,
  out: Float32Array,
): void {
  out.fill(0);
  const ipv = buffers.influencesPerVertex;
  const base = vertexIndex * ipv;
  for (let slot = 0; slot < ipv; slot += 1) {
    const joint = buffers.indices[base + slot]!;
    const w = buffers.weights[base + slot]!;
    if (w > 0 && joint < out.length) out[joint]! += w;
  }
}

function weightL1(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += Math.abs(a[i]! - b[i]!);
  return sum;
}

/**
 * Aggregate anomaly score across diagnostic frames (max over poses).
 * Normalized relative to the mesh: edge stretch vs local median, movement vs
 * local neighbor median displacement.
 */
export function detectLocalDeformationOutliers(params: {
  restPositions: ArrayLike<number>;
  topology: CanonicalAutorigTopology;
  regionLabels: Uint8Array;
  buffers?: SkinWeightBuffers | null;
  frames: DiagnosticPoseFrame[];
  options?: Partial<typeof DEFORMATION_AUTO_REPAIR_DEFAULTS>;
}): DeformationOutlierVertex[] {
  const opts = { ...DEFORMATION_AUTO_REPAIR_DEFAULTS, ...params.options };
  const { topology, regionLabels, buffers } = params;
  const vertexCount = Math.floor(params.restPositions.length / 3);
  if (vertexCount === 0 || params.frames.length === 0) return [];
  if (topology.adjacencyOffsets.length !== vertexCount + 1) return [];

  const jointCount = buffers?.jointOrder.length ?? 0;
  const ownWeights = jointCount > 0 ? new Float32Array(jointCount) : null;
  const nbrWeights = jointCount > 0 ? new Float32Array(jointCount) : null;

  const bestScore = new Float32Array(vertexCount);
  const bestMaxStretch = new Float32Array(vertexCount);
  const bestMedianStretch = new Float32Array(vertexCount);
  const bestMoveDisagree = new Float32Array(vertexCount);
  const bestWeightDisagree = new Float32Array(vertexCount);
  const bestRegionDisagree = new Float32Array(vertexCount);

  for (const frame of params.frames) {
    if (frame.poseId === 'neutral') continue;
    const posed = frame.positions;
    if (Math.floor(posed.length / 3) < vertexCount) continue;

    for (let v = 0; v < vertexCount; v += 1) {
      const start = topology.adjacencyOffsets[v]!;
      const end = topology.adjacencyOffsets[v + 1]!;
      if (start === end) continue;

      const edgeStretches: number[] = [];
      let moveDx = 0;
      let moveDy = 0;
      let moveDz = 0;
      let moveCount = 0;
      let regionMismatch = 0;
      let regionCount = 0;
      let weightSum = 0;
      let weightCount = 0;

      const [vx, vy, vz] = displacement(params.restPositions, posed, v);
      const vDisp = Math.hypot(vx, vy, vz);
      const vRegion = regionLabels[v]!;

      if (ownWeights && buffers) vertexWeightMap(buffers, v, ownWeights);

      for (let ai = start; ai < end; ai += 1) {
        const u = topology.adjacencyVertices[ai]!;
        const restLen = Math.max(dist3(params.restPositions, v, u), 1e-8);
        const poseLen = dist3(posed, v, u);
        const stretch = poseLen / restLen;
        edgeStretches.push(stretch);

        const [ux, uy, uz] = displacement(params.restPositions, posed, u);
        moveDx += ux;
        moveDy += uy;
        moveDz += uz;
        moveCount += 1;

        regionCount += 1;
        if (regionLabels[u] !== vRegion) regionMismatch += 1;

        if (ownWeights && nbrWeights && buffers) {
          vertexWeightMap(buffers, u, nbrWeights);
          weightSum += weightL1(ownWeights, nbrWeights);
          weightCount += 1;
        }
      }

      const maxStretch = edgeStretches.reduce((a, b) => Math.max(a, b), 0);
      const medianStretch = medianOf(edgeStretches);
      // Fraction of incident edges that are badly stretched. True spikes tend to
      // stretch most of their edges; victims of a neighboring spike usually have
      // only one bad edge (to the spike) so this fraction stays low.
      const badEdgeFraction = edgeStretches.filter((s) => s >= 1.75).length
        / Math.max(edgeStretches.length, 1);

      // Neighbors' edge stretches that do NOT involve v — calm neighborhood.
      const neighborInteriorStretches: number[] = [];
      for (let ai = start; ai < end; ai += 1) {
        const u = topology.adjacencyVertices[ai]!;
        const uStart = topology.adjacencyOffsets[u]!;
        const uEnd = topology.adjacencyOffsets[u + 1]!;
        for (let uj = uStart; uj < uEnd; uj += 1) {
          const w = topology.adjacencyVertices[uj]!;
          if (w === v) continue;
          const restLen = Math.max(dist3(params.restPositions, u, w), 1e-8);
          const poseLen = dist3(posed, u, w);
          neighborInteriorStretches.push(poseLen / restLen);
        }
      }
      const neighborMedianInterior = medianOf(neighborInteriorStretches);
      const stretchOutlier = neighborMedianInterior > 1e-6
        ? maxStretch / Math.max(neighborMedianInterior, 1)
        : maxStretch;

      const meanNbrDx = moveCount > 0 ? moveDx / moveCount : 0;
      const meanNbrDy = moveCount > 0 ? moveDy / moveCount : 0;
      const meanNbrDz = moveCount > 0 ? moveDz / moveCount : 0;
      const moveDisagree = Math.hypot(vx - meanNbrDx, vy - meanNbrDy, vz - meanNbrDz);
      const nbrDisp = Math.hypot(meanNbrDx, meanNbrDy, meanNbrDz);
      const localMoveScale = Math.max(nbrDisp, vDisp * 0.25, 1e-5);
      const moveRatio = moveDisagree / localMoveScale;

      const weightDisagree = weightCount > 0 ? weightSum / weightCount : 0;
      const regionDisagree = regionCount > 0 ? regionMismatch / regionCount : 0;

      // Soft scores in ~[0, 1+] then combine. Median stretch + bad-edge fraction
      // distinguish the flying vertex from its one-edge-stretched neighbors.
      const maxScore = Math.max(
        0,
        (maxStretch - 1.35) / Math.max(opts.extremeStretch - 1.35, 1e-3),
      );
      const medianScore = Math.max(
        0,
        (medianStretch - 1.2) / Math.max(opts.extremeStretch * 0.75 - 1.2, 1e-3),
      );
      const outlierRatioScore = Math.max(
        0,
        (stretchOutlier - 1) / Math.max(opts.stretchOutlierRatio - 1, 1e-3),
      );
      const stretchScore = maxScore * 0.25
        + medianScore * 0.35
        + outlierRatioScore * 0.2
        + badEdgeFraction * 0.2;
      const moveScore = Math.max(0, (moveRatio - 1) / Math.max(opts.movementOutlierRatio - 1, 1e-3));
      const weightScore = weightDisagree / 2; // L1 in [0, 2]
      const regionScore = regionDisagree;

      const anomaly = stretchScore * 0.4
        + moveScore * 0.3
        + weightScore * 0.15
        + regionScore * 0.15;

      if (anomaly > bestScore[v]!) {
        bestScore[v] = anomaly;
        bestMaxStretch[v] = maxStretch;
        bestMedianStretch[v] = medianStretch;
        bestMoveDisagree[v] = moveDisagree;
        bestWeightDisagree[v] = weightDisagree;
        bestRegionDisagree[v] = regionDisagree;
      }
    }
  }

  const outliers: DeformationOutlierVertex[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    if (bestScore[v]! < opts.anomalyThreshold) continue;
    // Require a real stretch signal — pure label disagreements without strain
    // are not auto-repair targets.
    if (bestMaxStretch[v]! < 1.6) continue;
    // Victims of a neighboring spike: one long edge, calm median, coherent motion.
    // Keep them out unless region/weight disagreement is also strong.
    if (
      bestMedianStretch[v]! < 1.45
      && bestRegionDisagree[v]! < 0.5
      && bestWeightDisagree[v]! < opts.weightDisagreementThreshold
    ) {
      continue;
    }
    outliers.push({
      vertexIndex: v,
      anomalyScore: bestScore[v]!,
      maxEdgeStretch: bestMaxStretch[v]!,
      medianEdgeStretch: bestMedianStretch[v]!,
      movementDisagreement: bestMoveDisagree[v]!,
      weightDisagreement: bestWeightDisagree[v]!,
      regionDisagreement: bestRegionDisagree[v]!,
    });
  }
  return outliers;
}

/** Group connected suspicious vertices into patches. */
export function groupOutlierPatches(
  outliers: DeformationOutlierVertex[],
  topology: CanonicalAutorigTopology,
  options?: Partial<typeof DEFORMATION_AUTO_REPAIR_DEFAULTS>,
): DeformationOutlierPatch[] {
  const opts = { ...DEFORMATION_AUTO_REPAIR_DEFAULTS, ...options };
  if (outliers.length === 0) return [];
  const scoreByVertex = new Map<number, number>();
  for (const o of outliers) scoreByVertex.set(o.vertexIndex, o.anomalyScore);
  const visited = new Set<number>();
  const patches: DeformationOutlierPatch[] = [];

  for (const seed of outliers) {
    if (visited.has(seed.vertexIndex)) continue;
    const queue = [seed.vertexIndex];
    visited.add(seed.vertexIndex);
    const members: number[] = [];
    let scoreSum = 0;
    while (queue.length > 0) {
      const v = queue.pop()!;
      members.push(v);
      scoreSum += scoreByVertex.get(v) ?? 0;
      const start = topology.adjacencyOffsets[v]!;
      const end = topology.adjacencyOffsets[v + 1]!;
      for (let ai = start; ai < end; ai += 1) {
        const n = topology.adjacencyVertices[ai]!;
        if (visited.has(n) || !scoreByVertex.has(n)) continue;
        visited.add(n);
        queue.push(n);
      }
    }
    const size = members.length;
    let kind: DeformationPatchKind;
    let confidence: DeformationRepairConfidence;
    if (size === 1) {
      kind = 'spike';
      confidence = 'automatic';
    } else if (size <= opts.maxAutomaticIsland) {
      kind = 'island';
      confidence = 'automatic';
    } else if (size <= opts.maxAutomaticIsland * 3) {
      kind = 'strip';
      confidence = 'suggested';
    } else {
      kind = 'area';
      confidence = 'manual';
    }
    patches.push({
      vertexIndices: members,
      kind,
      meanAnomalyScore: scoreSum / size,
      confidence,
    });
  }

  patches.sort((a, b) => b.meanAnomalyScore - a.meanAnomalyScore);
  return patches;
}

interface NeighborRegionVote {
  majorityCode: AutorigRegionCode;
  majorityShare: number;
  secondShare: number;
  boundaryCount: number;
}

function neighborRegionVotes(
  vertexIndices: number[],
  topology: CanonicalAutorigTopology,
  regionLabels: Uint8Array,
): NeighborRegionVote | null {
  const counts = new Uint32Array(7);
  let boundary = 0;
  const memberSet = new Set(vertexIndices);
  for (const v of vertexIndices) {
    const start = topology.adjacencyOffsets[v]!;
    const end = topology.adjacencyOffsets[v + 1]!;
    for (let ai = start; ai < end; ai += 1) {
      const n = topology.adjacencyVertices[ai]!;
      if (memberSet.has(n)) continue;
      const code = regionLabels[n]!;
      if (!isValidRegionCode(code) || code === AUTORIG_REGION_CODE.unknown) continue;
      counts[code]! += 1;
      boundary += 1;
    }
  }
  if (boundary === 0) return null;
  let majorityCode: AutorigRegionCode = AUTORIG_REGION_CODE.torso;
  let majorityCount = 0;
  let secondCount = 0;
  for (let code = AUTORIG_REGION_CODE.head; code <= AUTORIG_REGION_CODE.rightLeg; code += 1) {
    const c = counts[code]!;
    if (c > majorityCount) {
      secondCount = majorityCount;
      majorityCount = c;
      majorityCode = code as AutorigRegionCode;
    } else if (c > secondCount) {
      secondCount = c;
    }
  }
  return {
    majorityCode,
    majorityShare: majorityCount / boundary,
    secondShare: secondCount / boundary,
    boundaryCount: boundary,
  };
}

function meanWeightDisagreement(
  vertexIndices: number[],
  topology: CanonicalAutorigTopology,
  regionLabels: Uint8Array,
  buffers: SkinWeightBuffers,
): number {
  const jointCount = buffers.jointOrder.length;
  if (jointCount === 0) return 0;
  const own = new Float32Array(jointCount);
  const nbr = new Float32Array(jointCount);
  let sum = 0;
  let count = 0;
  const memberSet = new Set(vertexIndices);
  for (const v of vertexIndices) {
    vertexWeightMap(buffers, v, own);
    const start = topology.adjacencyOffsets[v]!;
    const end = topology.adjacencyOffsets[v + 1]!;
    for (let ai = start; ai < end; ai += 1) {
      const u = topology.adjacencyVertices[ai]!;
      if (memberSet.has(u)) continue;
      if (regionLabels[u] !== regionLabels[v]) continue;
      vertexWeightMap(buffers, u, nbr);
      sum += weightL1(own, nbr);
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

function writeTopInfluences(
  indices: Uint16Array,
  weights: Float32Array,
  vertexIndex: number,
  ipv: number,
  jointWeights: Map<number, number>,
): void {
  const entries = [...jointWeights.entries()]
    .filter(([, w]) => w > 1e-6)
    .sort((a, b) => b[1]! - a[1]!);
  const top = entries.slice(0, ipv);
  let sum = 0;
  for (const [, w] of top) sum += w;
  const base = vertexIndex * ipv;
  for (let slot = 0; slot < ipv; slot += 1) {
    if (slot < top.length && sum > 1e-8) {
      indices[base + slot] = top[slot]![0]!;
      weights[base + slot] = top[slot]![1]! / sum;
    } else {
      indices[base + slot] = 0;
      weights[base + slot] = 0;
    }
  }
}

/**
 * Distance-weighted robust average of surrounding same-region weights.
 * Keeps strongest four influences and renormalizes.
 */
export function blendNeighborhoodWeights(params: {
  vertexIndices: number[];
  topology: CanonicalAutorigTopology;
  positions: ArrayLike<number>;
  regionLabels: Uint8Array;
  buffers: SkinWeightBuffers;
  /** Extra adjacency rings of smoothing after the blend (0–2). */
  smoothRings?: number;
}): {
  vertexIndices: Uint32Array;
  indices: Uint16Array;
  weights: Float32Array;
} {
  const { topology, buffers, regionLabels } = params;
  const ipv = buffers.influencesPerVertex;
  const jointCount = buffers.jointOrder.length;
  const memberSet = new Set(params.vertexIndices);
  const outIndices = new Uint16Array(params.vertexIndices.length * ipv);
  const outWeights = new Float32Array(params.vertexIndices.length * ipv);
  const scratch = new Float32Array(jointCount);

  for (let mi = 0; mi < params.vertexIndices.length; mi += 1) {
    const v = params.vertexIndices[mi]!;
    const vRegion = regionLabels[v]!;
    const vx = params.positions[v * 3]!;
    const vy = params.positions[v * 3 + 1]!;
    const vz = params.positions[v * 3 + 2]!;
    const accum = new Map<number, number>();
    let weightTotal = 0;

    const start = topology.adjacencyOffsets[v]!;
    const end = topology.adjacencyOffsets[v + 1]!;
    for (let ai = start; ai < end; ai += 1) {
      const u = topology.adjacencyVertices[ai]!;
      if (memberSet.has(u)) continue;
      if (regionLabels[u] !== vRegion) continue;
      const ux = params.positions[u * 3]!;
      const uy = params.positions[u * 3 + 1]!;
      const uz = params.positions[u * 3 + 2]!;
      const dist = Math.max(Math.hypot(vx - ux, vy - uy, vz - uz), 1e-5);
      const wDist = 1 / dist;
      vertexWeightMap(buffers, u, scratch);
      for (let j = 0; j < jointCount; j += 1) {
        const w = scratch[j]!;
        if (w <= 0) continue;
        accum.set(j, (accum.get(j) ?? 0) + w * wDist);
      }
      weightTotal += wDist;
    }

    if (weightTotal <= 1e-8) {
      // Fall back to copying first neighbor of any region.
      for (let ai = start; ai < end; ai += 1) {
        const u = topology.adjacencyVertices[ai]!;
        if (memberSet.has(u)) continue;
        vertexWeightMap(buffers, u, scratch);
        for (let j = 0; j < jointCount; j += 1) {
          const w = scratch[j]!;
          if (w > 0) accum.set(j, (accum.get(j) ?? 0) + w);
        }
        break;
      }
    }

    const localIndices = new Uint16Array(ipv);
    const localWeights = new Float32Array(ipv);
    writeTopInfluences(localIndices, localWeights, 0, ipv, accum);
    outIndices.set(localIndices, mi * ipv);
    outWeights.set(localWeights, mi * ipv);
  }

  // Optional one-ring smooth among repaired verts + outside neighbors.
  const rings = Math.max(0, Math.min(2, params.smoothRings ?? 1));
  if (rings > 0 && params.vertexIndices.length > 0) {
    const working = cloneSkinBuffers(buffers);
    for (let mi = 0; mi < params.vertexIndices.length; mi += 1) {
      const v = params.vertexIndices[mi]!;
      const base = v * ipv;
      const src = mi * ipv;
      for (let slot = 0; slot < ipv; slot += 1) {
        working.indices[base + slot] = outIndices[src + slot]!;
        working.weights[base + slot] = outWeights[src + slot]!;
      }
    }
    for (let ring = 0; ring < rings; ring += 1) {
      for (let mi = 0; mi < params.vertexIndices.length; mi += 1) {
        const v = params.vertexIndices[mi]!;
        const vRegion = regionLabels[v]!;
        const accum = new Map<number, number>();
        vertexWeightMap(working, v, scratch);
        for (let j = 0; j < jointCount; j += 1) {
          if (scratch[j]! > 0) accum.set(j, scratch[j]! * 0.5);
        }
        const start = topology.adjacencyOffsets[v]!;
        const end = topology.adjacencyOffsets[v + 1]!;
        let nbrN = 0;
        for (let ai = start; ai < end; ai += 1) {
          const u = topology.adjacencyVertices[ai]!;
          if (regionLabels[u] !== vRegion) continue;
          vertexWeightMap(working, u, scratch);
          nbrN += 1;
          for (let j = 0; j < jointCount; j += 1) {
            const w = scratch[j]!;
            if (w > 0) accum.set(j, (accum.get(j) ?? 0) + w * 0.5);
          }
        }
        if (nbrN === 0) continue;
        for (const [j, w] of accum) accum.set(j, w / Math.max(nbrN, 1));
        // Re-normalize against own 0.5 + neighbor 0.5 average already mixed.
        writeTopInfluences(working.indices, working.weights, v, ipv, accum);
      }
    }
    for (let mi = 0; mi < params.vertexIndices.length; mi += 1) {
      const v = params.vertexIndices[mi]!;
      const base = v * ipv;
      const dst = mi * ipv;
      for (let slot = 0; slot < ipv; slot += 1) {
        outIndices[dst + slot] = working.indices[base + slot]!;
        outWeights[dst + slot] = working.weights[base + slot]!;
      }
    }
  }

  return {
    vertexIndices: Uint32Array.from(params.vertexIndices),
    indices: outIndices,
    weights: outWeights,
  };
}

function patchTouchesAmbiguousSeam(
  vertexIndices: number[],
  topology: CanonicalAutorigTopology,
  regionLabels: Uint8Array,
): boolean {
  // If the island borders 3+ distinct regions, treat as seam-ish / ambiguous.
  const regions = new Set<number>();
  const memberSet = new Set(vertexIndices);
  for (const v of vertexIndices) {
    regions.add(regionLabels[v]!);
    const start = topology.adjacencyOffsets[v]!;
    const end = topology.adjacencyOffsets[v + 1]!;
    for (let ai = start; ai < end; ai += 1) {
      const n = topology.adjacencyVertices[ai]!;
      if (memberSet.has(n)) continue;
      regions.add(regionLabels[n]!);
    }
  }
  return regions.size >= 3;
}

function closerToRegionChain(
  vertexIndices: number[],
  positions: ArrayLike<number>,
  jointPositions: Partial<Record<HumanJointId, Vec3>> | null | undefined,
  candidate: AutorigBodyRegionId,
  current: AutorigBodyRegionId,
): boolean {
  if (!jointPositions) return true;
  const candChain = REGION_CHAINS[candidate];
  const currChain = REGION_CHAINS[current];
  let candSum = 0;
  let currSum = 0;
  let count = 0;
  for (const v of vertexIndices) {
    const px = positions[v * 3]!;
    const py = positions[v * 3 + 1]!;
    const pz = positions[v * 3 + 2]!;
    candSum += minDistToChain(px, py, pz, candChain, jointPositions);
    currSum += minDistToChain(px, py, pz, currChain, jointPositions);
    count += 1;
  }
  if (count === 0) return true;
  return candSum / count <= currSum / count * 1.05;
}

function minDistToChain(
  px: number,
  py: number,
  pz: number,
  chain: readonly HumanJointId[],
  jointPositions: Partial<Record<HumanJointId, Vec3>>,
): number {
  let best = Infinity;
  for (const id of chain) {
    const p = jointPositions[id];
    if (!p) continue;
    best = Math.min(best, Math.hypot(px - p[0], py - p[1], pz - p[2]));
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Propose high-confidence region or weight repairs for outlier patches.
 */
export function proposeDeformationRepairs(params: {
  patches: DeformationOutlierPatch[];
  outliers: DeformationOutlierVertex[];
  topology: CanonicalAutorigTopology;
  positions: ArrayLike<number>;
  regionLabels: Uint8Array;
  buffers: SkinWeightBuffers;
  jointPositions?: Partial<Record<HumanJointId, Vec3>> | null;
  options?: Partial<typeof DEFORMATION_AUTO_REPAIR_DEFAULTS>;
}): DeformationRepairProposal[] {
  const opts = { ...DEFORMATION_AUTO_REPAIR_DEFAULTS, ...params.options };
  const outlierByVertex = new Map(params.outliers.map((o) => [o.vertexIndex, o]));
  const proposals: DeformationRepairProposal[] = [];

  for (const patch of params.patches) {
    if (patch.confidence === 'manual') {
      proposals.push({
        patch,
        kind: 'region',
        confidence: 'manual',
        reason: 'Large ambiguous area — leave for Smart Paint.',
      });
      continue;
    }

    const votes = neighborRegionVotes(patch.vertexIndices, params.topology, params.regionLabels);
    if (!votes) {
      proposals.push({
        patch,
        kind: 'weights',
        confidence: 'manual',
        reason: 'No exterior neighbors to compare.',
      });
      continue;
    }

    const islandCodes = new Set(patch.vertexIndices.map((v) => params.regionLabels[v]!));
    const majorityRegion = regionOf(votes.majorityCode);
    if (!majorityRegion) continue;

    // Does the island disagree with the surrounding majority?
    let regionOutlier = false;
    for (const code of islandCodes) {
      if (code !== votes.majorityCode) {
        regionOutlier = true;
        break;
      }
    }

    const seamAmbiguous = patchTouchesAmbiguousSeam(
      patch.vertexIndices,
      params.topology,
      params.regionLabels,
    );

    if (regionOutlier) {
      let allCompatible = true;
      for (const v of patch.vertexIndices) {
        const from = regionOf(params.regionLabels[v]!);
        if (!from || !anatomicallyCompatible(from, majorityRegion)) {
          allCompatible = false;
          break;
        }
      }
      const strongMajority = votes.majorityShare >= opts.majorityFraction
        && votes.secondShare <= opts.ambiguousSecondShare
        && votes.boundaryCount >= Math.max(3, patch.vertexIndices.length);
      const chainOk = closerToRegionChain(
        patch.vertexIndices,
        params.positions,
        params.jointPositions,
        majorityRegion,
        regionOf(params.regionLabels[patch.vertexIndices[0]!]!) ?? majorityRegion,
      );

      let confidence: DeformationRepairConfidence = patch.confidence;
      if (!allCompatible || seamAmbiguous || !strongMajority || !chainOk) {
        confidence = seamAmbiguous || !allCompatible ? 'manual' : 'suggested';
      } else if (patch.kind === 'spike' || patch.kind === 'island') {
        confidence = 'automatic';
      }

      proposals.push({
        patch,
        kind: 'region',
        confidence,
        newRegionCode: votes.majorityCode,
        reason: confidence === 'automatic'
          ? `Relabel isolated ${patch.kind} to surrounding ${majorityRegion}.`
          : `Ambiguous region boundary near ${majorityRegion}.`,
      });
      continue;
    }

    // Same region as neighbors — try weight repair.
    const weightDisagree = meanWeightDisagreement(
      patch.vertexIndices,
      params.topology,
      params.regionLabels,
      params.buffers,
    );
    const stretchExtreme = patch.vertexIndices.some((v) => {
      const o = outlierByVertex.get(v);
      return o != null && o.maxEdgeStretch >= opts.extremeStretch * 0.7;
    });

    if (weightDisagree < opts.weightDisagreementThreshold && !stretchExtreme) {
      proposals.push({
        patch,
        kind: 'weights',
        confidence: 'suggested',
        reason: 'Deformation outlier without clear weight discontinuity.',
      });
      continue;
    }

    const weightPatch = blendNeighborhoodWeights({
      vertexIndices: patch.vertexIndices,
      topology: params.topology,
      positions: params.positions,
      regionLabels: params.regionLabels,
      buffers: params.buffers,
      smoothRings: 1,
    });

    let confidence: DeformationRepairConfidence = 'suggested';
    if (
      patch.confidence === 'automatic'
      && !seamAmbiguous
      && (patch.kind === 'spike' || patch.kind === 'island')
    ) {
      confidence = 'automatic';
    }

    proposals.push({
      patch,
      kind: 'weights',
      confidence,
      weightPatch,
      reason: confidence === 'automatic'
        ? 'Replace isolated weight spike with neighborhood blend.'
        : 'Weight discontinuity near a seam or larger patch.',
    });
  }

  return proposals;
}

export function applyRepairProposal(
  proposal: DeformationRepairProposal,
  regionLabels: Uint8Array,
  buffers: SkinWeightBuffers,
): { regionLabels: Uint8Array; buffers: SkinWeightBuffers } {
  const nextLabels = new Uint8Array(regionLabels);
  const nextBuffers = cloneSkinBuffers(buffers);
  if (proposal.kind === 'region' && proposal.newRegionCode != null) {
    for (const v of proposal.patch.vertexIndices) {
      nextLabels[v] = proposal.newRegionCode;
    }
  } else if (proposal.kind === 'weights' && proposal.weightPatch) {
    const ipv = nextBuffers.influencesPerVertex;
    const { vertexIndices, indices, weights } = proposal.weightPatch;
    for (let i = 0; i < vertexIndices.length; i += 1) {
      const v = vertexIndices[i]!;
      const src = i * ipv;
      const dst = v * ipv;
      for (let slot = 0; slot < ipv; slot += 1) {
        nextBuffers.indices[dst + slot] = indices[src + slot]!;
        nextBuffers.weights[dst + slot] = weights[src + slot]!;
      }
    }
  }
  return { regionLabels: nextLabels, buffers: nextBuffers };
}

/**
 * Sum of per-vertex anomaly scores (lower is better). Used to accept/reject repairs.
 */
export function scoreDeformationAnomalies(params: {
  restPositions: ArrayLike<number>;
  topology: CanonicalAutorigTopology;
  regionLabels: Uint8Array;
  buffers?: SkinWeightBuffers | null;
  frames: DiagnosticPoseFrame[];
  options?: Partial<typeof DEFORMATION_AUTO_REPAIR_DEFAULTS>;
}): { total: number; outlierCount: number; outliers: DeformationOutlierVertex[] } {
  const outliers = detectLocalDeformationOutliers(params);
  let total = 0;
  for (const o of outliers) total += o.anomalyScore;
  return { total, outlierCount: outliers.length, outliers };
}

/**
 * Transactionally apply high-confidence repairs. Only keeps changes that reduce
 * the anomaly score; Neutral must not regress when scoreNeutral is provided.
 */
export function validateAndApplyRepairs(params: {
  proposals: DeformationRepairProposal[];
  regionLabels: Uint8Array;
  buffers: SkinWeightBuffers;
  /** Score current labels+buffers (lower better). */
  scoreCurrent: number;
  /**
   * Evaluate a candidate. For region repairs the caller should regenerate
   * Binder V2 weights from the candidate labels before posing.
   */
  evaluateCandidate: (candidate: {
    regionLabels: Uint8Array;
    buffers: SkinWeightBuffers;
    proposal: DeformationRepairProposal;
  }) => {
    score: number;
    /** Optional regenerated buffers after region relabel. */
    buffers?: SkinWeightBuffers;
    frames?: DiagnosticPoseFrame[];
    /** Neutral max drift; > tolerance rejects. */
    neutralMaxDrift?: number;
  };
  /** Only apply these confidence tiers (default: automatic). */
  acceptConfidence?: DeformationRepairConfidence[];
  neutralTolerance?: number;
}): DeformationAutoRepairResult {
  const accept = new Set(params.acceptConfidence ?? ['automatic']);
  let labels = new Uint8Array(params.regionLabels);
  let buffers = cloneSkinBuffers(params.buffers);
  let currentScore = params.scoreCurrent;
  const applied: DeformationRepairProposal[] = [];
  const rejected: DeformationRepairProposal[] = [];
  const skipped: DeformationRepairProposal[] = [];
  const repaired = new Set<number>();

  // Smallest / highest-score first among automatic spikes.
  const ordered = params.proposals.slice().sort((a, b) => {
    if (a.confidence !== b.confidence) {
      const rank = { automatic: 0, suggested: 1, manual: 2 };
      return rank[a.confidence] - rank[b.confidence];
    }
    if (a.patch.vertexIndices.length !== b.patch.vertexIndices.length) {
      return a.patch.vertexIndices.length - b.patch.vertexIndices.length;
    }
    return b.patch.meanAnomalyScore - a.patch.meanAnomalyScore;
  });

  for (const proposal of ordered) {
    if (!accept.has(proposal.confidence)) {
      skipped.push(proposal);
      continue;
    }
    if (proposal.kind === 'region' && proposal.newRegionCode == null) {
      skipped.push(proposal);
      continue;
    }
    if (proposal.kind === 'weights' && !proposal.weightPatch) {
      skipped.push(proposal);
      continue;
    }

    const snapshotLabels = new Uint8Array(labels);
    const snapshotBuffers = cloneSkinBuffers(buffers);
    const trial = applyRepairProposal(proposal, labels, buffers);

    const evaluation = params.evaluateCandidate({
      regionLabels: trial.regionLabels,
      buffers: trial.buffers,
      proposal,
    });
    const nextBuffers = evaluation.buffers ?? trial.buffers;
    const neutralOk = evaluation.neutralMaxDrift == null
      || evaluation.neutralMaxDrift <= (params.neutralTolerance ?? 1e-3);
    const improved = evaluation.score < currentScore * 0.98
      || (evaluation.score <= currentScore && proposal.patch.vertexIndices.length <= 2);

    if (!neutralOk || !improved) {
      rejected.push(proposal);
      labels = snapshotLabels;
      buffers = snapshotBuffers;
      continue;
    }

    labels = trial.regionLabels;
    buffers = cloneSkinBuffers(nextBuffers);
    currentScore = evaluation.score;
    applied.push(proposal);
    for (const v of proposal.patch.vertexIndices) repaired.add(v);
  }

  return {
    applied,
    rejected,
    skipped,
    repairedVertexCount: repaired.size,
    regionLabels: labels,
    buffers,
    iterations: 1,
  };
}

/**
 * Full detect → propose → validate loop for high-confidence spikes.
 * The caller supplies pose evaluation (typically silent diagnostic poses).
 */
export function runHighConfidenceDeformationAutoRepair(params: {
  restPositions: ArrayLike<number>;
  topology: CanonicalAutorigTopology;
  regionLabels: Uint8Array;
  buffers: SkinWeightBuffers;
  frames: DiagnosticPoseFrame[];
  jointPositions?: Partial<Record<HumanJointId, Vec3>> | null;
  /**
   * After a region label change, regenerate Binder V2 weights (full or partial).
   * Weight-only proposals skip this.
   */
  regenerateWeights: (regionLabels: Uint8Array) => SkinWeightBuffers;
  /**
   * Re-pose the candidate buffers and return diagnostic frames (and optional
   * Neutral drift).
   */
  evaluatePoseFrames: (buffers: SkinWeightBuffers) => {
    frames: DiagnosticPoseFrame[];
    neutralMaxDrift?: number;
  };
  options?: Partial<typeof DEFORMATION_AUTO_REPAIR_DEFAULTS>;
}): DeformationAutoRepairResult {
  const opts = { ...DEFORMATION_AUTO_REPAIR_DEFAULTS, ...params.options };
  let labels = new Uint8Array(params.regionLabels);
  let buffers = cloneSkinBuffers(params.buffers);
  let frames = params.frames;
  const allApplied: DeformationRepairProposal[] = [];
  const allRejected: DeformationRepairProposal[] = [];
  const allSkipped: DeformationRepairProposal[] = [];
  const repaired = new Set<number>();

  for (let iteration = 0; iteration < opts.maxIterations; iteration += 1) {
    const scored = scoreDeformationAnomalies({
      restPositions: params.restPositions,
      topology: params.topology,
      regionLabels: labels,
      buffers,
      frames,
      options: opts,
    });
    if (scored.outlierCount === 0) {
      return {
        applied: allApplied,
        rejected: allRejected,
        skipped: allSkipped,
        repairedVertexCount: repaired.size,
        regionLabels: labels,
        buffers,
        iterations: iteration,
      };
    }

    const patches = groupOutlierPatches(scored.outliers, params.topology, opts);
    const proposals = proposeDeformationRepairs({
      patches,
      outliers: scored.outliers,
      topology: params.topology,
      positions: params.restPositions,
      regionLabels: labels,
      buffers,
      jointPositions: params.jointPositions,
      options: opts,
    });

    const automatic = proposals.filter((p) => p.confidence === 'automatic');
    if (automatic.length === 0) {
      allSkipped.push(...proposals);
      return {
        applied: allApplied,
        rejected: allRejected,
        skipped: allSkipped,
        repairedVertexCount: repaired.size,
        regionLabels: labels,
        buffers,
        iterations: iteration + 1,
      };
    }

    let changed = false;
    // Apply one patch at a time, smallest first.
    automatic.sort((a, b) => {
      if (a.patch.vertexIndices.length !== b.patch.vertexIndices.length) {
        return a.patch.vertexIndices.length - b.patch.vertexIndices.length;
      }
      return b.patch.meanAnomalyScore - a.patch.meanAnomalyScore;
    });

    for (const proposal of automatic) {
      const snapshotLabels = new Uint8Array(labels);
      const snapshotBuffers = cloneSkinBuffers(buffers);
      const trial = applyRepairProposal(proposal, labels, buffers);
      let candidateBuffers = trial.buffers;
      if (proposal.kind === 'region') {
        candidateBuffers = params.regenerateWeights(trial.regionLabels);
        // Neighborhood cleanup after relabel.
        const blended = blendNeighborhoodWeights({
          vertexIndices: proposal.patch.vertexIndices,
          topology: params.topology,
          positions: params.restPositions,
          regionLabels: trial.regionLabels,
          buffers: candidateBuffers,
          smoothRings: 1,
        });
        const ipv = candidateBuffers.influencesPerVertex;
        for (let i = 0; i < blended.vertexIndices.length; i += 1) {
          const v = blended.vertexIndices[i]!;
          const src = i * ipv;
          const dst = v * ipv;
          for (let slot = 0; slot < ipv; slot += 1) {
            candidateBuffers.indices[dst + slot] = blended.indices[src + slot]!;
            candidateBuffers.weights[dst + slot] = blended.weights[src + slot]!;
          }
        }
      }

      const evaluation = params.evaluatePoseFrames(candidateBuffers);
      const nextScore = scoreDeformationAnomalies({
        restPositions: params.restPositions,
        topology: params.topology,
        regionLabels: trial.regionLabels,
        buffers: candidateBuffers,
        frames: evaluation.frames,
        options: opts,
      });
      const neutralOk = evaluation.neutralMaxDrift == null
        || evaluation.neutralMaxDrift <= 1e-3;
      const improved = nextScore.total < scored.total * 0.98
        || (
          nextScore.total <= scored.total
          && nextScore.outlierCount < scored.outlierCount
        );

      if (!neutralOk || !improved) {
        allRejected.push(proposal);
        labels = snapshotLabels;
        buffers = snapshotBuffers;
        continue;
      }

      labels = trial.regionLabels;
      buffers = candidateBuffers;
      frames = evaluation.frames;
      allApplied.push(proposal);
      for (const v of proposal.patch.vertexIndices) repaired.add(v);
      changed = true;
      // Refresh baseline score for subsequent patches in this iteration.
      scored.total = nextScore.total;
      scored.outlierCount = nextScore.outlierCount;
    }

    for (const p of proposals) {
      if (p.confidence !== 'automatic') allSkipped.push(p);
    }

    if (!changed) break;
  }

  return {
    applied: allApplied,
    rejected: allRejected,
    skipped: allSkipped,
    repairedVertexCount: repaired.size,
    regionLabels: labels,
    buffers,
    iterations: opts.maxIterations,
  };
}

/** Pose IDs used for silent deformation auto-repair diagnostics. */
export const DEFORMATION_AUTO_REPAIR_POSE_IDS = [
  'arms-raised',
  'elbows-bent',
  'walking',
  'sitting',
  'crouching',
] as const;

/** User-facing prepare banner after automatic spike cleanup. */
export function formatDeformationAutoRepairMessage(
  result: Pick<DeformationAutoRepairResult, 'repairedVertexCount' | 'applied'>,
): string | null {
  if (result.repairedVertexCount <= 0 || result.applied.length === 0) return null;
  const n = result.repairedVertexCount;
  return `Rig prepared — ${n} deformation spike${n === 1 ? '' : 's'} corrected automatically.`;
}

/**
 * Build hard overrides that force `repairedLabels` over `suggested`, leaving
 * vertices that already match suggested as 0 (use automatic).
 */
export function overridesFromRepairedLabels(params: {
  suggested: Uint8Array;
  previousOverrides: Uint8Array | null | undefined;
  repairedLabels: Uint8Array;
}): Uint8Array {
  const { suggested, repairedLabels } = params;
  const out = params.previousOverrides && params.previousOverrides.length === suggested.length
    ? new Uint8Array(params.previousOverrides)
    : new Uint8Array(suggested.length);
  const n = Math.min(suggested.length, repairedLabels.length);
  for (let v = 0; v < n; v += 1) {
    if (repairedLabels[v] === suggested[v]) continue;
    out[v] = repairedLabels[v]!;
  }
  return out;
}
