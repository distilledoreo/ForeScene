import { describe, expect, it } from 'vitest';
import {
  approveProductionCanary,
  CANARY_OUTPUTS,
  canAdvanceFullStillRun,
  completeProductionGate,
  createProductionGateState,
  deriveProductionShotCapabilities,
  planProductionCanary,
  runProductionCanary,
  startProductionGate,
  type ProductionCanaryShotResult,
} from '../src/engine/previs/productionGates';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';

const manifest: PrevisProductionManifestV1 = {
  version: 1,
  project: { name: 'Canary fixture', aspectRatio: '16:9' },
  locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
  cast: [
    { id: 'lead', name: 'Lead', type: 'human_dummy', defaultPose: 'standing' },
    { id: 'creature', name: 'Creature', type: 'imported_character', source: 'creature.glb', rigMode: 'preserve-existing' },
  ],
  props: [{ id: 'sword', name: 'Sword', primitive: 'box' }],
  shots: [
    {
      id: 'shot.001', shotNumber: '001', name: 'Dialogue', description: '', locationId: 'room',
      subjects: ['lead'], camera: { template: 'medium', subjects: ['lead'] },
    },
    {
      id: 'shot.002', shotNumber: '002', name: 'Creature move', description: '', locationId: 'room',
      subjects: ['lead', 'creature'], camera: { template: 'two_shot', subjects: ['lead', 'creature'] },
      requirements: { visibleProps: ['sword'] },
      blocking: [{ subject: 'creature', placement: { type: 'location_slot', slot: 'center' }, pose: 'running' }],
      motion: {
        durationSeconds: 2,
        keyframes: [
          { timeSeconds: 0, camera: { position: [0, 2, 6] } },
          { timeSeconds: 2, camera: { position: [1, 2, 5] }, staging: [{ subject: 'creature', visible: false }, { subject: 'creature', visible: true, posePreset: 'running' }] },
        ],
      },
    },
  ],
};

function passingResult(shotId: string): ProductionCanaryShotResult {
  return {
    shotId,
    presenceOk: true,
    capabilitiesOk: true,
    panoramaOk: true,
    compositionOk: true,
    unrelatedStateChanged: false,
    outputs: CANARY_OUTPUTS.map((output) => ({ output, ok: true })),
  };
}

describe('production gates and capability canary', () => {
  it('derives high-risk capabilities from shot intent', () => {
    const capabilities = deriveProductionShotCapabilities({
      shot: manifest.shots[1]!,
      manifest,
      production: {
        schemaVersion: 1,
        bindings: { creature: { kind: 'group', groupId: 'creature-group' } },
        locations: {},
        shotContracts: { 'shot.002': { environment: { locationId: 'room' }, presence: { expectedVisibleObjectIds: [], expectedVisibleGroupIds: [], allowUnspecifiedDynamicObjects: false } } },
      },
    });
    expect(capabilities).toEqual(expect.arrayContaining([
      'location', 'panorama', 'dynamic_presence', 'imported_character', 'multipart_group',
      'multiple_subjects', 'prop', 'pose_deformation', 'camera_motion', 'object_motion', 'visibility_transition',
    ]));
  });

  it('selects a deterministic small set-cover canary', () => {
    const plan = planProductionCanary({
      candidates: manifest.shots.map((shot) => ({
        shotId: shot.id,
        shotNumber: shot.shotNumber,
        capabilities: deriveProductionShotCapabilities({ shot, manifest }),
      })),
    });
    expect(plan.shotIds).toEqual(['shot.002', 'shot.001']);
    expect(plan.complete).toBe(true);
    expect(plan.outputs).toHaveLength(4);
  });

  it('keeps the full run locked when a high-risk canary fails', () => {
    let state = createProductionGateState('run-1', '2026-01-01T00:00:00.000Z');
    state = startProductionGate(state, 'VERIFY_CANARY_STATE');
    state = completeProductionGate(state, 'VERIFY_CANARY_STATE', { ok: true });
    state = completeProductionGate(state, 'VERIFY_CANARY_OUTPUT', { ok: true });
    const plan = planProductionCanary({ candidates: [{ shotId: 'shot.001', shotNumber: '001', capabilities: ['location'] }] });
    const result = runProductionCanary(plan, [{
      ...passingResult('shot.001'),
      presenceOk: false,
    }]);
    state = { ...state, canaryPlan: plan, canaryResult: result };
    state = approveProductionCanary(state, result);
    expect(state.canaryApproved).toBe(false);
    expect(canAdvanceFullStillRun(state)).toBe(false);
  });

  it('requires an explicit reason to override a failed canary', () => {
    let state = createProductionGateState('run-2');
    state = completeProductionGate(state, 'VERIFY_CANARY_STATE', { ok: true });
    state = completeProductionGate(state, 'VERIFY_CANARY_OUTPUT', { ok: true });
    const plan = planProductionCanary({ candidates: [{ shotId: 'shot.001', shotNumber: '001', capabilities: ['location'] }] });
    const result = runProductionCanary(plan, [{ ...passingResult('shot.001'), panoramaOk: false }]);
    state = approveProductionCanary(state, result, 'Director approved clay-only review; panorama is optional for this pass.');
    expect(state.canaryApproved).toBe(true);
    expect(state.overrideReason).toContain('Director approved');
    expect(canAdvanceFullStillRun(state)).toBe(true);
  });
});
