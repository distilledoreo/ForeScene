/**
 * Shot diagnostics for the Agent API — deterministic visibility / framing checks.
 */

import type { LocationProject, SceneObject, Shot } from '../../domain/types';
import { resolveShotLinkedPano } from '../sync';
import { resolveProjectForShot } from '../shotSceneState';
import {
  buildShotCompositionTelemetry,
  describeSceneObjectComposition,
} from '../previs/compositionTelemetry';
import { sampleShotTimeline } from '../shotTimeline';
import type { AgentShotDiagnostics, AgentShotDiagnosticsSubject, AgentSubjectDisplacement } from './protocol';
import {
  cameraInsideBounds,
  cameraIntersectsSolidGeometry,
  computeEnvironmentBounds,
  displacementMeters,
  getEffectiveObject,
  getShotEffectiveState,
  identifyFloorY,
  signedGroundClearanceMeters,
} from './spatialShotState';

function frameVisibleFraction(
  bounds: { behindCamera: boolean; areaCoverage?: number; unclipped?: { areaCoverage: number }; visible?: { areaCoverage: number } },
  occlusionRatio?: number,
): number {
  if (bounds.behindCamera) return 0;
  const unclippedArea = bounds.unclipped?.areaCoverage ?? 0;
  if (unclippedArea <= 0) return 0;
  const visibleArea = bounds.visible?.areaCoverage ?? bounds.areaCoverage ?? 0;
  const unobstructed = Math.max(0, Math.min(1, 1 - (occlusionRatio ?? 0)));
  return Math.max(0, Math.min(1, (visibleArea / unclippedArea) * unobstructed));
}

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

function subjectDisplacements(
  project: LocationProject,
  shot: Shot,
  objectIds: string[],
): AgentSubjectDisplacement[] {
  const keyframes = [...shot.cameraKeyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (keyframes.length < 2) {
    return objectIds.map((objectId) => ({ objectId, displacementMeters: 0 }));
  }
  const startTime = keyframes[0]!.timeSeconds;
  const endTime = keyframes[keyframes.length - 1]!.timeSeconds;
  const startState = getShotEffectiveState(project, shot.id, startTime);
  const endState = getShotEffectiveState(project, shot.id, endTime);
  return objectIds.map((objectId) => {
    const startObject = startState ? getEffectiveObject(startState, objectId) : undefined;
    const endObject = endState ? getEffectiveObject(endState, objectId) : undefined;
    return {
      objectId,
      displacementMeters: startObject && endObject
        ? displacementMeters(startObject.transform.position, endObject.transform.position)
        : 0,
    };
  });
}

function buildSubjectDiagnostic(
  project: LocationProject,
  shotForInspect: Shot,
  object: SceneObject,
): AgentShotDiagnosticsSubject {
  const entry = describeSceneObjectComposition({
    project,
    shot: shotForInspect,
    object,
  });
  const floorY = identifyFloorY(project, object.transform.position);
  return {
    objectId: object.id,
    screenCoverage: entry.bounds.areaCoverage,
    visibleFraction: frameVisibleFraction(entry.bounds, entry.occlusionRatio),
    groundClearanceMeters: signedGroundClearanceMeters(object, floorY),
    occlusionRatio: entry.occlusionRatio,
    behindCamera: entry.bounds.behindCamera,
    clipped: entry.bounds.clipped,
    humanLandmarks: entry.landmarks,
  };
}

function inferDiagnosticSubjectIds(
  shot: Shot,
  telemetry: ReturnType<typeof buildShotCompositionTelemetry>,
  resolvedObjects: SceneObject[],
): string[] {
  const objectByNameOrId = new Map<string, string>();
  for (const object of resolvedObjects) {
    objectByNameOrId.set(object.id, object.id);
    objectByNameOrId.set(object.name, object.id);
  }

  const ids = new Set<string>();
  for (const key of Object.keys(telemetry.subjects)) {
    ids.add(objectByNameOrId.get(key) ?? key);
  }
  for (const object of resolvedObjects) {
    if (object.type === 'floor' || object.type === 'sun_marker' || object.visible === false) continue;
    if (shot.objectOverrides?.[object.id]) {
      ids.add(object.id);
    }
  }
  return [...ids];
}

export function inspectAgentShotDiagnostics(params: {
  project: LocationProject;
  shot: Shot;
  timeSeconds?: number;
  subjectIds?: string[];
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
  const resolvedById = new Map(resolvedObjects.map((object) => [object.id, object]));

  const subjectIds = params.subjectIds?.length
    ? params.subjectIds
    : inferDiagnosticSubjectIds(shotForInspect, telemetry, resolvedObjects);

  const subjects: AgentShotDiagnosticsSubject[] = [];
  for (const objectId of subjectIds) {
    const sceneObject = resolvedById.get(objectId);
    if (!sceneObject || sceneObject.visible === false) continue;
    subjects.push(buildSubjectDiagnostic(project, shotForInspect, sceneObject));
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
    subjectDisplacements: subjectDisplacements(project, shot, subjectIds),
    diagnostics: [],
  };
}
