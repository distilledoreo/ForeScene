/**
 * Atomic shot panorama assignment for the Agent API.
 */

import type { LocationProject } from '../../domain/types';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { touchProject } from '../../state/slices/touchProject';
import { unlinkShotPano, withShotPanoLink } from '../sync';
import { awaitAgentNotBusy } from './busy';
import { coerceShotTarget } from './targetResolver';
import { resolveExistingShotTarget } from './inspection';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
  type AgentDiagnostic,
} from './diagnostics';
import type { AgentShotPanoramaResult } from './protocol';

export async function setAgentShotPanorama(input: {
  shotId?: string;
  shot?: import('./protocol').AgentEntityTarget;
  panoId: string | null;
}): Promise<AgentShotPanoramaResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId ?? '',
      diagnostics: [writeAccessRequiredDiagnostic('setShotPanorama')],
    };
  }

  const busy = await awaitAgentNotBusy();
  if (busy) {
    return {
      ok: false,
      status: 'busy',
      shotId: input.shotId ?? '',
      diagnostics: busy,
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId ?? '',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')],
    };
  }

  const project = useProjectStore.getState().project;
  const shotTarget = coerceShotTarget(input);
  const shotResolved = shotTarget
    ? resolveExistingShotTarget(project, shotTarget)
    : { ok: false as const, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'setShotPanorama requires shotId or shot.')] };
  if (!shotResolved.ok) {
    return {
      ok: false,
      status: 'failed',
      shotId: input.shotId ?? '',
      diagnostics: shotResolved.diagnostics,
    };
  }
  const shotId = shotResolved.id;
  const shot = project.shots.find((candidate) => candidate.id === shotId);
  if (!shot) {
    return {
      ok: false,
      status: 'failed',
      shotId,
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${shotId}".`)],
    };
  }

  let nextLinkedPanoId: string | null | undefined;
  let nextPanoCrop: typeof shot.panoCrop;
  const diagnostics: AgentDiagnostic[] = [];

  if (input.panoId === null) {
    const unlinked = unlinkShotPano(shot);
    nextLinkedPanoId = unlinked.linkedPanoId ?? null;
    nextPanoCrop = undefined;
  } else {
    const pano = project.panoRefs.find((candidate) => candidate.id === input.panoId);
    if (!pano) {
      return {
        ok: false,
        status: 'failed',
        shotId,
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
          if (candidate.id !== shotId) return candidate;
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
        const activePanoId = selectedShotId === shotId
          ? (nextLinkedPanoId ?? undefined)
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
      shotId,
      linkedPanoId: nextLinkedPanoId ?? null,
      revisionId: verified?.revision.id,
      diagnostics,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      shotId,
      diagnostics: [agentError(
        'set_shot_panorama_failed',
        error instanceof Error ? error.message : 'Could not set shot panorama.',
      )],
    };
  }
}
