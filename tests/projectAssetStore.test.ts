import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference } from '../src/domain/defaults';
import { createProjectPackage, readProjectFile } from '../src/engine/projectIO';
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
    const zip = await JSZip.loadAsync(await packageBlob.arrayBuffer());
    const manifest = JSON.parse(await zip.file('project.json')!.async('text')) as typeof project;
    const packagedAsset = manifest.assets.assets[asset.id];

    expect(packagedAsset.uri).toBe(`${PROJECT_ASSET_URI_PREFIX}${asset.storageKey}`);
    expect(zip.file(`project-assets/${encodeURIComponent(asset.storageKey!)}.bin`)).toBeTruthy();

    const reopened = await readProjectFile(new File([packageBlob], 'reference.panoref-project'));
    const reopenedAsset = reopened.assets.assets[asset.id];
    expect(reopenedAsset.storageKey).toBe(asset.storageKey);
    expect(reopenedAsset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)).toBe(false);
    expect(await getProjectAssetBlob(reopenedAsset.storageKey!)).toBeInstanceOf(Blob);
  });
});
