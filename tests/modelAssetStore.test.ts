import { beforeEach, describe, expect, it } from 'vitest';
import { deleteModelAsset, getModelAsset, putModelAsset, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { createDefaultProject, createTransform } from '../src/domain/defaults';
import { encodeBinaryGrayboxMesh, encodePackedGrayboxMesh, MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMesh';
import { createProjectPackage, readProjectFile } from '../src/engine/projectIO';
import JSZip from 'jszip';

describe('binary model asset storage', () => {
  beforeEach(resetModelAssetStoreForTests);

  it('creates, retrieves, and deletes binary geometry without sharing mutable buffers', async () => {
    await putModelAsset('mesh/a', new Uint8Array([1, 2, 3]).buffer);
    const first = new Uint8Array((await getModelAsset('mesh/a'))!);
    first[0] = 9;
    expect(Array.from(new Uint8Array((await getModelAsset('mesh/a'))!))).toEqual([1, 2, 3]);
    await deleteModelAsset('mesh/a');
    expect(await getModelAsset('mesh/a')).toBeUndefined();
  });

  it('does not create an asset when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(putModelAsset('mesh/cancelled', new ArrayBuffer(8), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await getModelAsset('mesh/cancelled')).toBeUndefined();
  });

  it('round-trips a binary-backed model through a project package', async () => {
    const packed = encodeBinaryGrayboxMesh(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]));
    await putModelAsset('project/mesh', packed.buffer);
    const project = createDefaultProject();
    project.assets.assets.mesh = { id: 'mesh', type: 'model', name: 'mesh.panoref-mesh', uri: `${MODEL_ASSET_URI_PREFIX}project/mesh`, createdAt: new Date(0).toISOString() };
    project.scene.objects.push({ id: 'model-object', name: 'Model', type: 'imported_model', transform: createTransform(), dimensions: [1, 1, 0.001], category: 'architecture', locked: false, visible: true, modelAssetId: 'mesh' });
    const blob = await createProjectPackage(project);
    resetModelAssetStoreForTests();
    const reopened = await readProjectFile(new File([blob], 'scene.panoref-project'));
    expect(reopened.assets.assets.mesh.uri.startsWith(`${MODEL_ASSET_URI_PREFIX}import/`)).toBe(true);
    expect(await getModelAsset(reopened.assets.assets.mesh.uri.slice(MODEL_ASSET_URI_PREFIX.length))).toBeTruthy();
  });

  it('migrates legacy base64 geometry into a binary package on save', async () => {
    const legacy = encodePackedGrayboxMesh(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]));
    const project = createDefaultProject();
    project.assets.assets.mesh = { id: 'mesh', type: 'model', name: 'legacy.panoref-mesh', uri: legacy.uri, createdAt: new Date(0).toISOString() };
    project.scene.objects.push({ id: 'model-object', name: 'Model', type: 'imported_model', transform: createTransform(), dimensions: [1, 1, 0.001], category: 'architecture', locked: false, visible: true, modelAssetId: 'mesh' });
    const zip = await JSZip.loadAsync(await (await createProjectPackage(project)).arrayBuffer());
    const manifest = await zip.file('project.json')!.async('text');
    expect(manifest).toContain(MODEL_ASSET_URI_PREFIX);
    expect(manifest).not.toContain(';base64,');
  });

  it('reports a recoverable missing binary in a project package', async () => {
    const project = createDefaultProject();
    project.assets.assets.mesh = { id: 'mesh', type: 'model', name: 'missing.panoref-mesh', uri: `${MODEL_ASSET_URI_PREFIX}missing/key`, createdAt: new Date(0).toISOString() };
    project.scene.objects.push({ id: 'model-object', name: 'Model', type: 'imported_model', transform: createTransform(), dimensions: [1, 1, 0.001], category: 'architecture', locked: false, visible: true, modelAssetId: 'mesh' });
    await expect(createProjectPackage(project)).rejects.toThrow('binary model asset missing.panoref-mesh is missing');
  });

  it('does not overwrite existing model storage when another package binary is missing', async () => {
    await putModelAsset('existing/key', new Uint8Array([9]).buffer);
    const project = createDefaultProject();
    project.assets.assets.first = {
      id: 'first',
      type: 'model',
      name: 'first.panoref-mesh',
      uri: `${MODEL_ASSET_URI_PREFIX}existing/key`,
      createdAt: new Date(0).toISOString(),
    };
    project.assets.assets.second = {
      id: 'second',
      type: 'model',
      name: 'second.panoref-mesh',
      uri: `${MODEL_ASSET_URI_PREFIX}missing/key`,
      createdAt: new Date(0).toISOString(),
    };
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(project));
    zip.file(`model-assets/${encodeURIComponent('existing/key')}.bin`, new Uint8Array([1, 2, 3]));

    await expect(readProjectFile(new File([
      await zip.generateAsync({ type: 'blob' }),
    ], 'broken.panoref-project'))).rejects.toThrow('binary model asset second.panoref-mesh');

    expect(Array.from(new Uint8Array((await getModelAsset('existing/key'))!))).toEqual([9]);
  });

  it('stages valid imported model data under a fresh key instead of overwriting an open project key', async () => {
    await putModelAsset('project/shared-mesh', new Uint8Array([9, 9, 9]).buffer);
    const project = createDefaultProject();
    project.assets.assets.mesh = {
      id: 'mesh',
      type: 'model',
      name: 'shared.panoref-mesh',
      uri: `${MODEL_ASSET_URI_PREFIX}project/shared-mesh`,
      createdAt: new Date().toISOString(),
    };
    project.scene.objects.push({ id: 'model-object', name: 'Model', type: 'imported_model', transform: createTransform(), dimensions: [1, 1, 0.001], category: 'architecture', locked: false, visible: true, modelAssetId: 'mesh' });
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(project));
    zip.file(`model-assets/${encodeURIComponent('project/shared-mesh')}.bin`, new Uint8Array([1, 2, 3]));

    const imported = await readProjectFile(new File([
      await zip.generateAsync({ type: 'blob' }),
    ], 'replacement.panoref-project'));
    const importedKey = imported.assets.assets.mesh.uri.slice(MODEL_ASSET_URI_PREFIX.length);

    expect(Array.from(new Uint8Array((await getModelAsset('project/shared-mesh'))!))).toEqual([9, 9, 9]);
    expect(importedKey).not.toBe('project/shared-mesh');
    expect(Array.from(new Uint8Array((await getModelAsset(importedKey))!))).toEqual([1, 2, 3]);
  });
});
