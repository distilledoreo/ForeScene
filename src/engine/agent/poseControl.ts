/**
 * Agent API semantic character posing controls.
 */

import type { HumanJointId, HumanPose } from '../../domain/types';
import {
  cloneHumanPose,
  createEmptyHumanPose,
  eulerDegreesToQuaternion,
  mirrorHumanPose,
  resetHumanJoint,
  HUMAN_POSE_EDITABLE_JOINT_IDS,
} from '../humanPose';
import { applyHumanPosePreset } from '../humanPosePresets';
import { clampHumanJointEulerDegrees } from '../humanoidSkeleton';
import { applyShotStagingPatch } from './spatialShotState';
import { sampleShotTimeline } from '../shotTimeline';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import { buildPoseableRigPackage, resolvePoseableRigForObject } from '../poseableRigPackage';
import { registerAgentArtifact } from './artifactRegistry';
import { agentError, writeAccessRequiredDiagnostic } from './diagnostics';
import type {
  AgentCharacterPoseInspection,
  AgentJointRotationInput,
  AgentPoseMutationResult,
} from './protocol';
import { deriveOperationOk, deriveOperationStatus } from './renderResult';

function resolvePoseContext(
  objectId: string,
  shotId?: string,
  timeSeconds?: number,
): { objectId: string; pose?: HumanPose; shotId?: string; timeSeconds?: number } | null {
  const project = useProjectStore.getState().project;
  const object = project.scene.objects.find((candidate) => candidate.id === objectId);
  if (!object) return null;

  if (shotId !== undefined && timeSeconds !== undefined) {
    const sample = sampleShotTimeline(project, shotId, timeSeconds);
    const override = sample.objectOverrides[objectId];
    return {
      objectId,
      pose: override?.humanPose ?? object.humanPose,
      shotId,
      timeSeconds,
    };
  }

  if (shotId !== undefined) {
    const shot = project.shots.find((candidate) => candidate.id === shotId);
    const override = shot?.objectOverrides?.[objectId];
    return {
      objectId,
      pose: override?.humanPose ?? object.humanPose,
      shotId,
    };
  }

  return { objectId, pose: object.humanPose };
}

async function commitPoseMutation(
  reason: string,
  mutate: () => void,
): Promise<AgentPoseMutationResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic(reason)],
    };
  }
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    };
  }
  const verified = await runDestructive(reason, mutate);
  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    revisionId: verified?.revision.id,
    diagnostics: [],
  };
}

function applyPoseToContext(
  objectId: string,
  pose: HumanPose,
  shotId?: string,
  timeSeconds?: number,
): void {
  useProjectStore.setState((state) => {
    if (shotId) {
      const nextProject = applyShotStagingPatch(state.project, shotId, objectId, { humanPose: pose });
      return { project: touchProject(nextProject) };
    }
    const objects = state.project.scene.objects.map((object) => (
      object.id === objectId ? { ...object, humanPose: pose } : object
    ));
    return { project: touchProject({ ...state.project, scene: { ...state.project.scene, objects } }) };
  });
}

export function inspectAgentCharacterPose(input: {
  objectId: string;
  shotId?: string;
  timeSeconds?: number;
}): AgentCharacterPoseInspection {
  const ctx = resolvePoseContext(input.objectId, input.shotId, input.timeSeconds);
  if (!ctx) {
    return {
      objectId: input.objectId,
      editableJointIds: [...HUMAN_POSE_EDITABLE_JOINT_IDS],
    };
  }
  return {
    objectId: ctx.objectId,
    shotId: ctx.shotId,
    timeSeconds: ctx.timeSeconds,
    pose: ctx.pose ? cloneHumanPose(ctx.pose) : undefined,
    presetId: ctx.pose?.presetId,
    editableJointIds: [...HUMAN_POSE_EDITABLE_JOINT_IDS],
  };
}

export async function setAgentJointRotation(
  input: AgentJointRotationInput,
): Promise<AgentPoseMutationResult> {
  const ctx = resolvePoseContext(input.objectId, input.shotId, input.timeSeconds);
  if (!ctx) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('object_not_found', `No object with id "${input.objectId}".`)],
    };
  }

  const base = cloneHumanPose(ctx.pose) ?? createEmptyHumanPose();
  const clamped = clampHumanJointEulerDegrees(input.jointId, input.rotation);
  base.joints[input.jointId] = {
    rotation: eulerDegreesToQuaternion(clamped[0], clamped[1], clamped[2]),
  };

  return commitPoseMutation('Set joint rotation', () => {
    applyPoseToContext(input.objectId, base, input.shotId, input.timeSeconds);
  });
}

export async function applyAgentPosePreset(input: {
  objectId: string;
  presetId: string;
  shotId?: string;
  timeSeconds?: number;
}): Promise<AgentPoseMutationResult> {
  const pose = applyHumanPosePreset(input.presetId);
  return commitPoseMutation('Apply pose preset', () => {
    applyPoseToContext(input.objectId, pose, input.shotId, input.timeSeconds);
  });
}

export async function mirrorAgentPose(input: {
  objectId: string;
  shotId?: string;
  timeSeconds?: number;
}): Promise<AgentPoseMutationResult> {
  const ctx = resolvePoseContext(input.objectId, input.shotId, input.timeSeconds);
  if (!ctx) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('object_not_found', `No object with id "${input.objectId}".`)],
    };
  }
  const base = cloneHumanPose(ctx.pose) ?? createEmptyHumanPose();
  return commitPoseMutation('Mirror pose', () => {
    applyPoseToContext(input.objectId, mirrorHumanPose(base), input.shotId, input.timeSeconds);
  });
}

export async function resetAgentJointPose(input: {
  objectId: string;
  jointId?: HumanJointId;
  shotId?: string;
  timeSeconds?: number;
}): Promise<AgentPoseMutationResult> {
  const ctx = resolvePoseContext(input.objectId, input.shotId, input.timeSeconds);
  if (!ctx) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('object_not_found', `No object with id "${input.objectId}".`)],
    };
  }
  const base = cloneHumanPose(ctx.pose) ?? createEmptyHumanPose();
  const next = input.jointId ? resetHumanJoint(base, input.jointId) : createEmptyHumanPose();
  return commitPoseMutation('Reset joint pose', () => {
    applyPoseToContext(input.objectId, next, input.shotId, input.timeSeconds);
  });
}

export async function copyAgentPoseBetweenShots(input: {
  objectId: string;
  fromShotId: string;
  toShotId: string;
  timeSeconds?: number;
}): Promise<AgentPoseMutationResult> {
  const fromCtx = resolvePoseContext(input.objectId, input.fromShotId, input.timeSeconds);
  if (!fromCtx?.pose) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('pose_not_found', 'Source shot has no pose for this object.')],
    };
  }
  const pose = cloneHumanPose(fromCtx.pose)!;
  return commitPoseMutation('Copy pose between shots', () => {
    applyPoseToContext(input.objectId, pose, input.toShotId, input.timeSeconds);
  });
}

export async function exportAgentRigPackage(input: { objectId: string }) {
  const project = useProjectStore.getState().project;
  const object = project.scene.objects.find((candidate) => candidate.id === input.objectId);
  if (!object?.poseableCharacter) {
    return {
      ok: false,
      status: 'failed' as const,
      diagnostics: [agentError('not_poseable', 'Object is not a poseable character.')],
    };
  }
  try {
    const resolved = resolvePoseableRigForObject(object, project.assets);
    if (!resolved) {
      return {
        ok: false,
        status: 'failed' as const,
        diagnostics: [agentError('rig_not_resolved', 'Could not resolve poseable rig for this object.')],
      };
    }
    const pkg = await buildPoseableRigPackage({
      rig: resolved.rig,
      assets: project.assets,
      characterName: object.name,
    });
    const artifact = registerAgentArtifact({
      blob: pkg.blob,
      mimeType: 'application/zip',
      fileName: pkg.fileName,
      revisionId: useProjectSafetyStore.getState().activeRevisionId,
    });
    return {
      ok: true,
      status: 'completed' as const,
      artifact,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed' as const,
      diagnostics: [agentError('rig_export_failed', error instanceof Error ? error.message : 'Rig export failed.')],
    };
  }
}
