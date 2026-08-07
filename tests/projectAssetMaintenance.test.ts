import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { commitPreparedStillArtifact } from '../src/engine/commitPreparedStillArtifact';
import { cleanupUnreferencedProjectAssetPayloads } from '../src/engine/projectAssetMaintenance';
import {
  getProjectAssetBlob,
  listProjectAssetBlobKeys,
  resetProjectAssetStoreForTests,
} from '../src/engine/projectAssetStore';
import {
  loadProjectRevision,
  saveProjectRevision,
} from '../src/engine/projectSafety';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import { stillArtifactKey, type StillArtifactSpecification } from '../src/engine/stillArtifactTypes';

function claySpec(project = createDefaultProject()): StillArtifactSpecification {
  const shot = project.shots[0]!;
  return {
    kind: 'clay-viewport',
    appearance: 'clay',
    peopleVariant: 'with_people',
    width: shot.exportSettings.width,
    height: shot.exportSettings.height,
  };
}

describe('revision-safe project asset maintenance', () => {
  beforeEach(async () => {
    resetProjectAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
  });

  afterEach(async () => {
    resetProjectAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
  });

  it('removes an unreferenced transient prepared still while the prior revision remains recoverable', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const specification = claySpec(project);
    const fingerprint = computeStillArtifactFingerprint(project, shot, specification);

    const committed = await commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification,
      expectedFingerprint: fingerprint.key,
      prepared: {
        fingerprint,
        artifactKey: stillArtifactKey(specification),
        blob: new Blob(['revision-safe-still'], { type: 'image/png' }),
        width: specification.width,
        height: specification.height,
        mimeType: 'image/png',
        cacheStatus: 'rendered',
      },
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const transientAsset = committed.project.assets.assets[committed.assetId]!;
    expect(transientAsset.storageKey).toMatch(new RegExp(`^project/${project.id}/`));
    expect(await getProjectAssetBlob(transientAsset.storageKey!)).toBeDefined();

    const saved = await saveProjectRevision(committed.project, {
      reason: 'Before prepared still removal',
    });

    // Simulate an output removal/deletion after the verified revision has pinned
    // its own content-addressed recovery bytes.
    const withoutStill = {
      ...committed.project,
      shots: committed.project.shots.map((item) =>
        item.id === shot.id
          ? {
            ...item,
            materializedMedia: undefined,
            assets: {
              ...item.assets,
              viewportRenderAssetId: undefined,
            },
          }
          : item
      ),
      assets: {
        ...committed.project.assets,
        assets: Object.fromEntries(
          Object.entries(committed.project.assets.assets)
            .filter(([assetId]) => assetId !== committed.assetId),
        ),
      },
    };

    const cleanup = await cleanupUnreferencedProjectAssetPayloads(withoutStill);
    expect(cleanup.keys).toContain(transientAsset.storageKey);
    expect(await getProjectAssetBlob(transientAsset.storageKey!)).toBeUndefined();

    // The old verified revision must still restore the still from its immutable
    // content-addressed recovery resource.
    const restored = await loadProjectRevision(saved.revision.id);
    const restoredShot = restored.project.shots.find((item) => item.id === shot.id)!;
    const artifact = restoredShot.materializedMedia?.stills[stillArtifactKey(specification)];
    expect(artifact).toBeDefined();
    const restoredAsset = artifact
      ? restored.project.assets.assets[artifact.assetId]
      : undefined;
    expect(restoredAsset?.storageKey).toBeTruthy();
    expect(restoredAsset?.storageKey).not.toBe(transientAsset.storageKey);
    expect(await getProjectAssetBlob(restoredAsset!.storageKey!)).toBeDefined();

    const keys = await listProjectAssetBlobKeys();
    expect(keys).not.toContain(transientAsset.storageKey);
    expect(keys).toContain(restoredAsset!.storageKey!);
  });
});
