/**
 * Semantic camera solver — template → finite position/target/FOV.
 * No model-generated world coordinates required.
 */

import type { CameraData, Vec3 } from '../../domain/types';
import type {
  PrevisCameraAngle,
  PrevisCameraTemplate,
  PrevisLensClass,
  PrevisShotDefinition,
} from './manifest';
import {
  aimHeightFraction,
  defaultLensClassForTemplate,
  FRAMING_COVERAGE,
  scoreCoverage,
  verticalFovForLens,
} from './framing';

export interface SubjectBounds {
  id: string;
  /** Axis-aligned world bounds. */
  min: Vec3;
  max: Vec3;
  /** Floor-contact position. */
  position: Vec3;
}

export interface CameraSolveInput {
  shot: PrevisShotDefinition;
  subjects: SubjectBounds[];
  aspectRatio: number;
  /** Optional solid blockers (AABB) for inside-geometry rejection. */
  blockers?: Array<{ min: Vec3; max: Vec3 }>;
}

export interface CameraSolveResult {
  camera: CameraData;
  score: number;
  warnings: string[];
  measuredCoverage?: number;
}

export function solveShotCamera(input: CameraSolveInput): CameraSolveResult {
  const template = input.shot.camera.template;
  const lensClass = input.shot.camera.lensClass ?? defaultLensClassForTemplate(template);
  const angle = input.shot.camera.angle ?? defaultAngleForTemplate(template);
  const fovDegrees = verticalFovForLens(lensClass, input.aspectRatio);
  const coverage = FRAMING_COVERAGE[template];
  const warnings: string[] = [];

  const subjectIds = new Set(input.shot.camera.subjects);
  let primary = input.subjects.filter((subject) => subjectIds.has(subject.id));
  if (primary.length === 0) {
    primary = [...input.subjects];
    warnings.push('No camera subjects matched; framing all provided subjects.');
  }

  const foreground = input.shot.camera.foregroundSubject
    ? input.subjects.find((subject) => subject.id === input.shot.camera.foregroundSubject)
    : undefined;
  if (input.shot.camera.template === 'over_the_shoulder' && !foreground) {
    warnings.push('OTS missing foreground subject bounds; approximating.');
  }

  const group = boundsUnion(primary.map((subject) => ({ min: subject.min, max: subject.max })));
  const centroid = centerOf(group);
  const subjectHeight = Math.max(0.4, group.max[1] - group.min[1]);
  const aimY = group.min[1] + subjectHeight * aimHeightFraction(template);
  let target: Vec3 = [centroid[0], aimY, centroid[2]];

  if (template === 'over_the_shoulder' && foreground) {
    // Bias target toward primary subject, camera near foreground shoulder.
    const primaryCentroid = centerOf(boundsUnion(primary.map((s) => ({ min: s.min, max: s.max }))));
    target = [
      primaryCentroid[0] * 0.7 + foreground.position[0] * 0.3,
      aimY,
      primaryCentroid[2] * 0.7 + foreground.position[2] * 0.3,
    ];
  }

  const distance = distanceForCoverage({
    subjectHeight,
    coverageTarget: coverage.target,
    fovDegrees,
    template,
  });

  const candidates = buildCandidates({
    template,
    angle,
    target,
    distance,
    centroid,
    foreground,
    subjectHeight,
  });

  let best: { camera: CameraData; score: number; coverage: number } | undefined;

  for (const candidate of candidates) {
    if (!isFiniteVec3(candidate.position) || !isFiniteVec3(candidate.target)) continue;
    if (input.blockers && isInsideAny(candidate.position, input.blockers)) continue;

    const measured = estimateVerticalCoverage({
      cameraPosition: candidate.position,
      cameraTarget: candidate.target,
      fovDegrees,
      subjectMinY: group.min[1],
      subjectMaxY: group.max[1],
    });

    let score = scoreCoverage(measured, coverage);
    // Prefer candidates that keep required subjects roughly in front of camera.
    for (const subject of primary) {
      if (!isRoughlyInFront(candidate.position, candidate.target, centerOf({ min: subject.min, max: subject.max }))) {
        score -= 25;
      }
    }
    if (template === 'two_shot' && primary.length >= 2) score += 10;
    if (template === 'over_the_shoulder' && foreground) score += 10;

    if (!best || score > best.score) {
      best = {
        camera: {
          position: candidate.position,
          target: candidate.target,
          fovDegrees,
          aspectRatio: input.aspectRatio,
          near: 0.05,
          far: 500,
        },
        score,
        coverage: measured,
      };
    }
  }

  if (!best) {
    // Guaranteed finite fallback.
    const fallbackPos: Vec3 = [target[0], target[1] + 0.3, target[2] + Math.max(2, distance)];
    warnings.push('All camera candidates rejected; using fallback.');
    return {
      camera: {
        position: fallbackPos,
        target,
        fovDegrees,
        aspectRatio: input.aspectRatio,
        near: 0.05,
        far: 500,
      },
      score: -50,
      warnings,
      measuredCoverage: coverage.target,
    };
  }

  return {
    camera: best.camera,
    score: best.score,
    warnings,
    measuredCoverage: best.coverage,
  };
}

function defaultAngleForTemplate(template: PrevisCameraTemplate): PrevisCameraAngle {
  switch (template) {
    case 'profile':
      return 'profile';
    case 'over_the_shoulder':
      return 'three_quarter';
    default:
      return 'three_quarter';
  }
}

function distanceForCoverage(params: {
  subjectHeight: number;
  coverageTarget: number;
  fovDegrees: number;
  template: PrevisCameraTemplate;
}): number {
  const fovRad = (params.fovDegrees * Math.PI) / 180;
  // coverage ≈ subjectHeight / (2 * d * tan(fov/2))
  const denom = 2 * Math.tan(fovRad / 2) * Math.max(0.05, params.coverageTarget);
  let distance = params.subjectHeight / denom;
  if (params.template === 'establishing') distance *= 1.35;
  if (params.template === 'insert') distance *= 0.7;
  return Math.min(40, Math.max(0.6, distance));
}

function buildCandidates(params: {
  template: PrevisCameraTemplate;
  angle: PrevisCameraAngle;
  target: Vec3;
  distance: number;
  centroid: Vec3;
  foreground?: SubjectBounds;
  subjectHeight: number;
}): Array<{ position: Vec3; target: Vec3 }> {
  const yawOffsets = yawOffsetsForAngle(params.angle);
  const candidates: Array<{ position: Vec3; target: Vec3 }> = [];

  if (params.template === 'overhead') {
    candidates.push({
      position: [params.target[0], params.target[1] + params.distance, params.target[2]],
      target: params.target,
    });
    candidates.push({
      position: [params.target[0] + 0.5, params.target[1] + params.distance * 0.9, params.target[2] + 0.5],
      target: params.target,
    });
    return candidates;
  }

  const heightBias = heightBiasForTemplate(params.template, params.subjectHeight);

  for (const yawDeg of yawOffsets) {
    for (const distScale of [0.85, 1.0, 1.2]) {
      const distance = params.distance * distScale;
      const yaw = (yawDeg * Math.PI) / 180;
      let origin = params.target;
      if (params.template === 'over_the_shoulder' && params.foreground) {
        origin = [
          params.foreground.position[0],
          params.target[1],
          params.foreground.position[2],
        ];
      }
      const position: Vec3 = [
        origin[0] + Math.sin(yaw) * distance,
        origin[1] + heightBias,
        origin[2] + Math.cos(yaw) * distance,
      ];
      candidates.push({ position, target: params.target });
    }
  }

  return candidates;
}

function yawOffsetsForAngle(angle: PrevisCameraAngle): number[] {
  switch (angle) {
    case 'front':
      return [0, 8, -8];
    case 'profile':
      return [90, 85, 95, -90];
    case 'rear':
      return [180, 170, 190];
    case 'three_quarter':
    default:
      return [35, 45, 25, -35, -45];
  }
}

function heightBiasForTemplate(template: PrevisCameraTemplate, subjectHeight: number): number {
  switch (template) {
    case 'low_angle':
      return -subjectHeight * 0.25;
    case 'high_angle':
      return subjectHeight * 0.45;
    case 'overhead':
      return subjectHeight;
    default:
      return subjectHeight * 0.05;
  }
}

function estimateVerticalCoverage(params: {
  cameraPosition: Vec3;
  cameraTarget: Vec3;
  fovDegrees: number;
  subjectMinY: number;
  subjectMaxY: number;
}): number {
  const subjectHeight = Math.max(0.01, params.subjectMaxY - params.subjectMinY);
  const midY = (params.subjectMinY + params.subjectMaxY) / 2;
  const dx = params.cameraPosition[0] - params.cameraTarget[0];
  const dy = params.cameraPosition[1] - midY;
  const dz = params.cameraPosition[2] - params.cameraTarget[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-4) return 10;
  const fovRad = (params.fovDegrees * Math.PI) / 180;
  const frameHeight = 2 * distance * Math.tan(fovRad / 2);
  return subjectHeight / Math.max(1e-4, frameHeight);
}

function boundsUnion(boxes: Array<{ min: Vec3; max: Vec3 }>): { min: Vec3; max: Vec3 } {
  if (boxes.length === 0) {
    return { min: [0, 0, 0], max: [0, 1.7, 0] };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    min[0] = Math.min(min[0], box.min[0]);
    min[1] = Math.min(min[1], box.min[1]);
    min[2] = Math.min(min[2], box.min[2]);
    max[0] = Math.max(max[0], box.max[0]);
    max[1] = Math.max(max[1], box.max[1]);
    max[2] = Math.max(max[2], box.max[2]);
  }
  return { min, max };
}

function centerOf(box: { min: Vec3; max: Vec3 }): Vec3 {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
}

function isFiniteVec3(value: Vec3): boolean {
  return value.every((component) => Number.isFinite(component));
}

function isInsideAny(point: Vec3, blockers: Array<{ min: Vec3; max: Vec3 }>): boolean {
  return blockers.some((box) => (
    point[0] >= box.min[0] && point[0] <= box.max[0]
    && point[1] >= box.min[1] && point[1] <= box.max[1]
    && point[2] >= box.min[2] && point[2] <= box.max[2]
  ));
}

function isRoughlyInFront(camera: Vec3, target: Vec3, point: Vec3): boolean {
  const forward: Vec3 = [target[0] - camera[0], 0, target[2] - camera[2]];
  const toPoint: Vec3 = [point[0] - camera[0], 0, point[2] - camera[2]];
  const forwardLen = Math.hypot(forward[0], forward[2]);
  const pointLen = Math.hypot(toPoint[0], toPoint[2]);
  if (forwardLen < 1e-6 || pointLen < 1e-6) return true;
  const dot = (forward[0] * toPoint[0] + forward[2] * toPoint[2]) / (forwardLen * pointLen);
  return dot > 0.1;
}

export function subjectBoundsFromPlacement(params: {
  id: string;
  position: Vec3;
  height?: number;
  width?: number;
  depth?: number;
}): SubjectBounds {
  const height = params.height ?? 1.75;
  const width = params.width ?? 0.55;
  const depth = params.depth ?? 0.55;
  // position is floor-contact; center is at height/2
  const min: Vec3 = [
    params.position[0] - width / 2,
    params.position[1],
    params.position[2] - depth / 2,
  ];
  const max: Vec3 = [
    params.position[0] + width / 2,
    params.position[1] + height,
    params.position[2] + depth / 2,
  ];
  return { id: params.id, min, max, position: params.position };
}
