import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { AGENT_PLAN_LIMITS } from '../src/engine/agent/constants';
import { previewAgentPlan } from '../src/engine/agent/planCompiler';
import { compileAgentScript } from '../scripts/agent/agentScript';

describe('agent scripting compiler', () => {
  it('turns normal JavaScript loops into ordinary Agent Plan commands', () => {
    const project = createDefaultProject();
    const before = structuredClone(project);
    const result = compileAgentScript(`
      plan.description('Procedural colonnade');
      for (let i = 0; i < 6; i += 1) {
        scene.create('column', {
          name: 'Column ' + (i + 1),
          position: [i * 2, 0, 0],
          dimensions: [0.6, 4, 0.6],
        });
      }
      workspace.open('build');
    `, project);

    expect(result.commandCount).toBe(7);
    expect(result.plan.description).toBe('Procedural colonnade');
    expect(result.plan.expectedFingerprint).toBeTruthy();
    expect(result.plan.commands[0]).toMatchObject({
      op: 'object.create',
      ref: 'script_object_1',
      object: { type: 'column', name: 'Column 1', position: [0, 0, 0] },
    });
    expect(result.plan.commands[6]).toEqual({ op: 'workspace.open', workspace: 'build' });
    expect(project).toEqual(before);
  });

  it('produces plans accepted by the existing plan compiler', () => {
    const project = createDefaultProject();
    const compiled = compileAgentScript(`
      for (let i = 0; i < 4; i += 1) {
        scene.create('column', {
          name: 'Validated ' + i,
          position: [i * 2, 0, 0],
          dimensions: [0.5, 3, 0.5],
        });
      }
    `, project);
    const preview = previewAgentPlan(compiled.plan, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: undefined,
      activePanoId: undefined,
      gridSnap: false,
    });
    expect(preview.ok).toBe(true);
    expect(preview.summary?.commandCount).toBe(4);
    expect(preview.diff?.objectsCreated).toHaveLength(4);
  });

  it('queries the read-only project snapshot and targets existing entities', () => {
    const project = createDefaultProject();
    const known = project.scene.objects[0];
    const result = compileAgentScript(`
      const object = scene.require({ name: ${JSON.stringify(known.name)}, match: 'exact' });
      scene.update(object, { visible: false });
    `, project);

    expect(result.plan.commands).toEqual([
      { op: 'object.update', object: { id: known.id }, updates: { visible: false } },
    ]);
  });

  it('supports plan-local refs for procedural duplicate-and-edit workflows', () => {
    const project = createDefaultProject();
    const source = project.scene.objects[0];
    const result = compileAgentScript(`
      const source = scene.require({ name: ${JSON.stringify(source.name)} });
      for (let i = 0; i < 3; i += 1) {
        scene.duplicate(source, {
          updates: { name: 'Copy ' + i, position: [i, 0, 0] },
        });
      }
    `, project);

    expect(result.plan.commands).toHaveLength(3);
    expect(result.plan.commands[0]).toMatchObject({
      op: 'object.duplicateMany',
      items: [{ ref: 'script_object_1', updates: { name: 'Copy 0', position: [0, 0, 0] } }],
    });
    expect(result.expandedCommandCount).toBe(6);
  });

  it('lets later statements query earlier shadow mutations and use spatial relationships', () => {
    const project = createDefaultProject();
    const initialCount = project.scene.objects.length;
    const result = compileAgentScript(`
      const platform = scene.create('box', {
        name: 'Platform',
        position: [0, 0.5, 0],
        dimensions: [4, 1, 4],
      });
      const prop = scene.create('box', {
        name: 'Prop',
        position: [0, 0, 0],
        dimensions: [1, 1, 1],
      });

      if (project.scene.objects.length !== ${initialCount + 2}) throw new Error('shadow project did not update');
      scene.placeOn(prop, platform, { gap: 0.2 });
      scene.update(prop, { name: 'Placed Prop' });

      const live = scene.require({ name: 'Placed Prop' });
      const bounds = scene.bounds(live);
      if (Math.abs(bounds.min[1] - 1.2) > 1e-6) throw new Error('placeOn did not update shadow bounds');
      if (scene.distance(live, platform) < 0.199) throw new Error('distance did not see updated placement');

      scene.align(live, platform, { axis: 'x', source: 'center', target: 'max', offset: 0.5 });
      const aligned = scene.bounds(scene.require({ name: 'Placed Prop' }));
      const platformBounds = scene.bounds(platform);
      if (Math.abs(aligned.center[0] - (platformBounds.max[0] + 0.5)) > 1e-6) {
        throw new Error('align did not update shadow state');
      }
    `, project);

    expect(result.commandCount).toBe(5);
    expect(result.plan.commands.map((command) => command.op)).toEqual([
      'object.create',
      'object.create',
      'object.update',
      'object.update',
      'object.update',
    ]);
    expect(project.scene.objects).toHaveLength(initialCount);
  });

  it('compresses large deterministic arrays into bounded bulk plan commands', () => {
    const project = createDefaultProject();
    const result = compileAgentScript(`
      const source = scene.create('column', {
        name: 'Ring Source',
        position: [0, 0, 0],
        dimensions: [0.6, 4, 0.6],
      });
      const copies = scene.radialArray(source, {
        count: 300,
        radius: 12,
        center: [0, 2, 0],
        faceCenter: true,
        namePrefix: 'Ring Column',
      });
      if (copies.length !== 300) throw new Error('bulk array did not materialize in shadow project');
      if (!scene.find({ name: 'Ring Column 300' })) throw new Error('bulk copies are not queryable');
    `, project);

    expect(result.commandCount).toBe(2);
    expect(result.expandedCommandCount).toBe(601);
    expect(result.plan.commands[1]?.op).toBe('object.duplicateMany');
    const preview = previewAgentPlan(result.plan, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
      activePanoId: undefined,
      gridSnap: false,
    });
    expect(preview.ok).toBe(true);
    expect(preview.diff?.objectsCreated).toHaveLength(301);
  });

  it('does not expose process, require, or dynamic string code generation', () => {
    const project = createDefaultProject();
    const safe = compileAgentScript(`
      if (typeof process !== 'undefined') throw new Error('process leaked');
      if (typeof require !== 'undefined') throw new Error('require leaked');
      scene.create('box', { name: 'Safe' });
    `, project);
    expect(safe.commandCount).toBe(1);

    expect(() => compileAgentScript(`
      Function('return 1')();
    `, project)).toThrow(/code generation from strings disallowed|agent script failed/i);
  });

  it('bounds execution time and command volume', () => {
    const project = createDefaultProject();
    expect(() => compileAgentScript('while (true) {}', project, { timeoutMs: 10 }))
      .toThrow(/timed out|agent script failed/i);

    expect(() => compileAgentScript(`
      for (let i = 0; i < ${AGENT_PLAN_LIMITS.maxCommands + 1}; i += 1) {
        scene.create('box', { name: 'Box ' + i });
      }
    `, project)).toThrow(/top-level command limit exceeded/i);
  });

  it('lets advanced scripts emit any existing Agent Plan command explicitly', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const result = compileAgentScript(`
      plan.command({
        op: 'shot.timeline.setDuration',
        shot: target.id(${JSON.stringify(shot.id)}),
        durationSeconds: 8,
      });
    `, project);
    expect(result.plan.commands).toEqual([{
      op: 'shot.timeline.setDuration',
      shot: { id: shot.id },
      durationSeconds: 8,
    }]);
  });
});
