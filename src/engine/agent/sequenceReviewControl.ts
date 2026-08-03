/**
 * Agent API shot library and sequence review operations.
 */

import { createShot } from '../../domain/defaults';
import { resolveShotMedia } from '../../domain/shotMedia';
import type { LocationProject, Shot } from '../../domain/types';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import { reorderShots as reorderShotsInSequence } from '../sequenceStoryboard';
import { resolveFacingYaw } from '../previs/facingSolver';
import { agentError, writeAccessRequiredDiagnostic } from './diagnostics';
import type {
  AgentDuplicateShotInput,
  AgentDuplicateShotResult,
  AgentReorderShotsInput,
  AgentSequenceContinuityDelta,
  AgentShotMediaItem,
} from './protocol';
import { deriveOperationOk, deriveOperationStatus } from './renderResult';

function cameraDirectionDegrees(shot: Shot): number {
  const dx = shot.camera.target[0] - shot.camera.position[0];
  const dz = shot.camera.target[2] - shot.camera.position[2];
  return (Math.atan2(dx, dz) * 180) / Math.PI;
}

export async function duplicateAgentShot(
  input: AgentDuplicateShotInput,
): Promise<AgentDuplicateShotResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic('duplicateShot')],
    };
  }

  const project = useProjectStore.getState().project;
  const source = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!source) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('shot_not_found', `No shot with id "${input.shotId}".`)],
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

  let newShotId: string | undefined;
  const verified = await runDestructive('Duplicate shot', () => {
    useProjectStore.setState((state) => {
      const index = state.project.shots.findIndex((candidate) => candidate.id === input.shotId);
      const created = createShot({
        index: state.project.shots.length + 1,
        camera: structuredClone(source.camera),
        linkedPanoId: source.linkedPanoId,
        panoCrop: source.panoCrop ? structuredClone(source.panoCrop) : undefined,
        exportDefaults: source.exportSettings,
      });
      const merged: Shot = {
        ...structuredClone(source),
        id: created.id,
        shotNumber: created.shotNumber,
        name: `${source.name} copy`,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        assets: {},
      };
      newShotId = merged.id;
      const shots = [...state.project.shots];
      const insertAt = input.insertAfter ? index + 1 : index;
      shots.splice(insertAt, 0, merged);
      return { project: touchProject({ ...state.project, shots }) };
    });
  });

  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    shotId: newShotId,
    sourceShotId: input.shotId,
    revisionId: verified?.revision.id,
    diagnostics: [],
  };
}

export async function reorderAgentShots(
  input: AgentReorderShotsInput,
): Promise<{ ok: boolean; revisionId?: string; diagnostics: import('./diagnostics').AgentDiagnostic[] }> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return { ok: false, diagnostics: [writeAccessRequiredDiagnostic('reorderShots')] };
  }

  const project = useProjectStore.getState().project;
  if (input.shotIds.length !== project.shots.length) {
    return {
      ok: false,
      diagnostics: [agentError('invalid_reorder', 'reorderShots requires the full shot id list.')],
    };
  }

  const uniqueIds = new Set(input.shotIds);
  if (uniqueIds.size !== input.shotIds.length) {
    return {
      ok: false,
      diagnostics: [agentError('invalid_reorder', 'reorderShots shot id list contains duplicates.')],
    };
  }

  const knownShotIds = new Set(project.shots.map((shot) => shot.id));
  const unknownIds = input.shotIds.filter((id) => !knownShotIds.has(id));
  if (unknownIds.length > 0) {
    return {
      ok: false,
      diagnostics: [agentError('invalid_reorder', 'Unknown shot ids: ' + unknownIds.join(', ') + '.')],
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')] };
  }

  const verified = await runDestructive('Reorder shots', () => {
    useProjectStore.setState((state) => {
      const byId = new Map(state.project.shots.map((shot) => [shot.id, shot]));
      const reordered = input.shotIds.map((id) => byId.get(id)).filter(Boolean) as Shot[];
      return { project: touchProject({ ...state.project, shots: reordered }) };
    });
  });

  return { ok: true, revisionId: verified?.revision.id, diagnostics: [] };
}

export function listAgentShotMedia(input: { shotId: string }): AgentShotMediaItem[] {
  const project = useProjectStore.getState().project;
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) return [];
  return resolveShotMedia(project, shot).map((item) => ({
    id: item.id,
    assetId: item.asset.id,
    kind: item.kind,
    label: item.label,
    source: item.source,
  }));
}

export function compareAgentAdjacentShots(
  input: { shotId: string },
  projectOverride?: LocationProject,
): AgentSequenceContinuityDelta {
  const project = projectOverride ?? useProjectStore.getState().project;
  const index = project.shots.findIndex((candidate) => candidate.id === input.shotId);
  const shot = project.shots[index];
  const nextShot = index >= 0 ? project.shots[index + 1] : undefined;
  if (!shot) {
    return {
      shotId: input.shotId,
      diagnostics: [agentError('shot_not_found', `No shot with id "${input.shotId}".`)],
    };
  }
  if (!nextShot) {
    return { shotId: shot.id, diagnostics: [] };
  }

  const dirA = cameraDirectionDegrees(shot);
  const dirB = cameraDirectionDegrees(nextShot);
  let delta = dirB - dirA;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;

  const lensA = shot.camera.fovDegrees ?? project.settings.defaultShotFovDegrees ?? 35;
  const lensB = nextShot.camera.fovDegrees ?? project.settings.defaultShotFovDegrees ?? 35;
  const lensFovDeltaDegrees = lensB - lensA;

  const subjectSideReversal = Math.abs(delta) > 90;

  return {
    shotId: shot.id,
    nextShotId: nextShot.id,
    cameraDirectionDeltaDegrees: delta,
    lensFovDeltaDegrees,
    subjectSideReversal,
    panoramaChanged: shot.linkedPanoId !== nextShot.linkedPanoId,
    stagingDelta: Object.keys(nextShot.objectOverrides ?? {}).length
      - Object.keys(shot.objectOverrides ?? {}).length,
    diagnostics: subjectSideReversal
      ? [agentError('screen_direction_reversal', 'Adjacent shots may reverse screen direction.')]
      : [],
  };
}

export function inspectAgentSequenceContinuity(input: { shotIds: string[] }): AgentSequenceContinuityDelta[] {
  return input.shotIds.map((shotId) => compareAgentAdjacentShots({ shotId }));
}

export function buildContinuityReport(project: LocationProject, shotIds: string[]): AgentSequenceContinuityDelta[] {
  return shotIds.map((shotId) => compareAgentAdjacentShots({ shotId }, project));
}
