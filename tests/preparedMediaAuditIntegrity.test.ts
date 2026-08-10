import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { LocationProject, ProjectAsset } from '../src/domain/types';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import { cleanupUnreferencedProjectAssetPayloads } from '../src/engine/projectAssetMaintenance';
import {
  deleteProjectAssetBlob,
  getProjectAssetBlob,
  resetProjectAssetStoreForTests,
  storeProjectAssetBlobDurable,
} from '../src/engine/projectAssetStore';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { createStillReconciliationScheduler } from '../src/engine/stillArtifactReconciliation';
import { stillArtifactKey, type StillArtifactSpecification } from '../src/engine/stillArtifactTypes';

function claySpec(project: LocationProject): StillArtifactSpecification {
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
    blob: new Blob([`render:${specification.kind}`], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

function bumpCamera(project: LocationProject, shotId = project.shots[0]!.id): LocationProject {
  return {
    ...project,
    shots: project.shots.map((shot) => shot.id === shotId ? {
      ...shot,
      camera: { ...shot.camera, fovDegrees: shot.camera.fovDegrees + 3 },
    } : shot),
  };
}

async function materializeOne(params: {
  live: LocationProject;
  render: ReturnType<typeof renderMock>;
}): Promise<{ live: LocationProject; assetId: string; key: string }> {
  let live = params.live;
  const shotId = live.shots[0]!.id;
  const specification = claySpec(live);
  const key = stillArtifactKey(specification);
  const result = await materializeShotStills({
    project: live,
    shotId,
    reason: 'capture',
    scope: 'all-configured',
    artifactKeys: new Set([key]),
    render: params.render,
    getLiveProject: () => live,
    commitLiveProject: (updater) => {
      live = updater(live);
      return live;
    },
  });
  const assetId = result.artifacts.find((artifact) => artifact.key === key)?.assetId;
  expect(assetId).toBeTruthy();
  return { live, assetId: assetId!, key };
}

describe('prepared-media audit integrity regressions', () => {
  beforeEach(async () => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetProjectAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
  });

  afterEach(async () => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetProjectAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
  });

  it('repairs a fingerprint-current still when its backing bytes were deleted', async () => {
    const initialRender = renderMock();
    const first = await materializeOne({ live: createDefaultProject(), render: initialRender });
    const asset = first.live.assets.assets[first.assetId]!;
    expect(asset.storageKey).toBeTruthy();
    await deleteProjectAssetBlob(asset.storageKey!);
    expect(await getProjectAssetBlob(asset.storageKey!)).toBeUndefined();

    let live = first.live;
    const recoveryRender = renderMock();
    const result = await materializeShotStills({
      project: live,
      shotId: live.shots[0]!.id,
      reason: 'edit',
      scope: 'stale-only',
      artifactKeys: new Set([first.key]),
      render: recoveryRender,
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        live = updater(live);
        return live;
      },
    });

    expect(recoveryRender).toHaveBeenCalledTimes(1);
    expect(result.artifacts.find((artifact) => artifact.key === first.key)?.status).toBe('rendered');
    const nextId = live.shots[0]!.materializedMedia!.stills[first.key]!.assetId;
    expect(nextId).not.toBe(first.assetId);
    expect(await getProjectAssetBlob(live.assets.assets[nextId]!.storageKey!)).toBeDefined();
  });

  it('removes a superseded still record only after the latest live merge proves it unreferenced', async () => {
    const first = await materializeOne({ live: createDefaultProject(), render: renderMock() });
    const assetCountBefore = Object.keys(first.live.assets.assets).length;
    const oldStorageKey = first.live.assets.assets[first.assetId]!.storageKey!;

    let live = bumpCamera(first.live);
    const result = await materializeShotStills({
      project: live,
      shotId: live.shots[0]!.id,
      reason: 'edit',
      scope: 'stale-only',
      artifactKeys: new Set([first.key]),
      render: renderMock(),
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        live = updater(live);
        return live;
      },
    });

    const nextId = result.artifacts.find((artifact) => artifact.key === first.key)?.assetId;
    expect(nextId).toBeTruthy();
    expect(nextId).not.toBe(first.assetId);
    expect(live.assets.assets[first.assetId]).toBeUndefined();
    expect(Object.keys(live.assets.assets)).toHaveLength(assetCountBefore);
    expect(await getProjectAssetBlob(oldStorageKey)).toBeUndefined();
  });

  it('does not let cleanup of an older save delete an asset already present in the newer live project', async () => {
    const savedSnapshot = createDefaultProject();
    const assetId = 'asset-save-race';
    const base: ProjectAsset = {
      id: assetId,
      type: 'image',
      name: 'newer-prepared.png',
      uri: '',
      mimeType: 'image/png',
      width: 32,
      height: 18,
      createdAt: new Date().toISOString(),
    };
    const stored = await storeProjectAssetBlobDurable(
      savedSnapshot.id,
      base,
      new Blob(['newer-unsaved'], { type: 'image/png' }),
    );
    const live = {
      ...savedSnapshot,
      assets: {
        ...savedSnapshot.assets,
        assets: { ...savedSnapshot.assets.assets, [stored.id]: stored },
      },
    };

    const cleanup = await cleanupUnreferencedProjectAssetPayloads(savedSnapshot, {
      getLiveProject: () => live,
    });

    expect(cleanup.keys).not.toContain(stored.storageKey);
    expect(await getProjectAssetBlob(stored.storageKey!)).toBeDefined();
  });

  it('protects bytes written after save start even before their live manifest merge', async () => {
    const savedSnapshot = createDefaultProject();
    const saveStartedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const base: ProjectAsset = {
      id: 'asset-mid-save',
      type: 'image',
      name: 'mid-save.png',
      uri: '',
      mimeType: 'image/png',
      width: 16,
      height: 9,
      createdAt: new Date().toISOString(),
    };
    const stored = await storeProjectAssetBlobDurable(
      savedSnapshot.id,
      base,
      new Blob(['mid-save'], { type: 'image/png' }),
    );

    // Simulate the exact microtask window where durable bytes exist but the live
    // project has not yet accepted the artifact record.
    const cleanup = await cleanupUnreferencedProjectAssetPayloads(savedSnapshot, {
      getLiveProject: () => savedSnapshot,
      protectWrittenAtOrAfter: saveStartedAt,
    });

    expect(cleanup.keys).not.toContain(stored.storageKey);
    expect(await getProjectAssetBlob(stored.storageKey!)).toBeDefined();
  });

  it('reconciliation does not perform a redundant whole-project write after transactional commits', async () => {
    const first = await materializeOne({ live: createDefaultProject(), render: renderMock() });
    let live = bumpCamera(first.live);
    let setProjectCalls = 0;

    const completion = new Promise<void>((resolve, reject) => {
      const scheduler = createStillReconciliationScheduler({
        debounceMs: 0,
        getProject: () => live,
        setProject: (project) => {
          setProjectCalls += 1;
          live = project;
        },
        render: renderMock(),
        onComplete: (_shotId, result) => {
          try {
            const rendered = result.artifacts.filter((artifact) => artifact.status === 'rendered').length;
            expect(setProjectCalls).toBe(1 + rendered);
            scheduler.dispose();
            resolve();
          } catch (error) {
            scheduler.dispose();
            reject(error);
          }
        },
        onError: (_shotId, error) => reject(error),
      });
      scheduler.schedule([live.shots[0]!.id]);
    });

    await completion;
  });

  it('rejects queued cancellation immediately without waiting for the active render', async () => {
    let releaseActive!: () => void;
    const active = renderWorkCoordinator.schedule(
      'background-video',
      () => new Promise<void>((resolve) => { releaseActive = resolve; }),
      { ownerId: 'shot-active' },
    );
    await Promise.resolve();

    const queued = renderWorkCoordinator.schedule(
      'capture-primary-still',
      async () => 42,
      { ownerId: 'shot-queued' },
    );
    expect(renderWorkCoordinator.cancelByOwner('shot-queued')).toBe(1);
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });

    releaseActive();
    await active;
  });
});
