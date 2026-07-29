import type { CanonicalAutorigTopology } from './topology';
import {
  AUTORIG_REGION_CODE,
  AUTORIG_REGION_ID_BY_CODE,
  type AutorigBodyRegionId,
  type AutorigRegionCode,
  isValidRegionCode,
} from './regions';

export interface AutorigRegionEdit {
  changedVertices: Uint32Array;
  previousLabels: Uint8Array;
  nextLabels: Uint8Array;
}

const SEAM_REGION_PAIRS: ReadonlyArray<readonly [AutorigBodyRegionId, AutorigBodyRegionId]> = [
  ['head', 'torso'],
  ['torso', 'leftArm'],
  ['torso', 'rightArm'],
  ['torso', 'leftLeg'],
  ['torso', 'rightLeg'],
];

function isSeamPair(a: AutorigBodyRegionId, b: AutorigBodyRegionId): boolean {
  for (const [x, y] of SEAM_REGION_PAIRS) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

/** Expand a seed set across `rings` adjacency hops within the same connected component. */
export function expandVertexRings(params: {
  topology: CanonicalAutorigTopology;
  seeds: ArrayLike<number>;
  rings: number;
  /** Optional mask — when provided, only vertices with mask[v] === 1 are kept/expanded. */
  mask?: Uint8Array | null;
}): Uint32Array {
  const { topology, rings } = params;
  const vertexCount = Math.floor(topology.positions.length / 3);
  const selected = new Uint8Array(vertexCount);
  let frontier: number[] = [];

  for (let i = 0; i < params.seeds.length; i += 1) {
    const v = params.seeds[i]! >>> 0;
    if (v >= vertexCount || selected[v]) continue;
    if (params.mask && !params.mask[v]) continue;
    selected[v] = 1;
    frontier.push(v);
  }

  for (let ring = 0; ring < rings; ring += 1) {
    const next: number[] = [];
    for (const v of frontier) {
      const component = topology.vertexComponent[v]!;
      const start = topology.adjacencyOffsets[v]!;
      const end = topology.adjacencyOffsets[v + 1]!;
      for (let ai = start; ai < end; ai += 1) {
        const n = topology.adjacencyVertices[ai]!;
        if (selected[n]) continue;
        if (topology.vertexComponent[n] !== component) continue;
        if (params.mask && !params.mask[n]) continue;
        selected[n] = 1;
        next.push(n);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const out: number[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    if (selected[v]) out.push(v);
  }
  return Uint32Array.from(out);
}

/**
 * Collect neck / shoulder / hip seam vertices whose region membership changed,
 * or that sit on a seam edge involving a changed region.
 */
export function collectAffectedSeamVertices(params: {
  topology: CanonicalAutorigTopology;
  previousLabels: Uint8Array;
  nextLabels: Uint8Array;
  changedVertices: ArrayLike<number>;
}): Uint32Array {
  const { topology, previousLabels, nextLabels } = params;
  const vertexCount = Math.min(previousLabels.length, nextLabels.length);
  const changedRegions = new Set<AutorigBodyRegionId>();
  const seed = new Uint8Array(vertexCount);

  for (let i = 0; i < params.changedVertices.length; i += 1) {
    const v = params.changedVertices[i]! >>> 0;
    if (v >= vertexCount) continue;
    seed[v] = 1;
    const prev = AUTORIG_REGION_ID_BY_CODE[previousLabels[v]! as AutorigRegionCode];
    const next = AUTORIG_REGION_ID_BY_CODE[nextLabels[v]! as AutorigRegionCode];
    if (prev) changedRegions.add(prev);
    if (next) changedRegions.add(next);
  }

  const seams: number[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    const code = nextLabels[v]!;
    if (!isValidRegionCode(code) && code !== AUTORIG_REGION_CODE.unknown) continue;
    const region = AUTORIG_REGION_ID_BY_CODE[code as AutorigRegionCode];
    if (!region) continue;
    const start = topology.adjacencyOffsets[v]!;
    const end = topology.adjacencyOffsets[v + 1]!;
    for (let ai = start; ai < end; ai += 1) {
      const n = topology.adjacencyVertices[ai]!;
      const nRegion = AUTORIG_REGION_ID_BY_CODE[nextLabels[n]! as AutorigRegionCode];
      if (!nRegion || nRegion === region) continue;
      if (!isSeamPair(region, nRegion)) continue;
      // Include seam verts near the edit or on a changed region's seam.
      if (
        seed[v]
        || seed[n]
        || changedRegions.has(region)
        || changedRegions.has(nRegion)
      ) {
        seams.push(v);
        break;
      }
    }
  }
  return Uint32Array.from(seams);
}

/**
 * Build the dirty vertex set for a region correction:
 * 1. Explicitly painted / changed vertices
 * 2. Four adjacency rings around those vertices
 * 3. Affected neck / shoulder / hip seam vertices
 * 4. Two additional rings around those seams
 */
export function buildDirtyVertexSet(params: {
  topology: CanonicalAutorigTopology;
  edit: AutorigRegionEdit;
  paintRings?: number;
  seamRings?: number;
}): Uint32Array {
  const paintRings = params.paintRings ?? 4;
  const seamRings = params.seamRings ?? 2;
  const paintedExpanded = expandVertexRings({
    topology: params.topology,
    seeds: params.edit.changedVertices,
    rings: paintRings,
  });

  const seams = collectAffectedSeamVertices({
    topology: params.topology,
    previousLabels: params.edit.previousLabels,
    nextLabels: params.edit.nextLabels,
    changedVertices: params.edit.changedVertices,
  });

  const seamExpanded = expandVertexRings({
    topology: params.topology,
    seeds: seams,
    rings: seamRings,
  });

  const vertexCount = Math.floor(params.topology.positions.length / 3);
  const selected = new Uint8Array(vertexCount);
  for (let i = 0; i < paintedExpanded.length; i += 1) selected[paintedExpanded[i]!] = 1;
  for (let i = 0; i < seamExpanded.length; i += 1) selected[seamExpanded[i]!] = 1;

  const out: number[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    if (selected[v]) out.push(v);
  }
  return Uint32Array.from(out);
}

/** Diff two resolved label buffers into an AutorigRegionEdit. */
export function createRegionEditFromLabels(params: {
  previousLabels: Uint8Array;
  nextLabels: Uint8Array;
}): AutorigRegionEdit | null {
  const n = Math.min(params.previousLabels.length, params.nextLabels.length);
  const changed: number[] = [];
  for (let v = 0; v < n; v += 1) {
    if (params.previousLabels[v] !== params.nextLabels[v]) changed.push(v);
  }
  if (changed.length === 0) return null;
  return {
    changedVertices: Uint32Array.from(changed),
    previousLabels: new Uint8Array(params.previousLabels),
    nextLabels: new Uint8Array(params.nextLabels),
  };
}
