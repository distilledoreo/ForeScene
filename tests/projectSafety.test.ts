import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference, createSceneObject } from '../src/domain/defaults';
import { MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';
import { getModelAsset, putModelAsset, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { createProjectPackage, readProjectFile, validateProjectPackage } from '../src/engine/projectIO';
import {
  createProjectSnapshot,
  getPersistentProjectStorageStatus,
  listLocalProjectHistories,
  listProjectRevisionSummaries,
  loadProjectRevision,
  removeLocalProjectHistory,
  recoverLatestProject,
  ProjectStorageQuotaError,
  requestPersistentProjectStorage,
  restoreProjectRevision,
  saveProjectRevision,
} from '../src/engine/projectSafety';
import {
  PROJECT_ASSET_URI_PREFIX,
  failNextProjectAssetBlobWriteForTests,
  getProjectAssetBlob,
  deleteProjectAssetBlob,
  putProjectAssetBlobs,
  resetProjectAssetStoreForTests,
  storeProjectAssetDataUrl,
} from '../src/engine/projectAssetStore';
import {
  failNextProjectRevisionCommitForTests,
  failNextProjectRevisionDeleteForTests,
  resetProjectRevisionStoreForTests,
} from '../src/engine/projectRevisionStore';

async function resetSafetyStorage() {
  resetProjectAssetStoreForTests();
  resetModelAssetStoreForTests();
  await resetProjectRevisionStoreForTests();
}

describe('project safety revisions', () => {
  beforeEach(resetSafetyStorage);
  afterEach(resetSafetyStorage);

  it('stages a verified revision and recovers the latest known-good project', async () => {
    const project = createDefaultProject();
    project.name = 'Reliable courtyard';
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,aGVsbG8=',
      width: 16,
      height: 8,
    }));
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 16,
      height: 8,
      isCanonical: true,
    })];

    const saved = await saveProjectRevision(project, { reason: 'Initial local save' });
    const recovered = await recoverLatestProject();

    expect(saved.revision.resources.projectAssetKeys).toHaveLength(1);
    expect(recovered?.project.name).toBe('Reliable courtyard');
    expect(recovered?.project.assets.assets[asset.id]?.uri.startsWith('blob:')).toBe(true);
    expect(recovered?.recoveredPreviousRevision).toBe(false);
  });

  it('keeps the active revision recoverable when a later save has a missing blob', async () => {
    const project = createDefaultProject();
    project.name = 'Known good';
    await saveProjectRevision(project, { reason: 'Initial local save' });

    const missing = createPanoAsset({
      name: 'missing.png',
      uri: 'panoref-asset:missing/project-blob',
      width: 16,
      height: 8,
    });
    missing.storageKey = 'missing/project-blob';
    project.assets.assets[missing.id] = missing;
    project.panoRefs = [createPanoReference({
      name: 'Broken reference',
      assetId: missing.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 16,
      height: 8,
      isCanonical: true,
    })];

    await expect(saveProjectRevision(project)).rejects.toThrow('cannot be resolved');
    expect((await recoverLatestProject())?.project.name).toBe('Known good');
  });

  it('keeps a timestamped snapshot and restores it without deleting the current revision', async () => {
    const project = createDefaultProject();
    project.name = 'Before replacement';
    await saveProjectRevision(project, { reason: 'Initial local save' });

    project.name = 'Before panorama replacement';
    const snapshot = await createProjectSnapshot(project, 'Before panorama replacement');
    project.name = 'After replacement';
    await saveProjectRevision(project, { reason: 'Automatic save' });

    const restored = await restoreProjectRevision(project.id, snapshot.revision.id);
    const revisions = await listProjectRevisionSummaries(project.id);

    expect(restored.project.name).toBe('Before panorama replacement');
    expect(revisions.some((revision) => revision.id === snapshot.revision.id && revision.kind === 'snapshot')).toBe(true);
    expect(revisions.some((revision) => revision.reason === 'Automatic save')).toBe(true);
  });

  it('does not promote a later revision when the atomic metadata commit is interrupted', async () => {
    const project = createDefaultProject();
    project.name = 'Before interrupted save';
    await saveProjectRevision(project);

    project.name = 'Interrupted save';
    failNextProjectRevisionCommitForTests();

    await expect(saveProjectRevision(project)).rejects.toThrow('Injected project revision commit failure');
    expect((await recoverLatestProject())?.project.name).toBe('Before interrupted save');
  });

  it('keeps the active revision recoverable when a staged binary store write fails', async () => {
    const project = createDefaultProject();
    project.name = 'Known good before binary failure';
    await saveProjectRevision(project);

    const sourceKey = `project/${project.id}/asset/failing-reference`;
    await putProjectAssetBlobs([{
      key: sourceKey,
      blob: new Blob(['reference-bytes'], { type: 'image/png' }),
    }]);
    const asset = createPanoAsset({
      name: 'failing-reference.png',
      uri: `${PROJECT_ASSET_URI_PREFIX}${sourceKey}`,
      width: 16,
      height: 8,
    });
    asset.storageKey = sourceKey;
    asset.mimeType = 'image/png';
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference', assetId: asset.id, type: 'ai_global_reference', origin: [0, 1.6, 0], width: 16, height: 8, isCanonical: true,
    })];

    failNextProjectAssetBlobWriteForTests();
    await expect(saveProjectRevision(project)).rejects.toThrow('Injected project asset storage write failure');
    expect((await recoverLatestProject())?.project.name).toBe('Known good before binary failure');
  });

  it('rejects a known quota shortfall before starting a large project write', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn(async () => ({ usage: 900, quota: 1000 })),
      },
    });
    const project = createDefaultProject();
    try {
      await expect(saveProjectRevision(project)).rejects.toBeInstanceOf(ProjectStorageQuotaError);
      expect(await recoverLatestProject()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains the latest ten recovery snapshots without removing the active or previous revision', async () => {
    const project = createDefaultProject();
    for (let index = 0; index < 12; index += 1) {
      project.name = `Snapshot ${index}`;
      await createProjectSnapshot(project, `Milestone ${index}`);
    }

    const snapshots = (await listProjectRevisionSummaries(project.id)).filter((revision) => revision.kind === 'snapshot');

    expect(snapshots).toHaveLength(10);
    expect(snapshots[0]?.reason).toBe('Milestone 11');
    expect(snapshots.at(-1)?.reason).toBe('Milestone 2');
  });

  it('leaves the active recovery project intact when a validated import cannot stage its binaries', async () => {
    const active = createDefaultProject();
    active.name = 'Current recoverable project';
    await saveProjectRevision(active);

    const imported = createDefaultProject();
    imported.name = 'Incoming project';
    const sourceKey = `project/${imported.id}/asset/incoming-reference`;
    await putProjectAssetBlobs([{
      key: sourceKey,
      blob: new Blob(['incoming-reference'], { type: 'image/png' }),
    }]);
    const asset = createPanoAsset({
      name: 'incoming-reference.png',
      uri: `${PROJECT_ASSET_URI_PREFIX}${sourceKey}`,
      width: 16,
      height: 8,
    });
    asset.storageKey = sourceKey;
    asset.mimeType = 'image/png';
    imported.assets.assets[asset.id] = asset;
    imported.panoRefs = [createPanoReference({
      name: 'Incoming Reference', assetId: asset.id, type: 'ai_global_reference', origin: [0, 1.6, 0], width: 16, height: 8, isCanonical: true,
    })];
    const backup = await createProjectPackage(imported);

    failNextProjectAssetBlobWriteForTests();
    await expect(readProjectFile(new File([backup], 'incoming.panoref-project'))).rejects.toThrow('Injected project asset storage write failure');
    expect((await recoverLatestProject())?.project.name).toBe('Current recoverable project');
  });

  it('round-trips a validated portable backup with both image and model binaries', async () => {
    const project = createDefaultProject();
    project.name = 'Portable complete project';
    const imageKey = `project/${project.id}/asset/reference`;
    await putProjectAssetBlobs([{
      key: imageKey,
      blob: new Blob(['reference-image'], { type: 'image/png' }),
    }]);
    const image = createPanoAsset({
      name: 'reference.png',
      uri: `${PROJECT_ASSET_URI_PREFIX}${imageKey}`,
      width: 16,
      height: 8,
    });
    image.storageKey = imageKey;
    image.mimeType = 'image/png';
    project.assets.assets[image.id] = image;
    project.panoRefs = [createPanoReference({
      name: 'Reference', assetId: image.id, type: 'ai_global_reference', origin: [0, 1.6, 0], width: 16, height: 8, isCanonical: true,
    })];

    const modelKey = `project/${project.id}/model/mesh`;
    await putModelAsset(modelKey, new Uint8Array([1, 2, 3, 4]).buffer);
    project.assets.assets.mesh = {
      id: 'mesh',
      type: 'model',
      name: 'mesh.panoref-mesh',
      uri: `${MODEL_ASSET_URI_PREFIX}${modelKey}`,
      createdAt: new Date(0).toISOString(),
    };
    const modelObject = createSceneObject('box', 1);
    modelObject.type = 'imported_model';
    modelObject.modelAssetId = 'mesh';
    project.scene.objects.push(modelObject);

    const backup = await createProjectPackage(project);
    await expect(validateProjectPackage(backup)).resolves.toBeUndefined();
    resetProjectAssetStoreForTests();
    resetModelAssetStoreForTests();

    const restored = await readProjectFile(new File([backup], 'portable.panoref-project'));
    const restoredImage = restored.assets.assets[image.id];
    const restoredModel = restored.assets.assets.mesh;

    expect(restored.name).toBe('Portable complete project');
    expect(restored.panoRefs[0]?.imageAssetId).toBe(image.id);
    expect(await (await getProjectAssetBlob(restoredImage.storageKey!))?.text()).toBe('reference-image');
    expect(Array.from(new Uint8Array((await getModelAsset(restoredModel.uri.slice(MODEL_ASSET_URI_PREFIX.length)))!))).toEqual([1, 2, 3, 4]);
  });

  it('recovers an older healthy snapshot after both active autosaves fail validation', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png', uri: 'data:image/png;base64,Zmlyc3Q=', width: 16, height: 8,
    }));
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference', assetId: asset.id, type: 'ai_global_reference', origin: [0, 1.6, 0], width: 16, height: 8, isCanonical: true,
    })];
    project.name = 'Snapshot fallback';
    const snapshot = await createProjectSnapshot(project, 'Milestone before unstable saves');

    project.assets.assets[asset.id] = storeProjectAssetDataUrl(project.id, {
      ...asset, uri: 'data:image/png;base64,c2Vjb25k', storageKey: undefined,
    });
    const previous = await saveProjectRevision(project, { reason: 'Autosave before failure' });
    project.assets.assets[asset.id] = storeProjectAssetDataUrl(project.id, {
      ...asset, uri: 'data:image/png;base64,dGhpcmQ=', storageKey: undefined,
    });
    const active = await saveProjectRevision(project, { reason: 'Latest autosave before failure' });

    await deleteProjectAssetBlob(active.revision.resources.projectAssets![0]!.key);
    await deleteProjectAssetBlob(previous.revision.resources.projectAssets![0]!.key);

    const recovered = await recoverLatestProject();

    expect(recovered?.revision.id).toBe(snapshot.revision.id);
    expect(recovered?.recoveredPreviousRevision).toBe(true);
    expect((await listProjectRevisionSummaries(project.id)).find((revision) => revision.id === snapshot.revision.id)?.isActive).toBe(true);
  });

  it('rejects same-length binary corruption instead of trusting a content-addressed key', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png', uri: 'data:image/png;base64,YWJjZA==', width: 16, height: 8,
    }));
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference', assetId: asset.id, type: 'ai_global_reference', origin: [0, 1.6, 0], width: 16, height: 8, isCanonical: true,
    })];
    const saved = await saveProjectRevision(project);
    const resource = saved.revision.resources.projectAssets![0]!;

    await putProjectAssetBlobs([{ key: resource.key, blob: new Blob(['wxyz'], { type: 'image/png' }) }]);

    await expect(loadProjectRevision(saved.revision.id)).rejects.toThrow('SHA-256 integrity verification');
  });

  it('keeps a durable active save successful when revision maintenance fails', async () => {
    const project = createDefaultProject();
    for (let index = 0; index < 8; index += 1) {
      project.name = `Autosave ${index}`;
      await saveProjectRevision(project);
    }
    project.name = 'Verified despite cleanup warning';
    failNextProjectRevisionDeleteForTests();

    const saved = await saveProjectRevision(project);

    expect(saved.maintenanceWarning).toContain('new verified save is safe');
    expect((await recoverLatestProject())?.project.name).toBe('Verified despite cleanup warning');
  });

  it('lists and intentionally removes older local project histories', async () => {
    const current = createDefaultProject();
    current.name = 'Current project';
    const older = createDefaultProject();
    older.name = 'Older project';
    await saveProjectRevision(older);
    await saveProjectRevision(current);

    const histories = await listLocalProjectHistories();
    expect(histories.map((history) => history.name)).toEqual(expect.arrayContaining(['Current project', 'Older project']));

    const removed = await removeLocalProjectHistory(older.id);
    expect(removed.revisionsRemoved).toBe(1);
    expect((await listLocalProjectHistories()).some((history) => history.projectId === older.id)).toBe(false);
  });

  it('reports browser persistence status without treating unsupported storage as a save failure', async () => {
    const persisted = vi.fn(async () => true);
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persisted, persist } });
    try {
      await expect(getPersistentProjectStorageStatus()).resolves.toEqual({ supported: true, persistent: true, requested: false });
      await expect(requestPersistentProjectStorage()).resolves.toEqual({ supported: true, persistent: true, requested: false });
      expect(persist).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
