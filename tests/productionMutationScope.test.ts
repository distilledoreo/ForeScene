import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  buildCanaryMutationExpectation,
  buildFullStillMutationExpectation,
  verifyProductionMutationScope,
} from '../src/engine/previs/productionMutationScope';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import { planProductionCanary } from '../src/engine/previs/productionGates';

const manifest: PrevisProductionManifestV1 = {
  version: 1,
  project: { name: 'Scope fixture', aspectRatio: '16:9' },
  locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
  cast: [{ id: 'lead', name: 'Lead', type: 'human_dummy', defaultPose: 'standing-neutral' }],
  props: [{ id: 'sword', name: 'Sword', primitive: 'box' }],
  shots: [
    {
      id: 'shot.001',
      shotNumber: '001',
      name: 'Wide',
      description: 'Wide',
      locationId: 'room',
      subjects: ['lead'],
      camera: { template: 'wide', subjects: ['lead'] },
    },
    {
      id: 'shot.002',
      shotNumber: '002',
      name: 'Close',
      description: 'Close',
      locationId: 'room',
      subjects: ['lead'],
      camera: { template: 'close_up', subjects: ['lead'] },
    },
  ],
};

function preparedProject() {
  const before = createDefaultProject();
  const lead = createSceneObject('human_dummy', 1);
  lead.name = 'Lead';
  before.scene.objects.push(lead);
  before.workflow.production = {
    schemaVersion: 1,
    bindings: {
      lead: { kind: 'object', objectId: lead.id },
      room: { kind: 'location', locationId: 'room' },
    },
    locations: {
      room: {
        id: 'room',
        objectIds: [],
        objectGroupIds: [],
        anchors: {},
        blockerObjectIds: [],
      },
    },
    shotContracts: {},
  };
  return { before, lead };
}

describe('production mutation scope', () => {
  it('rejects canary compiles that modify unrelated shots', () => {
    const before = createDefaultProject();
    const canaryShot = before.shots[0]!;
    canaryShot.productionShotId = '001';
    const unrelatedShot = structuredClone(before.shots[1] ?? before.shots[0]!);
    unrelatedShot.id = 'unrelated-shot';
    unrelatedShot.shotNumber = '999';
    const plan = planProductionCanary({
      candidates: [{ shotId: 'shot.001', shotNumber: '001', capabilities: ['location'] }],
    });
    const expectation = buildCanaryMutationExpectation(before, plan, manifest);
    const after = structuredClone(before);
    after.shots = [
      ...after.shots,
      unrelatedShot,
    ];
    after.shots[0] = { ...after.shots[0]!, name: 'Changed canary shot' };
    const result = verifyProductionMutationScope(before, after, expectation);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes('Unexpected new shot'))).toBe(true);
  });

  it('allows full still compiles to create remaining manifest shots', () => {
    const before = createDefaultProject();
    const existing = before.shots[0]!;
    existing.productionShotId = '001';
    const expectation = buildFullStillMutationExpectation(before, manifest);
    const after = structuredClone(before);
    const created = structuredClone(existing);
    created.id = 'compiled-shot-002';
    created.shotNumber = '002';
    created.productionShotId = '002';
    after.shots = [existing, created];
    const result = verifyProductionMutationScope(before, after, expectation);
    expect(result.ok).toBe(true);
  });

  it('rejects full still compiles that remove unrelated shots', () => {
    const before = createDefaultProject();
    const keeper = before.shots[0]!;
    keeper.productionShotId = '001';
    const extra = structuredClone(keeper);
    extra.id = 'extra-shot';
    extra.shotNumber = '999';
    before.shots.push(extra);
    const expectation = buildFullStillMutationExpectation(before, manifest);
    const after = structuredClone(before);
    after.shots = after.shots.filter((shot) => shot.id !== 'extra-shot');
    const result = verifyProductionMutationScope(before, after, expectation);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes('was removed'))).toBe(true);
  });

  it('rejects unexpected new objects in prepared production', () => {
    const { before } = preparedProject();
    const plan = planProductionCanary({
      candidates: [{ shotId: 'shot.001', shotNumber: '001', capabilities: ['location'] }],
    });
    const expectation = buildCanaryMutationExpectation(before, plan, manifest);
    expect(expectation.expectedCreatedEntityIds.size).toBe(0);
    const after = structuredClone(before);
    const leaked = createSceneObject('box', 1);
    leaked.name = 'Leaked helper';
    after.scene.objects.push(leaked);
    const result = verifyProductionMutationScope(before, after, expectation);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes('Unexpected new scene object'))).toBe(true);
  });

  it('accepts expected greenfield objects tagged with productionEntityId metadata', () => {
    const before = createDefaultProject();
    const expectation = buildFullStillMutationExpectation(before, manifest, 'greenfield_production');
    expect(expectation.expectedCreatedEntityIds.has('lead')).toBe(true);
    expect(expectation.expectedCreatedEntityIds.has('sword')).toBe(true);
    const after = structuredClone(before);
    const lead = createSceneObject('human_dummy', 1);
    lead.metadata = { productionEntityId: 'lead' };
    after.scene.objects.push(lead);
    const result = verifyProductionMutationScope(before, after, expectation);
    expect(result.ok).toBe(true);
  });

  it('rejects duplicate objects for one semantic entity', () => {
    const before = createDefaultProject();
    const expectation = buildFullStillMutationExpectation(before, manifest, 'greenfield_production');
    const after = structuredClone(before);
    const first = createSceneObject('human_dummy', 1);
    first.metadata = { productionEntityId: 'lead' };
    const second = createSceneObject('human_dummy', 2);
    second.metadata = { productionEntityId: 'lead' };
    after.scene.objects.push(first, second);
    const result = verifyProductionMutationScope(before, after, expectation);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes('Duplicate scene object for production entity "lead"'))).toBe(true);
  });

  it('expects prepared production to create no new entities', () => {
    const { before } = preparedProject();
    const expectation = buildFullStillMutationExpectation(before, manifest);
    expect([...expectation.expectedCreatedEntityIds]).toEqual([]);
    const after = structuredClone(before);
    const prop = createSceneObject('box', 1);
    prop.metadata = { productionEntityId: 'sword' };
    after.scene.objects.push(prop);
    const result = verifyProductionMutationScope(before, after, expectation);
    expect(result.ok).toBe(false);
  });
});
