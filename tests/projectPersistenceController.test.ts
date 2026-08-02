import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  ProjectPersistenceController,
  type ProjectPersistenceState,
} from '../src/engine/projectPersistenceController';
import { listProjectRevisionSummaries, loadProjectRevision, recoverLatestProject } from '../src/engine/projectSafety';
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
    const failed = states.at(-1)!;
    expect(failed.status).toBe('failed');
    expect(failed.message).toBeTruthy();
    // Prior verified recovery remains the openable project (F5 storage failure path).
    // Failed writes must not promote the broken project to the recovery head.
    expect((await recoverLatestProject())?.project.name).toBe('Known good controller save');
    expect((await recoverLatestProject())?.project.assets.assets.broken).toBeUndefined();
  });

  it('surfaces injected asset-cache failures as failed status without clearing recovery metadata (F5)', async () => {
    const states: ProjectPersistenceState[] = [];
    const controller = new ProjectPersistenceController({
      debounceMs: 1,
      onStateChange: (state) => states.push(state),
    });
    const project = createDefaultProject();
    project.name = 'F5 durable before asset fail';
    controller.start(project);
    await controller.flushAndLoadActiveRevision('Verified save before asset failure');
    const saved = states.at(-1)!;
    expect(saved.status).toBe('saved');
    expect(saved.lastSavedAt).toBeTruthy();
    expect(saved.activeRevisionId).toBeTruthy();

    controller.reportAssetPersistenceFailure(new Error('QuotaExceededError: simulated full storage'));
    const failed = states.at(-1)!;
    expect(failed.status).toBe('failed');
    expect(failed.message).toMatch(/could not be written locally/i);
    expect(failed.message).toMatch(/QuotaExceededError|previous verified save/i);
    expect(failed.lastSavedAt).toBe(saved.lastSavedAt);
    expect(failed.activeRevisionId).toBe(saved.activeRevisionId);
    expect((await recoverLatestProject())?.project.name).toBe('F5 durable before asset fail');
  });

  it('commits a destructive snapshot before applying the live mutation', async () => {
    const controller = new ProjectPersistenceController({ debounceMs: 1, onStateChange: () => undefined });
    const before = createDefaultProject();
    before.scene.objects.push(createSceneObject('box', 1));
    controller.start(before);
    await controller.flushAndLoadActiveRevision('Initial local save');
    let current = before;
    let snapshotWasDurable = false;

    const verified = await controller.runDestructiveMutation(
      before,
      'Before deleting scene objects',
      async () => {
        snapshotWasDurable = (await listProjectRevisionSummaries(before.id))
          .some((revision) => revision.kind === 'snapshot' && revision.reason === 'Before deleting scene objects');
        current = structuredClone(before);
        current.scene.objects = [];
        controller.noteProjectChange(current, before);
      },
      () => current,
    );

    expect(snapshotWasDurable).toBe(true);
    expect(verified?.project.scene.objects).toEqual([]);
    expect((await listProjectRevisionSummaries(before.id)).some((revision) => revision.reason === 'Before deleting scene objects')).toBe(true);
  });

  it('captures the current project when a queued destructive mutation begins', async () => {
    const controller = new ProjectPersistenceController({ debounceMs: 1, onStateChange: () => undefined });
    const stale = createDefaultProject();
    stale.name = 'Stale call-time project';
    stale.scene.objects.push(createSceneObject('box', 1));
    controller.start(stale);
    await controller.flushAndLoadActiveRevision('Initial local save');
    let current = stale;

    const pending = controller.runDestructiveMutation(
      stale,
      'Before deleting scene objects',
      () => {
        const changed = structuredClone(current);
        changed.scene.objects = [];
        controller.noteProjectChange(changed, current);
        current = changed;
      },
      () => current,
    );

    current = structuredClone(stale);
    current.name = 'Latest state at queue drain';
    const verified = await pending;
    const snapshot = (await listProjectRevisionSummaries(stale.id))
      .find((revision) => revision.kind === 'snapshot' && revision.reason === 'Before deleting scene objects');

    expect(snapshot).toBeDefined();
    expect((await loadProjectRevision(snapshot!.id)).project.name).toBe('Latest state at queue drain');
    expect(verified?.project.name).toBe('Latest state at queue drain');
    expect(verified?.project.scene.objects).toEqual([]);
  });

  it('returns an immutable loaded revision for export instead of mutable editor state', async () => {
    const controller = new ProjectPersistenceController({ debounceMs: 1, onStateChange: () => undefined });
    const project = createDefaultProject();
    project.name = 'Verified export input';
    controller.start(project);
    const verified = await controller.flushAndLoadActiveRevision('Verified save before export');
    const changed = structuredClone(project);
    changed.name = 'Mutable editor change after export started';
    controller.noteProjectChange(changed, project);

    expect(verified?.project.name).toBe('Verified export input');
    expect(verified?.revision.id).toBeTruthy();
  });

  it('flushes the supplied live project when persistence has not observed its change yet', async () => {
    const controller = new ProjectPersistenceController({ debounceMs: 1, onStateChange: () => undefined });
    const initial = createDefaultProject();
    initial.name = 'Initial controller state';
    controller.start(initial);
    await controller.flushAndLoadActiveRevision('Initial local save');

    const liveStoreProject = structuredClone(initial);
    liveStoreProject.name = 'Normalized live store state';
    const verified = await controller.flushCurrentProject(
      liveStoreProject,
      'Verified save before package export',
    );

    expect(verified?.project.name).toBe('Normalized live store state');
    expect((await recoverLatestProject())?.project.name).toBe('Normalized live store state');
  });

  it('keeps prior save metadata visible when a later write fails', async () => {
    const states: ProjectPersistenceState[] = [];
    const controller = new ProjectPersistenceController({ debounceMs: 1, onStateChange: (state) => states.push(state) });
    const project = createDefaultProject();
    controller.start(project);
    await controller.flushAndLoadActiveRevision();
    const prior = states.at(-1)!;
    controller.reportAssetPersistenceFailure(new Error('Injected later asset write failure.'));
    const failed = states.at(-1)!;
    expect(failed.lastSavedAt).toBe(prior.lastSavedAt);
    expect(failed.activeRevisionId).toBe(prior.activeRevisionId);
  });
});
