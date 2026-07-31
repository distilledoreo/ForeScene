/**
 * Telemetry-driven repair suggestions for structured validation issues.
 * Limited to two attempts per shot by the orchestrator.
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
}

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
  const primaryTelemetry = primaryId && params.telemetry
    ? params.telemetry.subjects[primaryId]
    : primaryId && params.telemetry
      ? Object.entries(params.telemetry.subjects).find(([key]) => (
        key.toLowerCase().includes(primaryId.toLowerCase())
      ))?.[1]
      : undefined;

  for (const issue of params.issues) {
    switch (issue.code) {
      case 'subject_too_small':
      case 'framing_too_loose': {
        const measured = issue.measuredCoverage
          ?? (typeof issue.measured?.heightCoverage === 'number'
            ? issue.measured.heightCoverage
            : primaryTelemetry?.bounds.heightCoverage);
        const target = range?.target ?? 0.6;
        if (measured && measured > 0) {
          const distanceScale = Math.min(0.95, Math.max(0.55, measured / target));
          camera.position = moveToward(camera.position, camera.target, distanceScale);
        } else {
          camera.position = moveToward(camera.position, camera.target, 0.82);
        }
        // Vertical head alignment when measured head Y is available.
        const headY = typeof issue.measured?.headTopY === 'number'
          ? issue.measured.headTopY
          : primaryTelemetry?.landmarks?.headTop?.y;
        if (typeof headY === 'number') {
          const desired = 0.10;
          const delta = (desired - headY) * 0.6;
          camera.target = [camera.target[0], camera.target[1] - delta * 0.8, camera.target[2]];
          camera.position = [camera.position[0], camera.position[1] - delta * 0.3, camera.position[2]];
        }
        cameraChanged = true;
        notes.push('tighten framing from telemetry');
        break;
      }
      case 'subject_too_large':
      case 'framing_too_tight': {
        const measured = issue.measuredCoverage
          ?? (typeof issue.measured?.heightCoverage === 'number'
            ? issue.measured.heightCoverage
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
        const headY = typeof issue.measured?.headTopY === 'number'
          ? issue.measured.headTopY
          : primaryTelemetry?.landmarks?.headTop?.y
            ?? 0.25;
        const desired = 0.10;
        const delta = headY - desired;
        camera.target = [camera.target[0], camera.target[1] + delta * 0.9, camera.target[2]];
        camera.position = [camera.position[0], camera.position[1] + delta * 0.35, camera.position[2]];
        cameraChanged = true;
        notes.push('reduce headroom');
        break;
      }
      case 'head_clipped': {
        camera.target = [camera.target[0], camera.target[1] - 0.12, camera.target[2]];
        camera.position = moveAway(camera.position, camera.target, 1.08);
        cameraChanged = true;
        notes.push('uncrop head');
        break;
      }
      case 'primary_off_center': {
        if (issue.subject && params.subjectPositions?.[issue.subject]) {
          const pos = params.subjectPositions[issue.subject]!;
          camera.target = [pos[0], camera.target[1], pos[2]];
          cameraChanged = true;
          notes.push('recenter primary');
        } else if (primaryTelemetry) {
          const shift = (0.5 - primaryTelemetry.bounds.centerX) * 0.6;
          // Shift target horizontally relative to camera right vector (XZ).
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
      case 'subject_out_of_frame': {
        if (issue.subject && params.subjectPositions?.[issue.subject]) {
          const pos = params.subjectPositions[issue.subject]!;
          camera.target = [pos[0], camera.target[1], pos[2]];
          cameraChanged = true;
          notes.push('recenter camera target');
        }
        break;
      }
      case 'camera_inside_geometry':
      case 'wall_dominant':
      case 'subject_occluded':
      case 'subject_face_occluded': {
        camera.position = rotateAroundTarget(camera.position, camera.target, 35);
        camera.position = moveAway(camera.position, camera.target, 1.12);
        cameraChanged = true;
        notes.push('orbit away from obstruction');
        break;
      }
      case 'ots_foreground_too_small': {
        // Move closer to foreground shoulder along camera→target.
        camera.position = moveToward(camera.position, camera.target, 0.78);
        cameraChanged = true;
        notes.push('OTS: move closer to foreground');
        break;
      }
      case 'ots_foreground_too_large': {
        camera.position = moveAway(camera.position, camera.target, 1.22);
        // Slight outward offset.
        camera.position = rotateAroundTarget(camera.position, camera.target, 12);
        cameraChanged = true;
        notes.push('OTS: pull back from foreground');
        break;
      }
      case 'ots_primary_obstructed':
      case 'ots_foreground_missing': {
        // Swap shoulder side.
        camera.position = mirrorAroundTarget(camera.position, camera.target);
        cameraChanged = true;
        notes.push('OTS: swap shoulder side');
        break;
      }
      case 'unwanted_subject_dominant': {
        // Dolly in on primary and slightly re-angle.
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
        const target = issue.subject ? params.subjectTargets?.[issue.subject] : undefined;
        const pos = issue.subject ? params.subjectPositions?.[issue.subject] : undefined;
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
        // No camera math — orchestrator should re-render after readiness.
        notes.push('re-render after ready');
        break;
      }
      default:
        break;
    }
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

  if (commands.length === 0) return undefined;
  return {
    commands,
    description: `Repair: ${notes.join(', ') || 'adjust'}`,
  };
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
