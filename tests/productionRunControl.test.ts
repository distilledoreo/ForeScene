import { describe, expect, it } from 'vitest';
import {
  cancelAgentProductionRun,
  getAgentProductionRun,
  listAgentProductionRuns,
  pauseAgentProductionRun,
  resetAgentProductionRunsForTests,
  runAgentProduction,
} from '../src/engine/agent/productionRunControl';

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
    description: '',
    locationId: 'room',
    subjects: ['lead'],
    camera: { template: 'wide', subjects: ['lead'] },
  }],
};

describe('browser production run lifecycle', () => {
  it('persists a planned run and preserves it through pause/cancel', async () => {
    resetAgentProductionRunsForTests();
    const started = await runAgentProduction({ manifest, maxCanaryShots: 1 });
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
