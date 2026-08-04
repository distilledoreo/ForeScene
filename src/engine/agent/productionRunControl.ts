/** Browser-owned production lifecycle and resumable still-review controller. */

import type { LocationProject } from '../../domain/types';
import { useProjectStore } from '../../state/useProjectStore';
import { applyAgentProductionCompile } from './productionManifestControl';
import { getAgentRenderShotFrameImpl } from './renderCallbackRegistry';
import { registerAgentArtifact } from './artifactRegistry';
import { agentError, type AgentDiagnostic } from './diagnostics';
import {
  inspectAgentProductionGates,
  planAgentProductionCanary,
  updateAgentProductionGateState,
} from './productionGateControl';
import { completeProductionGate, startProductionGate } from '../previs/productionGates';
import { hashPrevisManifest } from '../previs/manifestHash';
import { parsePrevisProductionManifest } from '../previs/manifestValidation';
import { computeRenderFingerprint } from '../previs/renderCache';
import { RAPID_REVIEW_PROFILE } from '../previs/renderProfiles';
import { recordAgentRenderCacheEntry } from './renderCacheControl';
import type {
  AgentProductionRunResult,
  AgentProductionRunState,
  AgentProductionRunStatus,
  AgentRenderShotFrameResult,
} from './protocol';

const STORAGE_KEY = 'forescene.production.runs.v1';
const runs = new Map<string, AgentProductionRunState>();
const listeners = new Map<string, Set<(state: AgentProductionRunState) => void>>();

function loadRuns(): void {
  if (runs.size > 0 || typeof window === 'undefined') return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, AgentProductionRunState>;
    for (const [runId, state] of Object.entries(stored)) {
      if (state?.runId && state.gateRunId) runs.set(runId, state);
    }
  } catch {
    // A corrupt lifecycle record must not prevent project recovery.
  }
}

function persistRuns(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(runs.entries())));
  } catch {
    // Verified project revisions remain authoritative when localStorage is full.
  }
}

function cloneState(state: AgentProductionRunState): AgentProductionRunState {
  return structuredClone(state);
}

function notify(state: AgentProductionRunState): void {
  const snapshot = cloneState(state);
  for (const listener of listeners.get(state.runId) ?? []) listener(snapshot);
}

function save(state: AgentProductionRunState): AgentProductionRunState {
  const next = { ...state, updatedAt: new Date().toISOString() };
  runs.set(next.runId, next);
  persistRuns();
  notify(next);
  return next;
}

function diagnosticsResult(
  state: AgentProductionRunState,
  diagnostics: AgentDiagnostic[],
): AgentProductionRunResult {
  return { ok: diagnostics.length === 0 && state.status !== 'failed' && state.status !== 'cancelled', status: state.status, runId: state.runId, state: cloneState(state), diagnostics };
}

function getStored(runId: string): AgentProductionRunState | undefined {
  loadRuns();
  return runs.get(runId);
}

function syncGateState(state: AgentProductionRunState): AgentProductionRunState {
  const inspected = inspectAgentProductionGates({ runId: state.gateRunId });
  if (!inspected.gateState) return state;
  const gateState = inspected.gateState;
  let status: AgentProductionRunStatus = state.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    if (gateState.canaryResult && !gateState.canaryApproved) status = 'needs_review';
    else if (gateState.canaryApproved && !gateState.stillLayoutApproved && gateState.currentGate === 'WAIT_FOR_STILL_APPROVAL') status = 'needs_review';
  }
  const next = {
    ...state,
    status,
    currentGate: gateState.currentGate,
    gateState,
    ...(gateState.overrideReason ? { overrideApprovals: [...new Set([...state.overrideApprovals, gateState.overrideReason])] } : {}),
  };
  runs.set(state.runId, next);
  persistRuns();
  return next;
}

function findCompiledShot(project: LocationProject, definition: { id: string; shotNumber: string }) {
  return project.shots.find((shot) => shot.productionShotId === definition.id)
    ?? project.shots.find((shot) => shot.shotNumber === definition.shotNumber);
}

async function persistInlineArtifact(
  result: AgentRenderShotFrameResult,
  runId: string,
  shotId: string,
): Promise<string | undefined> {
  if (!result.artifact || result.artifact.kind !== 'inline' || !result.artifact.dataUrl) return undefined;
  const blob = await fetch(result.artifact.dataUrl).then((response) => response.blob());
  const handle = registerAgentArtifact({
    blob,
    mimeType: result.artifact.mimeType,
    fileName: `production-${runId}-${shotId}.png`,
    revisionId: result.revisionId,
    shotId,
  });
  return handle.artifactId;
}

async function runFullStillSequence(state: AgentProductionRunState): Promise<AgentProductionRunResult> {
  let current = save({ ...state, status: 'running' });
  updateAgentProductionGateState(current.gateRunId, (gateState) => startProductionGate(gateState, 'AUTHOR_FULL_STILL_SEQUENCE'));
  const compiled = await applyAgentProductionCompile({ manifest: current.manifest, preserveCurrentAsRecovery: true });
  if (!compiled.ok) {
    const gateState = updateAgentProductionGateState(current.gateRunId, (gate) => completeProductionGate(gate, 'AUTHOR_FULL_STILL_SEQUENCE', {
      ok: false,
      diagnostics: compiled.diagnostics.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
    })) ?? current.gateState;
    current = save({ ...current, status: 'failed', gateState, currentGate: gateState.currentGate, blockingDiagnostics: compiled.diagnostics });
    return diagnosticsResult(current, compiled.diagnostics);
  }

  const afterCompile = updateAgentProductionGateState(current.gateRunId, (gate) => completeProductionGate(gate, 'AUTHOR_FULL_STILL_SEQUENCE', { ok: true }))
    ?? current.gateState;
  current = save({ ...current, gateState: afterCompile, currentGate: afterCompile.currentGate });
  const parsed = parsePrevisProductionManifest(current.manifest);
  const project = useProjectStore.getState().project;
  if (!parsed.manifest) {
    const diagnostics = [agentError('production_manifest_invalid', 'Production manifest disappeared before still rendering.')];
    const gateState = updateAgentProductionGateState(current.gateRunId, (gate) => completeProductionGate(gate, 'VERIFY_FULL_STILL_SEQUENCE', { ok: false, diagnostics })) ?? current.gateState;
    current = save({ ...current, status: 'failed', gateState, currentGate: gateState.currentGate, blockingDiagnostics: diagnostics });
    return diagnosticsResult(current, diagnostics);
  }

  const render = getAgentRenderShotFrameImpl();
  const failures: AgentDiagnostic[] = [];
  for (const definition of parsed.manifest.shots) {
    const shot = findCompiledShot(project, definition);
    if (!shot) {
      failures.push(agentError('compiled_shot_missing', `Compiled shot "${definition.shotNumber}" is missing.`));
      continue;
    }
    const fingerprint = computeRenderFingerprint({
      project,
      shot,
      profile: RAPID_REVIEW_PROFILE,
      rendererVersion: 'forescene-browser-production-v1',
      locationId: definition.locationId,
    });
    if (current.completedShotIds.includes(shot.id) && current.cacheKeys[shot.id] === fingerprint.key) continue;
    try {
      const result = await render({
        shotId: shot.id,
        appearance: 'clay',
        peopleVariant: 'with_people',
        content: 'full_scene',
        timeSeconds: 0,
      });
      if (!result.ok) {
        failures.push(...result.diagnostics);
        continue;
      }
      const artifactId = await persistInlineArtifact(result, current.runId, shot.id);
      recordAgentRenderCacheEntry({
        projectId: project.id,
        fingerprint,
        artifactId,
        sourceRevisionId: result.revisionId,
      });
      current = save({
        ...current,
        completedShotIds: [...new Set([...current.completedShotIds, shot.id])],
        cacheKeys: { ...current.cacheKeys, [shot.id]: fingerprint.key },
        artifactIds: artifactId ? [...new Set([...current.artifactIds, artifactId])] : current.artifactIds,
      });
    } catch (error) {
      failures.push(agentError('production_still_render_failed', error instanceof Error ? error.message : 'Still render failed.'));
    }
  }

  const gateState = updateAgentProductionGateState(current.gateRunId, (gate) => completeProductionGate(gate, 'VERIFY_FULL_STILL_SEQUENCE', {
    ok: failures.length === 0,
    diagnostics: failures.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
  })) ?? current.gateState;
  current = save({
    ...current,
    status: failures.length === 0 ? 'needs_review' : 'failed',
    gateState,
    currentGate: gateState.currentGate,
    blockingDiagnostics: failures,
  });
  return diagnosticsResult(current, failures);
}

export async function runAgentProduction(input: {
  manifest: unknown;
  maxCanaryShots?: number;
}): Promise<AgentProductionRunResult> {
  const parsed = parsePrevisProductionManifest(input.manifest);
  if (!parsed.manifest || parsed.errors.length > 0) {
    const runId = `production_invalid_${Date.now().toString(36)}`;
    const diagnostics = parsed.errors.map((item) => agentError(item.code, item.message));
    const empty = planAgentProductionCanary({ manifest: input.manifest, maxShots: input.maxCanaryShots });
    const gateState = inspectAgentProductionGates({ runId: empty.runId }).gateState;
    if (!gateState || !empty.runId) return { ok: false, status: 'failed', runId, diagnostics };
    const state: AgentProductionRunState = {
      runId,
      gateRunId: empty.runId,
      status: 'failed',
      currentGate: gateState.currentGate,
      manifest: input.manifest,
      gateState,
      completedShotIds: [],
      artifactIds: [],
      cacheKeys: {},
      blockingDiagnostics: diagnostics,
      overrideApprovals: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    save(state);
    return diagnosticsResult(state, diagnostics);
  }
  const planned = planAgentProductionCanary({ manifest: input.manifest, maxShots: input.maxCanaryShots });
  if (!planned.runId || !planned.plan) {
    return { ok: false, status: 'failed', runId: `production_plan_failed_${Date.now().toString(36)}`, diagnostics: planned.diagnostics };
  }
  const gateState = inspectAgentProductionGates({ runId: planned.runId }).gateState;
  if (!gateState) return { ok: false, status: 'failed', runId: planned.runId, diagnostics: [agentError('production_gate_state_missing', 'Production gate state was not persisted.')] };
  const state: AgentProductionRunState = {
    runId: planned.runId,
    gateRunId: planned.runId,
    status: planned.ok ? 'queued' : 'failed',
    currentGate: gateState.currentGate,
    manifest: input.manifest,
    manifestHash: hashPrevisManifest(input.manifest),
    gateState,
    completedShotIds: [],
    artifactIds: [],
    cacheKeys: {},
    blockingDiagnostics: planned.diagnostics,
    overrideApprovals: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  save(state);
  return diagnosticsResult(state, planned.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'));
}

export function getAgentProductionRun(runId: string): AgentProductionRunState | undefined {
  const stored = getStored(runId);
  return stored ? cloneState(syncGateState(stored)) : undefined;
}

export function listAgentProductionRuns(): AgentProductionRunState[] {
  loadRuns();
  return [...runs.values()].map((state) => cloneState(syncGateState(state))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function pauseAgentProductionRun(runId: string): AgentProductionRunResult {
  const state = getAgentProductionRun(runId);
  if (!state) return { ok: false, status: 'failed', runId, diagnostics: [agentError('production_run_not_found', `No production run "${runId}" exists.`)] };
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') return diagnosticsResult(state, [agentError('production_run_not_paused', 'A terminal production run cannot be paused.')]);
  return diagnosticsResult(save({ ...state, status: 'paused' }), []);
}

export async function resumeAgentProductionRun(runId: string): Promise<AgentProductionRunResult> {
  const state = getAgentProductionRun(runId);
  if (!state) return { ok: false, status: 'failed', runId, diagnostics: [agentError('production_run_not_found', `No production run "${runId}" exists.`)] };
  if (state.status === 'cancelled' || state.status === 'completed') return diagnosticsResult(state, [agentError('production_run_terminal', 'A terminal production run cannot be resumed.')]);
  if (!state.gateState.canaryApproved) {
    return diagnosticsResult(save({ ...state, status: 'needs_review' }), [agentError('canary_approval_required', 'Approve the capability canary before resuming the full still sequence.')]);
  }
  if (state.gateState.stillLayoutApproved) return diagnosticsResult(state, []);
  return runFullStillSequence(state);
}

export function cancelAgentProductionRun(runId: string): AgentProductionRunResult {
  const state = getAgentProductionRun(runId);
  if (!state) return { ok: false, status: 'failed', runId, diagnostics: [agentError('production_run_not_found', `No production run "${runId}" exists.`)] };
  return diagnosticsResult(save({ ...state, status: 'cancelled' }), []);
}

export function subscribeAgentProductionRun(runId: string, listener: (state: AgentProductionRunState) => void): () => void {
  const set = listeners.get(runId) ?? new Set<(state: AgentProductionRunState) => void>();
  set.add(listener);
  listeners.set(runId, set);
  const current = getAgentProductionRun(runId);
  if (current) listener(current);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(runId);
  };
}

export function resetAgentProductionRunsForTests(): void {
  runs.clear();
  listeners.clear();
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
}
