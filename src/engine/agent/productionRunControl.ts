/** Browser-owned production lifecycle and resumable still-review controller. */

import type { LocationProject } from '../../domain/types';
import { useProjectStore } from '../../state/useProjectStore';
import { applyAgentProductionCompile } from './productionManifestControl';
import { renderWorkCoordinator } from '../renderWorkCoordinator';
import { getAgentRenderShotFrameImpl } from './renderCallbackRegistry';
import { registerAgentArtifact, getAgentArtifactBlob } from './artifactRegistry';
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
import { explainAgentRenderCacheHit, recordAgentRenderCacheEntry } from './renderCacheControl';
import { projectFingerprint } from './planDiff';
import { verifyCompiledShotIntegrity } from './productionIntegrityVerification';
import { buildFullStillMutationExpectation } from '../previs/productionMutationScope';
import {
  setProductionRunAbortController,
  clearProductionRunCancellation,
  markProductionRunCancelled,
  resetProductionRunAbortControllersForTests,
} from './productionRunAbort';
import type {
  AgentProductionRunResult,
  AgentProductionRunState,
  AgentProductionRunStatus,
  AgentRenderShotFrameResult,
} from './protocol';

const STORAGE_KEY = 'forescene.production.runs.v1';
const runs = new Map<string, AgentProductionRunState>();
const listeners = new Map<string, Set<(state: AgentProductionRunState) => void>>();
const runControllers = new Map<string, { generation: number; abort: AbortController }>();

class StaleProductionRunError extends Error {
  constructor(message = 'Production run is no longer active.') {
    super(message);
    this.name = 'StaleProductionRunError';
  }
}

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

function beginRunGeneration(runId: string): number {
  const current = runControllers.get(runId);
  current?.abort.abort();
  clearProductionRunCancellation(runId);
  const generation = (current?.generation ?? 0) + 1;
  const abort = new AbortController();
  runControllers.set(runId, { generation, abort });
  setProductionRunAbortController(runId, abort);
  return generation;
}

function assertRunStillActive(runId: string, generation: number, signal?: AbortSignal): void {
  const controller = runControllers.get(runId);
  if (!controller || controller.generation !== generation) throw new StaleProductionRunError();
  if (signal?.aborted) {
    renderWorkCoordinator.cancelAll();
    throw new StaleProductionRunError();
  }
  const state = runs.get(runId);
  if (!state || state.status === 'cancelled') {
    renderWorkCoordinator.cancelAll();
    throw new StaleProductionRunError();
  }
}

function assertRunProjectContext(state: AgentProductionRunState): AgentDiagnostic[] {
  const project = useProjectStore.getState().project;
  const diagnostics: AgentDiagnostic[] = [];
  if (state.projectId && project.id !== state.projectId) {
    diagnostics.push(agentError(
      'production_run_project_mismatch',
      `Production run belongs to project "${state.projectId}" but the active project is "${project.id}".`,
    ));
  }
  if (state.manifestHash) {
    const currentHash = hashPrevisManifest(state.manifest);
    if (currentHash !== state.manifestHash) {
      diagnostics.push(agentError(
        'production_run_manifest_mismatch',
        'The production manifest changed since this run was created.',
      ));
    }
  }
  return diagnostics;
}

function save(state: AgentProductionRunState, generation?: number): AgentProductionRunState {
  const next = {
    ...state,
    ...(generation !== undefined ? { runGeneration: generation } : {}),
    updatedAt: new Date().toISOString(),
  };
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

function verifiedCacheHit(
  project: LocationProject,
  shot: LocationProject['shots'][number],
  fingerprintKey: string,
  sourceRevisionId?: string,
): { hit: boolean; artifactId?: string; reasons: string[] } {
  const fingerprint = computeRenderFingerprint({
    project,
    shot,
    profile: RAPID_REVIEW_PROFILE,
    rendererVersion: 'forescene-browser-production-v1',
  });
  if (fingerprint.key !== fingerprintKey) {
    return { hit: false, reasons: ['fingerprint_mismatch'] };
  }
  const decision = explainAgentRenderCacheHit({ projectId: project.id, fingerprint });
  if (!decision.hit || !decision.entry?.artifactId) {
    return { hit: false, reasons: decision.reasons };
  }
  const blob = getAgentArtifactBlob(decision.entry.artifactId);
  if (!blob || blob.size < 32) {
    return { hit: false, reasons: ['artifact_bytes_missing'] };
  }
  if (sourceRevisionId && decision.entry.sourceRevisionId && decision.entry.sourceRevisionId !== sourceRevisionId) {
    return { hit: false, reasons: ['source_revision_invalid'] };
  }
  return { hit: true, artifactId: decision.entry.artifactId, reasons: decision.reasons };
}

async function runFullStillSequence(state: AgentProductionRunState): Promise<AgentProductionRunResult> {
  const generation = beginRunGeneration(state.runId);
  const controller = runControllers.get(state.runId);
  const signal = controller?.abort.signal;
  const contextErrors = assertRunProjectContext(state);
  if (contextErrors.length > 0) {
    return diagnosticsResult(save({ ...state, status: 'failed', blockingDiagnostics: contextErrors }), contextErrors);
  }

  let current = save({ ...state, status: 'running', runGeneration: generation });
  try {
    updateAgentProductionGateState(current.gateRunId, (gateState) => startProductionGate(gateState, 'AUTHOR_FULL_STILL_SEQUENCE'));
    assertRunStillActive(current.runId, generation, signal);
    const beforeProject = structuredClone(useProjectStore.getState().project);
    const compiled = await applyAgentProductionCompile({ manifest: current.manifest, preserveCurrentAsRecovery: true });
    assertRunStillActive(current.runId, generation, signal);
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
    current = save({ ...current, gateState: afterCompile, currentGate: afterCompile.currentGate, recoveryRevisionId: compiled.revisionId ?? current.recoveryRevisionId });
    const parsed = parsePrevisProductionManifest(current.manifest);
    const project = useProjectStore.getState().project;
    const mutationExpectation = parsed.manifest
      ? buildFullStillMutationExpectation(beforeProject, parsed.manifest)
      : undefined;
    if (!parsed.manifest) {
      const diagnostics = [agentError('production_manifest_invalid', 'Production manifest disappeared before still rendering.')];
      const gateState = updateAgentProductionGateState(current.gateRunId, (gate) => completeProductionGate(gate, 'VERIFY_FULL_STILL_SEQUENCE', { ok: false, diagnostics })) ?? current.gateState;
      current = save({ ...current, status: 'failed', gateState, currentGate: gateState.currentGate, blockingDiagnostics: diagnostics });
      return diagnosticsResult(current, diagnostics);
    }

    const render = getAgentRenderShotFrameImpl();
    const failures: AgentDiagnostic[] = [];
    for (const definition of parsed.manifest.shots) {
      assertRunStillActive(current.runId, generation, signal);
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
      if (current.completedShotIds.includes(shot.id) && current.cacheKeys[shot.id] === fingerprint.key) {
        const cache = verifiedCacheHit(project, shot, fingerprint.key, current.recoveryRevisionId);
        if (cache.hit) {
          if (cache.artifactId && !current.artifactIds.includes(cache.artifactId)) {
            current = save({
              ...current,
              artifactIds: [...new Set([...current.artifactIds, cache.artifactId])],
            });
          }
          continue;
        }
      }

      let result: AgentRenderShotFrameResult;
      try {
        result = await render({
          shotId: shot.id,
          appearance: 'clay',
          peopleVariant: 'with_people',
          content: 'full_scene',
          timeSeconds: 0,
          width: RAPID_REVIEW_PROFILE.width,
          height: RAPID_REVIEW_PROFILE.height,
        });
      } catch (error) {
        if (signal?.aborted) {
          renderWorkCoordinator.cancelByOwner(shot.id);
          throw error;
        }
        failures.push(agentError('production_still_render_failed', error instanceof Error ? error.message : 'Still render failed.'));
        continue;
      }
      if (signal?.aborted) {
        renderWorkCoordinator.cancelByOwner(shot.id);
        throw new StaleProductionRunError();
      }
      assertRunStillActive(current.runId, generation, signal);
      if (!result.ok) {
        failures.push(...result.diagnostics);
        continue;
      }
      const artifactId = await persistInlineArtifact(result, current.runId, shot.id);
      const frameBytes = result.artifact?.kind === 'inline' && result.artifact.dataUrl
        ? (await fetch(result.artifact.dataUrl).then((response) => response.blob())).size
        : undefined;
      const verification = await verifyCompiledShotIntegrity({
        project,
        shot,
        definition,
        manifest: parsed.manifest,
        integrityMode: 'gated_production',
        beforeProject,
        mutationExpectation,
        frameExists: Boolean(artifactId || result.artifact),
        frameByteSize: frameBytes,
        fromCanonicalRenderer: true,
      });
      if (!verification.ok) {
        failures.push(...verification.diagnostics.map((item) => agentError(item.code, item.message)));
        continue;
      }
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
    }

    assertRunStillActive(current.runId, generation, signal);
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
  } catch (error) {
    if (error instanceof StaleProductionRunError) {
      const latest = getStored(state.runId) ?? state;
      return diagnosticsResult(latest, []);
    }
    throw error;
  }
}

export async function runAgentProduction(input: {
  manifest: unknown;
  maxCanaryShots?: number;
}): Promise<AgentProductionRunResult> {
  const parsed = parsePrevisProductionManifest(input.manifest);
  const project = useProjectStore.getState().project;
  if (!parsed.manifest || parsed.errors.length > 0) {
    const runId = `production_invalid_${Date.now().toString(36)}`;
    const diagnostics = parsed.errors.map((item) => agentError(item.code, item.message));
    const empty = await planAgentProductionCanary({ manifest: input.manifest, maxShots: input.maxCanaryShots });
    const gateState = inspectAgentProductionGates({ runId: empty.runId }).gateState;
    if (!gateState || !empty.runId) return { ok: false, status: 'failed', runId, diagnostics };
    const state: AgentProductionRunState = {
      runId,
      gateRunId: empty.runId,
      status: 'failed',
      currentGate: gateState.currentGate,
      manifest: input.manifest,
      projectId: project.id,
      sourceProjectFingerprint: projectFingerprint(project),
      manifestHash: hashPrevisManifest(input.manifest),
      gateState,
      completedShotIds: [],
      artifactIds: [],
      cacheKeys: {},
      blockingDiagnostics: diagnostics,
      overrideApprovals: [],
      runGeneration: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    save(state);
    return diagnosticsResult(state, diagnostics);
  }
  const planned = await planAgentProductionCanary({ manifest: input.manifest, maxShots: input.maxCanaryShots });
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
    projectId: project.id,
    sourceProjectFingerprint: projectFingerprint(project),
    recoveryRevisionId: gateState.recoveryRevisionId,
    gateState,
    completedShotIds: [],
    artifactIds: [],
    cacheKeys: {},
    blockingDiagnostics: planned.diagnostics,
    overrideApprovals: [],
    runGeneration: gateState.runGeneration ?? 0,
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
  const controller = runControllers.get(runId);
  controller?.abort.abort();
  return diagnosticsResult(save({ ...state, status: 'paused' }), []);
}

export async function resumeAgentProductionRun(runId: string): Promise<AgentProductionRunResult> {
  const state = getAgentProductionRun(runId);
  if (!state) return { ok: false, status: 'failed', runId, diagnostics: [agentError('production_run_not_found', `No production run "${runId}" exists.`)] };
  if (state.status === 'cancelled' || state.status === 'completed') return diagnosticsResult(state, [agentError('production_run_terminal', 'A terminal production run cannot be resumed.')]);
  if (state.status === 'paused') {
    // Allow resume from paused state.
  }
  const contextErrors = assertRunProjectContext(state);
  if (contextErrors.length > 0) return diagnosticsResult(state, contextErrors);
  if (!state.gateState.canaryApproved) {
    return diagnosticsResult(save({ ...state, status: 'needs_review' }), [agentError('canary_approval_required', 'Approve the capability canary before resuming the full still sequence.')]);
  }
  if (state.gateState.stillLayoutApproved) return diagnosticsResult(state, []);
  return runFullStillSequence(state);
}

export function cancelAgentProductionRun(runId: string): AgentProductionRunResult {
  const state = getAgentProductionRun(runId);
  if (!state) return { ok: false, status: 'failed', runId, diagnostics: [agentError('production_run_not_found', `No production run "${runId}" exists.`)] };
  markProductionRunCancelled(runId);
  renderWorkCoordinator.cancelAll();
  const controller = runControllers.get(runId);
  const generation = (controller?.generation ?? 0) + 1;
  if (controller) {
    runControllers.set(runId, { generation, abort: controller.abort });
  }
  return diagnosticsResult(save({ ...state, status: 'cancelled', runGeneration: generation }), []);
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
  runControllers.clear();
  resetProductionRunAbortControllersForTests();
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
}

export { StaleProductionRunError };
