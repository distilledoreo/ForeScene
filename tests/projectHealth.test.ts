import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createPanoAsset, createPanoReference, createSceneObject } from '../src/domain/defaults';
import { repairProjectHealth, runProjectHealthCheck } from '../src/engine/projectHealth';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { resetProjectAssetStoreForTests, storeProjectAssetDataUrl } from '../src/engine/projectAssetStore';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';

async function resetSafetyStorage() {
  resetProjectAssetStoreForTests();
  resetModelAssetStoreForTests();
  await resetProjectRevisionStoreForTests();
}

describe('project health', () => {
  beforeEach(resetSafetyStorage);
  afterEach(resetSafetyStorage);

  it('finds broken relationships, missing media, invalid cameras, and stale registry data', async () => {
    const project = createDefaultProject();
    const object = createSceneObject('box', 1);
    object.modelAssetId = 'missing-model';
    project.scene.objects.push(object);
    project.shots[0].linkedPanoId = 'missing-pano';
    project.shots[0].assets.viewportRenderAssetId = 'missing-media';
    project.shots[0].camera = {
      ...project.shots[0].camera,
      fovDegrees: 200,
      near: 3,
      far: 1,
    };
    const orphan = createPanoAsset({
      name: 'orphan.png',
      uri: 'data:image/png;base64,aGVsbG8=',
      width: 16,
      height: 8,
    });
    project.assets.assets[orphan.id] = orphan;

    const report = await runProjectHealthCheck(project);
    const codes = report.issues.map((entry) => entry.code);

    expect(codes).toEqual(expect.arrayContaining([
      'missing-model-reference',
      'broken-shot-pano-reference',
      'missing-shot-media',
      'invalid-shot-camera',
      'orphaned-asset-registry-entry',
    ]));
    expect(report.issues.some((entry) => entry.repairable)).toBe(true);
  });

  it('repairs only stale reference bookkeeping and orphaned registry entries', () => {
    const project = createDefaultProject();
    project.shots[0].linkedPanoId = 'missing-pano';
    project.shots[0].assets.viewportRenderAssetId = 'missing-media';
    const orphan = createPanoAsset({
      name: 'orphan.png',
      uri: 'data:image/png;base64,aGVsbG8=',
      width: 16,
      height: 8,
    });
    project.assets.assets[orphan.id] = orphan;

    const repaired = repairProjectHealth(project);

    expect(repaired.project.shots[0].linkedPanoId).toBeUndefined();
    expect(repaired.project.shots[0].assets.viewportRenderAssetId).toBeUndefined();
    expect(repaired.project.assets.assets[orphan.id]).toBeUndefined();
    expect(repaired.repairedIssueCodes).toEqual(expect.arrayContaining([
      'broken-shot-pano-reference',
      'missing-shot-media',
      'orphaned-asset-registry-entry',
    ]));
  });

  it('reports logical size and largest local assets without treating them as temporary data', async () => {
    const project = createDefaultProject();
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

    const report = await runProjectHealthCheck(project);

    expect(report.storage.logicalProjectBytes).toBeGreaterThan(0);
    expect(report.storage.largestAssets[0]?.id).toBe(asset.id);
    expect(report.storage.temporaryLocalBytes).toBe(0);
  });
});
