import JSZip from 'jszip';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { getModelAssetStorageKey, MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';
import { deleteModelAsset, getModelAsset, putModelAsset, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { createProjectPackage, readProjectFileWithWarnings, validateProjectPackage } from '../src/engine/projectIO';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { loadProjectRevision, saveProjectRevision } from '../src/engine/projectSafety';

function legacySavedRigProject(prefix = MODEL_ASSET_URI_PREFIX) {
  const project = createDefaultProject();
  const actor = createSceneObject('human_dummy');
  actor.poseableCharacter = { kind: 'autorigged', assetId: 'rig', rigId: 'rig' };
  project.scene.objects.push(actor);
  project.assets.assets.rig = {
    id: 'rig', type: 'poseable_rig', name: 'Saved rig', uri: 'data:,{}', createdAt: '',
    metadata: { poseableRig: {
      id: 'rig', version: 1, skeletonJoints: ['hips'],
      skin: { influencesPerVertex: 4, skinAssetId: 'skin' },
      regionMap: { version: 1, regionAssetId: 'region', vertexCount: 1, topologyHash: 'synthetic', sourceAssetId: 'fixture-source' },
    } },
  };
  for (const id of ['skin', 'region'] as const) {
    project.assets.assets[id] = {
      id, name: `${id}.bin`, type: 'other', uri: `${prefix}saved-rig/${id}`,
      storageKey: `saved-rig/${id}`, createdAt: '',
      metadata: id === 'skin' ? { poseableSkin: true } : { poseableRegionMap: true },
    };
  }
  return project;
}

const binaries = { skin: [1, 2, 3, 4], region: [5, 6, 7, 8] };

async function stageBinaries() {
  for (const [id, bytes] of Object.entries(binaries)) {
    await putModelAsset(`saved-rig/${id}`, new Uint8Array(bytes).buffer);
  }
}

describe('saved-rig project binary portability', () => {
  beforeEach(async () => {
    resetModelAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
  });

  it.each([MODEL_ASSET_URI_PREFIX, 'panoref-asset:'])('restores tagged legacy skin/region bytes in a fresh store (%s)', async (prefix) => {
    await stageBinaries();
    const project = legacySavedRigProject(prefix);
    const backup = await createProjectPackage(project);
    const zip = await JSZip.loadAsync(await backup.arrayBuffer());
    const integrity = JSON.parse(await zip.file('integrity.json')!.async('text'));
    for (const id of Object.keys(binaries)) {
      const path = `model-assets/${encodeURIComponent(`saved-rig/${id}`)}.bin`;
      expect(zip.file(path)).toBeTruthy();
      expect(integrity.entries[path].byteLength).toBe(4);
    }
    // The package must be self-contained, independent of the importing profile.
    resetModelAssetStoreForTests();
    await expect(validateProjectPackage(backup)).resolves.toBeUndefined();
    const opened = await readProjectFileWithWarnings(new File([backup], 'saved-rig.fsp'));
    expect(opened.warnings).toEqual([]);
    expect(opened.project.scene.objects.map((object) => object.id)).toEqual(project.scene.objects.map((object) => object.id));
    for (const [id, bytes] of Object.entries(binaries)) {
      const restored = opened.project.assets.assets[id]!;
      expect(restored.type).toBe('model');
      const key = getModelAssetStorageKey(restored)!;
      expect(key).toMatch(/^import\//);
      expect([...new Uint8Array((await getModelAsset(key))!)]).toEqual(bytes);
      expect(project.assets.assets[id]?.type).toBe('other');
    }
  });

  it('retains legacy saved-rig binaries in verified revisions after original keys are removed', async () => {
    await stageBinaries();
    const saved = await saveProjectRevision(legacySavedRigProject(), { reason: 'Saved rig recovery' });
    expect(saved.revision.resources.models).toHaveLength(2);
    await deleteModelAsset('saved-rig/skin');
    await deleteModelAsset('saved-rig/region');
    const restored = await loadProjectRevision(saved.revision.id);
    for (const [id, bytes] of Object.entries(binaries)) {
      const key = getModelAssetStorageKey(restored.project.assets.assets[id]!)!;
      expect([...new Uint8Array((await getModelAsset(key))!)]).toEqual(bytes);
    }
  });

  it('reports each missing skin/region binary in older incomplete backups', async () => {
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(legacySavedRigProject('panoref-asset:')));
    const backup = await zip.generateAsync({ type: 'blob' });
    await expect(validateProjectPackage(backup)).rejects.toThrow('missing binary model asset');
    const opened = await readProjectFileWithWarnings(new File([backup], 'incomplete.fsp'));
    expect(opened.warnings.map((warning) => warning.assetId).sort()).toEqual(['region', 'skin']);
    for (const id of Object.keys(binaries)) {
      expect(opened.project.assets.assets[id]?.resolutionStatus).toBe('missing');
    }
  });
});
