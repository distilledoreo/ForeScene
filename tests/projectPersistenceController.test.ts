import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  ProjectPersistenceController,
  type ProjectPersistenceState,
} from '../src/engine/projectPersistenceController';
import { listProjectRevisionSummaries, recoverLatestProject } from '../src/engine/projectSafety';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';

async function resetSafetyStorage() {
  resetProjectAssetStoreForTests();
  resetModelAssetStoreForTests();
  await resetProjectRevisionStoreForTests();
}

describe('project persistence controller', () => {
  beforeEach(resetSafetyStorage);
  afterEach(resetSafetyStorage);

  it('serializes an automatic pre-delete snapshot before saving the changed project', async () => {
    const states: ProjectPersistenceState[] = [];
    const controller = new ProjectPersistenceController({
      debounceMs: 1,
      onStateChange: (state) => states.push(state),
    });
    const project = createDefaultProject();
    project.scene.objects.push(createSceneObject('box', 1));
    controller.start(project);
    await controller.flush('Initial local save');

    const changed = structuredClone(project);
    changed.scene.objects = [];
    controller.noteProjectChange(changed, project);
    await controller.flush();

    const revisions = await listProjectRevisionSummaries(project.id);
    expect(revisions.some((revision) => revision.reason === 'Before deleting scene objects' && revision.kind === 'snapshot')).toBe(true);
    expect((await recoverLatestProject())?.project.scene.objects).toEqual([]);
    expect(states.some((state) => state.status === 'saving' && state.criticalWrite)).toBe(true);
    expect(states.at(-1)?.status).toBe('saved');
  });

  it('reports a failed write while preserving the prior verified recovery revision', async () => {
    const states: ProjectPersistenceState[] = [];
    const controller = new ProjectPersistenceController({
      debounceMs: 1,
      onStateChange: (state) => states.push(state),
    });
    const project = createDefaultProject();
    project.name = 'Known good controller save';
    controller.start(project);
    await controller.flush();

    const invalid = structuredClone(project);
    invalid.assets.assets.broken = {
      id: 'broken',
      type: 'image',
      name: 'broken.png',
      uri: 'panoref-asset:not-present',
      storageKey: 'not-present',
      createdAt: new Date().toISOString(),
    };
    invalid.panoRefs = [{
      id: 'broken-pano',
      name: 'Broken',
      imageAssetId: 'broken',
      type: 'ai_global_reference',
      projection: 'equirectangular',
      origin: [0, 1.6, 0],
      rotation: [0, 0, 0],
      width: 16,
      height: 8,
      isCanonical: true,
      createdAt: new Date().toISOString(),
    }];
    controller.noteProjectChange(invalid, project);

    await expect(controller.flush()).rejects.toThrow('cannot be resolved');
    expect(states.at(-1)?.status).toBe('failed');
    expect((await recoverLatestProject())?.project.name).toBe('Known good controller save');
  });
});
