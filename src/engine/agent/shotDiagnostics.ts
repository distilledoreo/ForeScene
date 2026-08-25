/**
 * Shot diagnostics for the Agent API — deterministic visibility / framing checks.
 */

import * as THREE from 'three';
import type { LocationProject, SceneObject, Shot } from '../../domain/types';
import { resolveShotLinkedPano } from '../sync';
import { resolveProjectForShot } from '../shotSceneState';
import {
  buildShotCompositionTelemetry,
  describeSceneObjectComposition,
} from '../previs/compositionTelemetry';
import { selectionBounds } from '../buildSelection';
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
import {
  agentError,
  agentWarning,
} from './diagnostics';
import {
  getProductionConfiguration,
  resolveProductionBindingObjectIds,
} from '../previs/productionConfiguration';

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
  effectiveObjects: SceneObject[],
): AgentShotDiagnosticsSubject {
  const entry = describeSceneObjectComposition({
    project,
    shot: shotForInspect,
    object,
  });
  const floorY = identifyFloorY(project, object.transform.position, effectiveObjects);
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

function buildProductionGroupDiagnostic(
  project: LocationProject,
  shotForInspect: Shot,
  _entityId: string,
  groupId: string,
  effectiveObjects: SceneObject[],
): AgentShotDiagnosticsSubject | undefined {
  const group = project.scene.objectGroups?.[groupId];
  if (!group) return undefined;
  const members = group.objectIds.flatMap((objectId) => {
    const object = effectiveObjects.find((candidate) => candidate.id === objectId);
    return object && object.visible !== false ? [object] : [];
  });
  if (members.length === 0) return undefined;
  const union = selectionBounds(members);
  const size = union.getSize(new THREE.Vector3());
  const center = union.getCenter(new THREE.Vector3());
  const aggregate: SceneObject = {
    ...members[0]!,
    id: groupId,
    name: group.name,
    type: 'box',
    dimensions: [size.x, size.y, size.z],
    transform: {
      position: [center.x, center.y, center.z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    poseableCharacter: undefined,
    humanPose: undefined,
  };
  const telemetry = describeSceneObjectComposition({
    project,
    shot: shotForInspect,
    object: aggregate,
  });
  const floorY = identifyFloorY(project, members[0]!.transform.position, effectiveObjects);
  const groundClearanceMeters = Math.min(
    ...members.map((object) => signedGroundClearanceMeters(object, floorY)),
  );
  return {
    objectId: groupId,
    screenCoverage: telemetry.bounds.areaCoverage,
    visibleFraction: frameVisibleFraction(telemetry.bounds, telemetry.occlusionRatio),
    groundClearanceMeters,
    occlusionRatio: telemetry.occlusionRatio,
    behindCamera: telemetry.bounds.behindCamera,
    clipped: telemetry.bounds.clipped,
    humanLandmarks: telemetry.landmarks,
  };
}

function productionContractSubjects(input: {
  project: LocationProject;
  shot: Shot;
  shotForInspect: Shot;
  effectiveObjects: SceneObject[];
}): AgentShotDiagnosticsSubject[] | undefined {
  const configuration = getProductionConfiguration(input.project);
  const contract = configuration.shotContracts[input.shot.id];
  if (!contract?.presence) return undefined;
  const subjects: AgentShotDiagnosticsSubject[] = [];
  const effectiveById = new Map(input.effectiveObjects.map((object) => [object.id, object]));
  for (const objectId of contract.presence.expectedVisibleObjectIds) {
    const object = effectiveById.get(objectId);
    if (object && object.visible !== false) {
      subjects.push(buildSubjectDiagnostic(input.project, input.shotForInspect, object, input.effectiveObjects));
    }
  }
  for (const groupId of contract.presence.expectedVisibleGroupIds) {
    const entity = Object.entries(configuration.bindings).find(([, binding]) => (
      binding.kind === 'group' && binding.groupId === groupId
    ));
    if (!entity) continue;
    const diagnostic = buildProductionGroupDiagnostic(
      input.project,
      input.shotForInspect,
      entity[0],
      groupId,
      input.effectiveObjects,
    );
    if (diagnostic) subjects.push(diagnostic);
  }
  return subjects;
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

  const productionSubjects = params.subjectIds?.length
    ? undefined
    : productionContractSubjects({
        project,
        shot,
        shotForInspect,
        effectiveObjects: resolvedObjects,
      });
  const subjectIds = params.subjectIds?.length
    ? params.subjectIds
    : inferDiagnosticSubjectIds(shotForInspect, telemetry, resolvedObjects);

  const subjects: AgentShotDiagnosticsSubject[] = productionSubjects ?? [];
  const diagnostics: import('./diagnostics').AgentDiagnostic[] = [];
  const expectedSubjectIds = params.subjectIds?.length ? [...params.subjectIds] : undefined;

  for (const objectId of productionSubjects ? [] : subjectIds) {
    const sceneObject = resolvedById.get(objectId);
    if (!sceneObject) {
      diagnostics.push(agentError(
        'subject_missing',
        `Diagnostic subject "${objectId}" is not present in the shot-effective scene.`,
        { candidates: [objectId] },
      ));
      continue;
    }
    if (sceneObject.visible === false) {
      diagnostics.push(agentWarning(
        'subject_hidden',
        `Diagnostic subject "${objectId}" is hidden in the shot-effective scene.`,
      ));
      continue;
    }
    subjects.push(buildSubjectDiagnostic(project, shotForInspect, sceneObject, resolvedObjects));
  }

  const projectedPanoramaVisible = Boolean(linkedPano)
    && Boolean(shotForInspect.linkedPanoId)
    && subjects.some((subject) => subject.visibleFraction > 0);

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
    projectedPanoramaVisible,
    cameraIntersectsSolidGeometry: cameraIntersectsSolidGeometry(project, shotForInspect),
    cameraInsideEnvironmentBounds: insideEnvironment,
    cameraDisplacementMeters: cameraDisplacementMeters(shot),
    subjectDisplacements: subjectDisplacements(
      project,
      shot,
      productionSubjects
        ? [...new Set(Object.values(getProductionConfiguration(project).bindings).flatMap((binding) => (
            resolveProductionBindingObjectIds(project, binding)
          )))]
        : subjectIds,
    ),
    expectedSubjectIds,
    diagnostics,
  };
}
