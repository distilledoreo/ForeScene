/**
 * Telemetry-driven repair suggestions for structured validation issues.
 *
 * Applies ONE root-cause correction per attempt. For two_shot and OTS,
 * re-runs the dedicated template solver instead of generic dolly nudges.
 */

import type { CameraData, Vec3 } from '../../domain/types';
import type { FrameValidationIssue } from './frameValidation';
import type { ForeSceneAgentCommand } from '../agent/protocol';
import type { ShotCompositionTelemetry } from './compositionTelemetry';
import { FRAMING_COVERAGE } from './framing';
import { templateFramingBands } from './framingProfiles';
import type { PrevisCameraTemplate, PrevisShotDefinition } from './manifest';
import {
  reSolveTemplateCamera,
  type CameraSolveRepairProfile,
  type SubjectBounds,
} from './cameraSolver';

export type CropAnchorKey = 'shoulderY' | 'chestY' | 'waistY';

export type CropAnchor = {
  key: CropAnchorKey;
  y: number;
};

export interface RepairAttemptAction {
  type: string;
  scale?: number;
  targetHeadY?: number;
  targetCropY?: number;
  cropAnchor?: CropAnchorKey;
}

export interface RepairPlan {
  commands: ForeSceneAgentCommand[];
  description: string;
  /** Issue code that drove this repair. */
  primaryIssueCode?: string;
  /** Structured action metadata for repair attempt logs. */
  action?: RepairAttemptAction;
  /** Measured framing metrics before the repair is applied. */
  before?: Record<string, number>;
}

/**
 * Repair priority: lower index = higher priority. Only the first matching
 * issue class is repaired each attempt so corrections do not fight each other.
 */
export const REPAIR_PRIORITY: string[][] = [
  ['frame_blank', 'render_not_ready'],
  ['camera_inside_geometry', 'wall_dominant', 'subject_occluded', 'subject_face_occluded', 'ots_primary_obstructed'],
  ['subject_out_of_frame', 'required_subject_hidden', 'ots_foreground_missing'],
  ['framing_too_loose', 'framing_too_tight', 'subject_too_small', 'subject_too_large', 'ots_foreground_too_small', 'ots_foreground_too_large'],
  ['headroom_excessive', 'head_clipped', 'crop_landmark_clipped'],
  ['unwanted_subject_dominant', 'primary_off_center', 'subjects_overlapping', 'character_underground'],
];

/**
 * Build a small Agent plan that nudges camera / grounding based on issues
 * and measured composition telemetry.
 */
export function buildRepairPlan(params: {
  shotTarget: { id: string } | { ref: string };
  camera: CameraData;
  issues: FrameValidationIssue[];
  /** object id/ref for underground / overlap repairs */
  subjectTargets?: Record<string, { id: string } | { ref: string }>;
  subjectPositions?: Record<string, Vec3>;
  telemetry?: ShotCompositionTelemetry;
  template?: PrevisCameraTemplate;
  primarySubjectId?: string;
  foregroundSubjectId?: string;
  /** Live subject bounds for template re-solves (two_shot / OTS). */
  subjects?: SubjectBounds[];
  aspectRatio?: number;
  blockers?: Array<{ id?: string; min: Vec3; max: Vec3 }>;
  /** Full shot definition when available — preferred for re-solve. */
  shotDefinition?: PrevisShotDefinition;
}): RepairPlan | undefined {
  const primaryIssue = selectPrimaryIssue(params.issues);
  if (!primaryIssue) return undefined;

  // Template-specific re-solve for two-shot and OTS: never stack generic dolly ops.
  if (
    (params.template === 'two_shot' || params.template === 'over_the_shoulder')
    && params.subjects
    && params.subjects.length >= 1
    && primaryIssue.code !== 'frame_blank'
    && primaryIssue.code !== 'render_not_ready'
    && primaryIssue.code !== 'character_underground'
  ) {
    const resolved = reSolveForTemplate({
      ...params,
      issues: params.issues,
      telemetry: params.telemetry,
    }, primaryIssue.code);
    if (resolved) return resolved;
  }

  const commands: ForeSceneAgentCommand[] = [];
  const notes: string[] = [];
  let camera: CameraData = {
    ...params.camera,
    position: [...params.camera.position] as Vec3,
    target: [...params.camera.target] as Vec3,
  };

  let cameraChanged = false;
  let repairAction: RepairAttemptAction | undefined;
  const template = params.template;
  const range = template ? FRAMING_COVERAGE[template] : undefined;
  const primaryId = params.primarySubjectId;
  const primaryTelemetry = resolvePrimaryTelemetry(params.telemetry, primaryId);

  switch (primaryIssue.code) {
    case 'subject_too_small':
    case 'framing_too_loose': {
      const anchor = applyAnchorSpanCameraRepair(camera, primaryIssue, template)
        ?? (primaryTelemetry && template
          ? applyAnchorSpanCameraRepair(camera, {
            code: 'framing_too_loose',
            message: 'landmark loose',
            measured: {
              headTopY: primaryTelemetry.landmarks?.headTop?.y,
              waistY: primaryTelemetry.landmarks?.waist?.y,
              shoulderY: primaryTelemetry.landmarks?.shoulders?.y,
              chestY: primaryTelemetry.landmarks?.chest?.y,
            },
          }, template)
          : undefined);
      if (anchor) {
        camera = anchor.camera;
        cameraChanged = true;
        repairAction = anchor.action;
        notes.push(anchor.action.type);
        break;
      }
      const measured = primaryIssue.measuredCoverage
        ?? (typeof primaryIssue.measured?.heightCoverage === 'number'
          ? primaryIssue.measured.heightCoverage
          : primaryTelemetry?.bounds.heightCoverage);
      const target = range?.target ?? 0.6;
      if (measured && measured > 0) {
        const distanceScale = Math.min(0.95, Math.max(0.55, measured / target));
        camera.position = moveToward(camera.position, camera.target, distanceScale);
      } else {
        camera.position = moveToward(camera.position, camera.target, 0.82);
      }
      const headY = typeof primaryIssue.measured?.headTopY === 'number'
        ? primaryIssue.measured.headTopY
        : primaryTelemetry?.landmarks?.headTop?.y;
      if (typeof headY === 'number') {
        camera = { ...camera, ...applyHeadroomCorrection(camera, headY, 0.10) };
      }
      cameraChanged = true;
      notes.push('tighten framing from telemetry');
      break;
    }
    case 'subject_too_large':
    case 'framing_too_tight': {
      const anchor = applyAnchorSpanCameraRepair(camera, primaryIssue, template)
        ?? (primaryTelemetry && template
          ? applyAnchorSpanCameraRepair(camera, {
            code: 'framing_too_tight',
            message: 'landmark tight',
            measured: {
              headTopY: primaryTelemetry.landmarks?.headTop?.y,
              waistY: primaryTelemetry.landmarks?.waist?.y,
              shoulderY: primaryTelemetry.landmarks?.shoulders?.y,
              chestY: primaryTelemetry.landmarks?.chest?.y,
            },
          }, template)
          : undefined);
      if (anchor) {
        camera = anchor.camera;
        cameraChanged = true;
        repairAction = anchor.action;
        notes.push(anchor.action.type);
        break;
      }
      const measured = primaryIssue.measuredCoverage
        ?? (typeof primaryIssue.measured?.heightCoverage === 'number'
          ? primaryIssue.measured.heightCoverage
          : primaryTelemetry?.bounds.heightCoverage);
      const target = range?.target ?? 0.6;
      if (measured && measured > 0) {
        const distanceScale = Math.min(1.55, Math.max(1.05, measured / Math.max(0.05, target)));
        camera.position = moveAway(camera.position, camera.target, distanceScale);
      } else {
        camera.position = moveAway(camera.position, camera.target, 1.18);
      }
      cameraChanged = true;
      notes.push('loosen framing from telemetry');
      break;
    }
    case 'headroom_excessive': {
      const headY = typeof primaryIssue.measured?.headTopY === 'number'
        ? primaryIssue.measured.headTopY
        : primaryTelemetry?.landmarks?.headTop?.y
          ?? 0.25;
      const headBand = template ? templateFramingBands(template).headTopY : undefined;
      const desiredHead = headBand
        ? (headBand[0] + headBand[1]) / 2
        : 0.10;
      const anchor = primaryTelemetry && template
        ? applyAnchorSpanCameraRepair(camera, {
          code: 'headroom_excessive',
          message: 'headroom with loose crop span',
          measured: {
            headTopY: headY,
            waistY: primaryTelemetry.landmarks?.waist?.y,
            shoulderY: primaryTelemetry.landmarks?.shoulders?.y,
            chestY: primaryTelemetry.landmarks?.chest?.y,
          },
        }, template)
        : undefined;
      if (anchor) {
        camera = anchor.camera;
        cameraChanged = true;
        repairAction = anchor.action;
        notes.push(anchor.action.type);
        break;
      }
      const headroom = applyHeadroomCorrection(camera, headY, desiredHead);
      camera = { ...camera, ...headroom };
      cameraChanged = true;
      repairAction = { type: 'tilt_down_reduce_headroom', targetHeadY: desiredHead };
      notes.push('reduce headroom');
      break;
    }
    case 'head_clipped':
    case 'crop_landmark_clipped': {
      const headY = typeof primaryIssue.measured?.headTopY === 'number'
        ? primaryIssue.measured.headTopY
        : primaryTelemetry?.landmarks?.headTop?.y
          ?? 0.05;
      const headBand = template ? templateFramingBands(template).headTopY : undefined;
      const desiredHead = headBand
        ? (headBand[0] + headBand[1]) / 2
        : 0.12;
      const headroom = applyHeadroomCorrection(camera, headY, desiredHead);
      camera = { ...camera, ...headroom };
      cameraChanged = true;
      repairAction = { type: 'tilt_up_uncrop_head', targetHeadY: desiredHead };
      notes.push('uncrop head');
      break;
    }
    case 'primary_off_center': {
      if (primaryIssue.subject && params.subjectPositions?.[primaryIssue.subject]) {
        const pos = params.subjectPositions[primaryIssue.subject]!;
        camera.target = [pos[0], camera.target[1], pos[2]];
        cameraChanged = true;
        notes.push('recenter primary');
      } else if (primaryTelemetry) {
        const shift = (0.5 - primaryTelemetry.bounds.centerX) * 0.6;
        const forward: Vec3 = [
          camera.target[0] - camera.position[0],
          0,
          camera.target[2] - camera.position[2],
        ];
        const fLen = Math.hypot(forward[0], forward[2]) || 1;
        const right: Vec3 = [forward[2] / fLen, 0, -forward[0] / fLen];
        camera.target = [
          camera.target[0] + right[0] * shift,
          camera.target[1],
          camera.target[2] + right[2] * shift,
        ];
        cameraChanged = true;
        notes.push('nudge target for center');
      }
      break;
    }
    case 'subject_out_of_frame':
    case 'required_subject_hidden': {
      if (primaryIssue.subject && params.subjectPositions?.[primaryIssue.subject]) {
        const pos = params.subjectPositions[primaryIssue.subject]!;
        camera.target = [pos[0], camera.target[1], pos[2]];
        cameraChanged = true;
        notes.push('recenter camera target');
      }
      break;
    }
    case 'camera_inside_geometry':
    case 'wall_dominant':
    case 'subject_occluded':
    case 'subject_face_occluded':
    case 'ots_primary_obstructed': {
      camera.position = rotateAroundTarget(camera.position, camera.target, 35);
      camera.position = moveAway(camera.position, camera.target, 1.12);
      cameraChanged = true;
      notes.push('orbit away from obstruction');
      break;
    }
    case 'ots_foreground_too_small': {
      camera.position = moveToward(camera.position, camera.target, 0.78);
      cameraChanged = true;
      notes.push('OTS: move closer to foreground');
      break;
    }
    case 'ots_foreground_too_large': {
      camera.position = moveAway(camera.position, camera.target, 1.22);
      camera.position = rotateAroundTarget(camera.position, camera.target, 12);
      cameraChanged = true;
      notes.push('OTS: pull back from foreground');
      break;
    }
    case 'ots_foreground_missing': {
      camera.position = mirrorAroundTarget(camera.position, camera.target);
      cameraChanged = true;
      notes.push('OTS: swap shoulder side');
      break;
    }
    case 'unwanted_subject_dominant': {
      camera.position = moveToward(camera.position, camera.target, 0.8);
      camera.position = rotateAroundTarget(camera.position, camera.target, 18);
      if (primaryId && params.subjectPositions?.[primaryId]) {
        const pos = params.subjectPositions[primaryId]!;
        camera.target = [pos[0], camera.target[1], pos[2]];
      }
      cameraChanged = true;
      notes.push('reduce secondary dominance');
      break;
    }
    case 'character_underground': {
      const target = primaryIssue.subject ? params.subjectTargets?.[primaryIssue.subject] : undefined;
      const pos = primaryIssue.subject ? params.subjectPositions?.[primaryIssue.subject] : undefined;
      if (target && pos) {
        commands.push({
          op: 'shot.stageObject',
          shot: params.shotTarget,
          object: target,
          transform: {
            position: [pos[0], Math.abs(pos[1]) < 0.01 ? 0.875 : pos[1], pos[2]],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          visible: true,
        });
        notes.push('reground character');
      }
      break;
    }
    case 'subjects_overlapping': {
      camera.position = moveAway(camera.position, camera.target, 1.05);
      cameraChanged = true;
      notes.push('increase separation via camera pullback');
      break;
    }
    case 'frame_blank':
    case 'render_not_ready': {
      notes.push('re-render after ready');
      break;
    }
    default:
      return undefined;
  }

  if (cameraChanged) {
    commands.unshift({
      op: 'shot.updateCamera',
      shot: params.shotTarget,
      camera: {
        position: camera.position,
        target: camera.target,
        fovDegrees: camera.fovDegrees,
      },
    });
  }

  if (commands.length === 0 && notes.length === 0) return undefined;
  if (commands.length === 0 && notes[0] === 're-render after ready') {
    return {
      commands: [],
      description: `Repair: ${notes.join(', ')}`,
      primaryIssueCode: primaryIssue.code,
    };
  }
  if (commands.length === 0) return undefined;

  return {
    commands,
    description: `Repair: ${notes.join(', ') || 'adjust'}`,
    primaryIssueCode: primaryIssue.code,
    ...(repairAction ? { action: repairAction } : {}),
  };
}

function reSolveForTemplate(
  params: {
    shotTarget: { id: string } | { ref: string };
    camera: CameraData;
    issues?: FrameValidationIssue[];
    telemetry?: ShotCompositionTelemetry;
    template?: PrevisCameraTemplate;
    primarySubjectId?: string;
    foregroundSubjectId?: string;
    subjects?: SubjectBounds[];
    aspectRatio?: number;
    blockers?: Array<{ id?: string; min: Vec3; max: Vec3 }>;
    shotDefinition?: PrevisShotDefinition;
  },
  issueCode: string,
): RepairPlan | undefined {
  const template = params.template!;
  const subjects = params.subjects!;
  const aspectRatio = params.aspectRatio
    ?? params.camera.aspectRatio
    ?? 16 / 9;
  const primaryIds = params.shotDefinition?.camera.subjects
    ?? (params.primarySubjectId ? [params.primarySubjectId] : subjects.map((s) => s.id));
  const foreground = params.foregroundSubjectId
    ?? params.shotDefinition?.camera.foregroundSubject;

  const shot: PrevisShotDefinition = params.shotDefinition ?? {
    id: 'repair',
    shotNumber: '000',
    name: 'repair',
    description: 'template re-solve',
    locationId: 'loc',
    subjects: primaryIds,
    camera: {
      template,
      subjects: primaryIds,
      ...(foreground ? { foregroundSubject: foreground } : {}),
    },
  };

  const repairProfile = template === 'over_the_shoulder'
    ? buildOtsRepairProfile({
      issueCode,
      camera: params.camera,
      issues: params.issues ?? [],
      telemetry: params.telemetry,
      foregroundId: foreground,
      primaryId: primaryIds[0],
    })
    : template === 'two_shot'
      ? { avoidCamera: params.camera, minCameraDistanceFromAvoid: 0.35 }
      : undefined;

  const solved = reSolveTemplateCamera({
    shot: {
      ...shot,
      camera: {
        ...shot.camera,
        template,
        subjects: primaryIds,
        ...(foreground ? { foregroundSubject: foreground } : {}),
      },
    },
    subjects,
    aspectRatio,
    blockers: params.blockers,
    repair: repairProfile,
  });

  if (!solved.camera.position.every(Number.isFinite)) return undefined;

  // If the re-solve is a near no-op, escalate OTS search farther — never arbitrary orbit.
  const posDist = Math.hypot(
    solved.camera.position[0] - params.camera.position[0],
    solved.camera.position[1] - params.camera.position[1],
    solved.camera.position[2] - params.camera.position[2],
  );
  const tgtDist = Math.hypot(
    solved.camera.target[0] - params.camera.target[0],
    solved.camera.target[1] - params.camera.target[1],
    solved.camera.target[2] - params.camera.target[2],
  );

  let finalCamera = solved.camera;
  if (template === 'over_the_shoulder' && posDist < 0.08 && tgtDist < 0.08) {
    const escalated = reSolveTemplateCamera({
      shot: {
        ...shot,
        camera: {
          ...shot.camera,
          template,
          subjects: primaryIds,
          ...(foreground ? { foregroundSubject: foreground } : {}),
        },
      },
      subjects,
      aspectRatio,
      blockers: params.blockers,
      repair: {
        ...repairProfile,
        avoidCamera: params.camera,
        minCameraDistanceFromAvoid: 0.7,
        minBack: Math.max(repairProfile?.minBack ?? 0.3, 0.9),
        minOut: Math.max(repairProfile?.minOut ?? 0.25, 0.85),
        preferOppositeShoulder: true,
        foregroundWidthMax: Math.min(repairProfile?.foregroundWidthMax ?? 0.40, 0.35),
      },
    });
    if (
      escalated.camera.position.every(Number.isFinite)
      && Math.hypot(
        escalated.camera.position[0] - params.camera.position[0],
        escalated.camera.position[2] - params.camera.position[2],
      ) > 0.1
    ) {
      finalCamera = escalated.camera;
    } else {
      // Genuinely stuck — refuse a meaningless command.
      return undefined;
    }
  }

  return {
    commands: [{
      op: 'shot.updateCamera',
      shot: params.shotTarget,
      camera: {
        position: finalCamera.position,
        target: finalCamera.target,
        fovDegrees: finalCamera.fovDegrees,
        aspectRatio: finalCamera.aspectRatio,
        near: finalCamera.near,
        far: finalCamera.far,
      },
    }],
    description: template === 'two_shot'
      ? `Repair: two-shot dedicated re-solve for ${issueCode}`
      : `Repair: OTS dedicated re-solve for ${issueCode}`,
    primaryIssueCode: issueCode,
  };
}

/** Build issue-aware OTS search constraints for the dedicated solver. */
export function buildOtsRepairProfile(params: {
  issueCode: string;
  camera: CameraData;
  issues: FrameValidationIssue[];
  telemetry?: ShotCompositionTelemetry;
  foregroundId?: string;
  primaryId?: string;
}): CameraSolveRepairProfile {
  const profile: CameraSolveRepairProfile = {
    avoidCamera: params.camera,
    minCameraDistanceFromAvoid: 0.4,
  };

  const issue = params.issues.find((item) => item.code === params.issueCode);
  const fgKey = params.foregroundId;
  const fgTelemetry = fgKey && params.telemetry
    ? params.telemetry.subjects[fgKey]
      ?? Object.entries(params.telemetry.subjects).find(([key]) => (
        key.toLowerCase().includes(fgKey.toLowerCase())
      ))?.[1]
    : undefined;
  const prevFgWidth = typeof issue?.measured?.widthCoverage === 'number'
    ? issue.measured.widthCoverage
    : fgTelemetry?.upperBodyBounds?.widthCoverage
      ?? fgTelemetry?.bounds.widthCoverage;

  switch (params.issueCode) {
    case 'ots_foreground_too_large':
      profile.minBack = 0.7;
      profile.minOut = 0.45;
      profile.foregroundWidthMax = 0.40;
      if (typeof prevFgWidth === 'number') {
        profile.previousForegroundWidth = prevFgWidth;
        profile.foregroundWidthMax = Math.min(0.40, prevFgWidth * 0.92);
      }
      profile.minCameraDistanceFromAvoid = 0.55;
      break;
    case 'framing_too_tight':
    case 'subject_too_large':
      profile.preferWiderLens = true;
      profile.minBack = 0.5;
      profile.minOut = 0.45;
      profile.primaryHeightMax = 0.85;
      profile.foregroundWidthMax = 0.40;
      profile.minCameraDistanceFromAvoid = 0.5;
      break;
    case 'ots_primary_obstructed':
    case 'subject_occluded':
    case 'subject_face_occluded':
      profile.preferOppositeShoulder = true;
      profile.requireLowerFgPrimaryOverlap = true;
      profile.minBack = 0.5;
      profile.minOut = 0.45;
      profile.minCameraDistanceFromAvoid = 0.5;
      break;
    case 'ots_foreground_too_small':
      profile.minBack = 0.3;
      profile.minOut = 0.25;
      profile.foregroundWidthMin = 0.12;
      // Allow slightly closer than previous if we know it was too small.
      break;
    case 'ots_foreground_missing':
      profile.preferOppositeShoulder = true;
      profile.minBack = 0.3;
      profile.minOut = 0.25;
      break;
    case 'headroom_excessive':
    case 'head_clipped':
      // Full re-solve with avoid so headroom candidates differ.
      profile.minCameraDistanceFromAvoid = 0.25;
      break;
    default:
      profile.minBack = 0.5;
      profile.minOut = 0.45;
      break;
  }

  return profile;
}

function resolveCropAnchor(
  issue: FrameValidationIssue,
  template?: PrevisCameraTemplate,
): CropAnchor | undefined {
  const measured = issue.measured;
  if (!measured) return undefined;
  const order: CropAnchorKey[] = (
    template === 'close_up' || template === 'extreme_close_up'
  ) ? ['shoulderY', 'chestY', 'waistY']
    : template === 'medium_close_up'
      ? ['chestY', 'shoulderY', 'waistY']
      : ['waistY', 'chestY', 'shoulderY'];
  for (const key of order) {
    const value = measured[key];
    if (typeof value === 'number' && isPlausibleScreenLandmarkY(value)) {
      return { key, y: value };
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPlausibleScreenLandmarkY(y: number): boolean {
  return y > 0 && y < 1.12;
}

/**
 * Two-anchor scale solve: adjust camera distance for head-to-crop span, then
 * re-aim to preserve head position.
 */
export function applyAnchorSpanCameraRepair(
  camera: CameraData,
  issue: FrameValidationIssue,
  template: PrevisCameraTemplate | undefined,
): { camera: CameraData; action: RepairAttemptAction } | undefined {
  const headY = typeof issue.measured?.headTopY === 'number' ? issue.measured.headTopY : undefined;
  const cropAnchor = resolveCropAnchor(issue, template);
  if (!template || headY === undefined || !cropAnchor) return undefined;

  const bands = templateFramingBands(template);
  const targetHeadY = bands.headTopY
    ? (bands.headTopY[0] + bands.headTopY[1]) / 2
    : 0.14;
  const cropBand = bands[cropAnchor.key];
  if (!cropBand) return undefined;
  const cropY = cropAnchor.y;
  const targetCropY = (cropBand[0] + cropBand[1]) / 2;

  const currentSpan = Math.max(0.08, cropY - headY);
  const targetSpan = Math.max(0.08, targetCropY - targetHeadY);
  const desiredScale = targetSpan / currentSpan;

  let updated = {
    position: [...camera.position] as Vec3,
    target: [...camera.target] as Vec3,
    fovDegrees: camera.fovDegrees,
  };
  let actionType: string;

  if (issue.code === 'framing_too_loose' || issue.code === 'subject_too_small') {
    const step = clamp(desiredScale, 1.01, 1.35);
    updated.position = moveToward(updated.position, updated.target, 1 / step);
    actionType = 'zoom_in_preserve_head';
  } else if (issue.code === 'headroom_excessive') {
    const partial = 1 + (desiredScale - 1) * 0.85;
    const step = clamp(partial, 1.03, 1.28);
    updated.position = moveToward(updated.position, updated.target, 1 / step);
    actionType = 'zoom_in_preserve_head';
  } else if (issue.code === 'framing_too_tight' || issue.code === 'subject_too_large') {
    const step = clamp(currentSpan / targetSpan, 1.01, 1.35);
    updated.position = moveAway(updated.position, updated.target, step);
    actionType = 'zoom_out_preserve_head';
  } else {
    return undefined;
  }

  if (issue.code === 'headroom_excessive') {
    const softTarget = targetHeadY + (headY - targetHeadY) * 0.18;
    updated = applyHeadroomCorrection(updated, headY, softTarget);
  } else {
    updated = applyHeadroomCorrection(updated, headY, targetHeadY);
  }

  return {
    camera: { ...camera, ...updated },
    action: {
      type: actionType,
      scale: desiredScale,
      targetHeadY,
      targetCropY,
      cropAnchor: cropAnchor.key,
    },
  };
}

export function selectPrimaryIssue(
  issues: FrameValidationIssue[],
): FrameValidationIssue | undefined {
  for (const group of REPAIR_PRIORITY) {
    const match = issues.find((issue) => group.includes(issue.code));
    if (match) return match;
  }
  return undefined;
}

function vecSubtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vecNormalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function vecCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vecScale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/**
 * Screen Y: 0 = top, 1 = bottom.
 * When headTopY is larger than desired (subject too low / excess headroom),
 * pitch down around the camera right axis so the subject rises in frame.
 */
export function applyHeadroomCorrection(
  camera: { position: Vec3; target: Vec3; fovDegrees: number },
  headTopY: number,
  desiredHeadTopY: number,
): { position: Vec3; target: Vec3; fovDegrees: number } {
  const excess = headTopY - desiredHeadTopY;
  if (Math.abs(excess) < 0.002) {
    return {
      position: [...camera.position] as Vec3,
      target: [...camera.target] as Vec3,
      fovDegrees: camera.fovDegrees,
    };
  }

  const target: Vec3 = [...camera.target] as Vec3;
  const offset = vecSubtract(camera.position, target);
  const distance = Math.hypot(offset[0], offset[1], offset[2]) || 1;
  const lookDown = excess * Math.max(distance * 0.35, 0.35);

  const forward = vecNormalize(vecSubtract(target, camera.position));
  let worldUp: Vec3 = [0, 1, 0];
  let right = vecCross(forward, worldUp);
  let rightLen = Math.hypot(right[0], right[1], right[2]);
  if (rightLen < 1e-4) {
    worldUp = [0, 0, 1];
    right = vecCross(forward, worldUp);
    rightLen = Math.hypot(right[0], right[1], right[2]) || 1;
  }
  right = [right[0] / rightLen, right[1] / rightLen, right[2] / rightLen];
  const up = vecNormalize(vecCross(right, forward));

  return {
    position: vecSubtract(camera.position, vecScale(up, lookDown * 0.25)),
    target: vecSubtract(target, vecScale(up, lookDown)),
    fovDegrees: camera.fovDegrees,
  };
}

export function estimateHeadTopYAfterHeadroomRepair(params: {
  camera: CameraData;
  headWorld: Vec3;
  headTopY: number;
  desiredHeadTopY?: number;
  frameHeight?: number;
}): number {
  const desired = params.desiredHeadTopY ?? 0.10;
  const repaired = applyHeadroomCorrection(
    {
      position: [...params.camera.position] as Vec3,
      target: [...params.camera.target] as Vec3,
      fovDegrees: params.camera.fovDegrees,
    },
    params.headTopY,
    desired,
  );

  const projectY = (cam: { position: Vec3; target: Vec3; fovDegrees: number }) => {
    const forward: Vec3 = [
      cam.target[0] - cam.position[0],
      cam.target[1] - cam.position[1],
      cam.target[2] - cam.position[2],
    ];
    const fLen = Math.hypot(forward[0], forward[1], forward[2]) || 1;
    const f: Vec3 = [forward[0] / fLen, forward[1] / fLen, forward[2] / fLen];
    const toHead: Vec3 = [
      params.headWorld[0] - cam.position[0],
      params.headWorld[1] - cam.position[1],
      params.headWorld[2] - cam.position[2],
    ];
    const depth = toHead[0] * f[0] + toHead[1] * f[1] + toHead[2] * f[2];
    if (depth < 1e-4) return params.headTopY;
    const up: Vec3 = [0, 1, 0];
    const dotFU = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
    const camUp: Vec3 = [up[0] - f[0] * dotFU, up[1] - f[1] * dotFU, up[2] - f[2] * dotFU];
    const upLen = Math.hypot(camUp[0], camUp[1], camUp[2]) || 1;
    const u: Vec3 = [camUp[0] / upLen, camUp[1] / upLen, camUp[2] / upLen];
    const elev = toHead[0] * u[0] + toHead[1] * u[1] + toHead[2] * u[2];
    const fovRad = (cam.fovDegrees * Math.PI) / 180;
    const ndcY = elev / (depth * Math.tan(fovRad / 2));
    return 1 - (ndcY * 0.5 + 0.5);
  };

  return projectY(repaired);
}

function resolvePrimaryTelemetry(
  telemetry: ShotCompositionTelemetry | undefined,
  primaryId: string | undefined,
) {
  if (!telemetry || !primaryId) return undefined;
  if (telemetry.subjects[primaryId]) return telemetry.subjects[primaryId];
  return Object.entries(telemetry.subjects).find(([key]) => (
    key.toLowerCase().includes(primaryId.toLowerCase())
  ))?.[1];
}

function moveToward(from: Vec3, to: Vec3, scale: number): Vec3 {
  return [
    to[0] + (from[0] - to[0]) * scale,
    to[1] + (from[1] - to[1]) * scale,
    to[2] + (from[2] - to[2]) * scale,
  ];
}

function moveAway(from: Vec3, to: Vec3, scale: number): Vec3 {
  return moveToward(from, to, scale);
}

function rotateAroundTarget(position: Vec3, target: Vec3, degrees: number): Vec3 {
  const rad = (degrees * Math.PI) / 180;
  const dx = position[0] - target[0];
  const dz = position[2] - target[2];
  const x = dx * Math.cos(rad) - dz * Math.sin(rad);
  const z = dx * Math.sin(rad) + dz * Math.cos(rad);
  return [target[0] + x, position[1], target[2] + z];
}

function mirrorAroundTarget(position: Vec3, target: Vec3): Vec3 {
  return [
    target[0] - (position[0] - target[0]),
    position[1],
    target[2] - (position[2] - target[2]),
  ];
}

// rotateAroundTarget retained for generic (non-OTS) obstruction repairs only.
