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
  regenerateShotStills,
  resetShotStillActionsForTests,
  retryFailedShotStills,
} from '../src/engine/shotStillActions';
import { resolveShotThumbnail } from '../src/domain/shotThumbnails';
import { stillArtifactKey } from '../src/engine/stillArtifactTypes';
import { selectPrimaryStillSpecification, buildStillArtifactSpecificationsForShot } from '../src/engine/stillArtifactPlanning';

function mockRender() {
  return vi.fn(async ({ specification }) => ({
    blob: new Blob([`png-${specification.kind}`], { type: 'image/png' }),
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
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetShotStillActionsForTests();
  });

  it('regenerateShotStills re-materializes configured stills', async () => {
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
    const callsAfterFirst = render.mock.calls.length;

    // Invalidate
    project = {
      ...project,
      shots: project.shots.map((item) =>
        item.id === shotId
          ? { ...item, camera: { ...item.camera, fovDegrees: item.camera.fovDegrees + 4 } }
          : item
      ),
    };

    const regen = await regenerateShotStills({ project, shotId, render });
    expect(regen.status).toBe('ready');
    expect(render.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('retryFailedShotStills only targets stale/missing', async () => {
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

    // Make primary stale via camera edit
    project = {
      ...project,
      shots: project.shots.map((item) =>
        item.id === shotId
          ? { ...item, camera: { ...item.camera, fovDegrees: item.camera.fovDegrees + 2 } }
          : item
      ),
    };
    const before = render.mock.calls.length;
    const retry = await retryFailedShotStills({ project, shotId, render });
    expect(retry.artifacts.some((a) => a.status === 'rendered' || a.status === 'current')).toBe(true);
    expect(render.mock.calls.length).toBeGreaterThan(before);
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
    // Wait until render starts
    for (let i = 0; i < 50 && !started; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cancelled = cancelShotStillPreparation(shotId);
    expect(cancelled.cancelledShotIds).toContain(shotId);
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

    // Edit camera without regenerating — fingerprint no longer matches.
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
  it('applyBuildSceneChange wrapper schedules reconciliation path exists', async () => {
    // Structural: stillReconciliationBridge exports project-level scheduler used by projectSlice.
    const bridge = await import('../src/state/stillReconciliationBridge');
    expect(typeof bridge.scheduleStillReconciliationAfterProjectChange).toBe('function');
    expect(typeof bridge.scheduleStillReconciliationAfterBuildSceneCommit).toBe('function');
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/state/slices/projectSlice.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain('scheduleStillReconciliationAfterBuildSceneCommit');
    expect(source).toContain('scheduleStillReconciliationAfterProjectChange');
  });
});
