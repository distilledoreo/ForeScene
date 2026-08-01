import { describe, expect, it } from 'vitest';
import { parseForeSceneAgentPlan } from '../src/engine/agent/validation';
import { AGENT_PLAN_LIMITS } from '../src/engine/agent/constants';

describe('agent plan validation', () => {
  it('parses a normalized plan and strips markdown fences', () => {
    const result = parseForeSceneAgentPlan(`\`\`\`json
{
  "version": 1,
  "description": "Stage a conversation",
  "commands": [
    {
      "op": "object.create",
      "ref": "actorA",
      "object": { "type": "human_dummy", "name": "Actor A", "position": [-1.2, 0, 0] }
    }
  ]
}
\`\`\``);
    expect(result.errors).toEqual([]);
    expect(result.plan?.commands).toHaveLength(1);
    expect(result.plan?.commands[0]).toMatchObject({
      op: 'object.create',
      ref: 'actorA',
    });
    expect(result.warnings.some((item) => item.code === 'markdown_fence')).toBe(true);
  });

  it('rejects invalid version, empty commands, and over-limit plans', () => {
    expect(parseForeSceneAgentPlan({ version: 2, commands: [{ op: 'workspace.open', workspace: 'build' }] }).errors[0]?.code)
      .toBe('schema_version');
    expect(parseForeSceneAgentPlan({ version: 1, commands: [] }).errors[0]?.code)
      .toBe('commands_empty');

    const commands = Array.from({ length: AGENT_PLAN_LIMITS.maxCommands + 1 }, () => ({
      op: 'workspace.open',
      workspace: 'build',
    }));
    expect(parseForeSceneAgentPlan({ version: 1, commands }).errors[0]?.code)
      .toBe('commands_limit');
  });

  it('rejects non-finite positions and unknown enums', () => {
    const infinite = parseForeSceneAgentPlan({
      version: 1,
      commands: [{
        op: 'object.create',
        object: { type: 'box', position: [0, Number.POSITIVE_INFINITY, 0] },
      }],
    });
    expect(infinite.errors.some((item) => item.code === 'vec3_finite')).toBe(true);

    const badType = parseForeSceneAgentPlan({
      version: 1,
      commands: [{
        op: 'object.create',
        object: { type: 'imported_model' },
      }],
    });
    expect(badType.errors.some((item) => item.code === 'object_type')).toBe(true);

    const badWorkspace = parseForeSceneAgentPlan({
      version: 1,
      commands: [{ op: 'workspace.open', workspace: 'review' }],
    });
    expect(badWorkspace.errors.some((item) => item.code === 'workspace')).toBe(true);
  });

  it('rejects duplicate refs and unsupported ops without preparing later commands', () => {
    const duplicate = parseForeSceneAgentPlan({
      version: 1,
      commands: [
        { op: 'object.create', ref: 'a', object: { type: 'box' } },
        { op: 'object.create', ref: 'a', object: { type: 'box' } },
      ],
    });
    expect(duplicate.plan).toBeUndefined();
    expect(duplicate.errors.some((item) => item.code === 'duplicate_ref')).toBe(true);

    const unsupported = parseForeSceneAgentPlan({
      version: 1,
      commands: [
        { op: 'object.create', object: { type: 'box' } },
        { op: 'file.import', path: 'x.glb' },
      ],
    });
    expect(unsupported.plan).toBeUndefined();
    expect(unsupported.errors.some((item) => item.code === 'not_implemented')).toBe(true);
  });

  it('parses temporal commands and enforces their wire-level invariants', () => {
    const valid = parseForeSceneAgentPlan({
      version: 1,
      commands: [{
        op: 'shot.timeline.replace',
        shot: { id: 'shot_123456789' },
        durationSeconds: 2,
        keyframes: [
          { timeSeconds: 0, camera: {} },
          { timeSeconds: 2, camera: {}, objects: [{ object: { ref: 'cast.alex' }, visible: true }] },
        ],
      }],
    });
    expect(valid.errors).toEqual([]);
    expect(valid.plan?.commands[0]?.op).toBe('shot.timeline.replace');

    const invalid = parseForeSceneAgentPlan({
      version: 1,
      commands: [{
        op: 'shot.timeline.replace',
        shot: { id: 'shot_123456789' },
        durationSeconds: 2,
        keyframes: [
          { timeSeconds: 1, camera: {} },
          { timeSeconds: 1, camera: {} },
        ],
      }],
    });
    expect(invalid.errors.some((item) => item.code === 'timeline_order')).toBe(true);
  });

  it('aliases standing-neutral pose presets', () => {
    const result = parseForeSceneAgentPlan({
      version: 1,
      commands: [{
        op: 'shot.stageObject',
        shot: { id: 'shot-1' },
        object: { id: 'obj-1' },
        posePreset: 'standing-neutral',
      }],
    });
    expect(result.errors).toEqual([]);
    expect(result.plan?.commands[0]).toMatchObject({
      op: 'shot.stageObject',
      posePreset: 'neutral',
    });
  });
});
