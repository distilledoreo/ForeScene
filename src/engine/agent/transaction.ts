/**
 * Atomic agent plan commit + undo.
 * Prepare on a clone, then replace project/UI state in one Zustand setState
 * inside runDestructiveProjectMutation so persistence never sees a half plan.
 */

import type { LocationProject, Workspace } from '../../domain/types';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { awaitAgentNotBusy, collectAgentBusyDiagnostics } from './busy';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
  type AgentDiagnostic,
} from './diagnostics';
import {
  clearAgentHistory,
  peekAgentHistory,
  popAgentHistory,
  pushAgentHistory,
} from './history';
import {
  prepareAgentPlan,
  type PreparedAgentPlan,
} from './planCompiler';
import { projectFingerprint, type AgentSelectionState } from './planDiff';
import type { AgentPlanApplyResult } from './protocol';

export { clearAgentHistory };

function requireWriteAccess(operation: string): AgentDiagnostic[] | null {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return [writeAccessRequiredDiagnostic(operation)];
  }
  return null;
}

function readLiveSource() {
  const projectState = useProjectStore.getState();
  return {
    project: projectState.project,
    workspace: projectState.workspace as Workspace,
    selectedObjectIds: projectState.selectedObjectIds,
    selectedShotId: projectState.selectedShotId,
    activePanoId: projectState.activePanoId,
    gridSnap: projectState.gridSnap,
  };
}

/**
 * Apply a prepared plan into the live store in one setState.
 * Does not call persistence — caller wraps with runDestructiveProjectMutation.
 */
export function commitPreparedPlanToStore(prepared: PreparedAgentPlan): void {
  useProjectStore.setState((state) => ({
    project: prepared.nextProject,
    workspace: prepared.nextSelection.workspace,
    selectedObjectIds: [...prepared.nextSelection.selectedObjectIds],
    selectedShotId: prepared.nextSelection.selectedShotId,
    activePanoId: prepared.nextActivePanoId ?? state.activePanoId,
    // Agent transactions own undo for mixed-domain plans.
    buildHistoryPast: [],
    buildHistoryFuture: [],
    buildHistoryBatchDepth: 0,
    buildHistoryBatchCaptured: false,
    buildHistoryCoalesceActive: false,
    shotCameraFlying: prepared.nextSelection.workspace === 'shots',
  }));
}

export function restoreAgentSelectionToStore(params: {
  project: LocationProject;
  selection: AgentSelectionState;
  activePanoId?: string;
}): void {
  useProjectStore.setState({
    project: params.project,
    workspace: params.selection.workspace,
    selectedObjectIds: [...params.selection.selectedObjectIds],
    selectedShotId: params.selection.selectedShotId,
    activePanoId: params.activePanoId,
    buildHistoryPast: [],
    buildHistoryFuture: [],
    buildHistoryBatchDepth: 0,
    buildHistoryBatchCaptured: false,
    buildHistoryCoalesceActive: false,
    shotCameraFlying: params.selection.workspace === 'shots',
  });
}

export interface AgentPlanApplyOptions {
  /**
   * Compare-and-swap: refuse the apply with stale_revision when the live
   * verified revision is missing or different. Mirrors the expectedRevisionId
   * contract on package export.
   */
  expectedRevisionId?: string;
}

export async function applyAgentPlan(
  input: unknown,
  options?: AgentPlanApplyOptions,
): Promise<AgentPlanApplyResult> {
  const writeBlocked = requireWriteAccess('applyPlan');
  if (writeBlocked) {
    return { ok: false, diagnostics: writeBlocked };
  }

  const stillBusy = await awaitAgentNotBusy();
  if (stillBusy) {
    return { ok: false, diagnostics: stillBusy };
  }

  if (options?.expectedRevisionId) {
    const activeRevisionId = useProjectSafetyStore.getState().activeRevisionId ?? '';
    if (!activeRevisionId || activeRevisionId !== options.expectedRevisionId) {
      return {
        ok: false,
        diagnostics: [
          agentError(
            AGENT_DIAGNOSTIC_CODES.staleRevision,
            activeRevisionId
              ? `expectedRevisionId "${options.expectedRevisionId}" does not match the active revision "${activeRevisionId}".`
              : `expectedRevisionId "${options.expectedRevisionId}" was provided but no verified revision is active yet.`,
          ),
        ],
      };
    }
  }

  const source = readLiveSource();
  const preparedResult = prepareAgentPlan(input, source);
  if (!preparedResult.ok) {
    return {
      ok: false,
      diagnostics: preparedResult.diagnostics,
    };
  }
  const prepared = preparedResult.prepared;

  // Re-check fingerprint immediately before the protected write.
  if (projectFingerprint(useProjectStore.getState().project) !== prepared.baseFingerprint) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.staleRevision,
          'Project changed after plan preparation; re-preview and apply again.',
        ),
      ],
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.busy,
          'Project persistence is not ready yet.',
        ),
      ],
    };
  }

  const projectBefore = structuredClone(useProjectStore.getState().project);
  const selectionBefore: AgentSelectionState = {
    selectedObjectIds: [...source.selectedObjectIds],
    selectedShotId: source.selectedShotId,
    workspace: source.workspace,
  };
  const activePanoIdBefore = source.activePanoId;
  const reason = prepared.summary.description
    ? `Agent plan: ${prepared.summary.description}`
    : `Agent plan ${prepared.planId}`;

  let verifiedRevisionId: string | undefined;
  try {
    // Re-check busy once more immediately before the protected write.
    const busyNow = collectAgentBusyDiagnostics();
    if (busyNow.length > 0) {
      return { ok: false, diagnostics: busyNow };
    }

    const verified = await runDestructive(reason, () => {
      const live = useProjectStore.getState().project;
      if (projectFingerprint(live) !== prepared.baseFingerprint) {
        throw new AgentTransactionError(
          AGENT_DIAGNOSTIC_CODES.staleRevision,
          'Project changed before the agent transaction could commit.',
        );
      }
      commitPreparedPlanToStore(prepared);
    });
    verifiedRevisionId = verified?.revision.id;
  } catch (error) {
    // Mutation may have committed before persistence threw — restore pre-plan state.
    const live = useProjectStore.getState().project;
    if (projectFingerprint(live) !== projectFingerprint(projectBefore)) {
      restoreAgentSelectionToStore({
        project: structuredClone(projectBefore),
        selection: selectionBefore,
        activePanoId: activePanoIdBefore,
      });
    }
    if (error instanceof AgentTransactionError) {
      return {
        ok: false,
        diagnostics: [agentError(error.code, error.message)],
      };
    }
    return {
      ok: false,
      diagnostics: [
        agentError(
          'apply_failed',
          error instanceof Error ? error.message : 'Agent plan apply failed.',
        ),
      ],
    };
  }

  pushAgentHistory({
    planId: prepared.planId,
    description: prepared.summary.description,
    projectBefore,
    projectAfterFingerprint: projectFingerprint(prepared.nextProject),
    selectionBefore,
    activePanoIdBefore,
  });

  return {
    ok: true,
    status: 'completed',
    planId: prepared.planId,
    verifiedRevisionId,
    revisionId: verifiedRevisionId,
    summary: prepared.summary,
    diagnostics: prepared.warnings,
  };
}

export async function undoLastAgentPlan(): Promise<AgentPlanApplyResult> {
  const writeBlocked = requireWriteAccess('undoLastPlan');
  if (writeBlocked) {
    return { ok: false, diagnostics: writeBlocked };
  }

  const stillBusy = await awaitAgentNotBusy();
  if (stillBusy) {
    return { ok: false, diagnostics: stillBusy };
  }

  const entry = peekAgentHistory();
  if (!entry) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          'nothing_to_undo',
          'No agent plan is available to undo.',
        ),
      ],
    };
  }

  const live = useProjectStore.getState().project;
  if (projectFingerprint(live) !== entry.projectAfterFingerprint) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.staleRevision,
          'Project was edited after the last agent plan; undo refused to overwrite those edits.',
        ),
      ],
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.busy,
          'Project persistence is not ready yet.',
        ),
      ],
    };
  }

  const reason = entry.description
    ? `Undo agent plan: ${entry.description}`
    : `Undo agent plan ${entry.planId}`;

  const projectAfter = structuredClone(useProjectStore.getState().project);
  const selectionAfter: AgentSelectionState = {
    selectedObjectIds: [...useProjectStore.getState().selectedObjectIds],
    selectedShotId: useProjectStore.getState().selectedShotId,
    workspace: useProjectStore.getState().workspace as Workspace,
  };
  const activePanoIdAfter = useProjectStore.getState().activePanoId;

  let verifiedRevisionId: string | undefined;
  try {
    const busyNow = collectAgentBusyDiagnostics();
    if (busyNow.length > 0) {
      return { ok: false, diagnostics: busyNow };
    }

    const verified = await runDestructive(reason, () => {
      const current = useProjectStore.getState().project;
      if (projectFingerprint(current) !== entry.projectAfterFingerprint) {
        throw new AgentTransactionError(
          AGENT_DIAGNOSTIC_CODES.staleRevision,
          'Project changed before undo could commit.',
        );
      }
      restoreAgentSelectionToStore({
        project: structuredClone(entry.projectBefore),
        selection: entry.selectionBefore,
        activePanoId: entry.activePanoIdBefore,
      });
    });
    verifiedRevisionId = verified?.revision.id;
  } catch (error) {
    // Undo mutation may have applied before persistence threw — restore post-plan state.
    const current = useProjectStore.getState().project;
    if (projectFingerprint(current) !== projectFingerprint(projectAfter)) {
      restoreAgentSelectionToStore({
        project: structuredClone(projectAfter),
        selection: selectionAfter,
        activePanoId: activePanoIdAfter,
      });
    }
    if (error instanceof AgentTransactionError) {
      return {
        ok: false,
        diagnostics: [agentError(error.code, error.message)],
      };
    }
    return {
      ok: false,
      diagnostics: [
        agentError(
          'undo_failed',
          error instanceof Error ? error.message : 'Agent plan undo failed.',
        ),
      ],
    };
  }

  popAgentHistory();

  return {
    ok: true,
    planId: entry.planId,
    verifiedRevisionId,
    summary: {
      commandCount: 0,
      affectedObjectIds: [],
      affectedShotIds: [],
      affectedLandmarkIds: [],
      createdRefs: {},
      description: entry.description ? `Undo: ${entry.description}` : `Undo: ${entry.planId}`,
    },
    diagnostics: [],
  };
}

class AgentTransactionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentTransactionError';
    this.code = code;
  }
}
