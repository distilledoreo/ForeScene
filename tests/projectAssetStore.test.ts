import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference } from '../src/domain/defaults';
import { createProjectPackage, readProjectFile, validateProjectPackage } from '../src/engine/projectIO';
import {
  PROJECT_ASSET_URI_PREFIX,
  getProjectAssetBlob,
  resetProjectAssetStoreForTests,
  storeProjectAssetDataUrl,
} from '../src/engine/projectAssetStore';

describe('local-first raster and video assets', () => {
  afterEach(() => {
    resetProjectAssetStoreForTests();
  });

  it('replaces a base64 data URL with a compact object URL and IndexedDB key', async () => {
    const project = createDefaultProject();
    const stored = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,aGVsbG8=',
      width: 16,
      height: 8,
    }));

    expect(stored.storageKey).toBeTruthy();
    expect(stored.uri.startsWith('data:')).toBe(false);
    expect(await getProjectAssetBlob(stored.storageKey!)).toBeInstanceOf(Blob);
  });

  it('packages stored image bytes separately and restores a usable local URL on import', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,aGVsbG8=',
      width: 16,
      height: 8,
    }));
    const pano = createPanoReference({
      name: 'Reference',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: [0, 1.65, 0],
      width: 16,
      height: 8,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [pano];

    const packageBlob = await createProjectPackage(project);
    await expect(validateProjectPackage(packageBlob)).resolves.toBeUndefined();
    const zip = await JSZip.loadAsync(await packageBlob.arrayBuffer());
    const manifest = JSON.parse(await zip.file('project.json')!.async('text')) as typeof project;
    const packagedAsset = manifest.assets.assets[asset.id];

    expect(packagedAsset.uri).toBe(`${PROJECT_ASSET_URI_PREFIX}${asset.storageKey}`);
    expect(zip.file(`project-assets/${encodeURIComponent(asset.storageKey!)}.bin`)).toBeTruthy();

    const reopened = await readProjectFile(new File([packageBlob], 'reference.panoref-project'));
    const reopenedAsset = reopened.assets.assets[asset.id];
    expect(reopenedAsset.storageKey).not.toBe(asset.storageKey);
    expect(reopenedAsset.storageKey).toMatch(new RegExp(`^import/${project.id}/`));
    expect(reopenedAsset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)).toBe(false);
    expect(await getProjectAssetBlob(reopenedAsset.storageKey!)).toBeInstanceOf(Blob);
  });

  it('stages imported raster bytes under a fresh key instead of overwriting an open project asset', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,b2xk',
      width: 16,
      height: 8,
    }));
    const pano = createPanoReference({
      name: 'Reference',
      assetId: asset.id,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      width: 16,
      height: 8,
      isCanonical: true,
    });
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [pano];
    const manifest = structuredClone(project);
    manifest.assets.assets[asset.id].uri = `${PROJECT_ASSET_URI_PREFIX}${asset.storageKey}`;
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(manifest));
    zip.file(`project-assets/${encodeURIComponent(asset.storageKey!)}.bin`, new TextEncoder().encode('new'));

    const imported = await readProjectFile(new File([
      await zip.generateAsync({ type: 'blob' }),
    ], 'replacement.panoref-project'));
    const importedKey = imported.assets.assets[asset.id].storageKey!;

    expect(await (await getProjectAssetBlob(asset.storageKey!))?.text()).toBe('old');
    expect(importedKey).not.toBe(asset.storageKey);
    expect(await (await getProjectAssetBlob(importedKey))?.text()).toBe('new');
  });

  it('rejects a backup with a missing binary before it can be presented as valid', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png',
      uri: 'data:image/png;base64,aGVsbG8=',
      width: 16,
      height: 8,
    }));
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference', assetId: asset.id, type: 'ai_global_reference', origin: [0, 1.6, 0], width: 16, height: 8, isCanonical: true,
    })];
    const zip = await JSZip.loadAsync(await (await createProjectPackage(project)).arrayBuffer());
    zip.remove(`project-assets/${encodeURIComponent(asset.storageKey!)}.bin`);

    await expect(validateProjectPackage(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow('missing binary asset');
  });

  it('rejects same-length tampering in a generated portable backup', async () => {
    const project = createDefaultProject();
    const asset = storeProjectAssetDataUrl(project.id, createPanoAsset({
      name: 'reference.png', uri: 'data:image/png;base64,YWJjZA==', width: 16, height: 8,
    }));
    project.assets.assets[asset.id] = asset;
    project.panoRefs = [createPanoReference({
      name: 'Reference', assetId: asset.id, type: 'ai_global_reference', origin: [0, 1.6, 0], width: 16, height: 8, isCanonical: true,
    })];
    const zip = await JSZip.loadAsync(await (await createProjectPackage(project)).arrayBuffer());
    zip.file(`project-assets/${encodeURIComponent(asset.storageKey!)}.bin`, new TextEncoder().encode('wxyz'));

    await expect(validateProjectPackage(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow('SHA-256 integrity verification');
  });
});
