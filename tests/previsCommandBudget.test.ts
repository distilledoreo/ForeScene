import { describe, it, expect } from 'vitest';
import { compileProduction, parsePrevisProductionManifest } from '../src/engine/previs';
import { compileShotList } from '../src/engine/previs/shotCompiler';
import { AGENT_PLAN_LIMITS } from '../src/engine/agent/constants';

function fixture(propCount: number) {
  const parsed = parsePrevisProductionManifest({
    version: 1, project: { name: 'Command budget', aspectRatio: '16:9' },
    locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
    cast: [{ id: 'actor', name: 'Actor', type: 'human_dummy' }],
    props: Array.from({ length: propCount }, (_, i) => ({ id: `prop${i}`, name: `Prop ${i}`, primitive: 'box' })),
    shots: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, shotNumber: String(i + 1), name: `Shot ${i + 1}`, description: 'A medium shot.',
      locationId: 'room', subjects: ['actor'], camera: { template: 'medium', subjects: ['actor'] } })),
  });
  expect(parsed.errors).toEqual([]);
  return parsed.manifest!;
}

describe('previs command budget', () => {
  it('keeps every shot atomic while partitioning dense plans below the public limit', () => {
    const manifest = fixture(40);
    const compiled = compileProduction(manifest);
    const batches = compileShotList(manifest, compiled.context);
    expect(batches[0].shotNumbers.length).toBeLessThan(5);
    expect(batches.flatMap(b => b.shotNumbers)).toEqual(manifest.shots.map(s => s.shotNumber));
    for (const batch of batches) {
      expect(batch.plan.commands.length).toBeLessThanOrEqual(AGENT_PLAN_LIMITS.maxCommands);
      expect(Object.values(batch.shotResults).every(s => s.ok)).toBe(true);
      const creates = batch.plan.commands.filter(c => c.op === 'shot.create');
      expect(creates).toHaveLength(batch.shotNumbers.length);
    }
  });
  it('rejects an indivisible oversized shot without emitting a partial plan', () => {
    const manifest = fixture(0);manifest.shots = manifest.shots.slice(0, 1);
    manifest.assets = [{ id: 'large', type: 'imported_model', source: 'large.glb' }];
    const context = compileProduction(manifest).context;
    context.entities['assets.large'] = { objectId: 'obj_large_000', objectIds: Array.from({ length: 220 }, (_, i) => `obj_large_${i}`), groupId: 'group_large', refs: {} };
    const batches = compileShotList(manifest, context);
    expect(batches[0].plan.commands).toEqual([]);
    expect(batches[0].shotResults['1'].ok).toBe(false);
    expect(batches[0].diagnostics.some(d => d.code === 'shot_commands_limit')).toBe(true);
  });
  it('rejects invalid batch sizes rather than hanging', () => {
    const manifest = fixture(0); const context = compileProduction(manifest).context;
    for (const batchSize of [0, -1, 1.5, Infinity]) expect(() => compileShotList(manifest, context, { batchSize })).toThrow();
  });
});
