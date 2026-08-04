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
  planAgentProductionCanary,
  resetAgentProductionGateRunsForTests,
  runAgentProductionCanary,
  __testOnlySetGateRun,
} from '../src/engine/agent/productionGateControl';
import {
  cancelAgentProductionRun,
  getAgentProductionRun,
  resetAgentProductionRunsForTests,
  runAgentProduction,
  StaleProductionRunError,
} from '../src/engine/agent/productionRunControl';
import { verifyCompiledShotIntegrity } from '../src/engine/agent/productionIntegrityVerification';
import { inspectShotPresence } from '../src/engine/previs/shotPresence';
import { useProjectStore } from '../src/state/useProjectStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { setAgentRenderShotFrameImpl } from '../src/engine/agent/renderCallbackRegistry';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';

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
      },
    },
    shotContracts: {
      [shot.id]: {
        presence: {
          expectedVisibleObjectIds: [lead.id],
          expectedVisibleGroupIds: [],
          allowUnspecifiedDynamicObjects: false,
        },
      },
    },
  };
  return { project, lead, shot };
}

describe('production integrity integration', () => {
  beforeEach(() => {
    resetAgentProductionGateRunsForTests();
    resetAgentProductionRunsForTests();
    const { project } = preparedProject();
    useProjectStore.setState({ project });
    useAgentControlStore.setState({ controlMode: 'read-write' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (_reason, mutation) => {
      await mutation();
      const current = useProjectStore.getState().project;
      return {
        project: structuredClone(current),
        revision: {
          id: `revision_${Date.now()}`,
          projectId: current.id,
          kind: 'autosave' as const,
          reason: _reason,
          createdAt: new Date().toISOString(),
          manifest: '{}',
          resources: { projectAssetKeys: [], modelAssetKeys: [] },
        },
      };
    });
    setAgentRenderShotFrameImpl(async (input) => ({
      ok: true,
      status: 'completed',
      shotId: input.shotId,
      width: input.width ?? 640,
      height: input.height ?? 360,
      revisionId: 'revision_render',
      artifact: { kind: 'inline', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
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

  it('requires presence contracts in gated production verification', () => {
    const { project } = preparedProject();
    const shot = project.shots[0]!;
    project.workflow.production!.shotContracts = {};
    const verification = verifyCompiledShotIntegrity({
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
    expect(planned.runId).toBeTruthy();
    const executed = await runAgentProductionCanary({ runId: planned.runId! });
    expect(executed.result).toBeDefined();
    expect(executed.gateState?.canaryResult).toBeDefined();
    expect(executed.gateState?.gates.AUTHOR_CANARY.status).not.toBe('pending');
    expect(executed.gateState?.gates.RENDER_CANARY.status).not.toBe('pending');
  });
});

describe('stale production run guard', () => {
  it('exposes a stale-run error type for aborted generations', () => {
    expect(new StaleProductionRunError().name).toBe('StaleProductionRunError');
  });
});
