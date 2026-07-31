/**
 * Structured first-frame validation without a vision model.
 */

import type { CameraData, LocationProject, Shot, Vec3 } from '../../domain/types';
import type { PrevisShotDefinition } from './manifest';
import { FRAMING_COVERAGE } from './framing';
import { resolveProjectForShot } from '../shotSceneState';

export type FrameValidationStatus = 'passed' | 'warning' | 'failed' | 'needs_review';

export interface FrameValidationIssue {
  code: string;
  message: string;
  subject?: string;
  expectedShotSize?: string;
  measuredCoverage?: number;
}

export interface FrameValidationResult {
  shotNumber: string;
  status: FrameValidationStatus;
  issues: FrameValidationIssue[];
}

export interface ValidateShotFrameInput {
  project: LocationProject;
  shot: Shot;
  definition: PrevisShotDefinition;
  frameExists: boolean;
  frameByteSize?: number;
  previousCamera?: CameraData;
  /** Manifest subject id → created object display name. */
  subjectNames?: Record<string, string>;
}

export function validateShotFrame(input: ValidateShotFrameInput): FrameValidationResult {
  const issues: FrameValidationIssue[] = [];
  const { shot, definition, project } = input;

  if (!shot) {
    return {
      shotNumber: definition.shotNumber,
      status: 'failed',
      issues: [{ code: 'shot_missing', message: 'Shot does not exist in the project.' }],
    };
  }

  const camera = shot.camera;
  if (
    !isFiniteVec3(camera.position)
    || !isFiniteVec3(camera.target)
    || !Number.isFinite(camera.fovDegrees)
  ) {
    issues.push({ code: 'camera_non_finite', message: 'Camera position, target, or FOV is non-finite.' });
  }

  if (camera.fovDegrees < 5 || camera.fovDegrees > 120) {
    issues.push({
      code: 'fov_out_of_bounds',
      message: `FOV ${camera.fovDegrees} is outside safe bounds (5–120).`,
    });
  }

  const resolved = resolveProjectForShot(project, shot);

  if (isCameraInsideSolidGeometry(camera.position, resolved)) {
    issues.push({
      code: 'camera_inside_geometry',
      message: 'Camera position appears to be inside solid set geometry.',
    });
  }

  const visibleRequired = definition.requirements?.visibleSubjects
    ?? definition.camera.subjects;

  for (const subjectId of visibleRequired) {
    const object = findSubjectObject(resolved, subjectId, definition, input.subjectNames);
    if (!object) {
      issues.push({
        code: 'required_subject_missing',
        message: `Required subject "${subjectId}" not found.`,
        subject: subjectId,
      });
      continue;
    }
    if (object.visible === false) {
      issues.push({
        code: 'required_subject_hidden',
        message: `Required subject "${subjectId}" is not visible in this shot.`,
        subject: subjectId,
      });
    }

    const coverage = estimateSubjectCoverage(camera, object);
    const range = FRAMING_COVERAGE[definition.camera.template];
    if (coverage < range.min * 0.5) {
      issues.push({
        code: 'subject_too_small',
        message: `Subject "${subjectId}" coverage ${coverage.toFixed(2)} is below expected for ${definition.camera.template}.`,
        subject: subjectId,
        expectedShotSize: definition.camera.template,
        measuredCoverage: coverage,
      });
    } else if (coverage > range.max * 1.35) {
      issues.push({
        code: 'subject_too_large',
        message: `Subject "${subjectId}" coverage ${coverage.toFixed(2)} is above expected for ${definition.camera.template}.`,
        subject: subjectId,
        expectedShotSize: definition.camera.template,
        measuredCoverage: coverage,
      });
    }

    if (!roughlyInFrame(camera, object.transform.position)) {
      issues.push({
        code: 'subject_out_of_frame',
        message: `Subject "${subjectId}" may be outside the camera frustum.`,
        subject: subjectId,
      });
    }

    // Feet near ground: center Y ≈ height/2
    const height = object.dimensions[1] * object.transform.scale[1];
    const feetY = object.transform.position[1] - height / 2;
    if (Math.abs(feetY) > 0.35) {
      issues.push({
        code: 'character_underground',
        message: `Subject "${subjectId}" feet are ${feetY.toFixed(2)}m from ground.`,
        subject: subjectId,
      });
    }
  }

  for (const propId of definition.requirements?.visibleProps ?? []) {
    const object = findSubjectObject(resolved, propId, definition, input.subjectNames);
    if (!object) {
      issues.push({
        code: 'required_prop_missing',
        message: `Required prop "${propId}" not found.`,
        subject: propId,
      });
    } else if (object.visible === false) {
      issues.push({
        code: 'required_prop_hidden',
        message: `Required prop "${propId}" is not visible.`,
        subject: propId,
      });
    }
  }

  if (input.previousCamera && camerasNearlyIdentical(camera, input.previousCamera)) {
    issues.push({
      code: 'adjacent_cameras_identical',
      message: 'Camera is nearly identical to the previous shot.',
    });
  }

  if (!input.frameExists || (input.frameByteSize !== undefined && input.frameByteSize < 32)) {
    issues.push({
      code: 'frame_missing',
      message: 'Output PNG is missing or empty.',
    });
  }

  // Check character overlaps
  const people = resolved.scene.objects.filter((object) => object.type === 'human_dummy' && object.visible !== false);
  for (let i = 0; i < people.length; i += 1) {
    for (let j = i + 1; j < people.length; j += 1) {
      const a = people[i]!;
      const b = people[j]!;
      const dx = a.transform.position[0] - b.transform.position[0];
      const dz = a.transform.position[2] - b.transform.position[2];
      if (Math.hypot(dx, dz) < 0.45) {
        issues.push({
          code: 'subjects_overlapping',
          message: `Characters "${a.name}" and "${b.name}" are overlapping.`,
          subject: a.name,
        });
      }
    }
  }

  const hasFailure = issues.some((issue) => (
    issue.code === 'shot_missing'
    || issue.code === 'camera_non_finite'
    || issue.code === 'frame_missing'
    || issue.code === 'required_subject_missing'
  ));
  const hasWarning = issues.length > 0;

  let status: FrameValidationStatus = 'passed';
  if (hasFailure) status = 'failed';
  else if (hasWarning) status = 'warning';

  return {
    shotNumber: definition.shotNumber,
    status,
    issues,
  };
}

function findSubjectObject(
  project: LocationProject,
  subjectId: string,
  _definition: PrevisShotDefinition,
  subjectNames?: Record<string, string>,
) {
  const mappedName = subjectNames?.[subjectId];
  const candidates = [mappedName, subjectId].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const exact = project.scene.objects.find((object) => (
      object.name === candidate
      || object.name.toLowerCase() === candidate.toLowerCase()
    ));
    if (exact) return exact;
  }
  return project.scene.objects.find((object) => (
    candidates.some((candidate) => object.name.toLowerCase().includes(candidate.toLowerCase()))
  ));
}

function estimateSubjectCoverage(
  camera: CameraData,
  object: { transform: { position: Vec3; scale: Vec3 }; dimensions: Vec3 },
): number {
  const height = object.dimensions[1] * object.transform.scale[1];
  const dx = camera.position[0] - object.transform.position[0];
  const dy = camera.position[1] - object.transform.position[1];
  const dz = camera.position[2] - object.transform.position[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-4) return 10;
  const fovRad = (camera.fovDegrees * Math.PI) / 180;
  const frameHeight = 2 * distance * Math.tan(fovRad / 2);
  return height / Math.max(1e-4, frameHeight);
}

function roughlyInFrame(camera: CameraData, point: Vec3): boolean {
  const forward: Vec3 = [
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ];
  const toPoint: Vec3 = [
    point[0] - camera.position[0],
    point[1] - camera.position[1],
    point[2] - camera.position[2],
  ];
  const forwardLen = Math.hypot(forward[0], forward[1], forward[2]);
  const pointLen = Math.hypot(toPoint[0], toPoint[1], toPoint[2]);
  if (forwardLen < 1e-6 || pointLen < 1e-6) return true;
  const dot = (
    forward[0] * toPoint[0]
    + forward[1] * toPoint[1]
    + forward[2] * toPoint[2]
  ) / (forwardLen * pointLen);
  return dot > 0.15;
}

function camerasNearlyIdentical(a: CameraData, b: CameraData): boolean {
  const posDist = Math.hypot(
    a.position[0] - b.position[0],
    a.position[1] - b.position[1],
    a.position[2] - b.position[2],
  );
  const tgtDist = Math.hypot(
    a.target[0] - b.target[0],
    a.target[1] - b.target[1],
    a.target[2] - b.target[2],
  );
  return posDist < 0.05 && tgtDist < 0.05 && Math.abs(a.fovDegrees - b.fovDegrees) < 0.25;
}

function isFiniteVec3(value: Vec3): boolean {
  return value.every((component) => Number.isFinite(component));
}

const SOLID_TYPES = new Set([
  'wall', 'box', 'column', 'arch', 'doorway', 'stairs', 'terrain_mass', 'background_card',
]);

function isCameraInsideSolidGeometry(
  cameraPosition: Vec3,
  project: LocationProject,
): boolean {
  for (const object of project.scene.objects) {
    if (!SOLID_TYPES.has(object.type)) continue;
    if (object.visible === false) continue;
    const dims = object.dimensions;
    const scale = object.transform.scale;
    const hx = (dims[0] * scale[0]) / 2;
    const hy = (dims[1] * scale[1]) / 2;
    const hz = (dims[2] * scale[2]) / 2;
    const center = object.transform.position;
    // Shrink slightly so resting near surfaces is not treated as inside.
    const margin = 0.08;
    if (
      cameraPosition[0] > center[0] - hx + margin
      && cameraPosition[0] < center[0] + hx - margin
      && cameraPosition[1] > center[1] - hy + margin
      && cameraPosition[1] < center[1] + hy - margin
      && cameraPosition[2] > center[2] - hz + margin
      && cameraPosition[2] < center[2] + hz - margin
    ) {
      return true;
    }
  }
  return false;
}


export function isRepairableIssue(code: string): boolean {
  return [
    'subject_too_small',
    'subject_too_large',
    'subject_out_of_frame',
    'camera_inside_geometry',
    'character_underground',
    'subjects_overlapping',
  ].includes(code);
}
