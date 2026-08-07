import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { cleanupUnreferencedProjectAssetPayloads } from '../src/engine/projectAssetMaintenance';
import {
  getProjectAssetBlob,
  registerProjectAssetBlob,
  resetProjectAssetStoreForTests,
} from '../src/engine/projectAssetStore';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';

describe('managed blob-url cleanup compatibility', () => {
  beforeEach(async () => {
    resetProjectAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
  });

  afterEach(async () => {
    resetProjectAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
  });

  it('keeps a live managed blob URL whose legacy asset omitted storageKey', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const assetId = 'asset-legacy-managed-blob';
    const storageKey = `project/${project.id}/asset/${assetId}`;
    const uri = registerProjectAssetBlob(
      storageKey,
      new Blob(['legacy-managed-live'], { type: 'image/png' }),
    );

    project.assets.assets[assetId] = {
      id: assetId,
      type: 'image',
      name: 'legacy-managed-live.png',
      uri,
      mimeType: 'image/png',
      width: 8,
      height: 8,
      createdAt: new Date().toISOString(),
    };
    shot.assets.viewportRenderAssetId = assetId;

    const whileLive = await cleanupUnreferencedProjectAssetPayloads(project);
    expect(whileLive.keys).not.toContain(storageKey);
    expect(await getProjectAssetBlob(storageKey)).toBeDefined();

    shot.assets.viewportRenderAssetId = undefined;
    delete project.assets.assets[assetId];

    const afterRemoval = await cleanupUnreferencedProjectAssetPayloads(project);
    expect(afterRemoval.keys).toContain(storageKey);
    expect(await getProjectAssetBlob(storageKey)).toBeUndefined();
  });
});