import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference, createSceneObject } from '../src/domain/defaults';
import { saveProjectRevision, recoverLatestProject } from '../src/engine/projectSafety';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { PROJECT_ASSET_URI_PREFIX, putProjectAssetBlobs, getProjectAssetBlob, deleteProjectAssetBlob, resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';
import { putModelAsset, getModelAsset, deleteModelAsset, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';

async function fixture() {
  const project = createDefaultProject();
  const key = `project/${project.id}/image`;
  const blob = new Blob(['retained-image'], { type: 'image/png' });
  await putProjectAssetBlobs([{ key, blob }]);
  const asset = { ...createPanoAsset({ name: 'reference.png', uri: `${PROJECT_ASSET_URI_PREFIX}${key}`, width: 16, height: 8 }), storageKey: key };
  project.assets.assets[asset.id] = asset;
  project.panoRefs = [createPanoReference({ name: 'Reference', assetId: asset.id, type: 'external_reference', origin: [0, 1.6, 0], width: 16, height: 8, isCanonical: true })];
  return { project, asset, blob };
}

beforeEach(async () => {
  resetProjectAssetStoreForTests(); resetModelAssetStoreForTests();
  await resetProjectRevisionStoreForTests();
});

describe('recovery copies are not authoritative cache hits', () => {
  it('recreates a removed cached image copy from the still-available original', async () => {
    const { project, blob } = await fixture();
    const first = await saveProjectRevision(project);
    const key = first.revision.resources.projectAssetKeys[0];
    await deleteProjectAssetBlob(key);
    const next = await saveProjectRevision(project);
    expect(next.revision.resources.projectAssetKeys).toEqual([key]);
    expect(await (await getProjectAssetBlob(key))!.text()).toBe(await blob.text());
    expect((await recoverLatestProject())?.revision.id).toBe(next.revision.id);
  });

  it('recreates a missing recovery-key image from a verified live blob URL', async () => {
    const { project, asset, blob } = await fixture();
    const saved = await saveProjectRevision(project);
    const key = saved.revision.resources.projectAssetKeys[0];
    const url = URL.createObjectURL(blob);
    try {
      project.assets.assets[asset.id] = { ...asset, storageKey: key, uri: url };
      await deleteProjectAssetBlob(key);
      const next = await saveProjectRevision(project);
      expect(next.revision.resources.projectAssetKeys).toEqual([key]);
      expect(await (await getProjectAssetBlob(key))!.text()).toBe(await blob.text());
    } finally { URL.revokeObjectURL(url); }
  });

  it('does not substitute different bytes under a recovery digest or advance the last good head', async () => {
    const { project, asset } = await fixture();
    // A last-good revision without the damaged asset remains genuinely readable.
    const safe = createDefaultProject(); safe.id = project.id; safe.name = 'Last good';
    const good = await saveProjectRevision(safe);
    const staged = await saveProjectRevision(project);
    const key = staged.revision.resources.projectAssetKeys[0];
    const url = URL.createObjectURL(new Blob(['wrong-content'], { type: 'image/png' }));
    try {
      project.assets.assets[asset.id] = { ...asset, storageKey: key, uri: url };
      await deleteProjectAssetBlob(key);
      await expect(saveProjectRevision(project)).rejects.toThrow();
      expect(await getProjectAssetBlob(key)).toBeUndefined();
      expect((await recoverLatestProject())?.revision.id).toBe(good.revision.id);
    } finally { URL.revokeObjectURL(url); }
  });

  it('recreates a missing cached model copy without changing original source bytes', async () => {
    const project = createDefaultProject();
    const key = `project/${project.id}/model`;
    const bytes = new TextEncoder().encode('immutable GLB source bytes').buffer;
    await putModelAsset(key, bytes);
    project.assets.assets.model = { id: 'model', name: 'model.glb', type: 'model', uri: `${MODEL_ASSET_URI_PREFIX}${key}`, storageKey: key, createdAt: new Date().toISOString() };
    project.scene.objects.push({ ...createSceneObject('imported_model'), modelAssetId: 'model' });
    const first = await saveProjectRevision(project);
    const recoveryKey = first.revision.resources.modelAssetKeys[0];
    await deleteModelAsset(recoveryKey);
    await saveProjectRevision(project);
    expect(new Uint8Array((await getModelAsset(recoveryKey))!)).toEqual(new Uint8Array(bytes));
  });
});
