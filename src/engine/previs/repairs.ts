/**
 * Telemetry-driven repair suggestions for structured validation issues.
 * Limited to two attempts per shot by the orchestrator.
 *
 * Applies ONE root-cause correction per attempt (priority order), then the
 * orchestrator re-renders and remeasures.
 */

import type { CameraData, Vec3 } from '../../domain/types';
import type { FrameValidationIssue } from './frameValidation';
import type { ForeSceneAgentCommand } from '../agent/protocol';
import type { ShotCompositionTelemetry } from './compositionTelemetry';
import { FRAMING_COVERAGE } from './framing';
import type { PrevisCameraTemplate } from './manifest';

export interface RepairPlan {
  commands: ForeSceneAgentCommand[];
  description: string;
  /** Issue code that drove this repair. */
  primaryIssueCode?: string;
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
  ['headroom_excessive', 'head_clipped'],
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
}): RepairPlan | undefined {
  const primaryIssue = selectPrimaryIssue(params.issues);
  if (!primaryIssue) return undefined;

  const commands: ForeSceneAgentCommand[] = [];
  const notes: string[] = [];
  let camera = {
    position: [...params.camera.position] as Vec3,
    target: [...params.camera.target] as Vec3,
    fovDegrees: params.camera.fovDegrees,
  };

  let cameraChanged = false;
  const template = params.template;
  const range = template ? FRAMING_COVERAGE[template] : undefined;
  const primaryId = params.primarySubjectId;
  const primaryTelemetry = resolvePrimaryTelemetry(params.telemetry, primaryId);

  switch (primaryIssue.code) {
    case 'subject_too_small':
    case 'framing_too_loose': {
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
      // Vertical: if head is too low in frame (large headTopY), look down so
      // the subject rises (headTopY decreases).
      const headY = typeof primaryIssue.measured?.headTopY === 'number'
        ? primaryIssue.measured.headTopY
        : primaryTelemetry?.landmarks?.headTop?.y;
      if (typeof headY === 'number') {
        camera = applyHeadroomCorrection(camera, headY, 0.10);
      }
      cameraChanged = true;
      notes.push('tighten framing from telemetry');
      break;
    }
    case 'subject_too_large':
    case 'framing_too_tight': {
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
      // Look down so the head moves toward the top of the frame (smaller headTopY).
      camera = applyHeadroomCorrection(camera, headY, 0.10);
      cameraChanged = true;
      notes.push('reduce headroom');
      break;
    }
    case 'head_clipped': {
      // Head is above the top of frame (headTopY too small / negative). Look up
      // slightly and pull back so the crown re-enters.
      camera.target = [camera.target[0], camera.target[1] + 0.12, camera.target[2]];
      camera.position = moveAway(camera.position, camera.target, 1.08);
      cameraChanged = true;
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
    // No camera op — orchestrator still re-renders.
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
  };
}

/**
 * Select the single highest-priority repairable issue.
 */
export function selectPrimaryIssue(
  issues: FrameValidationIssue[],
): FrameValidationIssue | undefined {
  for (const group of REPAIR_PRIORITY) {
    const match = issues.find((issue) => group.includes(issue.code));
    if (match) return match;
  }
  return undefined;
}

/**
 * Screen Y: 0 = top, 1 = bottom.
 * When headTopY is larger than desired (subject too low / excess headroom),
 * look down so the subject rises in frame and headTopY decreases.
 */
export function applyHeadroomCorrection(
  camera: { position: Vec3; target: Vec3; fovDegrees: number },
  headTopY: number,
  desiredHeadTopY: number,
): { position: Vec3; target: Vec3; fovDegrees: number } {
  const excess = headTopY - desiredHeadTopY;
  // Positive excess → look down (decrease target Y) so subject moves up in image.
  const lookDown = excess * 0.85;
  return {
    position: [
      camera.position[0],
      camera.position[1] - lookDown * 0.25,
      camera.position[2],
    ],
    target: [
      camera.target[0],
      camera.target[1] - lookDown,
      camera.target[2],
    ],
    fovDegrees: camera.fovDegrees,
  };
}

/**
 * Predict approximate screen-Y change direction for head after headroom repair.
 * Used by unit tests — pure geometry, no WebGL.
 *
 * Returns estimated headTopY after applying the same vertical aim change used
 * in applyHeadroomCorrection, under a simplified pinhole model.
 */
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

  // Project head through old and new look directions on the vertical plane.
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
    // World up component relative to forward.
    const up: Vec3 = [0, 1, 0];
    // Camera up ≈ orthogonalize world up against forward.
    const dotFU = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
    const camUp: Vec3 = [up[0] - f[0] * dotFU, up[1] - f[1] * dotFU, up[2] - f[2] * dotFU];
    const upLen = Math.hypot(camUp[0], camUp[1], camUp[2]) || 1;
    const u: Vec3 = [camUp[0] / upLen, camUp[1] / upLen, camUp[2] / upLen];
    const elev = toHead[0] * u[0] + toHead[1] * u[1] + toHead[2] * u[2];
    const fovRad = (cam.fovDegrees * Math.PI) / 180;
    const ndcY = elev / (depth * Math.tan(fovRad / 2));
    // Screen Y: 0 top (matches projectWorldPoint).
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
