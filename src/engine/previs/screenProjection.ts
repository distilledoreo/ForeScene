/**
 * Real screen-space composition: project AABB corners and body landmarks
 * through the actual camera matrices (not height/distance approximations).
 */

import type { CameraData, Vec3 } from '../../domain/types';
import {
  HUMAN_LANDMARK_HEIGHT,
  type HumanLandmark,
} from './framingProfiles';

export interface BoundsCoverage {
  widthCoverage: number;
  heightCoverage: number;
  areaCoverage: number;
  centerX: number;
  centerY: number;
  pixels: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}

export interface ProjectedBounds {
  /** Unclipped NDC extents (may extend outside [-1, 1]). */
  ndc: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  /**
   * Visible (frame-clamped) pixel box. Occupancy metrics on this object
   * (`widthCoverage` etc.) use the visible intersection with the frame.
   */
  pixels: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  /** Visible occupancy (0–1). Never exceeds 1. */
  widthCoverage: number;
  heightCoverage: number;
  areaCoverage: number;
  centerX: number;
  centerY: number;
  clipped: boolean;
  behindCamera: boolean;
  /** Full projected extents before frame clamp — useful for clipping diagnosis. */
  unclipped: BoundsCoverage;
  /** Explicit visible metrics (same as top-level occupancy fields). */
  visible: BoundsCoverage;
}

export interface ProjectedPoint {
  x: number;
  y: number;
  ndcX: number;
  ndcY: number;
  depth: number;
  inFrame: boolean;
  behindCamera: boolean;
}

export interface WorldAabb {
  min: Vec3;
  max: Vec3;
}

export interface CameraMatrices {
  view: Float64Array; // 4x4 column-major
  projection: Float64Array;
  viewProjection: Float64Array;
  position: Vec3;
  frameWidth: number;
  frameHeight: number;
}

/** Build view + perspective matrices matching ForeScene clay export. */
export function buildCameraMatrices(
  camera: CameraData,
  frameWidth: number,
  frameHeight: number,
): CameraMatrices {
  const aspect = frameWidth / Math.max(1e-6, frameHeight);
  const projection = perspectiveMatrix(
    (camera.fovDegrees * Math.PI) / 180,
    aspect,
    camera.near > 0 ? camera.near : 0.05,
    camera.far > 0 ? camera.far : 500,
  );
  const view = lookAtMatrix(camera.position, camera.target, [0, 1, 0]);
  const viewProjection = multiplyMat4(projection, view);
  return {
    view,
    projection,
    viewProjection,
    position: [...camera.position] as Vec3,
    frameWidth,
    frameHeight,
  };
}

export function projectWorldPoint(
  point: Vec3,
  matrices: CameraMatrices,
): ProjectedPoint {
  const clip = transformMat4(matrices.viewProjection, [point[0], point[1], point[2], 1]);
  const w = clip[3]!;
  if (Math.abs(w) < 1e-9) {
    return {
      x: 0,
      y: 0,
      ndcX: 0,
      ndcY: 0,
      depth: 0,
      inFrame: false,
      behindCamera: true,
    };
  }
  const ndcX = clip[0]! / w;
  const ndcY = clip[1]! / w;
  const depth = clip[2]! / w;
  const behindCamera = w < 0 || depth < -1;
  // Screen Y: 0 at top (image convention).
  const x = (ndcX * 0.5 + 0.5) * matrices.frameWidth;
  const y = (1 - (ndcY * 0.5 + 0.5)) * matrices.frameHeight;
  const inFrame = !behindCamera
    && ndcX >= -1 && ndcX <= 1
    && ndcY >= -1 && ndcY <= 1;
  return { x, y, ndcX, ndcY, depth, inFrame, behindCamera };
}

/** Project all eight AABB corners and return screen-space bounds. */
export function projectAabb(aabb: WorldAabb, matrices: CameraMatrices): ProjectedBounds {
  const corners = aabbCorners(aabb);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let anyFront = false;
  let allBehind = true;

  for (const corner of corners) {
    const p = projectWorldPoint(corner, matrices);
    if (!p.behindCamera) {
      anyFront = true;
      allBehind = false;
      minX = Math.min(minX, p.ndcX);
      maxX = Math.max(maxX, p.ndcX);
      // NDC Y: +1 top in OpenGL; convert to screen-top=0 later via pixels.
      minY = Math.min(minY, p.ndcY);
      maxY = Math.max(maxY, p.ndcY);
    }
  }

  if (!anyFront || allBehind) {
    return emptyBounds(true);
  }

  const unclipped = coverageFromNdc(minX, maxX, minY, maxY, matrices);
  // Visible occupancy: clamp NDC to the frame before measuring coverage.
  const cMinX = Math.max(-1, Math.min(1, minX));
  const cMaxX = Math.max(-1, Math.min(1, maxX));
  const cMinY = Math.max(-1, Math.min(1, minY));
  const cMaxY = Math.max(-1, Math.min(1, maxY));
  const noVisible = cMinX >= cMaxX || cMinY >= cMaxY;
  const visible = noVisible
    ? zeroCoverage()
    : coverageFromNdc(cMinX, cMaxX, cMinY, cMaxY, matrices);
  const clipped = minX < -1 || maxX > 1 || minY < -1 || maxY > 1;

  return {
    ndc: { minX, maxX, minY, maxY },
    pixels: visible.pixels,
    widthCoverage: visible.widthCoverage,
    heightCoverage: visible.heightCoverage,
    areaCoverage: visible.areaCoverage,
    centerX: visible.centerX,
    centerY: visible.centerY,
    clipped,
    behindCamera: false,
    unclipped,
    visible,
  };
}

function coverageFromNdc(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  matrices: CameraMatrices,
): BoundsCoverage {
  const left = (minX * 0.5 + 0.5) * matrices.frameWidth;
  const right = (maxX * 0.5 + 0.5) * matrices.frameWidth;
  // NDC +Y is up; screen top is 0.
  const top = (1 - (maxY * 0.5 + 0.5)) * matrices.frameHeight;
  const bottom = (1 - (minY * 0.5 + 0.5)) * matrices.frameHeight;
  const widthPx = Math.max(0, right - left);
  const heightPx = Math.max(0, bottom - top);
  const widthCoverage = widthPx / matrices.frameWidth;
  const heightCoverage = heightPx / matrices.frameHeight;
  return {
    widthCoverage,
    heightCoverage,
    areaCoverage: widthCoverage * heightCoverage,
    centerX: matrices.frameWidth > 0 ? (left + right) / 2 / matrices.frameWidth : 0.5,
    centerY: matrices.frameHeight > 0 ? (top + bottom) / 2 / matrices.frameHeight : 0.5,
    pixels: { left, top, right, bottom },
  };
}

function zeroCoverage(): BoundsCoverage {
  return {
    widthCoverage: 0,
    heightCoverage: 0,
    areaCoverage: 0,
    centerX: 0.5,
    centerY: 0.5,
    pixels: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}

export function projectHumanLandmarks(params: {
  /** Floor-contact position (feet). */
  position: Vec3;
  height: number;
  width?: number;
  depth?: number;
  /** Optional yaw radians for left/right body samples. */
  yawRadians?: number;
  matrices: CameraMatrices;
  landmarks?: HumanLandmark[];
}): Record<HumanLandmark, ProjectedPoint> {
  const list = params.landmarks ?? (Object.keys(HUMAN_LANDMARK_HEIGHT) as HumanLandmark[]);
  const result = {} as Record<HumanLandmark, ProjectedPoint>;
  for (const landmark of list) {
    const y = params.position[1] + params.height * HUMAN_LANDMARK_HEIGHT[landmark];
    const world: Vec3 = [params.position[0], y, params.position[2]];
    result[landmark] = projectWorldPoint(world, params.matrices);
  }
  return result;
}

/** Approximate left/right shoulder world points from facing yaw. */
export function shoulderWorldPoints(params: {
  position: Vec3;
  height: number;
  width?: number;
  yawRadians: number;
}): { left: Vec3; right: Vec3; head: Vec3; chest: Vec3; eyes: Vec3 } {
  const halfWidth = (params.width ?? 0.55) * 0.45;
  const shoulderY = params.position[1] + params.height * HUMAN_LANDMARK_HEIGHT.shoulders;
  const headY = params.position[1] + params.height * HUMAN_LANDMARK_HEIGHT.headTop;
  const chestY = params.position[1] + params.height * HUMAN_LANDMARK_HEIGHT.chest;
  const eyesY = params.position[1] + params.height * HUMAN_LANDMARK_HEIGHT.eyes;
  // Facing +Z at yaw 0; left is -X in local, rotated by yaw.
  const cos = Math.cos(params.yawRadians);
  const sin = Math.sin(params.yawRadians);
  const leftOffsetX = -halfWidth * cos;
  const leftOffsetZ = -halfWidth * sin;
  const rightOffsetX = halfWidth * cos;
  const rightOffsetZ = halfWidth * sin;
  return {
    left: [params.position[0] + leftOffsetX, shoulderY, params.position[2] + leftOffsetZ],
    right: [params.position[0] + rightOffsetX, shoulderY, params.position[2] + rightOffsetZ],
    head: [params.position[0], headY, params.position[2]],
    chest: [params.position[0], chestY, params.position[2]],
    eyes: [params.position[0], eyesY, params.position[2]],
  };
}

export interface OcclusionSampleResult {
  hit: boolean;
  objectId?: string;
  t?: number;
}

/**
 * Ray vs AABB intersection (slab method). Returns true if a solid is hit
 * before the subject sample point.
 */
export function rayAabbIntersection(
  origin: Vec3,
  direction: Vec3,
  box: WorldAabb,
): { hit: boolean; tNear: number; tFar: number } {
  let tNear = -Infinity;
  let tFar = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const o = origin[axis]!;
    const d = direction[axis]!;
    const min = box.min[axis]!;
    const max = box.max[axis]!;
    if (Math.abs(d) < 1e-12) {
      if (o < min || o > max) return { hit: false, tNear: 0, tFar: 0 };
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tNear = Math.max(tNear, t1);
    tFar = Math.min(tFar, t2);
    if (tNear > tFar) return { hit: false, tNear, tFar };
  }
  return { hit: tFar >= 0 && tNear <= tFar, tNear, tFar };
}

export function sampleSubjectOcclusion(params: {
  cameraPosition: Vec3;
  subjectSamples: Array<{ id: string; point: Vec3 }>;
  blockers: Array<{ objectId: string; min: Vec3; max: Vec3 }>;
  /** Exclude subject own bounds from hits. */
  excludeObjectIds?: Set<string>;
}): {
  occludedSampleRatio: number;
  faceOccluded: boolean;
  wallDominant: boolean;
  hits: Array<{ sampleId: string; objectId: string }>;
} {
  const hits: Array<{ sampleId: string; objectId: string }> = [];
  let occluded = 0;
  let faceOccluded = false;
  let wallHits = 0;

  for (const sample of params.subjectSamples) {
    const dir: Vec3 = [
      sample.point[0] - params.cameraPosition[0],
      sample.point[1] - params.cameraPosition[1],
      sample.point[2] - params.cameraPosition[2],
    ];
    const dist = Math.hypot(dir[0], dir[1], dir[2]);
    if (dist < 1e-6) continue;
    const nd: Vec3 = [dir[0] / dist, dir[1] / dist, dir[2] / dist];
    let blocked = false;
    for (const blocker of params.blockers) {
      if (params.excludeObjectIds?.has(blocker.objectId)) continue;
      const hit = rayAabbIntersection(params.cameraPosition, nd, blocker);
      if (hit.hit && hit.tNear > 0.05 && hit.tNear < dist - 0.05) {
        blocked = true;
        hits.push({ sampleId: sample.id, objectId: blocker.objectId });
        if (/wall|box|column|doorway|arch/i.test(blocker.objectId)) {
          wallHits += 1;
        }
        break;
      }
    }
    if (blocked) {
      occluded += 1;
      if (sample.id === 'head' || sample.id === 'eyes' || sample.id === 'chin') {
        faceOccluded = true;
      }
    }
  }

  const total = Math.max(1, params.subjectSamples.length);
  return {
    occludedSampleRatio: occluded / total,
    faceOccluded,
    wallDominant: wallHits >= Math.ceil(total * 0.4),
    hits,
  };
}

function aabbCorners(aabb: WorldAabb): Vec3[] {
  const { min, max } = aabb;
  return [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [min[0], max[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [min[0], max[1], max[2]],
    [max[0], max[1], max[2]],
  ];
}

function emptyBounds(behindCamera: boolean): ProjectedBounds {
  const z = zeroCoverage();
  return {
    ndc: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    pixels: z.pixels,
    widthCoverage: 0,
    heightCoverage: 0,
    areaCoverage: 0,
    centerX: 0.5,
    centerY: 0.5,
    clipped: true,
    behindCamera,
    unclipped: z,
    visible: z,
  };
}

/**
 * Project a head-and-shoulders region for OTS / close-up occupancy.
 * Avoids legs/torso below the frame inflating coverage.
 */
export function projectUpperBodyRegion(params: {
  position: Vec3;
  height: number;
  width?: number;
  depth?: number;
  matrices: CameraMatrices;
  /** Fraction of height for bottom of region (shoulders ≈ 0.82). */
  bottomFraction?: number;
  /** Fraction of height for top of region (headTop = 1). */
  topFraction?: number;
}): ProjectedBounds {
  const halfW = (params.width ?? 0.55) * 0.5;
  const halfD = (params.depth ?? 0.55) * 0.5;
  const bottom = params.bottomFraction ?? HUMAN_LANDMARK_HEIGHT.shoulders;
  const top = params.topFraction ?? HUMAN_LANDMARK_HEIGHT.headTop;
  const minY = params.position[1] + params.height * bottom;
  const maxY = params.position[1] + params.height * top;
  return projectAabb(
    {
      min: [params.position[0] - halfW, minY, params.position[2] - halfD],
      max: [params.position[0] + halfW, maxY, params.position[2] + halfD],
    },
    params.matrices,
  );
}

function perspectiveMatrix(fovY: number, aspect: number, near: number, far: number): Float64Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const out = new Float64Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

function lookAtMatrix(eye: Vec3, target: Vec3, up: Vec3): Float64Array {
  const zx = eye[0] - target[0];
  const zy = eye[1] - target[1];
  const zz = eye[2] - target[2];
  let zLen = Math.hypot(zx, zy, zz);
  if (zLen < 1e-9) zLen = 1;
  const z0 = zx / zLen;
  const z1 = zy / zLen;
  const z2 = zz / zLen;

  let x0 = up[1] * z2 - up[2] * z1;
  let x1 = up[2] * z0 - up[0] * z2;
  let x2 = up[0] * z1 - up[1] * z0;
  let xLen = Math.hypot(x0, x1, x2);
  if (xLen < 1e-9) {
    x0 = 1;
    x1 = 0;
    x2 = 0;
    xLen = 1;
  }
  x0 /= xLen;
  x1 /= xLen;
  x2 /= xLen;

  const y0 = z1 * x2 - z2 * x1;
  const y1 = z2 * x0 - z0 * x2;
  const y2 = z0 * x1 - z1 * x0;

  const out = new Float64Array(16);
  out[0] = x0;
  out[1] = y0;
  out[2] = z0;
  out[3] = 0;
  out[4] = x1;
  out[5] = y1;
  out[6] = z1;
  out[7] = 0;
  out[8] = x2;
  out[9] = y2;
  out[10] = z2;
  out[11] = 0;
  out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
  out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
  out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
  out[15] = 1;
  return out;
}

function multiplyMat4(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] = a[0 * 4 + row]! * b[col * 4 + 0]!
        + a[1 * 4 + row]! * b[col * 4 + 1]!
        + a[2 * 4 + row]! * b[col * 4 + 2]!
        + a[3 * 4 + row]! * b[col * 4 + 3]!;
    }
  }
  return out;
}

function transformMat4(m: Float64Array, v: [number, number, number, number]): [number, number, number, number] {
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]! * v[3],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]! * v[3],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]! * v[3],
    m[3]! * v[0] + m[7]! * v[1] + m[11]! * v[2] + m[15]! * v[3],
  ];
}
