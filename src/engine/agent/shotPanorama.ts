/**
 * Atomic shot panorama assignment for the Agent API.
 */

import type { LocationProject } from '../../domain/types';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import { withShotPanoLink } from '../sync';
import { awaitAgentNotBusy } from './busy';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
  type AgentDiagnostic,
} from './diagnostics';
import type { AgentShotPanoramaResult } from './protocol';

export async function setAgentShotPanorama(input: {
  shotId: string;
  panoId: string | null;
}): Promise<AgentShotPanoramaResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      diagnostics: [writeAccessRequiredDiagnostic('setShotPanorama')],
    };
  }

  const busy = await awaitAgentNotBusy();
  if (busy) {
    return {
      ok: false,
      status: 'busy',
      shotId: input.shotId,
      diagnostics: busy,
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')],
    };
  }

  const project = useProjectStore.getState().project;
  const shot = project.shots.find((candidate) => candidate.id === input.shotId);
  if (!shot) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${input.shotId}".`)],
    };
  }

  let nextLinkedPanoId: string | undefined;
  let nextPanoCrop: typeof shot.panoCrop;
  const diagnostics: AgentDiagnostic[] = [];

  if (input.panoId === null) {
    nextLinkedPanoId = undefined;
    nextPanoCrop = undefined;
  } else {
    const pano = project.panoRefs.find((candidate) => candidate.id === input.panoId);
    if (!pano) {
      return {
        ok: false,
        status: 'failed',
        shotId: input.shotId,
        diagnostics: [agentError(
          AGENT_DIAGNOSTIC_CODES.targetNotFound,
          `No panorama with id "${input.panoId}".`,
          { path: 'panoId' },
        )],
      };
    }
    const linked = withShotPanoLink(project, shot, pano);
    nextLinkedPanoId = linked.linkedPanoId;
    nextPanoCrop = linked.panoCrop;
  }

  try {
    const verified = await runDestructive('Set shot panorama link', () => {
      useProjectStore.setState((state) => {
        const current = state.project;
        const updatedShots = current.shots.map((candidate) => {
          if (candidate.id !== input.shotId) return candidate;
          return {
            ...candidate,
            linkedPanoId: nextLinkedPanoId,
            panoCrop: nextPanoCrop,
            updatedAt: new Date().toISOString(),
          };
        });
        const nextProject: LocationProject = touchProject({
          ...current,
          shots: updatedShots,
        });
        const selectedShotId = state.selectedShotId;
        const activePanoId = selectedShotId === input.shotId
          ? nextLinkedPanoId
          : state.activePanoId;
        return {
          project: nextProject,
          activePanoId,
        };
      });
    });

    return {
      ok: true,
      status: 'completed',
      shotId: input.shotId,
      linkedPanoId: nextLinkedPanoId,
      revisionId: verified?.revision.id,
      diagnostics,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId,
      diagnostics: [agentError(
        'set_shot_panorama_failed',
        error instanceof Error ? error.message : 'Could not set shot panorama.',
      )],
    };
  }
}
