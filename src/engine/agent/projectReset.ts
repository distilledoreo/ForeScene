/**
 * Agent API project reset — replace the live project with a blank graybox shell.
 * Requires read-write mode AND an explicit reset authorization token from the CLI.
 */

import type { LocationProject, Workspace } from '../../domain/types';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useAppModeStore } from '../../state/useAppModeStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { awaitAgentNotBusy, collectAgentBusyDiagnostics } from './busy';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
  type AgentDiagnostic,
} from './diagnostics';
import { clearAgentHistory } from './history';
import { projectFingerprint } from './planDiff';
import type { AgentPlanApplyResult } from './protocol';
import { createBlankGrayboxProject } from '../previs/blankProject';
import type { PrevisAspectRatio } from '../previs/manifest';

export const AGENT_RESET_AUTHORIZATION = 'reset-project' as const;

export interface AgentResetProjectInput {
  name: string;
  description?: string;
  aspectRatio?: string;
  frameRate?: number;
  expectedProjectId?: string;
  /**
   * Must equal AGENT_RESET_AUTHORIZATION. CLI sets this only when --reset-project
   * is passed. --write alone must never authorize project replacement.
   */
  resetAuthorization?: string;
}

function isAspectRatio(value: string | undefined): value is PrevisAspectRatio {
  return value === '16:9' || value === '9:16' || value === '1:1' || value === '2.39:1';
}

export async function resetAgentProject(
  input: AgentResetProjectInput,
): Promise<AgentPlanApplyResult & { projectId?: string }> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      diagnostics: [writeAccessRequiredDiagnostic('resetProject')],
    };
  }

  if (input.resetAuthorization !== AGENT_RESET_AUTHORIZATION) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          'reset_authorization_required',
          'resetProject requires explicit reset authorization (--reset-project with --write).',
        ),
      ],
    };
  }

  if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
    return {
      ok: false,
      diagnostics: [
        agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'resetProject requires a nonempty name.', {
          path: 'name',
        }),
      ],
    };
  }

  const stillBusy = await awaitAgentNotBusy();
  if (stillBusy) {
    return { ok: false, diagnostics: stillBusy };
  }

  const live = useProjectStore.getState().project;
  if (input.expectedProjectId && live.id !== input.expectedProjectId) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.staleRevision,
          `expectedProjectId "${input.expectedProjectId}" does not match live project "${live.id}".`,
        ),
      ],
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      diagnostics: [
        agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready yet.'),
      ],
    };
  }

  const projectBefore = structuredClone(live) as LocationProject;
  const selectionBefore = {
    selectedObjectIds: [...useProjectStore.getState().selectedObjectIds],
    selectedShotId: useProjectStore.getState().selectedShotId,
    workspace: useProjectStore.getState().workspace as Workspace,
  };
  const activePanoIdBefore = useProjectStore.getState().activePanoId;
  const beforeFingerprint = projectFingerprint(projectBefore);

  const fresh = createBlankGrayboxProject({
    name: input.name.trim(),
    description: input.description,
    aspectRatio: isAspectRatio(input.aspectRatio) ? input.aspectRatio : '16:9',
    frameRate: input.frameRate,
  });

  let verifiedRevisionId: string | undefined;
  try {
    const busyNow = collectAgentBusyDiagnostics();
    if (busyNow.length > 0) {
      return { ok: false, diagnostics: busyNow };
    }

    const verified = await runDestructive(
      `Agent reset project: ${fresh.name}`,
      () => {
        const current = useProjectStore.getState().project;
        if (projectFingerprint(current) !== beforeFingerprint) {
          throw new ResetTransactionError(
            AGENT_DIAGNOSTIC_CODES.staleRevision,
            'Project changed before reset could commit.',
          );
        }
        useProjectStore.getState().setProject(fresh);
        useProjectStore.getState().setWorkspace('build');
        useAppModeStore.getState().setAppMode('studio');
        clearAgentHistory();
      },
    );
    verifiedRevisionId = verified?.revision.id;
  } catch (error) {
    const liveNow = useProjectStore.getState().project;
    if (projectFingerprint(liveNow) !== beforeFingerprint) {
      useProjectStore.setState({
        project: structuredClone(projectBefore),
        workspace: selectionBefore.workspace,
        selectedObjectIds: [...selectionBefore.selectedObjectIds],
        selectedShotId: selectionBefore.selectedShotId,
        activePanoId: activePanoIdBefore,
      });
    }
    if (error instanceof ResetTransactionError) {
      return { ok: false, diagnostics: [agentError(error.code, error.message)] };
    }
    return {
      ok: false,
      diagnostics: [
        agentError(
          'reset_failed',
          error instanceof Error ? error.message : 'Project reset failed.',
        ),
      ],
    };
  }

  const after = useProjectStore.getState().project;
  return {
    ok: true,
    planId: `reset-${after.id}`,
    verifiedRevisionId,
    projectId: after.id,
    summary: {
      commandCount: 1,
      affectedObjectIds: after.scene.objects.map((object) => object.id),
      affectedShotIds: after.shots.map((shot) => shot.id),
      affectedLandmarkIds: after.landmarks.map((landmark) => landmark.id),
      createdRefs: {},
      description: `Reset project to blank graybox: ${after.name}`,
    },
    diagnostics: [] as AgentDiagnostic[],
  };
}

class ResetTransactionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ResetTransactionError';
    this.code = code;
  }
}
