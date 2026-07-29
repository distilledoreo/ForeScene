import type { HumanJointId, Vec3 } from '../../domain/types';
import type { CanonicalAutorigTopology } from './topology';

/** User-visible body-part labels for guided autorig. */
export type AutorigBodyRegionId =
  | 'head'
  | 'torso'
  | 'leftArm'
  | 'rightArm'
  | 'leftLeg'
  | 'rightLeg';

/** Compact byte codes stored in region-map binaries. */
export const AUTORIG_REGION_CODE = {
  unknown: 0,
  head: 1,
  torso: 2,
  leftArm: 3,
  rightArm: 4,
  leftLeg: 5,
  rightLeg: 6,
} as const;

export type AutorigRegionCode = (typeof AUTORIG_REGION_CODE)[keyof typeof AUTORIG_REGION_CODE];

export const AUTORIG_BODY_REGION_IDS: readonly AutorigBodyRegionId[] = [
  'head',
  'torso',
  'leftArm',
  'rightArm',
  'leftLeg',
  'rightLeg',
] as const;

export const AUTORIG_REGION_ID_BY_CODE: Record<AutorigRegionCode, AutorigBodyRegionId | null> = {
  0: null,
  1: 'head',
  2: 'torso',
  3: 'leftArm',
  4: 'rightArm',
  5: 'leftLeg',
  6: 'rightLeg',
};

export const AUTORIG_REGION_CODE_BY_ID: Record<AutorigBodyRegionId, AutorigRegionCode> = {
  head: AUTORIG_REGION_CODE.head,
  torso: AUTORIG_REGION_CODE.torso,
  leftArm: AUTORIG_REGION_CODE.leftArm,
  rightArm: AUTORIG_REGION_CODE.rightArm,
  leftLeg: AUTORIG_REGION_CODE.leftLeg,
  rightLeg: AUTORIG_REGION_CODE.rightLeg,
};

/** Bones used for initial region classification (twist joints inherit parent limb). */
export const REGION_CHAINS: Record<AutorigBodyRegionId, readonly HumanJointId[]> = {
  head: ['neck', 'head'],
  torso: ['hips', 'spine', 'chest', 'upperSpine', 'neck'],
  leftArm: [
    'leftClavicle',
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'leftHandEnd',
  ],
  rightArm: [
    'rightClavicle',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
    'rightHandEnd',
  ],
  leftLeg: [
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'leftToeBase',
  ],
  rightLeg: [
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
    'rightToeBase',
  ],
};

/** Full bone sets used later by Binder V2 (includes twist joints). */
export const REGION_BONES: Record<AutorigBodyRegionId, readonly HumanJointId[]> = {
  head: ['neck', 'head'],
  torso: ['hips', 'spine', 'chest', 'upperSpine', 'leftClavicle', 'rightClavicle'],
  leftArm: [
    'leftClavicle',
    'leftUpperArm',
    'leftUpperArmTwist',
    'leftLowerArm',
    'leftLowerArmTwist',
    'leftHand',
    'leftHandEnd',
  ],
  rightArm: [
    'rightClavicle',
    'rightUpperArm',
    'rightUpperArmTwist',
    'rightLowerArm',
    'rightLowerArmTwist',
    'rightHand',
    'rightHandEnd',
  ],
  leftLeg: [
    'hips',
    'leftUpperLeg',
    'leftUpperLegTwist',
    'leftLowerLeg',
    'leftLowerLegTwist',
    'leftFoot',
    'leftToeBase',
  ],
  rightLeg: [
    'hips',
    'rightUpperLeg',
    'rightUpperLegTwist',
    'rightLowerLeg',
    'rightLowerLegTwist',
    'rightFoot',
    'rightToeBase',
  ],
};

export const BONE_REGION: Partial<Record<HumanJointId, AutorigBodyRegionId>> = Object.fromEntries(
  (Object.entries(REGION_BONES) as Array<[AutorigBodyRegionId, readonly HumanJointId[]]>)
    .flatMap(([region, bones]) => bones.map((bone) => [bone, region])),
);

export interface RegionChainSegment {
  region: AutorigBodyRegionId;
  start: Vec3;
  end: Vec3;
}

export interface AutoLabelResult {
  /** Soft automatic labels (replaceable). */
  suggested: Uint8Array;
  /** Confidence in [0,1] from best vs second-best score gap. */
  confidence: Float32Array;
  /** Vertices whose confidence is below the soft review threshold. */
  uncertainVertexCount: number;
}

export interface ResolveRegionMapParams {
  suggested: Uint8Array;
  /** Hard user overrides; 0 = no override. */
  overrides?: Uint8Array | null;
}

const REGION_SCORE_ORDER: AutorigBodyRegionId[] = [
  'head',
  'torso',
  'leftArm',
  'rightArm',
  'leftLeg',
  'rightLeg',
];

function distPointSegmentSquared(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  let t = abLenSq > 1e-12 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const cz = az + abz * t;
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return dx * dx + dy * dy + dz * dz;
}

function buildChainSegments(
  jointPositions: Partial<Record<HumanJointId, Vec3>>,
): RegionChainSegment[] {
  const segments: RegionChainSegment[] = [];
  for (const region of REGION_SCORE_ORDER) {
    const chain = REGION_CHAINS[region];
    for (let i = 0; i + 1 < chain.length; i += 1) {
      const a = jointPositions[chain[i]!];
      const b = jointPositions[chain[i + 1]!];
      if (!a || !b) continue;
      segments.push({ region, start: a, end: b });
    }
  }
  return segments;
}

export function isValidRegionCode(code: number): code is AutorigRegionCode {
  return code >= AUTORIG_REGION_CODE.head && code <= AUTORIG_REGION_CODE.rightLeg;
}

/** Normalize a label buffer so every vertex is one of the six regions (unknown → torso). */
export function normalizeRegionLabels(labels: Uint8Array): Uint8Array {
  const out = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i += 1) {
    const code = labels[i]!;
    out[i] = isValidRegionCode(code) ? code : AUTORIG_REGION_CODE.torso;
  }
  return out;
}

/**
 * Resolve hard user overrides over suggested labels.
 * Override 0 means "use suggested"; invalid codes are ignored.
 */
export function resolveRegionLabels(params: ResolveRegionMapParams): Uint8Array {
  const suggested = normalizeRegionLabels(params.suggested);
  const overrides = params.overrides;
  if (!overrides || overrides.length !== suggested.length) return suggested;
  const out = new Uint8Array(suggested);
  for (let i = 0; i < out.length; i += 1) {
    const override = overrides[i]!;
    if (isValidRegionCode(override)) out[i] = override;
  }
  return out;
}

/**
 * Mirror left/right hard overrides across X=0 by nearest opposite vertex.
 * Uses a uniform grid + cached correspondence so large meshes stay linear.
 */
export function mirrorRegionOverrides(params: {
  positions: Float32Array;
  overrides: Uint8Array;
  tolerance?: number;
  topologyHash?: string;
}): Uint8Array {
  const { positions, overrides } = params;
  const vertexCount = Math.floor(positions.length / 3);
  const out = new Uint8Array(overrides);
  const tolerance = params.tolerance ?? estimateMirrorTolerance(positions);
  const correspondence = getOrBuildMirrorCorrespondence({
    positions,
    tolerance,
    topologyHash: params.topologyHash,
  });

  const swapCode = (code: number): number => {
    if (code === AUTORIG_REGION_CODE.leftArm) return AUTORIG_REGION_CODE.rightArm;
    if (code === AUTORIG_REGION_CODE.rightArm) return AUTORIG_REGION_CODE.leftArm;
    if (code === AUTORIG_REGION_CODE.leftLeg) return AUTORIG_REGION_CODE.rightLeg;
    if (code === AUTORIG_REGION_CODE.rightLeg) return AUTORIG_REGION_CODE.leftLeg;
    return code;
  };

  for (let v = 0; v < vertexCount; v += 1) {
    const code = overrides[v]!;
    if (!isValidRegionCode(code)) continue;
    if (
      code !== AUTORIG_REGION_CODE.leftArm
      && code !== AUTORIG_REGION_CODE.rightArm
      && code !== AUTORIG_REGION_CODE.leftLeg
      && code !== AUTORIG_REGION_CODE.rightLeg
    ) {
      continue;
    }
    const opposite = correspondence[v]!;
    if (opposite >= 0) out[opposite] = swapCode(code);
  }
  return out;
}

/** Clear the mirror-correspondence cache (tests / topology changes). */
export function clearMirrorCorrespondenceCache(): void {
  mirrorCorrespondenceCache.clear();
}

const mirrorCorrespondenceCache = new Map<string, Int32Array>();
const MAX_MIRROR_CACHE = 4;

function cellKey(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`;
}

/**
 * Build (and cache) nearest reflected-vertex correspondence.
 * mirror[v] = opposite vertex index, or -1 when none is within tolerance.
 */
export function getOrBuildMirrorCorrespondence(params: {
  positions: Float32Array;
  tolerance: number;
  topologyHash?: string;
}): Int32Array {
  const vertexCount = Math.floor(params.positions.length / 3);
  const cacheKey = params.topologyHash
    ? `${params.topologyHash}:${params.tolerance.toFixed(6)}:${vertexCount}`
    : null;
  if (cacheKey) {
    const hit = mirrorCorrespondenceCache.get(cacheKey);
    if (hit && hit.length === vertexCount) return hit;
  }

  const { positions, tolerance } = params;
  const cellSize = Math.max(tolerance, 1e-4);
  const inv = 1 / cellSize;
  const buckets = new Map<string, number[]>();

  for (let v = 0; v < vertexCount; v += 1) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    const ix = Math.floor(x * inv);
    const iy = Math.floor(y * inv);
    const iz = Math.floor(z * inv);
    const key = cellKey(ix, iy, iz);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(v);
    else buckets.set(key, [v]);
  }

  const correspondence = new Int32Array(vertexCount);
  correspondence.fill(-1);
  const tolSq = tolerance * tolerance;

  for (let v = 0; v < vertexCount; v += 1) {
    const ox = -positions[v * 3]!;
    const oy = positions[v * 3 + 1]!;
    const oz = positions[v * 3 + 2]!;
    const ix = Math.floor(ox * inv);
    const iy = Math.floor(oy * inv);
    const iz = Math.floor(oz * inv);
    let best = -1;
    let bestDist = tolSq;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = buckets.get(cellKey(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const u of bucket) {
            if (u === v) continue;
            const ddx = positions[u * 3]! - ox;
            const ddy = positions[u * 3 + 1]! - oy;
            const ddz = positions[u * 3 + 2]! - oz;
            const d = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d <= bestDist) {
              bestDist = d;
              best = u;
            }
          }
        }
      }
    }
    correspondence[v] = best;
  }

  if (cacheKey) {
    if (mirrorCorrespondenceCache.has(cacheKey)) mirrorCorrespondenceCache.delete(cacheKey);
    mirrorCorrespondenceCache.set(cacheKey, correspondence);
    while (mirrorCorrespondenceCache.size > MAX_MIRROR_CACHE) {
      const oldest = mirrorCorrespondenceCache.keys().next().value;
      if (oldest == null) break;
      mirrorCorrespondenceCache.delete(oldest);
    }
  }
  return correspondence;
}

function estimateMirrorTolerance(positions: Float32Array): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const vertexCount = Math.floor(positions.length / 3);
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const height = Math.max(1e-3, maxY - minY);
  const width = Math.max(1e-3, maxX - minX);
  return Math.max(height, width) * 0.04;
}

export interface RegionEditHistoryEntry {
  vertexIndices: Uint32Array;
  before: Uint8Array;
  after: Uint8Array;
}

/** Apply a compact undo/redo delta to a label buffer (mutates and returns it). */
export function applyRegionEditDelta(
  labels: Uint8Array,
  entry: RegionEditHistoryEntry,
  direction: 'undo' | 'redo',
): Uint8Array {
  const values = direction === 'undo' ? entry.before : entry.after;
  for (let i = 0; i < entry.vertexIndices.length; i += 1) {
    const vertex = entry.vertexIndices[i]!;
    if (vertex < labels.length) labels[vertex] = values[i]!;
  }
  return labels;
}

/** Build an undo entry describing a sparse label change. */
export function createRegionEditDelta(
  beforeLabels: Uint8Array,
  afterLabels: Uint8Array,
): RegionEditHistoryEntry | null {
  if (beforeLabels.length !== afterLabels.length) return null;
  const indices: number[] = [];
  const before: number[] = [];
  const after: number[] = [];
  for (let i = 0; i < beforeLabels.length; i += 1) {
    if (beforeLabels[i] === afterLabels[i]) continue;
    indices.push(i);
    before.push(beforeLabels[i]!);
    after.push(afterLabels[i]!);
  }
  if (indices.length === 0) return null;
  return {
    vertexIndices: Uint32Array.from(indices),
    before: Uint8Array.from(before),
    after: Uint8Array.from(after),
  };
}

function scoreVertexRegions(params: {
  px: number;
  py: number;
  pz: number;
  segments: RegionChainSegment[];
  hipY: number;
  shoulderY: number;
  headY: number;
  poseHint?: 'a-pose' | 't-pose';
}): { best: AutorigBodyRegionId; confidence: number; scores: Record<AutorigBodyRegionId, number> } {
  const scores: Record<AutorigBodyRegionId, number> = {
    head: 0,
    torso: 0,
    leftArm: 0,
    rightArm: 0,
    leftLeg: 0,
    rightLeg: 0,
  };

  for (const segment of params.segments) {
    const d2 = distPointSegmentSquared(
      params.px, params.py, params.pz,
      segment.start[0], segment.start[1], segment.start[2],
      segment.end[0], segment.end[1], segment.end[2],
    );
    const score = 1 / (1e-4 + d2);
    scores[segment.region] += score;
  }

  // Height / side anatomical priors (forbid obvious cross-body mistakes).
  if (params.py < params.hipY - 0.02) {
    scores.head *= 0.02;
    scores.leftArm *= 0.15;
    scores.rightArm *= 0.15;
  }
  if (params.py > params.shoulderY + 0.05) {
    scores.leftLeg *= 0.05;
    scores.rightLeg *= 0.05;
  }
  if (params.py > params.headY - 0.02) {
    scores.head *= 2.2;
    scores.leftLeg *= 0.02;
    scores.rightLeg *= 0.02;
  }
  if (params.px > 0.02) {
    scores.rightArm *= 0.05;
    scores.rightLeg *= 0.08;
  } else if (params.px < -0.02) {
    scores.leftArm *= 0.05;
    scores.leftLeg *= 0.08;
  }
  if (params.poseHint === 't-pose') {
    // Emphasize lateral arm chains when arms are outstretched.
    if (params.py > params.hipY && Math.abs(params.px) > 0.12) {
      if (params.px > 0) scores.leftArm *= 1.35;
      else scores.rightArm *= 1.35;
      scores.torso *= 0.85;
    }
  }

  let best: AutorigBodyRegionId = 'torso';
  let bestScore = -1;
  let second = -1;
  for (const region of REGION_SCORE_ORDER) {
    const score = scores[region];
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = region;
    } else if (score > second) {
      second = score;
    }
  }
  const confidence = bestScore <= 1e-8
    ? 0
    : Math.max(0, Math.min(1, 1 - second / bestScore));
  return { best, confidence, scores };
}

/**
 * Remove tiny isolated region islands inside a connected component, then assign
 * very small disconnected components to the nearest chain region.
 */
export function cleanupRegionLabels(params: {
  labels: Uint8Array;
  topology: CanonicalAutorigTopology;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  islandFraction?: number;
}): Uint8Array {
  const labels = new Uint8Array(params.labels);
  const { topology } = params;
  const vertexCount = labels.length;
  const islandFraction = params.islandFraction ?? 0.02;
  const segments = buildChainSegments(params.jointPositions);
  // One reusable visited buffer for all components (generation stamp).
  const visited = new Int32Array(vertexCount);
  visited.fill(-1);

  for (let componentId = 0; componentId < topology.componentCount; componentId += 1) {
    const compStart = topology.componentOffsets[componentId]!;
    const compEnd = topology.componentOffsets[componentId + 1]!;
    const componentSize = compEnd - compStart;
    if (componentSize === 0) continue;

    const regionCounts = new Uint32Array(7);
    for (let i = compStart; i < compEnd; i += 1) {
      const v = topology.componentVertices[i]!;
      const code = labels[v]!;
      if (isValidRegionCode(code)) regionCounts[code]! += 1;
    }

    let dominantCode: AutorigRegionCode = AUTORIG_REGION_CODE.torso;
    let dominantCount = 0;
    for (let code = AUTORIG_REGION_CODE.head; code <= AUTORIG_REGION_CODE.rightLeg; code += 1) {
      const count = regionCounts[code]!;
      if (count > dominantCount) {
        dominantCount = count;
        dominantCode = code as AutorigRegionCode;
      }
    }

    // Tiny disconnected accessories → nearest region by chain distance.
    if (componentSize <= Math.max(8, Math.floor(vertexCount * 0.005))) {
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      for (let i = compStart; i < compEnd; i += 1) {
        const v = topology.componentVertices[i]!;
        sumX += topology.positions[v * 3]!;
        sumY += topology.positions[v * 3 + 1]!;
        sumZ += topology.positions[v * 3 + 2]!;
      }
      const inv = 1 / componentSize;
      const cx = sumX * inv;
      const cy = sumY * inv;
      const cz = sumZ * inv;
      let bestRegion: AutorigBodyRegionId = AUTORIG_REGION_ID_BY_CODE[dominantCode] ?? 'torso';
      let bestDist = Infinity;
      for (const segment of segments) {
        const d2 = distPointSegmentSquared(
          cx, cy, cz,
          segment.start[0], segment.start[1], segment.start[2],
          segment.end[0], segment.end[1], segment.end[2],
        );
        if (d2 < bestDist) {
          bestDist = d2;
          bestRegion = segment.region;
        }
      }
      const code = AUTORIG_REGION_CODE_BY_ID[bestRegion];
      for (let i = compStart; i < compEnd; i += 1) {
        labels[topology.componentVertices[i]!] = code;
      }
      continue;
    }

    // Within larger components, absorb tiny region islands into the local majority.
    const islandThreshold = Math.max(4, Math.floor(componentSize * islandFraction));
    for (let i = compStart; i < compEnd; i += 1) {
      const seed = topology.componentVertices[i]!;
      if (visited[seed] === componentId) continue;
      const regionCode = labels[seed]!;
      const queue = [seed];
      visited[seed] = componentId;
      const members = [seed];
      let qi = 0;
      while (qi < queue.length) {
        const v = queue[qi++]!;
        const start = topology.adjacencyOffsets[v]!;
        const end = topology.adjacencyOffsets[v + 1]!;
        for (let ai = start; ai < end; ai += 1) {
          const n = topology.adjacencyVertices[ai]!;
          if (visited[n] === componentId || topology.vertexComponent[n] !== componentId) continue;
          if (labels[n] !== regionCode) continue;
          visited[n] = componentId;
          queue.push(n);
          members.push(n);
        }
      }
      if (members.length > islandThreshold) continue;
      if (regionCode === dominantCode) continue;
      const neighborCounts = new Uint32Array(7);
      for (const v of members) {
        const start = topology.adjacencyOffsets[v]!;
        const end = topology.adjacencyOffsets[v + 1]!;
        for (let ai = start; ai < end; ai += 1) {
          const n = topology.adjacencyVertices[ai]!;
          if (topology.vertexComponent[n] !== componentId) continue;
          if (labels[n] === regionCode) continue;
          const code = labels[n]!;
          if (isValidRegionCode(code)) neighborCounts[code]! += 1;
        }
      }
      let replace: AutorigRegionCode = dominantCode;
      let replaceCount = 0;
      for (let code = AUTORIG_REGION_CODE.head; code <= AUTORIG_REGION_CODE.rightLeg; code += 1) {
        if (neighborCounts[code]! > replaceCount) {
          replaceCount = neighborCounts[code]!;
          replace = code as AutorigRegionCode;
        }
      }
      for (const v of members) labels[v] = replace;
    }
  }

  return normalizeRegionLabels(labels);
}

/**
 * Automatic first-pass six-region classification.
 * Produces a useful editable starting point — not final skinning.
 */
export function autoLabelBodyRegions(params: {
  topology: CanonicalAutorigTopology;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  poseHint?: 'a-pose' | 't-pose';
  uncertainThreshold?: number;
}): AutoLabelResult {
  const { topology, jointPositions } = params;
  const vertexCount = Math.floor(topology.positions.length / 3);
  const suggested = new Uint8Array(vertexCount);
  const confidence = new Float32Array(vertexCount);
  const segments = buildChainSegments(jointPositions);
  const hipY = jointPositions.hips?.[1] ?? topology.positions[1] ?? 0.9;
  const leftShoulderY = jointPositions.leftUpperArm?.[1];
  const rightShoulderY = jointPositions.rightUpperArm?.[1];
  const shoulderY = leftShoulderY != null && rightShoulderY != null
    ? (leftShoulderY + rightShoulderY) * 0.5
    : hipY + 0.45;
  const headY = jointPositions.head?.[1] ?? shoulderY + 0.3;
  const uncertainThreshold = params.uncertainThreshold ?? 0.22;

  for (let v = 0; v < vertexCount; v += 1) {
    const px = topology.positions[v * 3]!;
    const py = topology.positions[v * 3 + 1]!;
    const pz = topology.positions[v * 3 + 2]!;
    const scored = scoreVertexRegions({
      px, py, pz, segments, hipY, shoulderY, headY, poseHint: params.poseHint,
    });
    suggested[v] = AUTORIG_REGION_CODE_BY_ID[scored.best];
    confidence[v] = scored.confidence;
  }

  const cleaned = cleanupRegionLabels({
    labels: suggested,
    topology,
    jointPositions,
  });

  // Recompute confidence only for display; cleaned labels may differ slightly.
  let uncertainVertexCount = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    if (confidence[v]! < uncertainThreshold) uncertainVertexCount += 1;
  }

  return {
    suggested: cleaned,
    confidence,
    uncertainVertexCount,
  };
}

/** Ensure every vertex has a valid region (unknown → nearest chain / torso). */
export function ensureAllVerticesLabeled(params: {
  labels: Uint8Array;
  topology: CanonicalAutorigTopology;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
}): Uint8Array {
  const out = normalizeRegionLabels(params.labels);
  const segments = buildChainSegments(params.jointPositions);
  const vertexCount = out.length;
  for (let v = 0; v < vertexCount; v += 1) {
    if (isValidRegionCode(params.labels[v]!)) continue;
    const px = params.topology.positions[v * 3]!;
    const py = params.topology.positions[v * 3 + 1]!;
    const pz = params.topology.positions[v * 3 + 2]!;
    let best: AutorigBodyRegionId = 'torso';
    let bestDist = Infinity;
    for (const segment of segments) {
      const d2 = distPointSegmentSquared(
        px, py, pz,
        segment.start[0], segment.start[1], segment.start[2],
        segment.end[0], segment.end[1], segment.end[2],
      );
      if (d2 < bestDist) {
        bestDist = d2;
        best = segment.region;
      }
    }
    out[v] = AUTORIG_REGION_CODE_BY_ID[best];
  }
  return out;
}
