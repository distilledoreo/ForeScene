import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  cancelAgentProductionRun,
  getAgentProductionRun,
  listAgentProductionRuns,
  pauseAgentProductionRun,
  resetAgentProductionRunsForTests,
  runAgentProduction,
} from '../src/engine/agent/productionRunControl';
import { resetAgentProductionGateRunsForTests } from '../src/engine/agent/productionGateControl';
import { useProjectStore } from '../src/state/useProjectStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useAgentControlStore } from '../src/state/useAgentControlStore';

const manifest = {
  version: 1,
  project: { name: 'Browser production fixture', aspectRatio: '16:9' },
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

function bindPreparedProject(project: ReturnType<typeof createDefaultProject>, leadId: string) {
  const wall = project.scene.objects.find((object) => object.type === 'wall');
  project.workflow.production = {
    schemaVersion: 1,
    bindings: {
      lead: { kind: 'object', objectId: leadId },
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
      'shot.001': {
        presence: {
          expectedVisibleObjectIds: [leadId],
          expectedVisibleGroupIds: [],
          allowUnspecifiedDynamicObjects: false,
        },
      },
    },
  };
}

describe('browser production run lifecycle', () => {
  beforeEach(() => {
    resetAgentProductionRunsForTests();
    resetAgentProductionGateRunsForTests();
    const project = createDefaultProject();
    const lead = project.scene.objects.find((object) => object.type === 'human_dummy')!;
    bindPreparedProject(project, lead.id);
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
  });

  it('persists a planned run and preserves it through pause/cancel', async () => {
    const started = await runAgentProduction({ manifest, maxCanaryShots: 1 });
    expect(started.ok, JSON.stringify(started.diagnostics)).toBe(true);
    expect(started.runId).toBeTruthy();
    expect(getAgentProductionRun(started.runId)?.currentGate).toBe('AUTHOR_CANARY');
    expect(listAgentProductionRuns()).toHaveLength(1);

    const paused = pauseAgentProductionRun(started.runId);
    expect(paused.status).toBe('paused');
    const cancelled = cancelAgentProductionRun(started.runId);
    expect(cancelled.status).toBe('cancelled');
    expect(getAgentProductionRun(started.runId)?.status).toBe('cancelled');
  });
});
