import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { ensureStillArtifactForExport } from '../src/engine/ensureStillArtifactForExport';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import {
  listProjectAssetBlobKeys,
  resetProjectAssetStoreForTests,
} from '../src/engine/projectAssetStore';
import {
  resetPrepareStillArtifactInflightForTests,
} from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
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
    blob: new Blob(['prepared-media-regression'], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

function bumpShotCamera(project: LocationProject, shotId: string): LocationProject {
  return {
    ...project,
    shots: project.shots.map((shot) =>
      shot.id === shotId
        ? {
          ...shot,
          camera: {
            ...shot.camera,
            fovDegrees: shot.camera.fovDegrees + 9,
          },
        }
        : shot
    ),
  };
}

describe('prepared-media final commit concurrency', () => {
  beforeEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetProjectAssetStoreForTests();
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetProjectAssetStoreForTests();
  });

  it('export recovery preserves unrelated edits made at the final live merge boundary', async () => {
    let live = createDefaultProject();
    const frozen = structuredClone(live);
    const shotId = frozen.shots[0]!.id;
    const specification = claySpec(frozen);
    const concurrentName = 'Concurrent export edit survives';
    let injected = false;

    const result = await ensureStillArtifactForExport({
      frozenProject: frozen,
      shotId,
      specification,
      render: renderMock(),
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        if (!injected) {
          injected = true;
          live = { ...live, name: concurrentName };
        }
        live = updater(live);
        return live;
      },
    });

    expect(result.source).toBe('render-recovery');
    expect(live.name).toBe(concurrentName);
    const artifact = live.shots[0]!.materializedMedia?.stills[stillArtifactKey(specification)];
    expect(artifact?.assetId).toBeTruthy();
    expect(live.assets.assets[artifact!.assetId]).toBeDefined();
  });

  it('export recovery rejects a post-write stale result without leaving persisted bytes', async () => {
    let live = createDefaultProject();
    const frozen = structuredClone(live);
    const shotId = frozen.shots[0]!.id;
    const specification = claySpec(frozen);
    const keysBefore = await listProjectAssetBlobKeys();
    let injected = false;

    const result = await ensureStillArtifactForExport({
      frozenProject: frozen,
      shotId,
      specification,
      render: renderMock(),
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        if (!injected) {
          injected = true;
          live = bumpShotCamera(live, shotId);
        }
        live = updater(live);
        return live;
      },
    });

    expect(result.source).toBe('render-recovery');
    expect(result.assetId).toBeUndefined();
    expect(live.shots[0]!.materializedMedia?.stills[stillArtifactKey(specification)]).toBeUndefined();
    expect(await listProjectAssetBlobKeys()).toEqual(keysBefore);
  });

  it('normal materialization deletes a durable asset rejected by the post-write fingerprint check', async () => {
    let live = createDefaultProject();
    const shotId = live.shots[0]!.id;
    const specification = claySpec(live);
    const keysBefore = await listProjectAssetBlobKeys();
    let injected = false;

    const result = await materializeShotStills({
      project: live,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render: renderMock(),
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        if (!injected) {
          injected = true;
          live = bumpShotCamera(live, shotId);
        }
        live = updater(live);
        return live;
      },
    });

    expect(result.status).toBe('failed');
    expect(result.artifacts.some((artifact) => artifact.status === 'failed')).toBe(true);
    expect(live.shots[0]!.materializedMedia?.stills[stillArtifactKey(specification)]).toBeUndefined();
    expect(await listProjectAssetBlobKeys()).toEqual(keysBefore);
  });

  it('batch materialization removes newly written assets rejected at the live merge boundary', async () => {
    let live = createDefaultProject();
    const shotId = live.shots[0]!.id;
    const keysBefore = await listProjectAssetBlobKeys();
    let injected = false;
    let commitCalls = 0;

    const result = await materializeShotStills({
      project: live,
      shotId,
      reason: 'capture',
      scope: 'all-configured',
      batchCommit: true,
      render: renderMock(),
      getLiveProject: () => live,
      commitLiveProject: (updater) => {
        commitCalls += 1;
        if (commitCalls > 1 && !injected) {
          injected = true;
          live = bumpShotCamera(live, shotId);
        }
        live = updater(live);
        return live;
      },
    });

    expect(result.status).toBe('failed');
    expect(result.artifacts.some((artifact) => artifact.status === 'failed')).toBe(true);
    expect(live.shots[0]!.materializedMedia?.stills).toBeUndefined();
    expect(await listProjectAssetBlobKeys()).toEqual(keysBefore);
  });
});
