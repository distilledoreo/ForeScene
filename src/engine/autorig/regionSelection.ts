import type { CanonicalAutorigTopology } from './topology';
import {
  AUTORIG_REGION_CODE,
  type AutorigBodyRegionId,
  type AutorigRegionCode,
  AUTORIG_REGION_CODE_BY_ID,
  AUTORIG_REGION_ID_BY_CODE,
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

export interface BrushStrokePoint {
  x: number;
  y: number;
  radius: number;
}

/** Axis-aligned bounds expanded by each sample’s brush radius. */
export function brushStrokeBoundingRect(
  stroke: ReadonlyArray<BrushStrokePoint>,
): LassoBounds | null {
  if (stroke.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of stroke) {
    const r = Math.max(0, p.radius);
    if (p.x - r < minX) minX = p.x - r;
    if (p.y - r < minY) minY = p.y - r;
    if (p.x + r > maxX) maxX = p.x + r;
    if (p.y + r > maxY) maxY = p.y + r;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Distance from point to the brush polyline (segments + endpoint disks).
 * Returns true when the point falls within any sample radius.
 */
export function pointHitsBrushStroke(
  x: number,
  y: number,
  stroke: ReadonlyArray<BrushStrokePoint>,
): boolean {
  if (stroke.length === 0) return false;
  for (let i = 0; i < stroke.length; i += 1) {
    const p = stroke[i]!;
    const r = Math.max(0, p.radius);
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  for (let i = 1; i < stroke.length; i += 1) {
    const a = stroke[i - 1]!;
    const b = stroke[i]!;
    const radius = Math.max(a.radius, b.radius);
    if (radius <= 0) continue;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    if (lenSq < 1e-12) continue;
    let t = ((x - a.x) * abx + (y - a.y) * aby) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const dx = x - px;
    const dy = y - py;
    if (dx * dx + dy * dy <= radius * radius) return true;
  }
  return false;
}

/**
 * Drop near-duplicate brush samples while preserving stroke coverage.
 * Also interpolates sparse gaps so fast strokes do not leave holes.
 */
export function simplifyBrushStroke(
  points: ReadonlyArray<BrushStrokePoint>,
  minDistance = 1.5,
): BrushStrokePoint[] {
  if (points.length === 0) return [];
  const out: BrushStrokePoint[] = [{ ...points[0]! }];
  const minDistSq = minDistance * minDistance;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i]!;
    const prev = out[out.length - 1]!;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    const distSq = dx * dx + dy * dy;
    const gap = Math.max(prev.radius, p.radius) * 0.85;
    if (gap > 0 && distSq > gap * gap) {
      const dist = Math.sqrt(distSq);
      const steps = Math.max(1, Math.ceil(dist / Math.max(gap, minDistance)));
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps;
        out.push({
          x: prev.x + dx * t,
          y: prev.y + dy * t,
          radius: prev.radius + (p.radius - prev.radius) * t,
        });
      }
    }
    if (distSq < minDistSq && Math.abs(p.radius - prev.radius) < 0.5) {
      out[out.length - 1] = { ...p };
      continue;
    }
    out.push({ ...p });
  }
  return out;
}

/**
 * CPU fallback: select triangles whose projected centroid lies under the brush.
 */
export function selectTrianglesInBrushCpu(params: {
  topology: CanonicalAutorigTopology;
  projectVertex: (vertexIndex: number) => { x: number; y: number } | null;
  stroke: ReadonlyArray<BrushStrokePoint>;
}): Uint32Array {
  const { topology } = params;
  const stroke = simplifyBrushStroke(params.stroke);
  if (stroke.length === 0) return new Uint32Array(0);
  const bounds = brushStrokeBoundingRect(stroke);
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
    if (pointHitsBrushStroke(cx, cy, stroke)) hit.push(t);
  }
  return Uint32Array.from(hit);
}

export type AutorigCorrectionResult =
  | {
      status: 'changed';
      affectedVertexCount: number;
      oldRegions: AutorigBodyRegionId[];
      newRegion: AutorigBodyRegionId | 'automatic';
    }
  | {
      status: 'unchanged';
      region: AutorigBodyRegionId;
    }
  | {
      status: 'empty';
    }
  | {
      status: 'failed';
      message: string;
    };

/** Compare previous vs next overrides for painted seeds and classify the outcome. */
export function classifyRegionCorrection(params: {
  previousOverrides: Uint8Array;
  nextOverrides: Uint8Array;
  previousResolved: Uint8Array;
  nextResolved: Uint8Array;
  seedVertices: ArrayLike<number>;
  region: AutorigBodyRegionId | 'automatic';
}): AutorigCorrectionResult {
  const { seedVertices } = params;
  if (seedVertices.length === 0) return { status: 'empty' };

  let changed = 0;
  const oldRegionSet = new Set<AutorigBodyRegionId>();
  let sameRegion: AutorigBodyRegionId | null = null;

  for (let v = 0; v < params.nextResolved.length; v += 1) {
    if (params.previousResolved[v] !== params.nextResolved[v]
      || params.previousOverrides[v] !== params.nextOverrides[v]) {
      changed += 1;
      const prevId = AUTORIG_REGION_ID_BY_CODE[params.previousResolved[v]! as AutorigRegionCode];
      if (prevId) oldRegionSet.add(prevId);
    }
  }

  if (changed === 0) {
    for (let i = 0; i < seedVertices.length; i += 1) {
      const v = seedVertices[i]! >>> 0;
      if (v >= params.previousResolved.length) continue;
      const prevId = AUTORIG_REGION_ID_BY_CODE[params.previousResolved[v]! as AutorigRegionCode];
      if (prevId) {
        sameRegion = prevId;
        break;
      }
    }
    if (params.region !== 'automatic') {
      return { status: 'unchanged', region: params.region };
    }
    return { status: 'unchanged', region: sameRegion ?? 'torso' };
  }

  return {
    status: 'changed',
    affectedVertexCount: changed,
    oldRegions: [...oldRegionSet],
    newRegion: params.region,
  };
}

/**
 * Apply a brush (or precomputed triangle) region correction.
 * When `restoreAutomatic` is true, clears hard overrides instead of painting a region.
 */
export function applyBrushRegionCorrection(params: {
  topology: CanonicalAutorigTopology;
  suggested: Uint8Array;
  overrides: Uint8Array;
  resolved: Uint8Array;
  region: AutorigBodyRegionId;
  stroke: ReadonlyArray<BrushStrokePoint>;
  projectVertex: (vertexIndex: number) => { x: number; y: number } | null;
  visibleTriangleIds?: ArrayLike<number> | null;
  restoreAutomatic?: boolean;
}): {
  overrides: Uint8Array;
  affectedVertices: Uint32Array;
  seedVertices: Uint32Array;
  result: AutorigCorrectionResult;
} {
  const stroke = simplifyBrushStroke(params.stroke);
  const triangleIds = params.visibleTriangleIds && params.visibleTriangleIds.length > 0
    ? params.visibleTriangleIds
    : selectTrianglesInBrushCpu({
      topology: params.topology,
      projectVertex: params.projectVertex,
      stroke,
    });
  const seeds = trianglesToSeedVertices(params.topology, triangleIds);
  if (seeds.length === 0) {
    return {
      overrides: new Uint8Array(params.overrides),
      affectedVertices: new Uint32Array(0),
      seedVertices: seeds,
      result: { status: 'empty' },
    };
  }

  if (!params.restoreAutomatic) {
    const target = AUTORIG_REGION_CODE_BY_ID[params.region];
    let allMatch = true;
    for (let i = 0; i < seeds.length; i += 1) {
      const v = seeds[i]! >>> 0;
      if (v >= params.resolved.length || params.resolved[v] !== target) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      return {
        overrides: new Uint8Array(params.overrides),
        affectedVertices: new Uint32Array(0),
        seedVertices: seeds,
        result: { status: 'unchanged', region: params.region },
      };
    }
  } else {
    let anyOverride = false;
    for (let i = 0; i < seeds.length; i += 1) {
      const v = seeds[i]! >>> 0;
      if (v < params.overrides.length && params.overrides[v] !== AUTORIG_REGION_CODE.unknown) {
        anyOverride = true;
        break;
      }
    }
    if (!anyOverride) {
      return {
        overrides: new Uint8Array(params.overrides),
        affectedVertices: new Uint32Array(0),
        seedVertices: seeds,
        result: { status: 'unchanged', region: params.region },
      };
    }
  }

  let nextOverrides: Uint8Array;
  let affected: Uint32Array;
  if (params.restoreAutomatic) {
    nextOverrides = clearRegionOverridesAt({
      overrides: params.overrides,
      vertexIndices: seeds,
    });
    affected = seeds;
  } else {
    const expanded = expandRegionCorrection({
      topology: params.topology,
      resolved: params.resolved,
      seedVertices: seeds,
      region: params.region,
      suggested: params.suggested,
    });
    const merged = new Set<number>();
    for (let i = 0; i < seeds.length; i += 1) merged.add(seeds[i]!);
    for (let i = 0; i < expanded.length; i += 1) merged.add(expanded[i]!);
    affected = Uint32Array.from(merged);
    nextOverrides = applyRegionLassoOverride({
      overrides: params.overrides,
      vertexIndices: affected,
      region: params.region,
    });
  }

  const nextResolved = resolveLabelsLocal(params.suggested, nextOverrides);
  const result = classifyRegionCorrection({
    previousOverrides: params.overrides,
    nextOverrides,
    previousResolved: params.resolved,
    nextResolved,
    seedVertices: seeds,
    region: params.restoreAutomatic ? 'automatic' : params.region,
  });

  return {
    overrides: nextOverrides,
    affectedVertices: affected,
    seedVertices: seeds,
    result,
  };
}

function resolveLabelsLocal(suggested: Uint8Array, overrides: Uint8Array | null | undefined): Uint8Array {
  const out = new Uint8Array(suggested);
  if (!overrides) return out;
  const n = Math.min(out.length, overrides.length);
  for (let i = 0; i < n; i += 1) {
    const code = overrides[i]!;
    if (code !== AUTORIG_REGION_CODE.unknown && isValidRegionCode(code)) out[i] = code;
  }
  return out;
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
