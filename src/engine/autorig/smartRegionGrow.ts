import type { HumanJointId, Vec3 } from '../../domain/types';
import type { CanonicalAutorigTopology } from './topology';
import {
  AUTORIG_REGION_CODE,
  AUTORIG_REGION_CODE_BY_ID,
  AUTORIG_REGION_ID_BY_CODE,
  REGION_CHAINS,
  type AutorigBodyRegionId,
  type AutorigRegionCode,
  isValidRegionCode,
} from './regions';

export type SmartPaintReach = 'precise' | 'normal' | 'broad';

export interface TriangleAdjacency {
  triangleOffsets: Uint32Array;
  adjacentTriangles: Uint32Array;
}

export interface SmartRegionGrowParams {
  topology: CanonicalAutorigTopology;
  /** Optional posed or rest positions for normal/distance scoring. */
  positions?: Float32Array | null;
  resolvedLabels: Uint8Array;
  seedTriangles?: ArrayLike<number> | null;
  seedVertices: ArrayLike<number>;
  blockedVertices?: ArrayLike<number> | null;
  targetRegion: AutorigBodyRegionId;
  jointPositions?: Partial<Record<HumanJointId, Vec3>> | null;
  reach?: SmartPaintReach;
}

export interface SmartRegionGrowResult {
  coreVertices: Uint32Array;
  expandedVertices: Uint32Array;
  confidence: Float32Array;
  boundaryVertices: Uint32Array;
  /** True when the entire connected component was selected. */
  selectedWholeComponent: boolean;
  seedVertexCount: number;
}

const REACH_LIMITS: Record<SmartPaintReach, {
  maxTriangleHops: number;
  coreRings: number;
  softCrossPenalty: number;
  minScore: number;
  smallComponentFraction: number;
  smallComponentMaxVerts: number;
}> = {
  precise: {
    maxTriangleHops: 6,
    coreRings: 1,
    softCrossPenalty: 0.35,
    minScore: 0.45,
    smallComponentFraction: 0.02,
    smallComponentMaxVerts: 800,
  },
  normal: {
    maxTriangleHops: 18,
    coreRings: 2,
    softCrossPenalty: 0.22,
    minScore: 0.32,
    smallComponentFraction: 0.04,
    smallComponentMaxVerts: 2500,
  },
  broad: {
    maxTriangleHops: 40,
    coreRings: 3,
    softCrossPenalty: 0.12,
    minScore: 0.22,
    smallComponentFraction: 0.08,
    smallComponentMaxVerts: 8000,
  },
};

const OPPOSITE_REGION: Partial<Record<AutorigBodyRegionId, AutorigBodyRegionId>> = {
  leftArm: 'rightArm',
  rightArm: 'leftArm',
  leftLeg: 'rightLeg',
  rightLeg: 'leftLeg',
};

/** Build undirected triangle adjacency from shared edges. */
export function buildTriangleAdjacency(
  topology: CanonicalAutorigTopology,
): TriangleAdjacency {
  const triangleCount = Math.floor(topology.triangles.length / 3);
  const edgeMap = new Map<string, number>();
  const pairs: number[] = [];

  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = topology.triangles[t * 3]!;
    const i1 = topology.triangles[t * 3 + 1]!;
    const i2 = topology.triangles[t * 3 + 2]!;
    const edges: Array<[number, number]> = [[i0, i1], [i1, i2], [i2, i0]];
    for (const [a, b] of edges) {
      const key = edgeKey(a, b);
      const other = edgeMap.get(key);
      if (other == null) {
        edgeMap.set(key, t);
      } else if (other !== t) {
        pairs.push(other, t);
        edgeMap.delete(key); // only one adjacent pair per edge for manifold meshes
      }
    }
  }

  const degree = new Uint32Array(triangleCount);
  for (let i = 0; i < pairs.length; i += 2) {
    degree[pairs[i]!]! += 1;
    degree[pairs[i + 1]!]! += 1;
  }
  const triangleOffsets = new Uint32Array(triangleCount + 1);
  for (let t = 0; t < triangleCount; t += 1) {
    triangleOffsets[t + 1] = triangleOffsets[t]! + degree[t]!;
  }
  const adjacentTriangles = new Uint32Array(triangleOffsets[triangleCount]!);
  const write = new Uint32Array(triangleCount);
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i]!;
    const b = pairs[i + 1]!;
    adjacentTriangles[triangleOffsets[a]! + write[a]!] = b;
    write[a]! += 1;
    adjacentTriangles[triangleOffsets[b]! + write[b]!] = a;
    write[b]! += 1;
  }
  return { triangleOffsets, adjacentTriangles };
}

function triangleCentroid(
  topology: CanonicalAutorigTopology,
  positions: Float32Array,
  triangleId: number,
): Vec3 {
  const i0 = topology.triangles[triangleId * 3]!;
  const i1 = topology.triangles[triangleId * 3 + 1]!;
  const i2 = topology.triangles[triangleId * 3 + 2]!;
  return [
    (positions[i0 * 3]! + positions[i1 * 3]! + positions[i2 * 3]!) / 3,
    (positions[i0 * 3 + 1]! + positions[i1 * 3 + 1]! + positions[i2 * 3 + 1]!) / 3,
    (positions[i0 * 3 + 2]! + positions[i1 * 3 + 2]! + positions[i2 * 3 + 2]!) / 3,
  ];
}

function triangleNormal(
  topology: CanonicalAutorigTopology,
  positions: Float32Array,
  triangleId: number,
): Vec3 {
  const i0 = topology.triangles[triangleId * 3]!;
  const i1 = topology.triangles[triangleId * 3 + 1]!;
  const i2 = topology.triangles[triangleId * 3 + 2]!;
  const ax = positions[i1 * 3]! - positions[i0 * 3]!;
  const ay = positions[i1 * 3 + 1]! - positions[i0 * 3 + 1]!;
  const az = positions[i1 * 3 + 2]! - positions[i0 * 3 + 2]!;
  const bx = positions[i2 * 3]! - positions[i0 * 3]!;
  const by = positions[i2 * 3 + 1]! - positions[i0 * 3 + 1]!;
  const bz = positions[i2 * 3 + 2]! - positions[i0 * 3 + 2]!;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function regionSkeletonPoints(
  region: AutorigBodyRegionId,
  joints: Partial<Record<HumanJointId, Vec3>>,
): Vec3[] {
  const points: Vec3[] = [];
  for (const jointId of REGION_CHAINS[region]) {
    const p = joints[jointId];
    if (p) points.push(p);
  }
  return points;
}

function nearestDistanceSq(point: Vec3, samples: Vec3[]): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const dx = point[0] - sample[0];
    const dy = point[1] - sample[1];
    const dz = point[2] - sample[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return best;
}

function seedTrianglesFromVertices(
  topology: CanonicalAutorigTopology,
  seedVertices: ArrayLike<number>,
): Uint32Array {
  const vertexCount = Math.floor(topology.positions.length / 3);
  const marked = new Uint8Array(vertexCount);
  for (let i = 0; i < seedVertices.length; i += 1) {
    const v = seedVertices[i]! >>> 0;
    if (v < vertexCount) marked[v] = 1;
  }
  const triangleCount = Math.floor(topology.triangles.length / 3);
  const hit: number[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = topology.triangles[t * 3]!;
    const i1 = topology.triangles[t * 3 + 1]!;
    const i2 = topology.triangles[t * 3 + 2]!;
    if (marked[i0] || marked[i1] || marked[i2]) hit.push(t);
  }
  return Uint32Array.from(hit);
}

function componentVertexCount(
  topology: CanonicalAutorigTopology,
  componentId: number,
): number {
  const start = topology.componentOffsets[componentId]!;
  const end = topology.componentOffsets[componentId + 1]!;
  return Math.max(0, end - start);
}

function selectWholeComponentVertices(
  topology: CanonicalAutorigTopology,
  componentId: number,
): Uint32Array {
  const start = topology.componentOffsets[componentId]!;
  const end = topology.componentOffsets[componentId + 1]!;
  return topology.componentVertices.subarray(start, end).slice();
}

/**
 * Smart Paint growth: stroke seeds → connected surface patch.
 * Existing labels are a soft preference, not a hard stop. Opposite limbs are rejected.
 */
export function smartGrowRegionPatch(params: SmartRegionGrowParams): SmartRegionGrowResult {
  const reach = params.reach ?? 'normal';
  const limits = REACH_LIMITS[reach];
  const { topology } = params;
  const positions = params.positions ?? topology.positions;
  const vertexCount = Math.floor(topology.positions.length / 3);
  const triangleCount = Math.floor(topology.triangles.length / 3);
  const adjacency = buildTriangleAdjacency(topology);
  const blocked = new Uint8Array(vertexCount);
  if (params.blockedVertices) {
    for (let i = 0; i < params.blockedVertices.length; i += 1) {
      const v = params.blockedVertices[i]! >>> 0;
      if (v < vertexCount) blocked[v] = 1;
    }
  }

  const seedTriangles = params.seedTriangles && params.seedTriangles.length > 0
    ? params.seedTriangles
    : seedTrianglesFromVertices(topology, params.seedVertices);

  const coreVerts = new Uint8Array(vertexCount);
  const selectedTriangles = new Uint8Array(triangleCount);
  const hops = new Int16Array(triangleCount);
  hops.fill(-1);
  const confidence = new Float32Array(vertexCount);
  const queue: number[] = [];

  const targetCode = AUTORIG_REGION_CODE_BY_ID[params.targetRegion];
  const opposite = OPPOSITE_REGION[params.targetRegion];
  const oppositeCode = opposite ? AUTORIG_REGION_CODE_BY_ID[opposite] : null;
  const targetSkeleton = params.jointPositions
    ? regionSkeletonPoints(params.targetRegion, params.jointPositions)
    : [];
  const oppositeSkeleton = opposite && params.jointPositions
    ? regionSkeletonPoints(opposite, params.jointPositions)
    : [];

  // Seed core: every vertex of every brushed triangle.
  for (let i = 0; i < seedTriangles.length; i += 1) {
    const t = seedTriangles[i]! >>> 0;
    if (t >= triangleCount || selectedTriangles[t]) continue;
    selectedTriangles[t] = 1;
    hops[t] = 0;
    queue.push(t);
    for (let k = 0; k < 3; k += 1) {
      const v = topology.triangles[t * 3 + k]!;
      if (blocked[v]) continue;
      coreVerts[v] = 1;
      confidence[v] = Math.max(confidence[v]!, 1);
    }
  }

  // Also mark explicit seed vertices as core.
  for (let i = 0; i < params.seedVertices.length; i += 1) {
    const v = params.seedVertices[i]! >>> 0;
    if (v >= vertexCount || blocked[v]) continue;
    coreVerts[v] = 1;
    confidence[v] = Math.max(confidence[v]!, 1);
  }

  const seedCore = Uint32Array.from(
    Array.from({ length: vertexCount }, (_, v) => v).filter((v) => coreVerts[v]),
  );

  // Small disconnected accessory/component → select entire piece.
  // Never treat the dominant body component as a "small piece".
  let selectedWholeComponent = false;
  if (seedCore.length > 0) {
    const componentId = topology.vertexComponent[seedCore[0]!]!;
    let sameComponent = true;
    for (let i = 1; i < seedCore.length; i += 1) {
      if (topology.vertexComponent[seedCore[i]!] !== componentId) {
        sameComponent = false;
        break;
      }
    }
    const compSize = componentVertexCount(topology, componentId);
    const meshSize = vertexCount;
    let largestComponent = 0;
    for (let c = 0; c < topology.componentCount; c += 1) {
      largestComponent = Math.max(largestComponent, componentVertexCount(topology, c));
    }
    const small = compSize > 0
      && compSize <= limits.smallComponentMaxVerts
      && compSize <= Math.max(24, meshSize * limits.smallComponentFraction)
      && compSize < largestComponent;
    if (sameComponent && small) {
      const all = selectWholeComponentVertices(topology, componentId);
      const expanded = new Uint8Array(vertexCount);
      for (let i = 0; i < all.length; i += 1) {
        const v = all[i]!;
        if (blocked[v]) continue;
        expanded[v] = 1;
        confidence[v] = Math.max(confidence[v]!, 0.95);
      }
      selectedWholeComponent = true;
      return finalizeGrowResult({
        vertexCount,
        coreVerts,
        expanded,
        confidence,
        selectedWholeComponent,
        seedVertexCount: seedCore.length,
      });
    }
  }

  // Priority-ish BFS by hop distance with soft scoring.
  let qi = 0;
  while (qi < queue.length) {
    const t = queue[qi++]!;
    const hop = hops[t]!;
    if (hop >= limits.maxTriangleHops) continue;
    const parentNormal = triangleNormal(topology, positions, t);
    const parentCentroid = triangleCentroid(topology, positions, t);
    const start = adjacency.triangleOffsets[t]!;
    const end = adjacency.triangleOffsets[t + 1]!;

    for (let ai = start; ai < end; ai += 1) {
      const n = adjacency.adjacentTriangles[ai]!;
      if (selectedTriangles[n]) continue;

      const n0 = topology.triangles[n * 3]!;
      const n1 = topology.triangles[n * 3 + 1]!;
      const n2 = topology.triangles[n * 3 + 2]!;
      if (blocked[n0] && blocked[n1] && blocked[n2]) continue;

      // Stay inside the same connected component.
      if (
        topology.vertexComponent[n0] !== topology.vertexComponent[topology.triangles[t * 3]!]
      ) continue;

      const labels = [params.resolvedLabels[n0]!, params.resolvedLabels[n1]!, params.resolvedLabels[n2]!];
      let oppositeHits = 0;
      let targetHits = 0;
      let unknownHits = 0;
      for (const code of labels) {
        if (oppositeCode != null && code === oppositeCode) oppositeHits += 1;
        if (code === targetCode) targetHits += 1;
        if (code === AUTORIG_REGION_CODE.unknown) unknownHits += 1;
      }
      // Hard anatomical rejection: never grow into opposite-limb surface.
      if (oppositeHits > 0) continue;

      let score = 1;
      // Soft label preference (not a hard barrier).
      if (targetHits === 3 || unknownHits === 3) score += 0.25;
      else if (targetHits + unknownHits >= 2) score += 0.1;
      else score -= limits.softCrossPenalty;

      const childNormal = triangleNormal(topology, positions, n);
      const normalDot = Math.max(
        -1,
        parentNormal[0] * childNormal[0]
          + parentNormal[1] * childNormal[1]
          + parentNormal[2] * childNormal[2],
      );
      // Smooth surfaces continue; sharp folds slow growth (soft).
      score += (normalDot - 0.2) * 0.35;

      const childCentroid = triangleCentroid(topology, positions, n);
      if (targetSkeleton.length > 0) {
        const dTarget = nearestDistanceSq(childCentroid, targetSkeleton);
        const dOpposite = oppositeSkeleton.length > 0
          ? nearestDistanceSq(childCentroid, oppositeSkeleton)
          : Number.POSITIVE_INFINITY;
        if (Number.isFinite(dTarget)) {
          if (dOpposite < dTarget * 0.85) {
            // Drifting toward the opposite limb — reject.
            continue;
          }
          // Closer to target skeleton is better.
          const prefer = dOpposite === Number.POSITIVE_INFINITY
            ? 0.15
            : Math.max(-0.2, Math.min(0.25, (Math.sqrt(dOpposite) - Math.sqrt(dTarget)) * 2));
          score += prefer;
        }
      }

      // Distance from parent (local continuity).
      const dx = childCentroid[0] - parentCentroid[0];
      const dy = childCentroid[1] - parentCentroid[1];
      const dz = childCentroid[2] - parentCentroid[2];
      const dist = Math.hypot(dx, dy, dz);
      score -= Math.min(0.25, dist * 0.8);

      // Prefer nearer hops.
      score -= hop * 0.015;

      if (score < limits.minScore) continue;

      selectedTriangles[n] = 1;
      hops[n] = hop + 1;
      queue.push(n);
      const conf = Math.max(0.2, Math.min(0.98, score));
      for (let k = 0; k < 3; k += 1) {
        const v = topology.triangles[n * 3 + k]!;
        if (blocked[v]) continue;
        confidence[v] = Math.max(confidence[v]!, conf);
      }
    }
  }

  // Convert selected triangles → vertices, then add a small core ring fill.
  const expanded = new Uint8Array(vertexCount);
  for (let t = 0; t < triangleCount; t += 1) {
    if (!selectedTriangles[t]) continue;
    for (let k = 0; k < 3; k += 1) {
      const v = topology.triangles[t * 3 + k]!;
      if (blocked[v]) continue;
      // Never claim opposite-limb vertices even if a mixed triangle slipped through.
      if (oppositeCode != null && params.resolvedLabels[v] === oppositeCode) continue;
      expanded[v] = 1;
    }
  }
  for (let v = 0; v < vertexCount; v += 1) {
    if (coreVerts[v]) expanded[v] = 1;
  }

  // Immediate adjacency rings around the grown patch (smoothing / fill holes).
  let frontier: number[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    if (expanded[v]) frontier.push(v);
  }
  for (let ring = 0; ring < limits.coreRings; ring += 1) {
    const next: number[] = [];
    for (const v of frontier) {
      const component = topology.vertexComponent[v]!;
      const start = topology.adjacencyOffsets[v]!;
      const end = topology.adjacencyOffsets[v + 1]!;
      for (let ai = start; ai < end; ai += 1) {
        const n = topology.adjacencyVertices[ai]!;
        if (expanded[n] || blocked[n]) continue;
        if (topology.vertexComponent[n] !== component) continue;
        const code = params.resolvedLabels[n]!;
        if (oppositeCode != null && code === oppositeCode) continue;
        // Also reject by skeleton side when joints are available.
        if (oppositeSkeleton.length > 0 && targetSkeleton.length > 0) {
          const p: Vec3 = [
            positions[n * 3]!,
            positions[n * 3 + 1]!,
            positions[n * 3 + 2]!,
          ];
          const dTarget = nearestDistanceSq(p, targetSkeleton);
          const dOpposite = nearestDistanceSq(p, oppositeSkeleton);
          if (dOpposite < dTarget) continue;
        }
        // Ring fill: same/unknown freely; other same-side labels only on first ring.
        if (code === targetCode || code === AUTORIG_REGION_CODE.unknown) {
          expanded[n] = 1;
          confidence[n] = Math.max(confidence[n]!, 0.4 - ring * 0.08);
          next.push(n);
        } else if (ring === 0) {
          expanded[n] = 1;
          confidence[n] = Math.max(confidence[n]!, 0.28);
          next.push(n);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return finalizeGrowResult({
    vertexCount,
    coreVerts,
    expanded,
    confidence,
    selectedWholeComponent,
    seedVertexCount: seedCore.length,
  });
}

function finalizeGrowResult(params: {
  vertexCount: number;
  coreVerts: Uint8Array;
  expanded: Uint8Array;
  confidence: Float32Array;
  selectedWholeComponent: boolean;
  seedVertexCount: number;
}): SmartRegionGrowResult {
  const core: number[] = [];
  const expandedList: number[] = [];
  const boundary: number[] = [];
  for (let v = 0; v < params.vertexCount; v += 1) {
    if (params.coreVerts[v]) core.push(v);
    if (params.expanded[v]) expandedList.push(v);
  }
  // Boundary ≈ expanded verts that still neighbor a non-expanded vert.
  // (Cheap approximation; useful for UI outline later.)
  for (const v of expandedList) {
    // Mark later if needed; keep empty for now unless we walk adjacency.
    void v;
  }
  return {
    coreVertices: Uint32Array.from(core),
    expandedVertices: Uint32Array.from(expandedList),
    confidence: params.confidence,
    boundaryVertices: Uint32Array.from(boundary),
    selectedWholeComponent: params.selectedWholeComponent,
    seedVertexCount: params.seedVertexCount,
  };
}

export function regionLabelForCode(code: number): AutorigBodyRegionId | null {
  if (!isValidRegionCode(code)) return null;
  return AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode];
}
