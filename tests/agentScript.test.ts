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
          updates: { name: 'Copy ' + i, transform: { position: [i, 0, 0] } },
        });
      }
    `, project);

    expect(result.plan.commands).toHaveLength(6);
    expect(result.plan.commands[0]).toMatchObject({ op: 'object.duplicate', ref: 'script_object_1' });
    expect(result.plan.commands[1]).toMatchObject({ op: 'object.update', object: { ref: 'script_object_1' } });
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
    `, project)).toThrow(/command limit exceeded/i);
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
