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
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
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

  it('returns an isolated complete shot document for staging workflows', () => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    const project = createDefaultProject();
    const prop = createSceneObject('box', 1);
    project.scene.objects.push(prop);
    const shot = project.shots[0]!;
    shot.objectOverrides = {
      [prop.id]: {
        visible: false,
        transform: {
          position: [3, 1, -2],
          rotation: [0, 20, 0],
          scale: [1.5, 1.5, 1.5],
        },
      },
    };
    shot.cameraKeyframes = [{
      id: 'keyframe_staged',
      label: 'Reveal',
      timeSeconds: 1,
      camera: structuredClone(shot.camera),
      objectOverrides: structuredClone(shot.objectOverrides),
    }];
    useProjectStore.setState({ project, workspace: 'shots' });

    const document = createForeSceneBrowserApi().getShotDocument({ id: shot.id });
    expect(document.objectOverrides?.[prop.id]?.transform?.position).toEqual([3, 1, -2]);
    expect(document.cameraKeyframes[0]?.objectOverrides?.[prop.id]?.visible).toBe(false);

    document.objectOverrides![prop.id]!.visible = true;
    expect(useProjectStore.getState().project.shots[0]?.objectOverrides?.[prop.id]?.visible).toBe(false);
  });

  it('imports ordinary geometry through the protected shared model-import service', async () => {
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const project = createDefaultProject();
    const originalShotIds = project.shots.map((shot) => shot.id);
    const originalPanoIds = project.panoRefs.map((pano) => pano.id);
    const originalObjectCount = project.scene.objects.length;
    useProjectStore.setState({ project, workspace: 'build' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (_reason, mutation) => {
      await mutation();
      const live = useProjectStore.getState().project;
      return {
        project: structuredClone(live),
        revision: {
          id: 'rev_model_import',
          projectId: live.id,
          kind: 'autosave',
          reason: 'test',
          createdAt: new Date().toISOString(),
          manifest: '{}',
          resources: { projectAssetKeys: [], modelAssetKeys: [] },
        },
      };
    });

    const result = await createForeSceneBrowserApi().importModel({
      file: new File([
        'v 0 0 0\n',
        'v 1 0 0\n',
        'v 0 1 0\n',
        'f 1 2 3\n',
      ], 'replacement.obj', { type: 'text/plain' }),
    });

    expect(result.ok).toBe(true);
    expect(result.verifiedRevisionId).toBe('rev_model_import');
    expect(result.objectRefs).toHaveLength(1);
    const after = useProjectStore.getState().project;
    expect(after.id).toBe(project.id);
    expect(after.shots.map((shot) => shot.id)).toEqual(originalShotIds);
    expect(after.panoRefs.map((pano) => pano.id)).toEqual(originalPanoIds);
    expect(after.scene.objects).toHaveLength(originalObjectCount + 1);
    expect(after.scene.objects.find((object) => object.id === result.objectRefs![0]!.id)?.type).toBe('imported_model');
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(undefined);
  });

  it('disableWrites demotes write access; UI store escalates', async () => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (_reason, mutation) => {
      await mutation();
      const project = useProjectStore.getState().project;
      return {
        project: structuredClone(project),
        revision: {
          id: 'rev_test',
          projectId: project.id,
          kind: 'autosave',
          reason: 'test',
          createdAt: new Date().toISOString(),
          manifest: '{}',
          resources: { projectAssetKeys: [], modelAssetKeys: [] },
        },
      };
    });
    const api = createForeSceneBrowserApi();
    expect(api.getStatus().writeAccess).toBe(false);
    // Public API cannot escalate.
    expect(Object.prototype.hasOwnProperty.call(api, 'setControlMode')).toBe(false);
    useAgentControlStore.getState().setControlMode('read-write');
    expect(api.getStatus().writeAccess).toBe(true);
    const apply = await api.applyPlan({
      version: 1,
      commands: [{ op: 'project.updateInfo', name: 'Applied Name' }],
    });
    expect(apply.ok).toBe(true);
    expect(useProjectStore.getState().project.name).toBe('Applied Name');
    api.disableWrites();
    expect(api.getStatus().writeAccess).toBe(false);
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(undefined);
  });
});
