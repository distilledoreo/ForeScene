/** Deterministic camera-only refinement for normalized composition contracts. */

import type { CameraData, LocationProject, Shot, ShotCompositionConstraintSet, Vec3 } from '../../domain/types';
import {
  inspectShotCompositionError,
  type CompositionConstraintDiagnostic,
  type ShotCompositionConstraintInspection,
} from './compositionConstraints';

export interface CompositionConstraintSolveOptions {
  /** Maximum coordinate-descent passes. Defaults to 8. */
  maxIterations?: number;
  /** Stop when the weighted objective improves by less than this amount. */
  minimumImprovement?: number;
  /** Maximum world-space movement applied to camera position/target. */
  maxPositionDelta?: number;
  /** Maximum absolute FOV change from the starting camera. */
  maxFovDelta?: number;
}

export interface CompositionConstraintSolveResult {
  ok: boolean;
  shotId: string;
  before: ShotCompositionConstraintInspection;
  after: ShotCompositionConstraintInspection;
  shot: Shot;
  changed: boolean;
  iterations: number;
  diagnostics: CompositionConstraintDiagnostic[];
}

interface Candidate {
  camera: CameraData;
  inspection: ShotCompositionConstraintInspection;
  objective: number;
}

const DEFAULT_OPTIONS: Required<CompositionConstraintSolveOptions> = {
  maxIterations: 8,
  minimumImprovement: 1e-4,
  maxPositionDelta: 3,
  maxFovDelta: 20,
};

function finiteVec3(value: Vec3): boolean {
  return value.every((component) => Number.isFinite(component));
}

function cloneCamera(camera: CameraData): CameraData {
  return {
    ...camera,
    position: [...camera.position] as Vec3,
    target: [...camera.target] as Vec3,
  };
}

function objective(inspection: ShotCompositionConstraintInspection): number {
  // Missing entities and out-of-tolerance constraints need to dominate a
  // small numeric improvement in another constraint. This also makes the
  // solver deterministic when an incomplete contract is supplied.
  return inspection.totalWeightedError + inspection.diagnostics.length * 10;
}

function candidateCamera(
  start: CameraData,
  current: CameraData,
  axis: 'position' | 'target' | 'fov',
  index: number,
  delta: number,
  options: Required<CompositionConstraintSolveOptions>,
): CameraData | undefined {
  const next = cloneCamera(current);
  if (axis === 'fov') {
    next.fovDegrees = Math.max(5, Math.min(120, start.fovDegrees + delta));
  } else {
    const point = next[axis];
    const startPoint = start[axis];
    const nextValue = startPoint[index]! + (point[index]! - startPoint[index]!) + delta;
    if (Math.abs(nextValue - startPoint[index]!) > options.maxPositionDelta) return undefined;
    point[index] = nextValue;
  }
  if (!finiteVec3(next.position) || !finiteVec3(next.target) || !Number.isFinite(next.fovDegrees)) {
    return undefined;
  }
  return next;
}

function cameraChanged(a: CameraData, b: CameraData): boolean {
  return a.fovDegrees !== b.fovDegrees
    || a.position.some((value, index) => value !== b.position[index])
    || a.target.some((value, index) => value !== b.target[index]);
}

function inspectCandidate(
  project: LocationProject,
  sourceShot: Shot,
  camera: CameraData,
  contract?: ShotCompositionConstraintSet,
): Candidate {
  const shot = { ...sourceShot, camera };
  const inspection = inspectShotCompositionError(project, shot, contract);
  return { camera, inspection, objective: objective(inspection) };
}

/**
 * Refine only camera position, target, and FOV. Subject identity, pose,
 * location, panorama, and continuity state are intentionally immutable here.
 */
export function solveShotToCompositionConstraints(
  project: LocationProject,
  shotInput: Shot | string,
  contract?: ShotCompositionConstraintSet,
  options: CompositionConstraintSolveOptions = {},
): CompositionConstraintSolveResult {
  const resolvedShot = typeof shotInput === 'string'
    ? project.shots.find((shot) => shot.id === shotInput)
    : shotInput;
  const shotId = typeof shotInput === 'string' ? shotInput : shotInput.id;
  if (!resolvedShot) {
    const before = inspectShotCompositionError(project, shotId, contract);
    return {
      ok: false,
      shotId,
      before,
      after: before,
      shot: shotInput as Shot,
      changed: false,
      iterations: 0,
      diagnostics: before.diagnostics,
    };
  }

  const config = { ...DEFAULT_OPTIONS, ...options };
  const before = inspectShotCompositionError(project, resolvedShot, contract);
  const startCamera = cloneCamera(resolvedShot.camera);
  let current = inspectCandidate(project, resolvedShot, startCamera, contract);
  let iterations = 0;

  // Coarse-to-fine coordinate descent. The fixed order and fixed deltas make
  // the result reproducible across browser and CLI adapters.
  const passes: Array<{ axis: 'position' | 'target' | 'fov'; index: number; deltas: number[] }> = [
    { axis: 'target', index: 0, deltas: [-0.5, 0.5, -0.2, 0.2, -0.05, 0.05] },
    { axis: 'target', index: 1, deltas: [-0.4, 0.4, -0.15, 0.15, -0.05, 0.05] },
    { axis: 'target', index: 2, deltas: [-0.5, 0.5, -0.2, 0.2, -0.05, 0.05] },
    { axis: 'position', index: 0, deltas: [-0.5, 0.5, -0.2, 0.2, -0.05, 0.05] },
    { axis: 'position', index: 1, deltas: [-0.3, 0.3, -0.1, 0.1, -0.03, 0.03] },
    { axis: 'position', index: 2, deltas: [-0.5, 0.5, -0.2, 0.2, -0.05, 0.05] },
    { axis: 'fov', index: 0, deltas: [-8, 8, -3, 3, -1, 1] },
  ];

  for (let pass = 0; pass < config.maxIterations; pass += 1) {
    iterations += 1;
    const passStartObjective = current.objective;
    for (const step of passes) {
      let best = current;
      for (const delta of step.deltas) {
        const camera = candidateCamera(startCamera, current.camera, step.axis, step.index, delta, config);
        if (!camera) continue;
        const candidate = inspectCandidate(project, resolvedShot, camera, contract);
        if (candidate.objective + config.minimumImprovement < best.objective) best = candidate;
      }
      current = best;
    }
    if (passStartObjective - current.objective < config.minimumImprovement) break;
  }

  const solvedShot: Shot = { ...resolvedShot, camera: current.camera };
  const after = current.inspection;
  return {
    ok: after.contractPresent && after.diagnostics.length === 0,
    shotId,
    before,
    after,
    shot: solvedShot,
    changed: cameraChanged(startCamera, current.camera),
    iterations,
    diagnostics: after.diagnostics,
  };
}
