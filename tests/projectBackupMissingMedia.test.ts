import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createDefaultProject, createPanoAsset, createPanoReference } from '../src/domain/defaults';
import { createProjectPackage, readProjectFileWithWarnings, validateProjectFile, validateProjectPackage } from '../src/engine/projectIO';
import { PROJECT_ASSET_URI_PREFIX, putProjectAssetBlobs, resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import type { ProjectAsset } from '../src/domain/types';

function projectWithMedia(type: 'image' | 'video', status?: ProjectAsset['resolutionStatus']) {
  const project = createDefaultProject();
  const asset: ProjectAsset = {
    ...createPanoAsset({ name: 'missing-media', uri: `${PROJECT_ASSET_URI_PREFIX}absent-media`, width: 2, height: 1 }),
    type,
    storageKey: 'absent-media',
    resolutionStatus: status,
    mimeType: type === 'image' ? 'image/png' : 'video/mp4',
  };
  project.assets.assets[asset.id] = asset;
  if (type === 'image') {
    project.panoRefs = [createPanoReference({ name: 'Reference', assetId: asset.id, type: 'ai_global_reference', origin: [0, 1.6, 0], width: 2, height: 1, isCanonical: true })];
  } else {
    project.shots[0].assets.cameraMoveVideoAssetId = asset.id;
  }
  return { project, asset };
}

describe('portable backups with unavailable image and video assets', () => {
  beforeEach(() => resetProjectAssetStoreForTests());

  it.each(['image', 'video'] as const)('validates and reopens a %s placeholder when its binary is missing', async (type) => {
    const { project, asset } = projectWithMedia(type);
    const blob = await createProjectPackage(project);
    await expect(validateProjectPackage(blob)).resolves.toBeUndefined();
    const file = new File([blob], 'missing-media.fsp');
    const validated = await validateProjectFile(file);
    expect(validated.assets.assets[asset.id].resolutionStatus).toBe('missing');
    const opened = await readProjectFileWithWarnings(file);
    expect(opened.project.assets.assets[asset.id].resolutionStatus).toBe('missing');
    expect(opened.project.assets.assets[asset.id].storageKey).toBe(asset.storageKey);
    expect(type === 'image' ? opened.project.panoRefs[0].imageAssetId : opened.project.shots[0].assets.cameraMoveVideoAssetId).toBe(asset.id);
  });

  it('still rejects missing bytes for assets declared available', async () => {
    const { project, asset } = projectWithMedia('image', 'available');
    await putProjectAssetBlobs([{ key: asset.storageKey!, blob: new Blob(['image'], { type: 'image/png' }) }]);
    const blob = await createProjectPackage(project);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    zip.remove('project-assets/absent-media.bin');
    const damaged = await zip.generateAsync({ type: 'blob' });
    await expect(validateProjectPackage(damaged)).rejects.toThrow('missing binary asset');
    await expect(validateProjectFile(new File([damaged], 'damaged.fsp'))).rejects.toThrow('missing binary asset');
    const recovered = await readProjectFileWithWarnings(new File([damaged], 'damaged.fsp'));
    expect(recovered.project.assets.assets[asset.id].resolutionStatus).toBe('missing');
    expect(recovered.warnings).toHaveLength(1);
  });

  it.each(['missing', 'corrupt', 'unsupported'] as const)('does not package stale local bytes for an explicitly %s asset', async (status) => {
    const { project, asset } = projectWithMedia('image', status);
    await putProjectAssetBlobs([{ key: asset.storageKey!, blob: new Blob(['stale'], { type: 'image/png' }) }]);
    const blob = await createProjectPackage(project);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).filter((path) => path.endsWith('.bin'))).toEqual([]);
    await expect(validateProjectPackage(blob)).resolves.toBeUndefined();
    const opened = await readProjectFileWithWarnings(new File([blob], 'unavailable.fsp'));
    expect(opened.project.assets.assets[asset.id].resolutionStatus).toBe(status);
  });
});
