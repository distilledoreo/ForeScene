/**
 * Semantic spatial primitives for the Agent API.
 * Wraps deterministic previs solvers so agents avoid raw world-coordinate guessing.
 */

import type { CameraData, LocationProject, SceneObject, Transform, Vec3 } from '../../domain/types';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import { resolveFacingYaw } from '../previs/facingSolver';
import { objectWorldAabb } from '../previs/compositionTelemetry';
import {
  solveShotCamera,
  type SubjectBounds,
} from '../previs/cameraSolver';
import type { PrevisCameraTemplate } from '../previs/manifest';
import { AGENT_UPRIGHT_OBJECT_TYPES } from './constants';
import { awaitAgentNotBusy } from './busy';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  agentWarning,
  writeAccessRequiredDiagnostic,
  type AgentDiagnostic,
} from './diagnostics';
import {
  createShotKeyframe,
  setShotTimelineDuration,
} from '../shotTimeline';
import type {
  AgentFrameSubjectsInput,
  AgentFrameSubjectsResult,
  AgentOrientObjectTowardInput,
  AgentOrientObjectTowardResult,
  AgentPlaceObjectNearLandmarkInput,
  AgentPlaceObjectNearLandmarkResult,
  AgentSnapObjectToFloorInput,
  AgentSnapObjectToFloorResult,
  AgentTrackSubjectsInput,
  AgentTrackSubjectsResult,
} from './protocol';
import {
  resolveExistingLandmarkTarget,
  resolveExistingObjectTarget,
  resolveExistingShotTarget,
} from './inspection';

const COMPOSITION_TEMPLATES: Record<string, PrevisCameraTemplate> = {
  establishing: 'establishing',
  wide: 'wide',
  full_body: 'full',
  full: 'full',
  medium: 'medium',
  medium_close_up: 'medium_close_up',
  close_up: 'close_up',
  three_quarter_tracking: 'medium',
  over_the_shoulder: 'over_the_shoulder',
  two_shot: 'two_shot',
};

function requireWriteAccess(operation: string): AgentDiagnostic[] | null {
  return useAgentControlStore.getState().controlMode === 'read-write'
    ? null
    : [writeAccessRequiredDiagnostic(operation)];
}

function uprightFloorPosition(object: SceneObject): Vec3 {
  const height = object.dimensions[1] * object.transform.scale[1];
  const halfHeight = AGENT_UPRIGHT_OBJECT_TYPES.has(object.type) ? height / 2 : 0;
  return [
    object.transform.position[0],
    halfHeight,
    object.transform.position[2],
  ];
}

function applyObjectTransform(
  project: LocationProject,
  objectId: string,
  transform: Partial<Transform>,
): LocationProject {
  return {
    ...project,
    scene: {
      ...project.scene,
      objects: project.scene.objects.map((object) => {
        if (object.id !== objectId) return object;
        return {
          ...object,
          transform: {
            ...object.transform,
            ...(transform.position ? { position: [...transform.position] as Vec3 } : {}),
            ...(transform.rotation ? { rotation: [...transform.rotation] as Vec3 } : {}),
            ...(transform.scale ? { scale: [...transform.scale] as Vec3 } : {}),
          },
        };
      }),
    },
  };
}

function applyShotCamera(project: LocationProject, shotId: string, camera: CameraData): LocationProject {
  return {
    ...project,
    shots: project.shots.map((shot) => shot.id === shotId
      ? { ...shot, camera: { ...camera }, updatedAt: new Date().toISOString() }
      : shot),
  };
}

function toSubjectBounds(object: SceneObject): SubjectBounds {
  const box = objectWorldAabb(object);
  return {
    id: object.id,
    min: box.min,
    max: box.max,
    position: uprightFloorPosition(object),
    yawRadians: (object.transform.rotation[1] * Math.PI) / 180,
  };
}

async function commitProjectMutation(
  reason: string,
  mutate: (project: LocationProject) => LocationProject,
): Promise<{ revisionId?: string; diagnostics: AgentDiagnostic[] }> {
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')] };
  }
  const verified = await runDestructive(reason, () => {
    useProjectStore.setState((state) => ({
      project: touchProject(mutate(state.project)),
    }));
  });
  return { revisionId: verified?.revision.id, diagnostics: [] };
}

function solveSubjectsCamera(
  project: LocationProject,
  shotId: string,
  subjectIds: string[],
  composition?: string,
): { camera?: CameraData; measuredCoverage?: number; diagnostics: AgentDiagnostic[] } {
  const shot = project.shots.find((candidate) => candidate.id === shotId);
  if (!shot) {
    return {
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${shotId}".`)],
    };
  }

  const subjects: SubjectBounds[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  for (const subjectId of subjectIds) {
    const object = project.scene.objects.find((candidate) => candidate.id === subjectId);
    if (!object) {
      diagnostics.push(agentWarning('subject_not_found', `Subject "${subjectId}" was not found and was skipped.`));
      continue;
    }
    subjects.push(toSubjectBounds(object));
  }
  if (subjects.length === 0) {
    return {
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'At least one valid subject is required.')],
    };
  }

  const template = COMPOSITION_TEMPLATES[composition ?? 'medium'] ?? 'medium';
  const blockers = project.scene.objects
    .filter((object) => ['wall', 'box', 'column', 'arch', 'doorway'].includes(object.type))
    .map((object) => {
      const box = objectWorldAabb(object);
      return { id: object.id, min: box.min, max: box.max };
    });

  const solved = solveShotCamera({
    shot: {
      id: shot.id,
      shotNumber: shot.shotNumber,
      name: shot.name,
      description: shot.description,
      locationId: 'agent',
      subjects: subjectIds,
      camera: {
        template,
        subjects: subjectIds,
        lensClass: 'normal',
      },
      blocking: [],
    },
    subjects,
    aspectRatio: shot.camera.aspectRatio,
    blockers,
    frameWidth: shot.exportSettings.width,
    frameHeight: shot.exportSettings.height,
  });

  diagnostics.push(...solved.warnings.map((message) => agentWarning('frame_subjects', message)));
  return {
    camera: solved.camera,
    measuredCoverage: solved.measuredCoverage,
    diagnostics,
  };
}

export async function snapAgentObjectToFloor(
  input: AgentSnapObjectToFloorInput,
): Promise<AgentSnapObjectToFloorResult> {
  const blocked = requireWriteAccess('snapObjectToFloor');
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  const project = useProjectStore.getState().project;
  const resolved = resolveExistingObjectTarget(project, input.object);
  if (!resolved.ok) return { ok: false, status: 'failed', diagnostics: resolved.diagnostics };

  const object = project.scene.objects.find((candidate) => candidate.id === resolved.id);
  if (!object) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No object with id "${resolved.id}".`)],
    };
  }

  const nextPosition = uprightFloorPosition(object);
  const commit = await commitProjectMutation('Snap object to floor', (current) => (
    applyObjectTransform(current, object.id, { position: nextPosition })
  ));

  return {
    ok: true,
    status: 'completed',
    objectId: object.id,
    position: nextPosition,
    revisionId: commit.revisionId,
    diagnostics: commit.diagnostics,
  };
}

export async function placeAgentObjectNearLandmark(
  input: AgentPlaceObjectNearLandmarkInput,
): Promise<AgentPlaceObjectNearLandmarkResult> {
  const blocked = requireWriteAccess('placeObjectNearLandmark');
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  const project = useProjectStore.getState().project;
  const objectResolved = resolveExistingObjectTarget(project, input.object);
  if (!objectResolved.ok) return { ok: false, status: 'failed', diagnostics: objectResolved.diagnostics };
  const landmarkResolved = resolveExistingLandmarkTarget(project, input.landmark);
  if (!landmarkResolved.ok) return { ok: false, status: 'failed', diagnostics: landmarkResolved.diagnostics };

  const object = project.scene.objects.find((candidate) => candidate.id === objectResolved.id);
  const landmark = project.landmarks.find((candidate) => candidate.id === landmarkResolved.id);
  if (!object || !landmark) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, 'Object or landmark not found.')],
    };
  }

  const offset = input.offset ?? [0, 0, 1];
  const nextPosition: Vec3 = [
    landmark.position[0] + offset[0],
    uprightFloorPosition(object)[1],
    landmark.position[2] + offset[2],
  ];

  const commit = await commitProjectMutation('Place object near landmark', (current) => (
    applyObjectTransform(current, object.id, { position: nextPosition })
  ));

  return {
    ok: true,
    status: 'completed',
    objectId: object.id,
    landmarkId: landmark.id,
    position: nextPosition,
    revisionId: commit.revisionId,
    diagnostics: commit.diagnostics,
  };
}

export async function orientAgentObjectToward(
  input: AgentOrientObjectTowardInput,
): Promise<AgentOrientObjectTowardResult> {
  const blocked = requireWriteAccess('orientObjectToward');
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  const project = useProjectStore.getState().project;
  const objectResolved = resolveExistingObjectTarget(project, input.object);
  if (!objectResolved.ok) return { ok: false, status: 'failed', diagnostics: objectResolved.diagnostics };
  const targetResolved = resolveExistingObjectTarget(project, input.target);
  if (!targetResolved.ok) return { ok: false, status: 'failed', diagnostics: targetResolved.diagnostics };

  const object = project.scene.objects.find((candidate) => candidate.id === objectResolved.id);
  const target = project.scene.objects.find((candidate) => candidate.id === targetResolved.id);
  if (!object || !target) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, 'Object or target not found.')],
    };
  }

  const yaw = resolveFacingYaw({
    from: object.transform.position,
    faceTarget: target.transform.position,
  });
  const nextRotation: Vec3 = [...object.transform.rotation];
  nextRotation[1] = yaw;

  const commit = await commitProjectMutation('Orient object toward target', (current) => (
    applyObjectTransform(current, object.id, { rotation: nextRotation })
  ));

  return {
    ok: true,
    status: 'completed',
    objectId: object.id,
    targetId: target.id,
    rotation: nextRotation,
    revisionId: commit.revisionId,
    diagnostics: commit.diagnostics,
  };
}

export async function frameAgentSubjects(
  input: AgentFrameSubjectsInput,
): Promise<AgentFrameSubjectsResult> {
  const blocked = requireWriteAccess('frameSubjects');
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  const project = useProjectStore.getState().project;
  const shotResolved = resolveExistingShotTarget(project, { id: input.shotId });
  if (!shotResolved.ok) return { ok: false, status: 'failed', diagnostics: shotResolved.diagnostics };

  const solved = solveSubjectsCamera(project, input.shotId, input.subjectIds, input.composition);
  if (!solved.camera) {
    return { ok: false, status: 'failed', diagnostics: solved.diagnostics };
  }

  const commit = await commitProjectMutation('Frame subjects', (current) => (
    applyShotCamera(current, input.shotId, solved.camera!)
  ));

  return {
    ok: true,
    status: solved.diagnostics.some((item) => item.severity !== 'info')
      ? 'completed_with_warnings'
      : 'completed',
    shotId: input.shotId,
    camera: solved.camera,
    measuredCoverage: solved.measuredCoverage,
    revisionId: commit.revisionId,
    diagnostics: [...solved.diagnostics, ...commit.diagnostics],
  };
}

export async function trackAgentSubjects(
  input: AgentTrackSubjectsInput,
): Promise<AgentTrackSubjectsResult> {
  const blocked = requireWriteAccess('trackSubjects');
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  const start = input.startTime ?? 0;
  const end = input.endTime ?? 3;
  if (!(end > start)) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'endTime must be greater than startTime.')],
    };
  }

  const project = useProjectStore.getState().project;
  const startSolved = solveSubjectsCamera(project, input.shotId, input.subjectIds, input.composition);
  if (!startSolved.camera) {
    return { ok: false, status: 'failed', diagnostics: startSolved.diagnostics };
  }
  const endSolved = solveSubjectsCamera(project, input.shotId, input.subjectIds, input.composition);
  if (!endSolved.camera) {
    return { ok: false, status: 'failed', diagnostics: endSolved.diagnostics };
  }

  const commit = await commitProjectMutation('Track subjects', (current) => {
    let next = createShotKeyframe(current, input.shotId, {
      timeSeconds: start,
      camera: startSolved.camera!,
      label: 'Track start',
      snapshotShotStaging: true,
    });
    next = createShotKeyframe(next, input.shotId, {
      timeSeconds: end,
      camera: endSolved.camera!,
      label: 'Track end',
      snapshotShotStaging: true,
    });
    return setShotTimelineDuration(next, input.shotId, end);
  });

  return {
    ok: true,
    status: 'completed',
    shotId: input.shotId,
    startTimeSeconds: start,
    endTimeSeconds: end,
    revisionId: commit.revisionId,
    diagnostics: [...startSolved.diagnostics, ...endSolved.diagnostics, ...commit.diagnostics],
  };
}
