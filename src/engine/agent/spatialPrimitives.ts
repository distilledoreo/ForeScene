/**
 * Semantic spatial primitives for the Agent API.
 * All mutations are shot-scoped via objectOverrides — base scene geometry is immutable.
 */

import type { CameraData, LocationProject, SceneObject, Vec3 } from '../../domain/types';
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
  updateShotKeyframe,
} from '../shotTimeline';
import type {
  AgentEntityReference,
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
  ForeSceneAgentCommand,
} from './protocol';
import {
  resolveExistingLandmarkTarget,
  resolveExistingObjectTarget,
  resolveExistingShotTarget,
} from './inspection';
import {
  coerceShotTarget,
  resolveObjectTarget,
  resolveShotTarget,
} from './targetResolver';
import {
  applyShotCamera,
  applyShotStagingTransform,
  camerasNearlyEqual,
  displacementMeters,
  getEffectiveObject,
  getShotEffectiveState,
  identifyFloorY,
  groundObjectPositionOnFloor,
  uprightFloorPositionForObject,
} from './spatialShotState';

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

const MIN_TRACK_DISPLACEMENT_METERS = 0.05;

function requireWriteAccess(operation: string): AgentDiagnostic[] | null {
  return useAgentControlStore.getState().controlMode === 'read-write'
    ? null
    : [writeAccessRequiredDiagnostic(operation)];
}

function requireShotId(shotId: string | undefined, operation: string): AgentDiagnostic[] | null {
  if (!shotId) {
    return [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, `${operation} requires shotId or shot.`)];
  }
  return null;
}

function resolveShotIdFromInput(
  project: LocationProject,
  input: { shotId?: string; shot?: import('./protocol').AgentEntityTarget },
  operation: string,
): { ok: true; id: string } | { ok: false; diagnostics: AgentDiagnostic[] } {
  const target = coerceShotTarget(input);
  if (!target) {
    return {
      ok: false,
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, `${operation} requires shotId or shot.`)],
    };
  }
  return resolveExistingShotTarget(project, target);
}

function isPositionTarget(target: unknown): target is [number, number, number] | { position: [number, number, number] } {
  if (Array.isArray(target) && target.length === 3 && target.every((value) => typeof value === 'number')) {
    return true;
  }
  if (target && typeof target === 'object' && 'position' in target) {
    const position = (target as { position?: unknown }).position;
    return Array.isArray(position) && position.length === 3 && position.every((value) => typeof value === 'number');
  }
  return false;
}

function readPositionTarget(target: [number, number, number] | { position: [number, number, number] }): [number, number, number] {
  return Array.isArray(target) ? target : target.position;
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

function toSubjectBounds(object: SceneObject): SubjectBounds {
  const box = objectWorldAabb(object);
  const floorY = identifyFloorY(useProjectStore.getState().project, object.transform.position);
  return {
    id: object.id,
    min: box.min,
    max: box.max,
    position: uprightFloorPositionForObject(object, floorY),
    yawRadians: (object.transform.rotation[1] * Math.PI) / 180,
  };
}

function solveSubjectsCameraForShot(
  project: LocationProject,
  shotId: string,
  subjectIds: string[],
  composition?: string,
): { camera?: CameraData; measuredCoverage?: number; diagnostics: AgentDiagnostic[] } {
  const state = getShotEffectiveState(project, shotId);
  if (!state) {
    return {
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${shotId}".`)],
    };
  }
  return solveSubjectsCameraFromState(state, subjectIds, composition);
}

function solveSubjectsCameraAtTime(
  project: LocationProject,
  shotId: string,
  subjectIds: string[],
  timeSeconds: number,
  composition?: string,
): { camera?: CameraData; measuredCoverage?: number; diagnostics: AgentDiagnostic[] } {
  const state = getShotEffectiveState(project, shotId, timeSeconds);
  if (!state) {
    return {
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${shotId}".`)],
    };
  }
  return solveSubjectsCameraFromState(state, subjectIds, composition);
}

function solveSubjectsCameraFromState(
  state: NonNullable<ReturnType<typeof getShotEffectiveState>>,
  subjectIds: string[],
  composition?: string,
): { camera?: CameraData; measuredCoverage?: number; diagnostics: AgentDiagnostic[] } {
  const subjects: SubjectBounds[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  for (const subjectId of subjectIds) {
    const object = getEffectiveObject(state, subjectId);
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
  const blockers = state.objects
    .filter((object) => ['wall', 'box', 'column', 'arch', 'doorway'].includes(object.type))
    .map((object) => {
      const box = objectWorldAabb(object);
      return { id: object.id, min: box.min, max: box.max };
    });

  const solved = solveShotCamera({
    shot: {
      id: state.shot.id,
      shotNumber: state.shot.shotNumber,
      name: state.shot.name,
      description: state.shot.description,
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
    aspectRatio: state.shot.camera.aspectRatio,
    blockers,
    frameWidth: state.shot.exportSettings.width,
    frameHeight: state.shot.exportSettings.height,
  });

  diagnostics.push(...solved.warnings.map((message) => agentWarning('frame_subjects', message)));
  return {
    camera: solved.camera,
    measuredCoverage: solved.measuredCoverage,
    diagnostics,
  };
}

function resolveObjectId(
  project: LocationProject,
  target: AgentSnapObjectToFloorInput['object'],
): { ok: true; id: string } | { ok: false; diagnostics: AgentDiagnostic[] } {
  return resolveExistingObjectTarget(project, target);
}

export async function snapAgentObjectToFloor(
  input: AgentSnapObjectToFloorInput,
): Promise<AgentSnapObjectToFloorResult> {
  const blocked = requireWriteAccess('snapObjectToFloor');
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  const project = useProjectStore.getState().project;
  const shotResolved = resolveShotIdFromInput(project, input, 'snapObjectToFloor');
  if (!shotResolved.ok) return { ok: false, status: 'failed', diagnostics: shotResolved.diagnostics };
  const objectResolved = resolveObjectId(project, input.object);
  if (!objectResolved.ok) return { ok: false, status: 'failed', diagnostics: objectResolved.diagnostics };

  const state = getShotEffectiveState(project, shotResolved.id);
  const object = state ? getEffectiveObject(state, objectResolved.id) : undefined;
  if (!object) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No object with id "${objectResolved.id}".`)],
    };
  }

  const floorY = identifyFloorY(project, object.transform.position, state?.objects);
  const nextPosition = groundObjectPositionOnFloor(object, floorY);
  const commit = await commitProjectMutation('Snap object to floor (shot staging)', (current) => (
    applyShotStagingTransform(current, shotResolved.id, object.id, { position: nextPosition })
  ));

  return {
    ok: true,
    status: 'completed',
    shotId: shotResolved.id,
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
  const shotResolved = resolveShotIdFromInput(project, input, 'placeObjectNearLandmark');
  if (!shotResolved.ok) return { ok: false, status: 'failed', diagnostics: shotResolved.diagnostics };
  const objectResolved = resolveObjectId(project, input.object);
  if (!objectResolved.ok) return { ok: false, status: 'failed', diagnostics: objectResolved.diagnostics };
  const landmarkResolved = resolveExistingLandmarkTarget(project, input.landmark);
  if (!landmarkResolved.ok) return { ok: false, status: 'failed', diagnostics: landmarkResolved.diagnostics };

  const state = getShotEffectiveState(project, shotResolved.id);
  const object = state ? getEffectiveObject(state, objectResolved.id) : undefined;
  const landmark = project.landmarks.find((candidate) => candidate.id === landmarkResolved.id);
  if (!object || !landmark) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, 'Object or landmark not found.')],
    };
  }

  const offset = input.offset ?? [0, 0, 1];
  const floorY = identifyFloorY(project, [
    landmark.position[0] + offset[0],
    landmark.position[1],
    landmark.position[2] + offset[2],
  ]);
  const nextPosition: Vec3 = [
    landmark.position[0] + offset[0],
    groundObjectPositionOnFloor(object, floorY)[1],
    landmark.position[2] + offset[2],
  ];

  const commit = await commitProjectMutation('Place object near landmark (shot staging)', (current) => (
    applyShotStagingTransform(current, shotResolved.id, object.id, { position: nextPosition })
  ));

  return {
    ok: true,
    status: 'completed',
    shotId: shotResolved.id,
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
  const shotResolved = resolveShotIdFromInput(project, input, 'orientObjectToward');
  if (!shotResolved.ok) return { ok: false, status: 'failed', diagnostics: shotResolved.diagnostics };
  const objectResolved = resolveObjectId(project, input.object);
  if (!objectResolved.ok) return { ok: false, status: 'failed', diagnostics: objectResolved.diagnostics };

  const state = getShotEffectiveState(project, shotResolved.id);
  const object = state ? getEffectiveObject(state, objectResolved.id) : undefined;
  if (!object) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, 'Object not found.')],
    };
  }

  let targetId: string | undefined;
  let faceTarget: Vec3;
  if (isPositionTarget(input.target)) {
    faceTarget = readPositionTarget(input.target);
  } else {
    const targetResolved = resolveObjectId(project, input.target as import('./protocol').AgentEntityTarget);
    if (!targetResolved.ok) return { ok: false, status: 'failed', diagnostics: targetResolved.diagnostics };
    const target = state ? getEffectiveObject(state, targetResolved.id) : undefined;
    if (!target) {
      return {
        ok: false,
        status: 'failed',
        diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, 'Object or target not found.')],
      };
    }
    targetId = target.id;
    faceTarget = target.transform.position;
  }

  const yaw = resolveFacingYaw({
    from: object.transform.position,
    faceTarget,
  });
  const nextRotation: Vec3 = [...object.transform.rotation];
  nextRotation[1] = yaw;

  const commit = await commitProjectMutation('Orient object toward target (shot staging)', (current) => (
    applyShotStagingTransform(current, shotResolved.id, object.id, { rotation: nextRotation })
  ));

  return {
    ok: true,
    status: 'completed',
    shotId: shotResolved.id,
    objectId: object.id,
    targetId,
    rotation: nextRotation,
    revisionId: commit.revisionId,
    diagnostics: commit.diagnostics,
  };
}

export type FrameSubjectsPlanCommand = Extract<ForeSceneAgentCommand, { op: 'shot.frameSubjects' }>;
export type UpdateCameraPlanCommand = Extract<ForeSceneAgentCommand, { op: 'shot.updateCamera' }>;

/**
 * Expand a `shot.frameSubjects` plan command into the equivalent
 * `shot.updateCamera` command using the same solver as the frameSubjects
 * Agent API primitive. Runs at plan-prepare time so preview, diff, apply, and
 * undo all treat cinematic framing intent as an ordinary camera plan command.
 */
export function expandFrameSubjectsPlanCommand(
  project: LocationProject,
  command: FrameSubjectsPlanCommand,
  refs: Record<string, AgentEntityReference>,
): {
  ok: true;
  command: UpdateCameraPlanCommand;
  measuredCoverage?: number;
  warnings: AgentDiagnostic[];
} | {
  ok: false;
  diagnostics: AgentDiagnostic[];
} {
  const shotResolved = resolveShotTarget(project, command.shot, refs);
  if (!shotResolved.ok) return { ok: false, diagnostics: shotResolved.diagnostics };
  const subjectIds: string[] = [];
  for (const target of command.subjects) {
    const resolved = resolveObjectTarget(project, target, refs);
    if (!resolved.ok) return { ok: false, diagnostics: resolved.diagnostics };
    subjectIds.push(resolved.id);
  }
  if (subjectIds.length === 0) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          'shot.frameSubjects requires at least one subject.',
          { path: 'subjects' },
        ),
      ],
    };
  }
  const solved = solveSubjectsCameraForShot(project, shotResolved.id, subjectIds, command.composition);
  if (!solved.camera) {
    return { ok: false, diagnostics: solved.diagnostics };
  }
  return {
    ok: true,
    command: {
      op: 'shot.updateCamera',
      shot: { id: shotResolved.id },
      camera: solved.camera,
    },
    ...(solved.measuredCoverage !== undefined ? { measuredCoverage: solved.measuredCoverage } : {}),
    warnings: solved.diagnostics.filter((diagnostic) => diagnostic.severity !== 'error'),
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

  const solved = solveSubjectsCameraForShot(project, input.shotId, input.subjectIds, input.composition);
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

function measureSubjectDisplacement(
  project: LocationProject,
  shotId: string,
  subjectIds: string[],
  startTime: number,
  endTime: number,
): { maxDisplacementMeters: number; perSubject: Array<{ objectId: string; displacementMeters: number }> } {
  const startState = getShotEffectiveState(project, shotId, startTime);
  const endState = getShotEffectiveState(project, shotId, endTime);
  const perSubject: Array<{ objectId: string; displacementMeters: number }> = [];
  let maxDisplacementMeters = 0;
  for (const subjectId of subjectIds) {
    const startObject = startState ? getEffectiveObject(startState, subjectId) : undefined;
    const endObject = endState ? getEffectiveObject(endState, subjectId) : undefined;
    const delta = startObject && endObject
      ? displacementMeters(startObject.transform.position, endObject.transform.position)
      : 0;
    perSubject.push({ objectId: subjectId, displacementMeters: delta });
    maxDisplacementMeters = Math.max(maxDisplacementMeters, delta);
  }
  return { maxDisplacementMeters, perSubject };
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
  const startState = getShotEffectiveState(project, input.shotId, start);
  const endState = getShotEffectiveState(project, input.shotId, end);
  const displacement = measureSubjectDisplacement(project, input.shotId, input.subjectIds, start, end);
  const startSolved = solveSubjectsCameraAtTime(project, input.shotId, input.subjectIds, start, input.composition);
  if (!startSolved.camera) {
    return { ok: false, status: 'failed', diagnostics: startSolved.diagnostics };
  }
  const endSolved = solveSubjectsCameraAtTime(project, input.shotId, input.subjectIds, end, input.composition);
  if (!endSolved.camera) {
    return { ok: false, status: 'failed', diagnostics: endSolved.diagnostics };
  }

  const diagnostics: AgentDiagnostic[] = [
    ...startSolved.diagnostics,
    ...endSolved.diagnostics,
  ];

  const camerasMatch = camerasNearlyEqual(startSolved.camera, endSolved.camera);
  if (displacement.maxDisplacementMeters < MIN_TRACK_DISPLACEMENT_METERS && camerasMatch) {
    diagnostics.push(agentWarning(
      'track_no_motion',
      'Subjects did not move enough between start and end times, and the solved cameras are identical.',
    ));
  } else if (camerasMatch) {
    diagnostics.push(agentWarning(
      'track_static_camera',
      'Start and end cameras are effectively identical despite subject movement.',
    ));
  }

  const commit = await commitProjectMutation('Track subjects', (current) => {
    const shot = current.shots.find((candidate) => candidate.id === input.shotId);
    const startExisting = shot?.cameraKeyframes.find((keyframe) => Math.abs(keyframe.timeSeconds - start) < 0.0001);
    const endExisting = shot?.cameraKeyframes.find((keyframe) => Math.abs(keyframe.timeSeconds - end) < 0.0001);

    let next = startExisting
      ? updateShotKeyframe(current, input.shotId, startExisting.id, {
        camera: startSolved.camera!,
        label: 'Track start',
      })
      : createShotKeyframe(current, input.shotId, {
        timeSeconds: start,
        camera: startSolved.camera!,
        label: 'Track start',
        objectOverrides: startState?.shot.objectOverrides,
        snapshotShotStaging: false,
      });

    next = endExisting
      ? updateShotKeyframe(next, input.shotId, endExisting.id, {
        camera: endSolved.camera!,
        label: 'Track end',
      })
      : createShotKeyframe(next, input.shotId, {
        timeSeconds: end,
        camera: endSolved.camera!,
        label: 'Track end',
        objectOverrides: endState?.shot.objectOverrides,
        snapshotShotStaging: false,
      });

    return next;
  });

  const hasWarnings = diagnostics.some((item) => item.severity === 'warning' || item.severity === 'error');
  return {
    ok: true,
    status: hasWarnings ? 'completed_with_warnings' : 'completed',
    shotId: input.shotId,
    startTimeSeconds: start,
    endTimeSeconds: end,
    cameraDisplacementMeters: displacementMeters(startSolved.camera.position, endSolved.camera.position),
    subjectDisplacements: displacement.perSubject,
    revisionId: commit.revisionId,
    diagnostics: [...diagnostics, ...commit.diagnostics],
  };
}
