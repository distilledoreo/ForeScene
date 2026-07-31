import { describe, expect, it } from 'vitest';
import {
  createDefaultProject,
  createSceneObject,
} from '../src/domain/defaults';
import {
  prepareAgentPlan,
  previewAgentPlan,
  resolveAgentCreatePosition,
} from '../src/engine/agent/planCompiler';
import { projectFingerprint } from '../src/engine/agent/planDiff';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { createForeSceneBrowserApi } from '../src/engine/agent/browserApi';

describe('agent plan compiler preview', () => {
  it('never mutates the live project during preview', () => {
    const project = createDefaultProject();
    const before = structuredClone(project);
    const result = previewAgentPlan({
      version: 1,
      commands: [
        {
          op: 'object.create',
          ref: 'actorA',
          object: { type: 'human_dummy', name: 'Actor A', position: [-1.2, 0, 0] },
        },
        {
          op: 'project.updateInfo',
          name: 'Preview Location',
        },
      ],
    }, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
    });

    expect(result.ok).toBe(true);
    expect(project).toEqual(before);
    expect(result.summary?.affectedObjectIds).toHaveLength(1);
    expect(result.diff?.objectsCreated).toHaveLength(1);
    expect(result.diff?.projectInfoChanged).toBe(true);
  });

  it('lets a later command target an object created earlier via ref', () => {
    const project = createDefaultProject();
    const prepared = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'object.create',
          ref: 'propBox',
          object: { type: 'box', name: 'Crate', position: [1, 0, 0] },
        },
        {
          op: 'object.update',
          object: { ref: 'propBox' },
          updates: { visible: false, position: [2, 0.7, 0] },
        },
        {
          op: 'shot.create',
          ref: 'mediumShot',
          shot: {
            name: 'Two-shot medium',
            camera: { position: [0, 1.6, 5], target: [0, 1.4, 0], fovDegrees: 40 },
          },
        },
        {
          op: 'shot.stageObject',
          shot: { ref: 'mediumShot' },
          object: { ref: 'propBox' },
          visible: true,
        },
      ],
    }, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const crateId = prepared.prepared.refs.propBox?.id;
    const shotId = prepared.prepared.refs.mediumShot?.id;
    expect(crateId).toBeTruthy();
    expect(shotId).toBeTruthy();
    const crate = prepared.prepared.nextProject.scene.objects.find((object) => object.id === crateId);
    expect(crate?.visible).toBe(false);
    expect(crate?.transform.position).toEqual([2, 0.7, 0]);
    const shot = prepared.prepared.nextProject.shots.find((item) => item.id === shotId);
    expect(shot?.objectOverrides?.[crateId!]?.visible).toBe(true);
    expect(prepared.prepared.nextSelection.workspace).toBe('shots');
  });

  it('returns ambiguous_target candidates and rejects the whole plan', () => {
    const project = createDefaultProject();
    const left = createSceneObject('box', 1);
    left.name = 'Crate Left';
    const right = createSceneObject('box', 2);
    right.name = 'Crate Right';
    project.scene.objects.push(left, right);

    const result = prepareAgentPlan({
      version: 1,
      commands: [
        {
          op: 'object.update',
          object: { query: { name: 'Crate', match: 'contains' } },
          updates: { locked: true },
        },
        {
          op: 'object.create',
          object: { type: 'box', name: 'Should not be created' },
        },
      ],
    }, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe('ambiguous_target');
    expect(result.diagnostics[0]?.candidates?.sort()).toEqual([left.id, right.id].sort());
    expect(project.scene.objects.some((object) => object.name === 'Should not be created')).toBe(false);
  });

  it('invalid command mid-plan prevents preparing any later command', () => {
    const project = createDefaultProject();
    const beforeCount = project.scene.objects.length;
    const commands = [
      { op: 'object.create', object: { type: 'box', name: 'One' } },
      { op: 'object.create', object: { type: 'box', name: 'Two' } },
      {
        op: 'object.update',
        object: { id: 'missing-object' },
        updates: { visible: false },
      },
      { op: 'object.create', object: { type: 'box', name: 'Four' } },
    ];
    const result = prepareAgentPlan({ version: 1, commands }, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
    });
    expect(result.ok).toBe(false);
    expect(project.scene.objects).toHaveLength(beforeCount);
  });

  it('rejects stale expectedFingerprint', () => {
    const project = createDefaultProject();
    const result = prepareAgentPlan({
      version: 1,
      expectedFingerprint: 'stale',
      commands: [{ op: 'workspace.open', workspace: 'build' }],
    }, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('stale_revision');
    }
    expect(projectFingerprint(project)).toContain(project.id);
  });

  it('places upright characters with floor-contact semantics', () => {
    const human = createSceneObject('human_dummy', 1);
    human.dimensions = [0.55, 1.75, 0.55];
    expect(resolveAgentCreatePosition(human, [-1.2, 0, 0])).toEqual([-1.2, 0.875, 0]);

    const floor = createSceneObject('floor', 1);
    floor.dimensions = [12, 0.08, 12];
    expect(resolveAgentCreatePosition(floor, [0, 0, 0])).toEqual([0, -0.04, 0]);
  });
});

describe('browser API previewPlan', () => {
  it('previews without write access and leaves the store project identity intact', async () => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    const project = createDefaultProject();
    useProjectStore.setState({
      project,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
    });
    const api = createForeSceneBrowserApi();
    const liveBefore = useProjectStore.getState().project;
    const result = await api.previewPlan({
      version: 1,
      commands: [
        {
          op: 'object.create',
          ref: 'actorA',
          object: { type: 'human_dummy', name: 'Actor A', position: [-1.2, 0, 0] },
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.summary?.createdRefs.actorA?.name).toBe('Actor A');
    expect(useProjectStore.getState().project).toBe(liveBefore);
    expect(useProjectStore.getState().project.scene.objects).toHaveLength(project.scene.objects.length);
  });
});
