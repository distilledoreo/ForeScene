/**
 * Shot diagnostics for the Agent API — deterministic visibility / framing checks.
 */

import type { LocationProject, Shot } from '../../domain/types';
import { resolveShotLinkedPano } from '../sync';
import { resolveProjectForShot } from '../shotSceneState';
import {
  buildShotCompositionTelemetry,
  objectWorldAabb,
} from '../previs/compositionTelemetry';
import { sampleShotTimeline } from '../shotTimeline';
import type { AgentShotDiagnostics, AgentShotDiagnosticsSubject } from './protocol';

function visibleFraction(bounds: { behindCamera: boolean; areaCoverage: number }): number {
  if (bounds.behindCamera) return 0;
  return Math.max(0, Math.min(1, bounds.areaCoverage));
}

function groundClearanceMeters(object: {
  transform: { position: [number, number, number]; scale: [number, number, number] };
  dimensions: [number, number, number];
}): number {
  const height = object.dimensions[1] * object.transform.scale[1];
  const floorY = object.transform.position[1] - height / 2;
  return Math.max(0, floorY);
}

function cameraInsideEnvironmentBounds(
  project: LocationProject,
  shot: Shot,
): boolean {
  const solids = resolveProjectForShot(project, shot).scene.objects.filter((object) => (
    ['wall', 'box', 'column', 'arch', 'doorway', 'stairs', 'terrain_mass'].includes(object.type)
    && object.visible !== false
  ));
  const camera = shot.camera.position;
  for (const object of solids) {
    const box = objectWorldAabb(object);
    const margin = 0.05;
    if (
      camera[0] >= box.min[0] - margin && camera[0] <= box.max[0] + margin
      && camera[1] >= box.min[1] - margin && camera[1] <= box.max[1] + margin
      && camera[2] >= box.min[2] - margin && camera[2] <= box.max[2] + margin
    ) {
      return false;
    }
  }
  return true;
}

function motionDisplacementMeters(shot: Shot): number {
  const keyframes = shot.cameraKeyframes;
  if (keyframes.length < 2) return 0;
  const start = keyframes[0]!.camera.position;
  const end = keyframes[keyframes.length - 1]!.camera.position;
  return Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
}

function foregroundOcclusionFraction(
  telemetry: ReturnType<typeof buildShotCompositionTelemetry>,
): number {
  const blockers = telemetry.blockers.filter((blocker) => blocker.nearCamera);
  if (blockers.length === 0) return 0;
  return Math.min(1, blockers.reduce((sum, blocker) => sum + blocker.projectedArea, 0));
}

export function inspectAgentShotDiagnostics(params: {
  project: LocationProject;
  shot: Shot;
  timeSeconds?: number;
}): AgentShotDiagnostics {
  const { project, shot } = params;
  const sampled = params.timeSeconds !== undefined
    ? sampleShotTimeline(project, shot.id, params.timeSeconds)
    : undefined;
  const shotForInspect: Shot = sampled
    ? { ...shot, camera: sampled.camera, objectOverrides: sampled.objectOverrides }
    : shot;

  const telemetry = buildShotCompositionTelemetry({ project, shot: shotForInspect });
  const resolved = resolveProjectForShot(project, shotForInspect);
  const linkedPano = resolveShotLinkedPano(project, shot);

  const subjects: AgentShotDiagnosticsSubject[] = [];
  for (const object of resolved.scene.objects) {
    if (object.type === 'sun_marker' || object.visible === false) continue;
    const entry = telemetry.subjects[object.name] ?? telemetry.subjects[object.id];
    const bounds = entry?.bounds;
    subjects.push({
      objectId: object.id,
      screenCoverage: bounds?.areaCoverage ?? 0,
      visibleFraction: bounds ? visibleFraction(bounds) : 0,
      groundClearanceMeters: groundClearanceMeters(object),
      occlusionRatio: entry?.occlusionRatio,
    });
  }

  return {
    shotId: shot.id,
    revisionId: undefined,
    sampledTimeSeconds: sampled?.sampledTimeSeconds,
    subjects,
    foregroundOcclusionFraction: foregroundOcclusionFraction(telemetry),
    linkedPanoramaRendered: Boolean(linkedPano),
    linkedPanoId: shot.linkedPanoId,
    cameraInsideEnvironmentBounds: cameraInsideEnvironmentBounds(project, shotForInspect),
    motionDisplacementMeters: motionDisplacementMeters(shot),
    diagnostics: [],
  };
}
