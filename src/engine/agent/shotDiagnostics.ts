/**
 * Shot diagnostics for the Agent API — deterministic visibility / framing checks.
 */

import type { LocationProject, Shot } from '../../domain/types';
import { resolveShotLinkedPano } from '../sync';
import { resolveProjectForShot } from '../shotSceneState';
import { buildShotCompositionTelemetry } from '../previs/compositionTelemetry';
import { sampleShotTimeline } from '../shotTimeline';
import type { AgentShotDiagnostics, AgentShotDiagnosticsSubject, AgentSubjectDisplacement } from './protocol';
import {
  cameraInsideBounds,
  cameraIntersectsSolidGeometry,
  computeEnvironmentBounds,
  displacementMeters,
  identifyFloorY,
  signedGroundClearanceMeters,
} from './spatialShotState';

function foregroundOcclusionFraction(
  telemetry: ReturnType<typeof buildShotCompositionTelemetry>,
): number {
  const blockers = telemetry.blockers.filter((blocker) => blocker.nearCamera);
  if (blockers.length === 0) return 0;
  return Math.min(1, blockers.reduce((sum, blocker) => sum + blocker.projectedArea, 0));
}

function cameraDisplacementMeters(shot: Shot): number {
  const keyframes = shot.cameraKeyframes;
  if (keyframes.length < 2) return 0;
  const sorted = [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const start = sorted[0]!.camera.position;
  const end = sorted[sorted.length - 1]!.camera.position;
  return displacementMeters(start, end);
}

function subjectDisplacements(shot: Shot, objectIds: string[]): AgentSubjectDisplacement[] {
  const keyframes = [...shot.cameraKeyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (keyframes.length < 2) {
    return objectIds.map((objectId) => ({ objectId, displacementMeters: 0 }));
  }
  const startOverrides = keyframes[0]!.objectOverrides ?? shot.objectOverrides ?? {};
  const endOverrides = keyframes[keyframes.length - 1]!.objectOverrides ?? shot.objectOverrides ?? {};
  return objectIds.map((objectId) => {
    const start = startOverrides[objectId]?.transform?.position;
    const end = endOverrides[objectId]?.transform?.position;
    return {
      objectId,
      displacementMeters: start && end ? displacementMeters(start, end) : 0,
    };
  });
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
  const linkedPano = resolveShotLinkedPano(project, shot);
  const environmentBounds = computeEnvironmentBounds(project, shotForInspect);
  const resolvedObjects = resolveProjectForShot(project, shotForInspect).scene.objects;
  const trackedObjectIds = resolvedObjects
    .filter((object) => shotForInspect.objectOverrides?.[object.id])
    .map((object) => object.id);

  const subjects: AgentShotDiagnosticsSubject[] = [];
  const objectByNameOrId = new Map<string, string>();
  for (const object of resolvedObjects) {
    objectByNameOrId.set(object.id, object.id);
    objectByNameOrId.set(object.name, object.id);
  }

  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(telemetry.subjects)) {
    const objectId = objectByNameOrId.get(key) ?? key;
    if (seen.has(objectId)) continue;
    seen.add(objectId);
    const sceneObject = resolvedObjects.find((candidate) => candidate.id === objectId);
    const floorY = sceneObject
      ? identifyFloorY(project, sceneObject.transform.position)
      : 0;
    subjects.push({
      objectId,
      screenCoverage: entry.bounds.areaCoverage,
      visibleFraction: entry.bounds.behindCamera
        ? 0
        : Math.max(0, Math.min(1, 1 - (entry.occlusionRatio ?? 0))),
      groundClearanceMeters: sceneObject
        ? signedGroundClearanceMeters(sceneObject, floorY)
        : 0,
      occlusionRatio: entry.occlusionRatio,
    });
  }

  const cameraPosition = shotForInspect.camera.position;
  const insideEnvironment = environmentBounds
    ? cameraInsideBounds(cameraPosition, environmentBounds)
    : undefined;

  return {
    shotId: shot.id,
    revisionId: undefined,
    sampledTimeSeconds: sampled?.sampledTimeSeconds,
    subjects,
    foregroundOcclusionFraction: foregroundOcclusionFraction(telemetry),
    linkedPanoramaResolved: Boolean(linkedPano),
    linkedPanoId: shot.linkedPanoId,
    cameraIntersectsSolidGeometry: cameraIntersectsSolidGeometry(project, shotForInspect),
    cameraInsideEnvironmentBounds: insideEnvironment,
    cameraDisplacementMeters: cameraDisplacementMeters(shot),
    subjectDisplacements: subjectDisplacements(shot, trackedObjectIds),
    diagnostics: [],
  };
}
