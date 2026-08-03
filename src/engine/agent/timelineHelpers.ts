/**
 * Timeline convenience APIs for the Agent surface.
 */

import type { CameraKeyframe, LocationProject } from '../../domain/types';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import {
  createShotKeyframe,
  sampleShotTimeline,
  stageObjectAtKeyframe,
} from '../shotTimeline';
import { awaitAgentNotBusy } from './busy';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
} from './diagnostics';
import type {
  AgentCaptureKeyframeResult,
  AgentShotTimeSample,
  AgentUpsertObjectKeyframeInput,
  AgentUpsertObjectKeyframeResult,
} from './protocol';
import { sampleShotAtTimeSnapshot } from './inspection';

function sortedKeyframes(keyframes: readonly CameraKeyframe[]): CameraKeyframe[] {
  return [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
}

function requireWriteAccess(operation: string) {
  return useAgentControlStore.getState().controlMode === 'read-write'
    ? null
    : [writeAccessRequiredDiagnostic(operation)];
}

async function commitProject(
  reason: string,
  mutate: (project: LocationProject) => LocationProject,
) {
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false as const, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')] };
  }
  const verified = await runDestructive(reason, () => {
    useProjectStore.setState((state) => ({
      project: touchProject(mutate(state.project)),
    }));
  });
  return { ok: true as const, revisionId: verified?.revision.id, diagnostics: [] };
}

function findKeyframeAtTime(keyframes: readonly CameraKeyframe[], timeSeconds: number): CameraKeyframe | undefined {
  return sortedKeyframes(keyframes)
    .find((keyframe) => Math.abs(keyframe.timeSeconds - timeSeconds) < 0.0001);
}

export function sampleAgentShotState(input: {
  shotId: string;
  timeSeconds: number;
}): AgentShotTimeSample {
  const project = useProjectStore.getState().project;
  return sampleShotAtTimeSnapshot(project, input.shotId, input.timeSeconds);
}

export async function captureAgentShotStateAsKeyframe(input: {
  shotId: string;
  timeSeconds: number;
}): Promise<AgentCaptureKeyframeResult> {
  const blocked = requireWriteAccess('captureShotStateAsKeyframe');
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  const project = useProjectStore.getState().project;
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${input.shotId}".`)],
    };
  }

  const sampled = sampleShotTimeline(project, input.shotId, input.timeSeconds);
  const commit = await commitProject('Capture shot state as keyframe', (current) => (
    createShotKeyframe(current, input.shotId, {
      timeSeconds: input.timeSeconds,
      camera: sampled.camera,
      objectOverrides: sampled.objectOverrides,
      snapshotShotStaging: false,
      label: `Captured @ ${input.timeSeconds.toFixed(2)}s`,
    })
  ));
  if (!commit.ok) return { ok: false, status: 'failed', diagnostics: commit.diagnostics };

  const updated = useProjectStore.getState().project.shots.find((candidate) => candidate.id === input.shotId);
  const keyframe = findKeyframeAtTime(updated?.cameraKeyframes ?? [], input.timeSeconds);

  return {
    ok: true,
    status: 'completed',
    shotId: input.shotId,
    keyframeId: keyframe?.id,
    timeSeconds: input.timeSeconds,
    revisionId: commit.revisionId,
    diagnostics: [],
  };
}

export async function upsertAgentObjectKeyframe(
  input: AgentUpsertObjectKeyframeInput,
): Promise<AgentUpsertObjectKeyframeResult> {
  const blocked = requireWriteAccess('upsertObjectKeyframe');
  if (blocked) return { ok: false, status: 'failed', diagnostics: blocked };
  const busy = await awaitAgentNotBusy();
  if (busy) return { ok: false, status: 'busy', diagnostics: busy };

  const project = useProjectStore.getState().project;
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${input.shotId}".`)],
    };
  }
  const object = project.scene.objects.find((candidate) => candidate.id === input.objectId);
  if (!object) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No object with id "${input.objectId}".`)],
    };
  }

  const existing = findKeyframeAtTime(shot.cameraKeyframes, input.timeSeconds);

  const commit = await commitProject('Upsert object keyframe', (current) => {
    if (existing) {
      return stageObjectAtKeyframe(
        current,
        input.shotId,
        existing.id,
        input.objectId,
        {
          transform: input.transform,
          visible: input.visible,
          humanPose: input.humanPose,
        },
      );
    }

    const sampled = sampleShotTimeline(current, input.shotId, input.timeSeconds);
    let next = createShotKeyframe(current, input.shotId, {
      timeSeconds: input.timeSeconds,
      camera: sampled.camera,
      objectOverrides: input.preserveExplicitState ? sampled.objectOverrides : undefined,
      snapshotShotStaging: input.preserveExplicitState !== false,
      label: `Object keyframe @ ${input.timeSeconds.toFixed(2)}s`,
    });
    const updatedShot = next.shots.find((candidate) => candidate.id === input.shotId);
    const created = findKeyframeAtTime(updatedShot?.cameraKeyframes ?? [], input.timeSeconds);
    if (!created) return next;
    return stageObjectAtKeyframe(next, input.shotId, created.id, input.objectId, {
      transform: input.transform,
      visible: input.visible,
      humanPose: input.humanPose,
    });
  });

  if (!commit.ok) return { ok: false, status: 'failed', diagnostics: commit.diagnostics };
  const updatedShot = useProjectStore.getState().project.shots.find((candidate) => candidate.id === input.shotId);
  const keyframe = findKeyframeAtTime(updatedShot?.cameraKeyframes ?? [], input.timeSeconds);

  return {
    ok: true,
    status: 'completed',
    shotId: input.shotId,
    objectId: input.objectId,
    keyframeId: keyframe?.id ?? existing?.id,
    timeSeconds: input.timeSeconds,
    revisionId: commit.revisionId,
    diagnostics: [],
  };
}
