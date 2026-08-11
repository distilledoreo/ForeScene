import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import {
  cancelShotStillPreparation,
  captureShotStillPreparation,
  regenerateShotStills,
  resetShotStillActionsForTests,
  retryFailedShotStills,
} from '../src/engine/shotStillActions';
import { resolveShotThumbnail } from '../src/domain/shotThumbnails';
import { stillArtifactKey } from '../src/engine/stillArtifactTypes';
import { buildStillArtifactSpecificationsForShot, selectPrimaryStillSpecification } from '../src/engine/stillArtifactPlanning';
import {
  resetStillArtifactRuntimeForTests,
  setStillArtifactError,
} from '../src/engine/stillArtifactRuntime';

function mockRender() {
  return vi.fn(async ({ specification }) => ({
    blob: new Blob([`png-${specification.kind}-${Date.now()}`], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

function minimalProject() {
  const project = createDefaultProject();
  const shot = project.shots[0]!;
  shot.exportSettings = {
    ...shot.exportSettings,
    includeViewport: true,
    includeProjectedViewport: false,
    includeCameraMoveReferenceFrames: false,
    includeProjectedCameraMoveReferenceFrames: false,
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
    depth: { ...defaultShotDepthSettings, enabled: false },
    peopleExportMode: 'with_people',
  };
  return project;
}

describe('shot still actions + stale thumbnails', () => {
  beforeEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetShotStillActionsForTests();
    resetStillArtifactRuntimeForTests();
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetShotStillActionsForTests();
    resetStillArtifactRuntimeForTests();
  });

  it('regenerateShotStills forces a fresh render even when the artifact is current', async () => {
    let project = minimalProject();
    const shotId = project.shots[0]!.id;
    const render = mockRender();
    const first = await materializeShotStills({
      project,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render,
    });
    project = first.project;
    const firstAssetId = first.primaryStillAssetId;
    render.mockClear();

    const regen = await regenerateShotStills({ project, shotId, render });
    expect(regen.status).toBe('ready');
    expect(render).toHaveBeenCalledTimes(1);
    expect(regen.artifacts).toHaveLength(1);
    expect(regen.artifacts[0]?.status).toBe('rendered');
    expect(regen.primaryStillAssetId).toBeTruthy();
    expect(regen.primaryStillAssetId).not.toBe(firstAssetId);
  });

  it('retryFailedShotStills forces a runtime-failed key even when its stored fingerprint is current', async () => {
    let project = minimalProject();
    const shotId = project.shots[0]!.id;
    const render = mockRender();
    const first = await materializeShotStills({
      project,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render,
    });
    project = first.project;

    const shot = project.shots[0]!;
    const specs = buildStillArtifactSpecificationsForShot({ project, shot, purpose: 'reconcile' });
    const primary = selectPrimaryStillSpecification(project, shot, specs);
    const key = stillArtifactKey(primary);
    setStillArtifactError(shotId, key, 'previous render failed');
    render.mockClear();

    const retry = await retryFailedShotStills({ project, shotId, render });
    expect(render).toHaveBeenCalledTimes(1);
    expect(retry.artifacts).toHaveLength(1);
    expect(retry.artifacts[0]?.key).toBe(key);
    expect(retry.artifacts[0]?.status).toBe('rendered');
  });

  it('retryFailedShotStills targets a fingerprint-stale artifact', async () => {
    let project = minimalProject();
    const shotId = project.shots[0]!.id;
    const render = mockRender();
    const first = await materializeShotStills({
      project,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render,
    });
    project = first.project;
    project = {
      ...project,
      shots: project.shots.map((item) =>
        item.id === shotId
          ? { ...item, camera: { ...item.camera, fovDegrees: item.camera.fovDegrees + 2 } }
          : item
      ),
    };
    render.mockClear();
    const retry = await retryFailedShotStills({ project, shotId, render });
    expect(retry.artifacts.some((a) => a.status === 'rendered')).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('cancelShotStillPreparation aborts in-flight batch', async () => {
    const project = minimalProject();
    const shotId = project.shots[0]!.id;
    let started = false;
    const render = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      started = true;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () =>
          reject(Object.assign(new Error('Still materialization was cancelled.'), { name: 'AbortError' }));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => resolve(), 5_000);
      });
      return {
        blob: new Blob(['x'], { type: 'image/png' }),
        width: 8,
        height: 8,
        mimeType: 'image/png' as const,
      };
    });

    const promise = regenerateShotStills({ project, shotId, render });
    for (let i = 0; i < 50 && !started; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cancelled = cancelShotStillPreparation(shotId);
    expect(cancelled.cancelledShotIds).toContain(shotId);
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('capture-time preparation participates in the same cancellation registry', async () => {
    const project = minimalProject();
    const shotId = project.shots[0]!.id;
    let started = false;
    const render = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      started = true;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('capture cancelled'), { name: 'AbortError' }));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(resolve, 5_000);
      });
      return { blob: new Blob(['x'], { type: 'image/png' }), width: 8, height: 8, mimeType: 'image/png' as const };
    });

    const promise = captureShotStillPreparation({ project, shotId, render });
    for (let i = 0; i < 50 && !started; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(cancelShotStillPreparation(shotId).cancelledShotIds).toContain(shotId);
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('resolveShotThumbnail marks fingerprint-stale primary as stale', async () => {
    let project = minimalProject();
    const shot = project.shots[0]!;
    const render = mockRender();
    const first = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'primary',
      render,
    });
    project = first.project;
    const liveShot = project.shots[0]!;
    const readyThumb = resolveShotThumbnail(project, liveShot);
    expect(readyThumb.stale).toBe(false);
    expect(readyThumb.source).toBe('materialized_primary');

    const editedShot = {
      ...liveShot,
      camera: { ...liveShot.camera, fovDegrees: liveShot.camera.fovDegrees + 9 },
    };
    const editedProject = {
      ...project,
      shots: project.shots.map((item) => (item.id === shot.id ? editedShot : item)),
    };
    const staleThumb = resolveShotThumbnail(editedProject, editedShot);
    expect(staleThumb.asset).toBeDefined();
    expect(staleThumb.stale).toBe(true);
    expect(staleThumb.source).toBe('materialized_primary_stale');
  });
});

describe('project change reconciliation hook surface', () => {
  it('build-scene and project-level scheduling surfaces exist', async () => {
    const bridge = await import('../src/state/stillReconciliationBridge');
    expect(typeof bridge.scheduleStillReconciliationAfterProjectChange).toBe('function');
    expect(typeof bridge.scheduleStillReconciliationAfterBuildSceneCommit).toBe('function');
    expect(typeof bridge.rebindStillReconciliation).toBe('function');
  });
});
