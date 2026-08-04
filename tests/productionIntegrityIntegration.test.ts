import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  approveProductionCanary,
  canAdvanceFullStillRun,
  completeProductionGate,
  createProductionGateState,
  planProductionCanary,
  runProductionCanary,
  type ProductionCanaryShotResult,
} from '../src/engine/previs/productionGates';
import {
  approveAgentProductionCanary,
  planAgentProductionCanary,
  resetAgentProductionGateRunsForTests,
  runAgentProductionCanary,
  __testOnlyAttestProductionCanary,
} from '../src/engine/agent/productionGateControl';
import {
  cancelAgentProductionRun,
  getAgentProductionRun,
  resetAgentProductionRunsForTests,
  resumeAgentProductionRun,
  runAgentProduction,
  StaleProductionRunError,
} from '../src/engine/agent/productionRunControl';
import * as productionManifestControl from '../src/engine/agent/productionManifestControl';
import { verifyCompiledShotIntegrity } from '../src/engine/agent/productionIntegrityVerification';
import { restoreAgentProjectRevision } from '../src/engine/agent/projectHealthControl';
import { projectFingerprint } from '../src/engine/agent/planDiff';
import { useProjectStore } from '../src/state/useProjectStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { setAgentRenderShotFrameImpl } from '../src/engine/agent/renderCallbackRegistry';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';

vi.mock('../src/engine/agent/projectHealthControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/agent/projectHealthControl')>();
  return {
    ...actual,
    restoreAgentProjectRevision: vi.fn(),
  };
});

vi.mock('../src/engine/renderers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/renderers')>();
  return {
    ...actual,
    renderShotProjectedFrameWithHealth: vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,healthy',
      width: 640,
      height: 360,
      projectionHealth: {
        projectedTextureAvailable: true,
        occlusionMapAvailable: true,
        projectedMaterialCount: 4,
        geometryPixelCount: 1000,
        coveredPixelCount: 900,
        fallbackPixelCount: 50,
        projectionCoverage: 0.9,
        fallbackRatio: 0.05,
      },
    })),
  };
});

const manifest: PrevisProductionManifestV1 = {
  version: 1,
  project: { name: 'Integrity fixture', aspectRatio: '16:9' },
  locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
  cast: [{ id: 'lead', name: 'Lead', type: 'human_dummy', defaultPose: 'standing-neutral' }],
  props: [],
  shots: [{
    id: 'shot.001',
    shotNumber: '001',
    name: 'Wide',
    description: 'Wide establishing shot',
    locationId: 'room',
    subjects: ['lead'],
    camera: { template: 'wide', subjects: ['lead'] },
  }],
};

function passingCanaryResult(shotId: string): ProductionCanaryShotResult {
  return {
    shotId,
    presenceOk: true,
    capabilitiesOk: true,
    panoramaOk: true,
    compositionOk: true,
    unrelatedStateChanged: false,
    outputs: [
      { output: 'clay_dynamic_subjects', ok: true },
      { output: 'characters_only', ok: true },
      { output: 'clay_clean_plate', ok: true },
      { output: 'projected_dynamic_subjects', ok: true },
    ],
  };
}

function preparedProject() {
  const project = createDefaultProject();
  const wall = project.scene.objects.find((object) => object.type === 'wall');
  project.scene.objects = wall ? [wall] : [];
  const lead = createSceneObject('human_dummy', 1);
  lead.name = 'Lead';
  project.scene.objects.push(lead);
  const shot = project.shots[0]!;
  const pano = {
    id: 'pano_fixture',
    name: 'Room panorama',
    imageAssetId: 'asset_pano_fixture',
    type: 'graybox_render' as const,
    projection: 'equirectangular' as const,
    origin: [0, 1.65, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    width: 4,
    height: 2,
    isCanonical: true,
    createdAt: new Date().toISOString(),
  };
  project.panoRefs.push(pano);
  shot.linkedPanoId = pano.id;
  project.workflow.production = {
    schemaVersion: 1,
    bindings: {
      lead: { kind: 'object', objectId: lead.id },
      room: { kind: 'location', locationId: 'room' },
    },
    locations: {
      room: {
        id: 'room',
        objectIds: wall ? [wall.id] : [],
        objectGroupIds: [],
        anchors: {},
        blockerObjectIds: [],
        panoIds: [pano.id],
        defaultPanoId: pano.id,
      },
    },
    shotContracts: {
      [shot.id]: {
        presence: {
          expectedVisibleObjectIds: [lead.id],
          expectedVisibleGroupIds: [],
          allowUnspecifiedDynamicObjects: false,
        },
        environment: {
          locationId: 'room',
        },
      },
    },
  };
  return { project, lead, shot, pano };
}

describe('production integrity integration', () => {
  const revisionSnapshots = new Map<string, ReturnType<typeof createDefaultProject>>();

  beforeEach(() => {
    resetAgentProductionGateRunsForTests();
    resetAgentProductionRunsForTests();
    revisionSnapshots.clear();
    vi.mocked(restoreAgentProjectRevision).mockReset();
    const { project } = preparedProject();
    useProjectStore.setState({ project });
    useAgentControlStore.setState({ controlMode: 'read-write' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (reason, mutation) => {
      const before = structuredClone(useProjectStore.getState().project);
      await mutation();
      const current = useProjectStore.getState().project;
      const revisionId = `revision_${reason}_${Date.now()}`;
      revisionSnapshots.set(revisionId, before);
      return {
        project: structuredClone(current),
        revision: {
          id: revisionId,
          projectId: current.id,
          kind: 'autosave' as const,
          reason,
          createdAt: new Date().toISOString(),
          manifest: '{}',
          resources: { projectAssetKeys: [], modelAssetKeys: [] },
        },
      };
    });
    vi.mocked(restoreAgentProjectRevision).mockImplementation(async ({ revisionId }) => {
      const snapshot = revisionSnapshots.get(revisionId);
      if (!snapshot) {
        return { ok: false, diagnostics: [{ code: 'revision_missing', message: 'Revision not found.', severity: 'error' as const }] };
      }
      useProjectStore.setState({ project: structuredClone(snapshot) });
      return { ok: true, diagnostics: [] };
    });
    setAgentRenderShotFrameImpl(async (input) => ({
      ok: true,
      status: 'completed',
      shotId: input.shotId,
      width: input.width ?? 640,
      height: input.height ?? 360,
      revisionId: 'revision_render',
      artifact: {
        kind: 'inline',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${'A'.repeat(48)}`,
      },
      diagnostics: [],
    }));
  });

  it('blocks canary planning when bindings are missing', async () => {
    const project = createDefaultProject();
    useProjectStore.setState({ project });
    const planned = await planAgentProductionCanary({ manifest, maxShots: 1 });
    expect(planned.ok).toBe(false);
    expect(planned.diagnostics.some((item) => item.code === 'missing_binding')).toBe(true);
  });

  it('rejects fabricated canary attestation when structural checks fail', async () => {
    const plan = planProductionCanary({
      candidates: [{ shotId: 'shot.001', shotNumber: '001', capabilities: ['location'] }],
    });
    const result = runProductionCanary(plan, [{
      ...passingCanaryResult('shot.001'),
      presenceOk: false,
    }]);
    expect(result.ok).toBe(false);
    let state = createProductionGateState('fabricated');
    state = completeProductionGate(state, 'VERIFY_CANARY_STATE', { ok: false, diagnostics: result.diagnostics });
    state = approveProductionCanary(state, result);
    expect(state.canaryApproved).toBe(false);
    expect(canAdvanceFullStillRun(state)).toBe(false);
  });

  it('allows failed canary override to unlock full still run', () => {
    const plan = planProductionCanary({
      candidates: [{ shotId: 'shot.001', shotNumber: '001', capabilities: ['location'] }],
    });
    const result = runProductionCanary(plan, [{
      ...passingCanaryResult('shot.001'),
      panoramaOk: false,
    }]);
    let state = createProductionGateState('override');
    state = completeProductionGate(state, 'VERIFY_CANARY_STATE', { ok: false, diagnostics: result.diagnostics });
    state = completeProductionGate(state, 'VERIFY_CANARY_OUTPUT', { ok: false, diagnostics: result.diagnostics });
    state = { ...state, canaryPlan: plan, canaryResult: result };
    state = approveProductionCanary(state, result, 'Director approved review with known panorama gap.');
    expect(canAdvanceFullStillRun(state)).toBe(true);
  });

  it('requires presence contracts in gated production verification', async () => {
    const { project } = preparedProject();
    const shot = project.shots[0]!;
    project.workflow.production!.shotContracts = {};
    const verification = await verifyCompiledShotIntegrity({
      project,
      shot,
      definition: manifest.shots[0]!,
      manifest,
      integrityMode: 'gated_production',
      frameExists: true,
      frameByteSize: 128,
      fromCanonicalRenderer: true,
    });
    expect(verification.ok).toBe(false);
    expect(verification.presence.diagnostics.some((item) => item.code === 'presence_contract_missing')).toBe(true);
  });

  it('cannot resume a production run against another project', async () => {
    const started = await runAgentProduction({ manifest, maxCanaryShots: 1 });
    expect(started.ok).toBe(true);
    const other = createDefaultProject();
    other.id = 'other-project';
    useProjectStore.setState({ project: other });
    const resumed = await runAgentProduction({ manifest, maxCanaryShots: 1 });
    expect(resumed.ok).toBe(false);
    expect(started.runId).toBeTruthy();
    const run = getAgentProductionRun(started.runId);
    expect(run?.projectId).not.toBe(other.id);
  });

  it('marks cancelled runs without letting stale generations persist', async () => {
    const started = await runAgentProduction({ manifest, maxCanaryShots: 1 });
    expect(started.ok).toBe(true);
    const cancelled = cancelAgentProductionRun(started.runId);
    expect(cancelled.status).toBe('cancelled');
    expect(getAgentProductionRun(started.runId)?.status).toBe('cancelled');
  });

  it('executes canary internally instead of trusting caller attestation', async () => {
    const planned = await planAgentProductionCanary({ manifest, maxShots: 1 });
    expect(planned.ok).toBe(true);
    const executed = await runAgentProductionCanary({ runId: planned.runId! });
    expect(executed.ok).toBe(true);
    expect(executed.result).toBeDefined();
    expect(executed.gateState?.canaryResult).toBeDefined();
    expect(executed.gateState?.gates.AUTHOR_CANARY.status).not.toBe('pending');
    expect(executed.gateState?.gates.RENDER_CANARY.status).not.toBe('pending');
  });

  it('does not allow fabricated passing results through the public canary API', async () => {
    const planned = await planAgentProductionCanary({ manifest, maxShots: 1 });
    expect(planned.ok).toBe(true);
    setAgentRenderShotFrameImpl(async () => ({
      ok: false,
      status: 'failed',
      shotId: 'shot',
      width: 640,
      height: 360,
      revisionId: 'revision_render',
      diagnostics: [{ code: 'render_failed', message: 'Render failed.', severity: 'error' }],
    }));
    const fingerprintBefore = projectFingerprint(useProjectStore.getState().project);
    const executed = await runAgentProductionCanary({ runId: planned.runId! });
    expect(executed.ok).toBe(false);
    expect(executed.result?.ok).toBe(false);
    expect(projectFingerprint(useProjectStore.getState().project)).toBe(fingerprintBefore);
    expect(vi.mocked(restoreAgentProjectRevision)).toHaveBeenCalled();
  });

  it('keeps test-only attestation behind an explicit helper', async () => {
    const planned = await planAgentProductionCanary({ manifest, maxShots: 1 });
    expect(planned.ok).toBe(true);
    const attested = __testOnlyAttestProductionCanary({
      runId: planned.runId!,
      results: [passingCanaryResult('shot.001')],
    });
    expect(attested.ok).toBe(true);
    expect(attested.gateState?.canaryResult?.ok).toBe(true);
  });

  it('rolls back and resolves when a canary is cancelled after compile', async () => {
    const started = await runAgentProduction({ manifest, maxCanaryShots: 1 });
    expect(started.ok).toBe(true);
    const fingerprintBefore = projectFingerprint(useProjectStore.getState().project);
    const realCompile = productionManifestControl.applyAgentProductionCompile;
    const compileSpy = vi.spyOn(productionManifestControl, 'applyAgentProductionCompile').mockImplementation(async (input) => {
      const result = await realCompile(input);
      cancelAgentProductionRun(started.runId);
      return result;
    });
    const canaryPromise = runAgentProductionCanary({ runId: started.runId });
    const canary = await canaryPromise;
    compileSpy.mockRestore();
    expect(canary.ok).toBe(false);
    expect(canary.diagnostics.some((item) => item.code === 'canary_interrupted')).toBe(true);
    expect(projectFingerprint(useProjectStore.getState().project)).toBe(fingerprintBefore);
    expect(getAgentProductionRun(started.runId)?.status).toBe('cancelled');
    expect(vi.mocked(restoreAgentProjectRevision)).toHaveBeenCalled();
  });

  it('runs the full lifecycle from canary through still verification gate', async () => {
    const started = await runAgentProduction({ manifest, maxCanaryShots: 1 });
    expect(started.ok).toBe(true);
    const canary = await runAgentProductionCanary({ runId: started.runId });
    expect(canary.ok).toBe(true);
    const approved = approveAgentProductionCanary({ runId: started.runId });
    expect(approved.ok).toBe(true);
    const resumed = await resumeAgentProductionRun(started.runId);
    expect(resumed.ok).toBe(true);
    expect(resumed.state?.gateState?.gates.VERIFY_FULL_STILL_SEQUENCE.status).toMatch(/^passed/);
    expect(resumed.status).toBe('needs_review');
  });
});

describe('stale production run guard', () => {
  it('exposes a stale-run error type for aborted generations', () => {
    expect(new StaleProductionRunError().name).toBe('StaleProductionRunError');
  });
});
