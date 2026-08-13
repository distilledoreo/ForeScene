import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject, createShot } from '../src/domain/defaults';
import { touchProject } from '../src/state/slices/touchProject';
import { createForeSceneBrowserApi } from '../src/engine/agent/browserApi';
import { resetCacheTelemetryForTests } from '../src/engine/agent/cacheTelemetry';
import {
  cancelAgentJob,
  pauseAgentJob,
  resetAgentJobsForTests,
  resumeAgentJob,
  submitAgentJob,
  waitForAgentJob,
} from '../src/engine/agent/jobQueue';
import { resetAgentPackageExportControl } from '../src/engine/agent/packageExportControl';
import { withRevisionRetry } from '../src/engine/agent/revisionSync';
import {
  beginAgentRunSession,
  composeAgentValidationEvidence,
  resetAgentRunProvenanceContextForTests,
  resolveValidationRevisionBinding,
} from '../src/engine/agent/runProvenance';
import {
  resetAgentRenderShotFrameImplForTests,
  setAgentRenderShotFrameImpl,
} from '../src/engine/agent/renderCallbackRegistry';
import { buildInlineArtifact } from '../src/engine/agent/renderResult';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { createCliInvocationIdentity } from '../scripts/agent/cliIdentity';
import type { AgentVisualPreflightResult } from '../src/engine/agent/protocol';

function pngResult(shotId: string) {
  return {
    ok: true as const,
    status: 'completed' as const,
    shotId,
    revisionId: 'rev_test',
    width: 8,
    height: 8,
    artifact: buildInlineArtifact({
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    }),
    pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    diagnostics: [],
  };
}

describe('run provenance session telemetry', () => {
  beforeEach(() => {
    resetAgentRunProvenanceContextForTests();
    resetCacheTelemetryForTests();
    resetAgentJobsForTests();
    resetAgentPackageExportControl();
    useAgentControlStore.setState({ controlMode: 'read-write' });
    useProjectStore.setState({
      project: createDefaultProject(),
      workspace: 'shots',
      selectedObjectIds: [],
      isRenderingGraybox: false,
      isExportingPackage: false,
    });
    useProjectSafetyStore.setState({ criticalWrite: false, status: 'saved', activeRevisionId: 'rev_test' });
  });

  afterEach(() => {
    resetAgentRenderShotFrameImplForTests();
    resetAgentJobsForTests();
    resetAgentRunProvenanceContextForTests();
    resetCacheTelemetryForTests();
    useAgentControlStore.setState({ controlMode: 'read-only' });
  });

  it('records retries from withRevisionRetry and resumes, not from the first attempt', async () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_retry', command: 'verify', harness: 'test' });
    expect(api.getStatus().provenance?.retries).toBe(0);

    let attempts = 0;
    const result = await withRevisionRetry(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          diagnostics: [{ code: 'stale_revision', message: 'stale', severity: 'error' as const }],
        };
      }
      return { ok: true, diagnostics: [] };
    }, { refreshOnStale: false });

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(api.getStatus().provenance?.retries).toBe(1);
    expect(api.getStatus().provenance?.cancelled).toBe(false);
  });

  it('records cancellation from a real job cancel and resets on a new runId', async () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_cancel', command: 'package' });
    setAgentRenderShotFrameImpl(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return pngResult(input.shotId);
    });

    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_a' }, { shotId: 'shot_b' }],
      concurrency: 1,
    });
    expect(submitted.ok).toBe(true);
    const cancelled = cancelAgentJob(submitted.jobId!);
    expect(cancelled.ok).toBe(true);
    expect(api.getStatus().provenance?.cancelled).toBe(true);
    expect(api.getStatus().provenance?.cli?.runId).toBe('run_cancel');

    beginAgentRunSession({ runId: 'run_next', command: 'inspect' });
    expect(api.getStatus().provenance?.cancelled).toBe(false);
    expect(api.getStatus().provenance?.retries).toBe(0);
    expect(api.getStatus().provenance?.cli?.runId).toBe('run_next');
  });

  it('does not mark cancelled when cancel is a no-op on a completed job', async () => {
    const api = createForeSceneBrowserApi();
    setAgentRenderShotFrameImpl(async (input) => pngResult(input.shotId));
    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_done' }],
    });
    const progress = await waitForAgentJob(submitted.jobId!);
    expect(progress.status).toBe('completed');

    beginAgentRunSession({ runId: 'run_terminal_cancel', command: 'inspect' });
    expect(api.getStatus().provenance?.cancelled).toBe(false);
    const cancelled = cancelAgentJob(submitted.jobId!);
    expect(cancelled.ok).toBe(false);
    expect(cancelled.status).toBe('completed');
    expect(cancelled.diagnostics[0]?.code).toBe('job_already_terminal');
    expect(api.getStatus().provenance?.cancelled).toBe(false);
  });

  it('does not mark cancelled when an idle package export cancel is a no-op', () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_idle' });
    const result = api.cancelPackageExport();
    expect(result.ok).toBe(false);
    expect(api.getStatus().provenance?.cancelled).toBe(false);
  });

  it('records a retry when a paused job is actually resumed', async () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_resume' });
    setAgentRenderShotFrameImpl(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return pngResult(input.shotId);
    });
    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: [{ shotId: 'shot_a' }, { shotId: 'shot_b' }],
      concurrency: 1,
    });
    pauseAgentJob(submitted.jobId!);
    const resumed = await resumeAgentJob(submitted.jobId!);
    expect(resumed.ok).toBe(true);
    expect(api.getStatus().provenance?.retries).toBe(1);
    await waitForAgentJob(submitted.jobId!);
  });

  it('attaches passing and failing revision-bound validation summaries without re-running work', () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_validation', command: 'verify' });

    const passingPreflight: AgentVisualPreflightResult = {
      ok: true,
      shotId: 'shot_ok',
      score: 92,
      checks: [],
      subjects: [],
      diagnostics: [],
      environmentOnly: true,
    };
    const passing = api.recordRunValidation({
      source: 'verify',
      revisionId: 'rev_test',
      visualPreflight: [passingPreflight],
      assetPose: { revisionId: 'rev_test', objects: [], shots: [] },
      projectHealth: {
        ok: true,
        projectId: 'p1',
        checkedAt: new Date().toISOString(),
        issues: [],
        diagnostics: [],
      },
    });
    expect(passing.ok).toBe(true);
    expect(passing.revisionId).toBe('rev_test');
    expect(passing.revisionBinding).toBe('current');
    expect(passing.current).toBe(true);
    expect(passing.historical).toBeUndefined();
    expect(passing.gates.visualPreflight).toBe('passed');
    expect(passing.gates.revisionBound).toBe('passed');
    expect(api.getStatus().provenance?.validation?.ok).toBe(true);
    expect(api.getStatus().provenance?.validation?.current).toBe(true);
    expect(api.getStatus().provenance?.validation?.visualPreflight?.scores[0]?.environmentOnly).toBe(true);

    const failing = composeAgentValidationEvidence({
      source: 'verify',
      revisionId: 'rev_fail',
      visualPreflight: [{
        ok: false,
        shotId: 'shot_bad',
        score: 40,
        checks: [{ id: 'subject_visibility', status: 'failed', message: 'missing' }],
        subjects: [],
        diagnostics: [],
      }],
      projectHealth: {
        ok: false,
        projectId: 'p1',
        checkedAt: new Date().toISOString(),
        issues: [{ code: 'missing_binary', severity: 'danger', message: 'gone' }],
        diagnostics: [],
      },
    });
    expect(failing.ok).toBe(false);
    expect(failing.revisionId).toBe('rev_fail');
    expect(failing.activeRevisionId).toBe('rev_test');
    expect(failing.revisionBinding).toBe('stale');
    expect(failing.current).toBe(false);
    expect(failing.historical).toBe(true);
    expect(failing.gates.revisionBound).toBe('failed');
    expect(failing.gates.visualPreflight).toBe('failed');
    expect(failing.gates.projectHealth).toBe('failed');
    expect(failing.visualPreflight?.failedShotIds).toEqual(['shot_bad']);
  });

  it('records matching, mismatching, and absent revision ids with an explicit binding', () => {
    const matching = resolveValidationRevisionBinding({
      evidenceRevisionId: 'rev_test',
      activeRevisionId: 'rev_test',
    });
    expect(matching).toMatchObject({
      revisionBinding: 'current',
      current: true,
      revisionBound: 'passed',
      revisionId: 'rev_test',
    });

    const mismatching = composeAgentValidationEvidence({
      source: 'manual',
      revisionId: 'rev_other',
      visualPreflight: [{
        ok: true,
        shotId: 'shot_ok',
        score: 100,
        checks: [],
        subjects: [],
        diagnostics: [],
      }],
    });
    expect(mismatching.ok).toBe(false);
    expect(mismatching.current).toBe(false);
    expect(mismatching.historical).toBe(true);
    expect(mismatching.revisionBinding).toBe('stale');
    expect(mismatching.gates.revisionBound).toBe('failed');
    expect(mismatching.gates.visualPreflight).toBe('passed');

    useProjectSafetyStore.setState({ activeRevisionId: undefined });
    const absent = composeAgentValidationEvidence({
      source: 'manual',
      visualPreflight: [{
        ok: true,
        shotId: 'shot_ok',
        score: 100,
        checks: [],
        subjects: [],
        diagnostics: [],
      }],
    });
    expect(absent.revisionBinding).toBe('unbound');
    expect(absent.current).toBe(false);
    expect(absent.historical).toBeUndefined();
    expect(absent.gates.revisionBound).toBe('skipped');
    expect(absent.ok).toBe(true);
  });

  it('cannot report a passed visual gate when a mixed human/prop shot leaves the prop unresolved', () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_visual_gate', command: 'verify' });

    const floor = createSceneObject('floor', 1);
    floor.dimensions = [20, 0.1, 20];
    const actor = createSceneObject('human_dummy', 1, [0, 0.875, 0]);
    actor.name = 'On-camera actor';
    const prop = createSceneObject('imported_model', 1, [1.4, 0.5, 0]);
    prop.name = 'Imported monster';
    prop.category = 'architecture';
    const shot = createShot({
      index: 1,
      camera: {
        position: [0, 1.6, 6],
        target: [0, 1.4, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    const project = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor, actor, prop] },
      shots: [shot],
    });
    useProjectStore.getState().setProject(project);

    const mixed = api.inspectShotVisualPreflight({ shotId: shot.id });
    expect(mixed.ok).toBe(false);
    expect(mixed.gateStatus).toBe('failed');
    expect(mixed.unresolvedVisibleObjectIds).toContain(prop.id);
    expect(mixed.subjects.some((subject) => subject.objectId === actor.id)).toBe(true);

    const recorded = api.recordRunValidation({
      source: 'verify',
      revisionId: 'rev_test',
      visualPreflight: [mixed],
    });
    expect(recorded.ok).toBe(false);
    expect(recorded.gates.visualPreflight).toBe('failed');
    expect(recorded.visualPreflight?.failedShotIds).toContain(shot.id);
    expect(recorded.visualPreflight?.unresolvedVisibleObjectIds).toContain(prop.id);
    expect(recorded.visualPreflight?.unresolvedVisibleCount).toBeGreaterThan(0);
    expect(recorded.visualPreflight?.scores[0]?.ok).toBe(false);
    expect(recorded.visualPreflight?.scores[0]?.gateStatus).toBe('failed');
    expect(api.getStatus().provenance?.validation?.ok).toBe(false);
    expect(api.getStatus().provenance?.validation?.gates.visualPreflight).toBe('failed');

    const emptySet = createShot({
      index: 2,
      camera: {
        position: [0, 1.6, 8],
        target: [0, 1.4, 0],
        fovDegrees: 50,
        aspectRatio: 16 / 9,
        near: 0.1,
        far: 100,
      },
    });
    const emptyProject = touchProject({
      ...createDefaultProject(),
      scene: { ...createDefaultProject().scene, objects: [floor] },
      shots: [emptySet],
    });
    useProjectStore.getState().setProject(emptyProject);
    const unmarked = api.inspectShotVisualPreflight({ shotId: emptySet.id });
    expect(unmarked.ok).toBe(false);
    expect(unmarked.gateStatus).toBe('warning');
    const emptyEvidence = composeAgentValidationEvidence({
      source: 'visual-preflight',
      revisionId: 'rev_test',
      visualPreflight: [unmarked],
    });
    expect(emptyEvidence.ok).toBe(false);
    expect(emptyEvidence.gates.visualPreflight).toBe('warning');
    expect(emptyEvidence.visualPreflight?.warningShotIds).toContain(emptySet.id);

    useProjectStore.getState().setProject(project);
    const requested = api.inspectShotVisualPreflight({
      shotId: shot.id,
      subjectIds: [actor.id, prop.id],
    });
    expect(requested.unresolvedVisibleObjectIds ?? []).not.toContain(prop.id);
    expect(requested.candidateSubjectIds).toContain(prop.id);

    const optedIn = api.inspectShotVisualPreflight({
      shotId: shot.id,
      allowUnresolvedSetDressing: true,
    });
    expect(optedIn.ok).toBe(false);
    expect(optedIn.gateStatus).toBe('warning');
    expect(optedIn.allowUnresolvedSetDressing).toBe(true);
    expect(optedIn.unresolvedVisibleObjectIds).toContain(prop.id);
    const warningEvidence = composeAgentValidationEvidence({
      source: 'visual-preflight',
      revisionId: 'rev_test',
      visualPreflight: [optedIn],
    });
    expect(warningEvidence.ok).toBe(false);
    expect(warningEvidence.gates.visualPreflight).toBe('warning');
    expect(warningEvidence.visualPreflight?.warningShotIds).toContain(shot.id);
    expect(warningEvidence.visualPreflight?.unresolvedVisibleObjectIds).toContain(prop.id);
  });

  it('lets verify bind the live revision without extra renders', () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_verify', command: 'verify' });
    const recorded = api.recordRunValidation({
      source: 'verify',
      revisionId: api.getStatus().revisionId,
    });
    expect(recorded.revisionId).toBe('rev_test');
    expect(recorded.revisionBinding).toBe('current');
    expect(recorded.current).toBe(true);
    expect(recorded.gates.revisionBound).toBe('passed');
    expect(recorded.gates.visualPreflight).toBe('skipped');
    expect(api.getStatus().provenance?.validation?.current).toBe(true);
  });

  it('fails an explicitly empty visual result instead of passing the visual gate', () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_empty_visual', command: 'verify' });
    const composed = composeAgentValidationEvidence({
      source: 'visual-preflight',
      revisionId: 'rev_test',
      visualPreflight: [],
    });
    expect(composed.ok).toBe(false);
    expect(composed.gates.visualPreflight).toBe('failed');
    expect(composed.visualPreflight?.emptySelection).toBe(true);
    expect(composed.visualPreflight?.shotCount).toBe(0);
    expect(composed.visualPreflight?.diagnostic).toMatch(/no shot results/i);

    const recorded = api.recordRunValidation({
      source: 'visual-preflight',
      revisionId: 'rev_test',
      visualPreflight: [],
    });
    expect(recorded.ok).toBe(false);
    expect(recorded.gates.visualPreflight).toBe('failed');
    expect(api.getStatus().provenance?.validation?.ok).toBe(false);
    expect(api.getStatus().provenance?.validation?.gates.visualPreflight).toBe('failed');
  });

  it('collects visual preflight for existing shots through the CLI/API path', () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_collect_existing', command: 'visual-preflight' });
    const shot = useProjectStore.getState().project.shots[0]!;
    const collected = api.collectVisualPreflightValidation({
      shotIds: [shot.shotNumber],
    });
    expect(collected.ok).toBe(true);
    expect(collected.visualPreflight).toHaveLength(1);
    expect(collected.visualPreflight?.[0]?.shotId).toBe(shot.id);
    expect(collected.selection.unmatchedShotIds).toEqual([]);

    const recorded = api.recordRunValidation({
      source: 'visual-preflight',
      revisionId: api.getStatus().revisionId,
      visualPreflight: collected.visualPreflight,
    });
    expect(recorded.gates.visualPreflight).not.toBe('skipped');
    expect(recorded.visualPreflight?.shotCount).toBe(1);
    expect(recorded.visualPreflight?.emptySelection).toBeUndefined();
  });

  it('fails an explicit visual selection that matches no shots through the CLI/API path', () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_unmatched_visual', command: 'visual-preflight' });
    const collected = api.collectVisualPreflightValidation({
      shotIds: ['shot_missing', '99'],
    });
    expect(collected.ok).toBe(false);
    expect(collected.visualPreflight).toEqual([]);
    expect(collected.selection.explicitSelection).toBe(true);
    expect(collected.selection.unmatchedShotIds).toEqual(['shot_missing', '99']);
    expect(collected.selection.diagnostic).toMatch(/unknown shot/i);

    const recorded = api.recordRunValidation({
      source: 'visual-preflight',
      revisionId: api.getStatus().revisionId,
      visualPreflight: collected.visualPreflight,
      unmatchedVisualShotIds: collected.selection.unmatchedShotIds,
    });
    expect(recorded.ok).toBe(false);
    expect(recorded.gates.visualPreflight).toBe('failed');
    expect(recorded.visualPreflight?.emptySelection).toBe(true);
    expect(recorded.visualPreflight?.unmatchedShotIds).toEqual(['shot_missing', '99']);
    expect(recorded.visualPreflight?.diagnostic).toMatch(/shot_missing/);
  });

  it('fails collectVisualPreflightValidation for an explicit empty shotIds array', () => {
    const api = createForeSceneBrowserApi();
    beginAgentRunSession({ runId: 'run_explicit_empty_shots', command: 'verify' });
    const collected = api.collectVisualPreflightValidation({ shotIds: [] });
    expect(collected.ok).toBe(false);
    expect(collected.selection.explicitSelection).toBe(true);
    expect(collected.visualPreflight).toEqual([]);
    expect(collected.selection.diagnostic).toMatch(/no shot results/i);

    const recorded = api.recordRunValidation({
      source: 'verify',
      revisionId: api.getStatus().revisionId,
      visualPreflight: collected.visualPreflight,
      unmatchedVisualShotIds: collected.selection.unmatchedShotIds,
    });
    expect(recorded.ok).toBe(false);
    expect(recorded.gates.visualPreflight).toBe('failed');
    expect(recorded.visualPreflight?.emptySelection).toBe(true);
  });

  it('omits the visual gate for verify on a genuinely empty project', () => {
    const api = createForeSceneBrowserApi();
    const empty = createDefaultProject();
    empty.shots = [];
    useProjectStore.getState().setProject(empty);
    beginAgentRunSession({ runId: 'run_empty_project', command: 'verify' });

    const collected = api.collectVisualPreflightValidation();
    expect(collected.ok).toBe(true);
    expect(collected.visualPreflight).toBeUndefined();
    expect(collected.selection.emptyProject).toBe(true);
    expect(collected.selection.explicitSelection).toBe(false);

    const recorded = api.recordRunValidation({
      source: 'verify',
      revisionId: api.getStatus().revisionId,
      ...(collected.visualPreflight !== undefined ? { visualPreflight: collected.visualPreflight } : {}),
      assetPose: { revisionId: 'rev_test', objects: [], shots: [] },
      projectHealth: {
        ok: true,
        projectId: empty.id,
        checkedAt: new Date().toISOString(),
        issues: [],
        diagnostics: [],
      },
    });
    expect(recorded.gates.visualPreflight).toBe('skipped');
    expect(recorded.ok).toBe(true);
    expect(recorded.visualPreflight).toBeUndefined();
  });

  it('gives verify and package invocations distinct run ids and preserves the id through the session', () => {
    const verify = createCliInvocationIdentity({ command: 'verify' });
    const pack = createCliInvocationIdentity({ command: 'package' });
    expect(verify.runId).toMatch(/^cli_/);
    expect(pack.runId).toMatch(/^cli_/);
    expect(verify.runId).not.toBe(pack.runId);
    expect(verify.command).toBe('verify');
    expect(pack.command).toBe('package');
    const previousCommit = {
      FORESCENE_SOURCE_COMMIT: process.env.FORESCENE_SOURCE_COMMIT,
      VITE_GIT_COMMIT: process.env.VITE_GIT_COMMIT,
      GITHUB_SHA: process.env.GITHUB_SHA,
      FORESCENE_BUILD_ID: process.env.FORESCENE_BUILD_ID,
      VITE_BUILD_ID: process.env.VITE_BUILD_ID,
    };
    try {
      delete process.env.FORESCENE_SOURCE_COMMIT;
      delete process.env.VITE_GIT_COMMIT;
      delete process.env.GITHUB_SHA;
      delete process.env.FORESCENE_BUILD_ID;
      delete process.env.VITE_BUILD_ID;
      const isolated = createCliInvocationIdentity({ command: 'verify' });
      expect(isolated.sourceCommit).toBeUndefined();
      expect(isolated.buildId).toBeUndefined();
      process.env.FORESCENE_SOURCE_COMMIT = 'deadbeefcafebabe';
      expect(createCliInvocationIdentity({ command: 'verify' }).sourceCommit).toBe('deadbeefcafebabe');
    } finally {
      for (const [key, value] of Object.entries(previousCommit)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const api = createForeSceneBrowserApi();
    const first = api.beginRunSession(verify);
    expect(first.provenance?.cli?.runId).toBe(verify.runId);
    expect(first.provenance?.cli?.command).toBe('verify');
    api.recordRunValidation({
      source: 'verify',
      revisionId: 'rev_test',
    });
    expect(api.getStatus().provenance?.cli?.runId).toBe(verify.runId);

    const second = api.beginRunSession(pack);
    expect(second.provenance?.cli?.runId).toBe(pack.runId);
    expect(second.provenance?.cli?.command).toBe('package');
    expect(second.provenance?.cli?.runId).not.toBe(verify.runId);
    expect(second.provenance?.validation).toBeUndefined();
  });
});
