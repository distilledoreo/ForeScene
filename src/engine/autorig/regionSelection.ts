import type { CanonicalAutorigTopology } from './topology';
import {
  AUTORIG_REGION_CODE,
  type AutorigBodyRegionId,
  type AutorigRegionCode,
  AUTORIG_REGION_CODE_BY_ID,
  isValidRegionCode,
} from './regions';

export interface LassoPoint {
  x: number;
  y: number;
}

export interface LassoBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Close the path and drop consecutive near-duplicates. */
export function simplifyLassoPolygon(
  points: ReadonlyArray<LassoPoint>,
  minDistance = 1.5,
): LassoPoint[] {
  if (points.length === 0) return [];
  const out: LassoPoint[] = [{ x: points[0]!.x, y: points[0]!.y }];
  const minDistSq = minDistance * minDistance;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i]!;
    const prev = out[out.length - 1]!;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    if (dx * dx + dy * dy < minDistSq) continue;
    out.push({ x: p.x, y: p.y });
  }
  if (out.length >= 3) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    if (dx * dx + dy * dy > minDistSq) out.push({ x: first.x, y: first.y });
  }
  return out;
}

export function lassoBoundingRect(points: ReadonlyArray<LassoPoint>): LassoBounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** Even-odd / winding point-in-polygon (ray cast). */
export function pointInPolygon(x: number, y: number, polygon: ReadonlyArray<LassoPoint>): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x;
    const yi = polygon[i]!.y;
    const xj = polygon[j]!.x;
    const yj = polygon[j]!.y;
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Expand seed vertices across connected geometry that already matches the target
 * region (or is still unknown), stopping at strong competing-region boundaries.
 * Explicit seeds are always preserved as hard overrides.
 */
export function expandRegionCorrection(params: {
  topology: CanonicalAutorigTopology;
  /** Current resolved labels (suggested ⊕ overrides). */
  resolved: Uint8Array;
  seedVertices: ArrayLike<number>;
  region: AutorigBodyRegionId;
  /** Soft automatic labels — expansion may reclaim these when they match `region`. */
  suggested?: Uint8Array | null;
}): Uint32Array {
  const { topology, resolved } = params;
  const target = AUTORIG_REGION_CODE_BY_ID[params.region];
  const vertexCount = resolved.length;
  const selected = new Uint8Array(vertexCount);
  const queue: number[] = [];

  for (let i = 0; i < params.seedVertices.length; i += 1) {
    const v = params.seedVertices[i]! >>> 0;
    if (v >= vertexCount || selected[v]) continue;
    selected[v] = 1;
    queue.push(v);
  }

  let qi = 0;
  while (qi < queue.length) {
    const v = queue[qi++]!;
    const component = topology.vertexComponent[v]!;
    const start = topology.adjacencyOffsets[v]!;
    const end = topology.adjacencyOffsets[v + 1]!;
    for (let ai = start; ai < end; ai += 1) {
      const n = topology.adjacencyVertices[ai]!;
      if (selected[n]) continue;
      if (topology.vertexComponent[n] !== component) continue;
      const label = resolved[n]!;
      if (label === target || label === AUTORIG_REGION_CODE.unknown) {
        selected[n] = 1;
        queue.push(n);
        continue;
      }
      // Soft reclaim: neighbor still matches the automatic suggestion for this region.
      const soft = params.suggested?.[n];
      if (soft === target && label === soft) {
        selected[n] = 1;
        queue.push(n);
      }
    }
  }

  const out: number[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    if (selected[v]) out.push(v);
  }
  return Uint32Array.from(out);
}

/**
 * Apply a hard override for the given vertices (and expanded set) onto an
 * overrides buffer. Returns a new overrides array (0 = no override).
 */
export function applyRegionLassoOverride(params: {
  overrides: Uint8Array;
  vertexIndices: ArrayLike<number>;
  region: AutorigBodyRegionId;
}): Uint8Array {
  const next = new Uint8Array(params.overrides);
  const code = AUTORIG_REGION_CODE_BY_ID[params.region];
  for (let i = 0; i < params.vertexIndices.length; i += 1) {
    const v = params.vertexIndices[i]! >>> 0;
    if (v < next.length) next[v] = code;
  }
  return next;
}

/** Clear hard overrides for the given vertices (restore automatic behavior). */
export function clearRegionOverridesAt(params: {
  overrides: Uint8Array;
  vertexIndices: ArrayLike<number>;
}): Uint8Array {
  const next = new Uint8Array(params.overrides);
  for (let i = 0; i < params.vertexIndices.length; i += 1) {
    const v = params.vertexIndices[i]! >>> 0;
    if (v < next.length) next[v] = AUTORIG_REGION_CODE.unknown;
  }
  return next;
}

/**
 * CPU fallback: select triangles whose projected centroid lies inside the lasso.
 * Prefer the WebGL visible-surface pass when available; this is for tests and
 * environments without a selection render target.
 */
export function selectTrianglesInLassoCpu(params: {
  topology: CanonicalAutorigTopology;
  projectVertex: (vertexIndex: number) => { x: number; y: number } | null;
  polygon: ReadonlyArray<LassoPoint>;
}): Uint32Array {
  const { topology, polygon } = params;
  if (polygon.length < 3) return new Uint32Array(0);
  const bounds = lassoBoundingRect(polygon);
  if (!bounds) return new Uint32Array(0);
  const triangleCount = Math.floor(topology.triangles.length / 3);
  const hit: number[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = topology.triangles[t * 3]!;
    const i1 = topology.triangles[t * 3 + 1]!;
    const i2 = topology.triangles[t * 3 + 2]!;
    const p0 = params.projectVertex(i0);
    const p1 = params.projectVertex(i1);
    const p2 = params.projectVertex(i2);
    if (!p0 || !p1 || !p2) continue;
    const cx = (p0.x + p1.x + p2.x) / 3;
    const cy = (p0.y + p1.y + p2.y) / 3;
    if (cx < bounds.minX || cx > bounds.maxX || cy < bounds.minY || cy > bounds.maxY) continue;
    if (pointInPolygon(cx, cy, polygon)) hit.push(t);
  }
  return Uint32Array.from(hit);
}

/** Convert selected triangle ids into a deduplicated vertex seed set. */
export function trianglesToSeedVertices(
  topology: CanonicalAutorigTopology,
  triangleIds: ArrayLike<number>,
): Uint32Array {
  const seen = new Uint8Array(Math.floor(topology.positions.length / 3));
  const seeds: number[] = [];
  for (let i = 0; i < triangleIds.length; i += 1) {
    const t = triangleIds[i]! >>> 0;
    const base = t * 3;
    if (base + 2 >= topology.triangles.length) continue;
    for (let k = 0; k < 3; k += 1) {
      const v = topology.triangles[base + k]!;
      if (seen[v]) continue;
      seen[v] = 1;
      seeds.push(v);
    }
  }
  return Uint32Array.from(seeds);
}

/**
 * Full CPU lasso pipeline: polygon → visible-ish triangles → seeds → expand → override.
 * The WebGL path swaps only the triangle-selection step.
 */
export function applyLassoRegionCorrection(params: {
  topology: CanonicalAutorigTopology;
  suggested: Uint8Array;
  overrides: Uint8Array;
  resolved: Uint8Array;
  region: AutorigBodyRegionId;
  polygon: ReadonlyArray<LassoPoint>;
  projectVertex: (vertexIndex: number) => { x: number; y: number } | null;
  /** Optional precomputed visible triangle ids (from WebGL pass). */
  visibleTriangleIds?: ArrayLike<number> | null;
}): {
  overrides: Uint8Array;
  affectedVertices: Uint32Array;
} {
  const polygon = simplifyLassoPolygon(params.polygon);
  const triangleIds = params.visibleTriangleIds && params.visibleTriangleIds.length > 0
    ? params.visibleTriangleIds
    : selectTrianglesInLassoCpu({
      topology: params.topology,
      projectVertex: params.projectVertex,
      polygon,
    });
  const seeds = trianglesToSeedVertices(params.topology, triangleIds);
  if (seeds.length === 0) {
    return { overrides: new Uint8Array(params.overrides), affectedVertices: new Uint32Array(0) };
  }
  const expanded = expandRegionCorrection({
    topology: params.topology,
    resolved: params.resolved,
    seedVertices: seeds,
    region: params.region,
    suggested: params.suggested,
  });
  // Always include explicit seeds even if expansion filtered nothing extra.
  const merged = new Set<number>();
  for (let i = 0; i < seeds.length; i += 1) merged.add(seeds[i]!);
  for (let i = 0; i < expanded.length; i += 1) merged.add(expanded[i]!);
  const affected = Uint32Array.from(merged);
  return {
    overrides: applyRegionLassoOverride({
      overrides: params.overrides,
      vertexIndices: affected,
      region: params.region,
    }),
    affectedVertices: affected,
  };
}

/** Re-export validity helper for callers that only import this module. */
export { isValidRegionCode };
