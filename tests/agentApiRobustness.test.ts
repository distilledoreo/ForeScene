import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject, createShot } from '../src/domain/defaults';
import type { LocationProject, ObjectGroup } from '../src/domain/types';
import { createId } from '../src/utils/ids';
import { inspectAgentShotDiagnostics } from '../src/engine/agent/shotDiagnostics';
import { identifyFloorY } from '../src/engine/agent/spatialShotState';
import {
  createAgentObjectGroup,
  inspectAgentObjectGroup,
  listAgentObjectGroups,
} from '../src/engine/agent/objectGroupControl';
import {
  getAgentLoadedProjectSource,
  markAgentProjectSource,
} from '../src/engine/agent/projectImportControl';
import {
  listAgentArtifacts,
  registerAgentArtifact,
  resetAgentArtifactRegistryForTests,
} from '../src/engine/agent/artifactRegistry';
import {
  submitAgentJob,
  getAgentJob,
  cancelAgentJob,
  resetAgentJobsForTests,
} from '../src/engine/agent/jobQueue';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

function installMockDestructiveMutation() {
  useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (_reason, mutation) => {
    await mutation();
    const project = useProjectStore.getState().project;
    return {
      project: structuredClone(project),
      revision: {
        id: `rev_${Date.now().toString(36)}`,
        projectId: project.id,
        kind: 'autosave' as const,
        reason: 'test',
        createdAt: new Date().toISOString(),
        manifest: '{}',
        resources: { projectAssetKeys: [], modelAssetKeys: [] },
      },
    };
  });
}

describe('agent API robustness', () => {
  beforeEach(() => {
    useAgentControlStore.getState().setControlMode('read-write');
    useProjectStore.getState().setProject(createDefaultProject());
    installMockDestructiveMutation();
    resetAgentArtifactRegistryForTests();
    resetAgentJobsForTests();
  });

  afterEach(() => {
    useAgentControlStore.getState().setControlMode('off');
    resetAgentArtifactRegistryForTests();
    resetAgentJobsForTests();
  });

  it('reports missing diagnostic subjects instead of silently skipping them', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const diagnostics = inspectAgentShotDiagnostics({
      project,
      shot,
      subjectIds: ['missing-subject-id'],
    });
    expect(diagnostics.subjects).toHaveLength(0);
    expect(diagnostics.diagnostics.some((item) => item.code === 'subject_missing')).toBe(true);
  });

  it('uses shot-effective floors for grounding diagnostics', () => {
    const floor = createSceneObject('floor', 1);
    floor.dimensions = [10, 0.1, 10];
    floor.transform.position = [0, 0, 0];

    const hiddenFloor = createSceneObject('floor', 1);
    hiddenFloor.dimensions = [10, 0.1, 10];
    hiddenFloor.transform.position = [0, 5, 0];

    const actor = createSceneObject('human_dummy', 1, [0, 1, 0]);
    const project: LocationProject = {
      ...createDefaultProject(),
      scene: {
        ...createDefaultProject().scene,
        objects: [floor, hiddenFloor, actor],
      },
    };
    const shot = createShot({
      index: 1,
      camera: project.shots[0]!.camera,
    });
    shot.objectOverrides = {
      [hiddenFloor.id]: { visible: false },
    };
    project.shots = [shot];

    const baseFloorY = identifyFloorY(project, actor.transform.position);
    const effectiveObjects = project.scene.objects.map((object) => (
      object.id === hiddenFloor.id ? { ...object, visible: false } : object
    ));
    const effectiveFloorY = identifyFloorY(project, actor.transform.position, effectiveObjects);
    expect(baseFloorY).toBeGreaterThan(4);
    expect(effectiveFloorY).toBeLessThan(1);
  });

  it('creates and inspects logical object groups', async () => {
    const project = useProjectStore.getState().project;
    const a = createSceneObject('box', 1);
    const b = createSceneObject('box', 1);
    useProjectStore.setState({
      project: {
        ...project,
        scene: { ...project.scene, objects: [...project.scene.objects, a, b] },
      },
    });

    const result = await createAgentObjectGroup({
      name: 'Creature parts',
      objectIds: [a.id, b.id],
    });
    expect(result.ok).toBe(true);
    expect(result.groupId).toBeTruthy();

    const group = inspectAgentObjectGroup(result.groupId!);
    expect(group?.objectIds).toEqual([a.id, b.id]);
    expect(listAgentObjectGroups().length).toBe(1);
  });

  it('tracks loaded project source metadata', () => {
    markAgentProjectSource('import', 'demo.fsp');
    const source = getAgentLoadedProjectSource();
    expect(source.source).toBe('import');
    expect(source.sourceLabel).toBe('demo.fsp');
  });

  it('submits and cancels async jobs', () => {
    const submitted = submitAgentJob({
      type: 'render-shot-batch',
      jobs: ['a', 'b', 'c'],
      concurrency: 1,
    });
    expect(submitted.ok).toBe(true);
    expect(submitted.jobId).toBeTruthy();

    const job = getAgentJob(submitted.jobId!);
    expect(job?.totalItems).toBe(3);

    const cancelled = cancelAgentJob(submitted.jobId!);
    expect(cancelled.ok).toBe(true);
  });

  it('lists registered artifacts with filters', () => {
    registerAgentArtifact({
      blob: new Blob(['test'], { type: 'image/png' }),
      mimeType: 'image/png',
      fileName: 'shot.png',
      revisionId: 'rev_test',
      shotId: 'shot_1',
    });
    const listed = listAgentArtifacts({ shotId: 'shot_1' });
    expect(listed.length).toBe(1);
    expect(listed[0]?.fileName).toBe('shot.png');
  });
});
