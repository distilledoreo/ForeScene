import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { commitPreparedStillArtifact } from '../src/engine/commitPreparedStillArtifact';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import {
  createProjectPackage,
  readProjectFile,
  serializeProject,
  validateProjectPackage,
} from '../src/engine/projectIO';
import {
  getProjectAssetBlob,
  resetProjectAssetStoreForTests,
} from '../src/engine/projectAssetStore';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { computeStillArtifactFingerprint } from '../src/engine/stillArtifactFingerprint';
import { inspectShotStillRuntime } from '../src/engine/stillArtifactRuntime';
import { stillArtifactKey, type StillArtifactSpecification } from '../src/engine/stillArtifactTypes';

function primaryClaySpec(project = createDefaultProject()): StillArtifactSpecification {
  const shot = project.shots[0]!;
  return {
    kind: 'clay-viewport',
    appearance: 'clay',
    peopleVariant: 'with_people',
    width: shot.exportSettings.width,
    height: shot.exportSettings.height,
  };
}

function renderMock() {
  return vi.fn(async ({ specification }: { specification: StillArtifactSpecification }) => ({
    blob: new Blob(['portable-prepared-still'], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

describe('prepared-media portability and legacy migration', () => {
  beforeEach(() => {
    resetProjectAssetStoreForTests();
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  afterEach(() => {
    resetProjectAssetStoreForTests();
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('round-trips a materialized still and its PNG bytes through an .fsp backup', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const specification = primaryClaySpec(project);
    const fingerprint = computeStillArtifactFingerprint(project, shot, specification);
    const preparedBlob = new Blob(['portable-prepared-still'], { type: 'image/png' });

    const committed = await commitPreparedStillArtifact({
      project,
      shotId: shot.id,
      specification,
      expectedFingerprint: fingerprint.key,
      prepared: {
        fingerprint,
        artifactKey: stillArtifactKey(specification),
        blob: preparedBlob,
        width: specification.width,
        height: specification.height,
        mimeType: 'image/png',
        cacheStatus: 'rendered',
      },
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const packageBlob = await createProjectPackage(committed.project);
    await validateProjectPackage(packageBlob);

    // Prove the imported project does not depend on the source session's memory cache.
    resetProjectAssetStoreForTests();
    const imported = await readProjectFile(new File(
      [packageBlob],
      'prepared-media-roundtrip.fsp',
      { type: 'application/zip' },
    ));

    const importedShot = imported.shots.find((item) => item.id === shot.id)!;
    const key = stillArtifactKey(specification);
    const importedArtifact = importedShot.materializedMedia?.stills[key];
    expect(importedArtifact).toBeDefined();
    expect(importedArtifact?.fingerprint).toBe(fingerprint.key);

    const importedAsset = importedArtifact
      ? imported.assets.assets[importedArtifact.assetId]
      : undefined;
    expect(importedAsset?.storageKey).toBeTruthy();
    const restoredBlob = importedAsset?.storageKey
      ? await getProjectAssetBlob(importedAsset.storageKey)
      : undefined;
    expect(restoredBlob).toBeDefined();
    expect(await restoredBlob?.text()).toBe('portable-prepared-still');

    const status = inspectShotStillRuntime(imported, importedShot);
    expect(status.primary?.status).toBe('ready');
  });

  it('opens a pre-materialization project lazily and prepares references only on demand', async () => {
    const legacy = createDefaultProject();
    for (const shot of legacy.shots) delete shot.materializedMedia;

    const imported = await readProjectFile(new File(
      [serializeProject(legacy)],
      'legacy-project.json',
      { type: 'application/json' },
    ));
    const shot = imported.shots[0]!;
    const before = inspectShotStillRuntime(imported, shot);
    expect(before.overall).toBe('missing');
    expect(shot.materializedMedia).toBeUndefined();

    const render = renderMock();
    const prepared = await materializeShotStills({
      project: imported,
      shotId: shot.id,
      reason: 'capture',
      scope: 'primary',
      render,
    });

    expect(prepared.status).toBe('ready');
    expect(render).toHaveBeenCalledTimes(1);
    expect(prepared.primaryStillAssetId).toBeTruthy();
    expect(
      prepared.project.shots[0]!.materializedMedia?.stills[
        stillArtifactKey(primaryClaySpec(prepared.project))
      ],
    ).toBeDefined();
  });
});
