/**
 * Deterministic repair suggestions for structured validation issues.
 * Limited to two attempts per shot by the orchestrator.
 */

import type { CameraData, Vec3 } from '../../domain/types';
import type { FrameValidationIssue } from './frameValidation';
import type { ForeSceneAgentCommand } from '../agent/protocol';

export interface RepairPlan {
  commands: ForeSceneAgentCommand[];
  description: string;
}

/**
 * Build a small Agent plan that nudges camera / grounding based on issues.
 */
export function buildRepairPlan(params: {
  shotTarget: { id: string } | { ref: string };
  camera: CameraData;
  issues: FrameValidationIssue[];
  /** object id/ref for underground / overlap repairs */
  subjectTargets?: Record<string, { id: string } | { ref: string }>;
  subjectPositions?: Record<string, Vec3>;
}): RepairPlan | undefined {
  const commands: ForeSceneAgentCommand[] = [];
  const notes: string[] = [];
  let camera = {
    position: [...params.camera.position] as Vec3,
    target: [...params.camera.target] as Vec3,
    fovDegrees: params.camera.fovDegrees,
  };

  let cameraChanged = false;

  for (const issue of params.issues) {
    switch (issue.code) {
      case 'subject_too_small': {
        camera.position = moveToward(camera.position, camera.target, 0.82);
        cameraChanged = true;
        notes.push('move camera closer');
        break;
      }
      case 'subject_too_large': {
        camera.position = moveAway(camera.position, camera.target, 1.18);
        cameraChanged = true;
        notes.push('move camera farther');
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
      case 'camera_inside_geometry': {
        // Try alternate yaw (+35°).
        camera.position = rotateAroundTarget(camera.position, camera.target, 35);
        cameraChanged = true;
        notes.push('try alternate camera angle');
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
        // Mild separation is handled when recompiling; nudge camera only.
        camera.position = moveAway(camera.position, camera.target, 1.05);
        cameraChanged = true;
        notes.push('increase separation via camera pullback');
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
