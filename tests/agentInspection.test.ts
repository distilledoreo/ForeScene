import { describe, expect, it } from 'vitest';
import {
  createDefaultProject,
  createSceneObject,
} from '../src/domain/defaults';
import {
  inspectObjectSnapshot,
  inspectProjectSnapshot,
  inspectShotSnapshot,
  listLandmarksSnapshot,
  listObjectsSnapshot,
  listShotsSnapshot,
  resolveExistingObjectTarget,
  resolveExistingShotTarget,
} from '../src/engine/agent/inspection';
import { createExportPlan } from '../src/engine/exportPlan';
import { createForeSceneBrowserApi } from '../src/engine/agent/browserApi';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectStore } from '../src/state/useProjectStore';

describe('agent inspection snapshots', () => {
  it('summarizes the default project without mutating it', () => {
    const project = createDefaultProject();
    const before = structuredClone(project);
    const inspection = inspectProjectSnapshot({
      project,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
    });

    expect(inspection.id).toBe(project.id);
    expect(inspection.objectCount).toBe(project.scene.objects.length);
    expect(inspection.shotCount).toBe(project.shots.length);
    expect(inspection.workspace).toBe('build');
    expect(project).toEqual(before);
  });

  it('filters objects by name and type', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    actor.name = 'Actor A';
    actor.transform.position = [-1, 0, 0];
    const prop = createSceneObject('box', 1, [1, 0, 0]);
    prop.name = 'Prop Box';
    project.scene.objects.push(actor, prop);

    const actors = listObjectsSnapshot(project, {
      name: 'Actor',
      type: 'human_dummy',
      match: 'contains',
    });
    expect(actors).toHaveLength(1);
    expect(actors[0]!.name).toBe('Actor A');
    expect(actors[0]!.position).toEqual([-1, 0, 0]);
  });

  it('returns ambiguous_target when a name query matches multiple objects', () => {
    const project = createDefaultProject();
    const left = createSceneObject('box', 1);
    left.name = 'Crate Left';
    const right = createSceneObject('box', 2);
    right.name = 'Crate Right';
    project.scene.objects.push(left, right);
    const result = resolveExistingObjectTarget(project, {
      query: { name: 'Crate', match: 'contains' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]!.code).toBe('ambiguous_target');
      expect(result.diagnostics[0]!.candidates?.length).toBe(2);
    }
  });

  it('inspects shots and landmarks as compact summaries', () => {
    const project = createDefaultProject();
    const shots = listShotsSnapshot(project);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0]!.cameraPosition).toHaveLength(3);

    const shot = inspectShotSnapshot(project.shots[0]!);
    expect(shot.camera.fovDegrees).toBeTypeOf('number');
    expect(shot.stagedObjectIds).toEqual([]);

    const landmarks = listLandmarksSnapshot(project);
    expect(Array.isArray(landmarks)).toBe(true);

    const object = inspectObjectSnapshot(project.scene.objects[0]!);
    expect(object.transform.position).toHaveLength(3);
  });

  it('resolves shots by exact id and rejects missing ids', () => {
    const project = createDefaultProject();
    const shotId = project.shots[0]!.id;
    expect(resolveExistingShotTarget(project, { id: shotId })).toEqual({
      ok: true,
      id: shotId,
    });
    const missing = resolveExistingShotTarget(project, { id: 'missing-shot' });
    expect(missing.ok).toBe(false);
  });
});

describe('agent browser API (store-backed)', () => {
  it('exposes status and rejects mutations without write access', async () => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    const project = createDefaultProject();
    useProjectStore.setState({ project, workspace: 'build' });

    const api = createForeSceneBrowserApi();
    const status = api.getStatus();
    expect(status.ready).toBe(true);
    expect(status.writeAccess).toBe(false);
    expect(status.projectLoaded).toBe(true);
    expect(status.projectName).toBe(project.name);

    const inspection = api.inspectProject();
    expect(inspection.objectCount).toBe(project.scene.objects.length);

    const apply = await api.applyPlan({ version: 1, commands: [] });
    expect(apply.ok).toBe(false);
    expect(apply.diagnostics[0]!.code).toBe('write_access_required');

    const preview = await api.previewPlan({
      version: 1,
      commands: [{ op: 'workspace.open', workspace: 'build' }],
    });
    expect(preview.ok).toBe(true);
  });

  it('createExportPlan matches the engine planner summary', () => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    const project = createDefaultProject();
    useProjectStore.setState({ project, workspace: 'export' });

    const api = createForeSceneBrowserApi();
    const result = api.createExportPlan();
    expect(result.ok).toBe(true);
    const expected = createExportPlan(project, project.shots);
    expect(result.summary).toEqual(expected.summary);
    expect(result.plan?.estimatedFileCount).toBe(expected.estimatedFileCount);
    expect(result.plan?.archiveFileName).toBe(expected.archiveFileName);
    expect(result.plan?.packageType).toBe(expected.packageType);
  });

  it('setControlMode toggles writeAccess for the session', async () => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    const api = createForeSceneBrowserApi();
    expect(api.getStatus().writeAccess).toBe(false);
    api.setControlMode('read-write');
    expect(api.getStatus().writeAccess).toBe(true);
    const apply = await api.applyPlan({
      version: 1,
      commands: [{ op: 'workspace.open', workspace: 'build' }],
    });
    expect(apply.diagnostics[0]!.code).toBe('not_implemented');
    api.setControlMode('read-only');
    expect(api.getStatus().writeAccess).toBe(false);
  });
});
