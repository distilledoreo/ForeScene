/** Browser-side adapters for capability-driven production canary gates. */

import { parsePrevisProductionManifest } from '../previs/manifestValidation';
import { getProductionConfiguration } from '../previs/productionConfiguration';
import {
  approveProductionCanary as approveProductionCanaryEngine,
  approveStillLayout as approveStillLayoutEngine,
  canAdvanceFullStillRun,
  completeProductionGate,
  createProductionGateState,
  deriveProductionShotCapabilities,
  planProductionCanary as planProductionCanaryEngine,
  runProductionCanary as runProductionCanaryEngine,
  type ProductionCanaryPlan,
  type ProductionCanaryResult,
  type ProductionCanaryShotResult,
  type ProductionGateState,
} from '../previs/productionGates';
import {
  createApprovedLayoutRevision,
  createMotionWorkingRevision,
  verifyApprovedLayoutRevision,
} from '../previs/stillLayoutApproval';
import { createProductionRunId } from '../previs/productionRun';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { agentError, type AgentDiagnostic } from './diagnostics';
import type {
  AgentProductionCanaryApprovalResult,
  AgentProductionCanaryPlanResult,
  AgentProductionCanaryRunResult,
  AgentMotionWorkingRevisionResult,
  AgentStillLayoutApprovalResult,
} from './protocol';
import { cloneAgentProjectRevision } from './projectImportControl';

interface StoredProductionGateRun {
  gateState: ProductionGateState;
  manifest?: unknown;
}

const STORAGE_KEY = 'forescene.production.gate-runs.v1';
const runs = new Map<string, StoredProductionGateRun>();

function loadRuns(): void {
  if (runs.size > 0 || typeof window === 'undefined') return;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, StoredProductionGateRun>;
    for (const [runId, value] of Object.entries(parsed)) {
      if (value?.gateState?.runId) runs.set(runId, value);
    }
  } catch {
    // A malformed local run must not prevent opening the project. The next
    // planned run replaces it with a valid state.
  }
}

function persistRuns(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(runs.entries())));
  } catch {
    // Persistence is best effort; project revisions remain the authoritative
    // recovery mechanism for authored scene state.
  }
}

function diagnosticsFromManifest(raw: unknown) {
  const parsed = parsePrevisProductionManifest(raw);
  const diagnostics: AgentDiagnostic[] = [
    ...parsed.errors.map((item) => agentError(item.code, item.message)),
    ...parsed.warnings.map((item) => agentError(item.code, item.message)),
  ];
  return { parsed, diagnostics };
}

function getRun(runId: string): StoredProductionGateRun | undefined {
  loadRuns();
  return runs.get(runId);
}

export function planAgentProductionCanary(input: {
  manifest: unknown;
  maxShots?: number;
}): AgentProductionCanaryPlanResult {
  const parsedResult = diagnosticsFromManifest(input.manifest);
  if (!parsedResult.parsed.manifest || parsedResult.parsed.errors.length > 0) {
    return { ok: false, diagnostics: parsedResult.diagnostics };
  }
  const project = useProjectStore.getState().project;
  const production = getProductionConfiguration(project);
  const candidates = parsedResult.parsed.manifest.shots.map((shot) => ({
    shotId: shot.id,
    shotNumber: shot.shotNumber,
    capabilities: deriveProductionShotCapabilities({
      shot,
      manifest: parsedResult.parsed.manifest!,
      production,
      project,
    }),
  }));
  const plan = planProductionCanaryEngine({ candidates, maxShots: input.maxShots });
  const runId = createProductionRunId();
  let gateState = createProductionGateState(runId);
  gateState = completeProductionGate(gateState, 'VALIDATE_INPUT', { ok: true });
  gateState = completeProductionGate(gateState, 'VALIDATE_BINDINGS', { ok: true });
  gateState = completeProductionGate(gateState, 'VALIDATE_CAPABILITIES', { ok: true });
  gateState = completeProductionGate(gateState, 'CREATE_RECOVERY_REVISION', { ok: true });
  gateState = completeProductionGate(gateState, 'PLAN_CANARY', {
    ok: plan.complete,
    diagnostics: plan.uncoveredCapabilities.map((capability) => ({
      code: 'canary_capability_uncovered',
      message: `No canary shot covers capability "${capability}".`,
    })),
  });
  gateState = { ...gateState, canaryPlan: plan };
  runs.set(runId, { gateState, manifest: input.manifest });
  persistRuns();
  return {
    ok: plan.complete,
    runId,
    plan,
    diagnostics: [
      ...parsedResult.diagnostics,
      ...plan.uncoveredCapabilities.map((capability) => agentError(
        'canary_capability_uncovered',
        `No canary shot covers capability "${capability}".`,
      )),
    ],
  };
}

export function runAgentProductionCanary(input: {
  runId: string;
  results: ProductionCanaryShotResult[];
}): AgentProductionCanaryRunResult {
  const stored = getRun(input.runId);
  if (!stored) {
    return { ok: false, diagnostics: [agentError('production_run_not_found', `No production run "${input.runId}" exists.`)] };
  }
  const plan = stored.gateState.canaryPlan;
  if (!plan) {
    return { ok: false, runId: input.runId, diagnostics: [agentError('canary_plan_missing', 'Plan the production canary before running it.')] };
  }
  const result = runProductionCanaryEngine(plan, input.results);
  let gateState = stored.gateState;
  for (const gate of ['AUTHOR_CANARY', 'VERIFY_CANARY_STATE', 'RENDER_CANARY', 'VERIFY_CANARY_OUTPUT'] as const) {
    gateState = completeProductionGate(gateState, gate, {
      ok: result.ok,
      diagnostics: result.diagnostics,
    });
  }
  gateState = { ...gateState, canaryResult: result };
  runs.set(input.runId, { ...stored, gateState });
  persistRuns();
  return {
    ok: result.ok,
    runId: input.runId,
    result,
    gateState,
    diagnostics: result.diagnostics.map((item) => agentError(item.code, item.message)),
  };
}

export function approveAgentProductionCanary(input: {
  runId: string;
  overrideReason?: string;
}): AgentProductionCanaryApprovalResult {
  const stored = getRun(input.runId);
  if (!stored) return { ok: false, runId: input.runId, diagnostics: [agentError('production_run_not_found', `No production run "${input.runId}" exists.`)] };
  const result: ProductionCanaryResult | undefined = stored.gateState.canaryResult;
  if (!result) return { ok: false, runId: input.runId, diagnostics: [agentError('canary_result_missing', 'Run the production canary before approving it.')] };
  const gateState = approveProductionCanaryEngine(stored.gateState, result, input.overrideReason);
  runs.set(input.runId, { ...stored, gateState });
  persistRuns();
  const ok = gateState.canaryApproved;
  return {
    ok,
    runId: input.runId,
    gateState,
    diagnostics: ok ? [] : result.diagnostics.map((item) => agentError(item.code, item.message)),
  };
}

export async function approveAgentStillLayout(input: {
  runId: string;
  approvedShotIds: string[];
  reviewArtifactIds?: string[];
  reviewRecord?: string;
}): Promise<AgentStillLayoutApprovalResult> {
  const stored = getRun(input.runId);
  if (!stored) return {
    ok: false,
    status: 'failed',
    runId: input.runId,
    diagnostics: [agentError('production_run_not_found', `No production run "${input.runId}" exists.`)],
  };
  const state = stored.gateState;
  const stillSequenceReady = canAdvanceFullStillRun(state)
    && state.gates.AUTHOR_FULL_STILL_SEQUENCE.status === 'passed'
    && state.gates.VERIFY_FULL_STILL_SEQUENCE.status === 'passed';
  if (!stillSequenceReady) return {
    ok: false,
    status: 'failed',
    runId: input.runId,
    gateState: state,
    diagnostics: [agentError('still_layout_locked', 'The full still sequence must pass verification before approval.')],
  };
  const revisionId = useProjectSafetyStore.getState().activeRevisionId;
  if (!revisionId) return {
    ok: false,
    status: 'failed',
    runId: input.runId,
    gateState: state,
    diagnostics: [agentError('verified_revision_missing', 'Still approval requires an active verified recovery revision.')],
  };
  const project = useProjectStore.getState().project;
  let approval;
  try {
    approval = createApprovedLayoutRevision({
      revisionId,
      project,
      approvedShotIds: input.approvedShotIds,
      reviewArtifactIds: input.reviewArtifactIds,
    });
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      runId: input.runId,
      gateState: state,
      diagnostics: [agentError('still_layout_approval_invalid', error instanceof Error ? error.message : 'Still layout approval is invalid.')],
    };
  }
  const gateState = {
    ...approveStillLayoutEngine(state, {
      runId: input.runId,
      approvedShotIds: input.approvedShotIds,
      reviewRecord: input.reviewRecord,
    }),
    approvedLayoutRevision: approval,
    ...(input.reviewRecord?.trim() ? { stillReviewRecord: input.reviewRecord.trim() } : {}),
  };
  runs.set(input.runId, { ...stored, gateState });
  persistRuns();
  return {
    ok: gateState.stillLayoutApproved,
    status: gateState.stillLayoutApproved ? 'completed' : 'failed',
    runId: input.runId,
    revisionId,
    approvedLayoutRevision: approval,
    gateState,
    diagnostics: [],
  };
}

export async function createAgentMotionWorkingRevision(input: {
  runId: string;
}): Promise<AgentMotionWorkingRevisionResult> {
  const stored = getRun(input.runId);
  if (!stored) return {
    ok: false,
    status: 'failed',
    runId: input.runId,
    diagnostics: [agentError('production_run_not_found', `No production run "${input.runId}" exists.`)],
  };
  const approval = stored.gateState.approvedLayoutRevision;
  if (!stored.gateState.stillLayoutApproved || !approval) return {
    ok: false,
    status: 'failed',
    runId: input.runId,
    gateState: stored.gateState,
    diagnostics: [agentError('motion_layout_missing', 'Approve the still layout before creating a motion working revision.')],
  };
  const project = useProjectStore.getState().project;
  const verification = verifyApprovedLayoutRevision(project, approval);
  if (!verification.ok) return {
    ok: false,
    status: 'stale_revision',
    runId: input.runId,
    sourceRevisionId: approval.revisionId,
    approvedLayoutRevision: approval,
    gateState: stored.gateState,
    diagnostics: verification.errors.map((message) => agentError('still_layout_changed', message)),
  };
  // Run the pure clone guard as part of the adapter before creating the
  // persisted branch. The clone operation never loads the branch as current.
  createMotionWorkingRevision({
    project,
    approval,
    sourceRevisionId: approval.revisionId,
  });
  const cloned = await cloneAgentProjectRevision({
    revisionId: approval.revisionId,
    loadAsCurrent: false,
  });
  if (!cloned.ok || !cloned.revisionId) {
    const gateState = completeProductionGate(stored.gateState, 'CLONE_FOR_MOTION', {
      ok: false,
      diagnostics: [{ code: 'motion_clone_failed', message: 'The approved still revision could not be cloned.', severity: 'error' }],
    });
    runs.set(input.runId, { ...stored, gateState });
    persistRuns();
    return {
      ok: false,
      status: 'failed',
      runId: input.runId,
      sourceRevisionId: approval.revisionId,
      approvedLayoutRevision: approval,
      gateState,
      diagnostics: cloned.diagnostics.length > 0 ? cloned.diagnostics : [agentError('motion_clone_failed', 'The approved still revision could not be cloned.')],
    };
  }
  const gateState = {
    ...completeProductionGate(stored.gateState, 'CLONE_FOR_MOTION', { ok: true }),
    motionWorkingRevisionId: cloned.revisionId,
    motionWorkingProjectId: cloned.projectId,
  };
  runs.set(input.runId, { ...stored, gateState });
  persistRuns();
  return {
    ok: true,
    status: 'completed',
    runId: input.runId,
    sourceRevisionId: approval.revisionId,
    workingRevisionId: cloned.revisionId,
    workingProjectId: cloned.projectId,
    approvedLayoutRevision: approval,
    gateState,
    diagnostics: [],
  };
}

export function inspectAgentStillLayoutApproval(input: { runId?: string }) {
  const inspected = inspectAgentProductionGates(input);
  return {
    ...inspected,
    approvedLayoutRevision: inspected.gateState?.approvedLayoutRevision,
  };
}

/** Internal browser-run adapter for advancing gates after a real compiler or
 * renderer phase has completed. External callers should use the named API
 * operations instead of mutating gate state directly. */
export function updateAgentProductionGateState(
  runId: string,
  updater: (state: ProductionGateState) => ProductionGateState,
): ProductionGateState | undefined {
  const stored = getRun(runId);
  if (!stored) return undefined;
  const gateState = updater(stored.gateState);
  runs.set(runId, { ...stored, gateState });
  persistRuns();
  return gateState;
}

export function inspectAgentProductionGates(input: { runId?: string }) {
  loadRuns();
  const runId = input.runId ?? [...runs.keys()].at(-1);
  const state = runId ? runs.get(runId)?.gateState : undefined;
  return state
    ? { ok: true, runId, gateState: state, diagnostics: [] }
    : { ok: false, runId, diagnostics: [agentError('production_run_not_found', 'No persisted production gate run is available.')] };
}

export function resetAgentProductionGateRunsForTests(): void {
  runs.clear();
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
}
