import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import {
  materializeShotAfterCapture,
  materializeShotStills,
} from '../src/engine/materializeShotStills';
import {
  buildStillArtifactSpecificationsForShot,
  selectPrimaryStillSpecification,
} from '../src/engine/stillArtifactPlanning';
import { stillArtifactKey } from '../src/engine/stillArtifactTypes';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { resetPreparedMediaMetrics, getPreparedMediaMetrics } from '../src/engine/preparedMediaMetrics';

function mockRender() {
  let calls = 0;
  return vi.fn(async ({ specification }) => {
    calls += 1;
    await Promise.resolve();
    return {
      blob: new Blob([`png-${specification.kind}-${calls}`], { type: 'image/png' }),
      width: specification.width,
      height: specification.height,
      mimeType: 'image/png' as const,
    };
  });
}

function disableOptionalExports<T extends { exportSettings: import('../src/domain/types').ShotExportSettings }>(
  shot: T,
  extra: Partial<T['exportSettings']> = {},
): T {
  shot.exportSettings = {
    ...shot.exportSettings,
    includeViewport: true,
    includeProjectedViewport: false,
    includeCameraMoveReferenceFrames: false,
    includeProjectedCameraMoveReferenceFrames: false,
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
    depth: { ...defaultShotDepthSettings, enabled: false },
    ...extra,
  };
  return shot;
}

describe('materializeShotStills', () => {
  beforeEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
    resetPreparedMediaMetrics();
  });

  afterEach(() => {
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('builds deterministic specs and primary selection for default shot', () => {
    const project = createDefaultProject();
    const shot = disableOptionalExports(project.shots[0]!);
    const specs = buildStillArtifactSpecificationsForShot({
      project,
      shot,
      purpose: 'capture',
    });
    expect(specs.some((s) => s.kind === 'clay-viewport')).toBe(true);
    const primary = selectPrimaryStillSpecification(project, shot, specs);
    expect(primary.kind).toBe('clay-viewport');
    expect(primary.appearance).toBe('clay');
    expect(primary.peopleVariant).toBe('with_people');
  });

  it('await-primary materializes primary first and returns asset id', async () => {
    const project = createDefaultProject();
    const shot = disableOptionalExports(project.shots[0]!, { peopleExportMode: 'with_people' });
    const render = mockRender();
    const result = await materializeShotAfterCapture({
      project,
      shotId: shot.id,
      mode: 'await-primary',
      render,
    });
    expect(result.status).toBe('ready');
    expect(result.primaryStillAssetId).toBeTruthy();
    expect(result.artifacts.some((a) => a.status === 'rendered' || a.status === 'current')).toBe(true);
    expect(render).toHaveBeenCalled();
  });

  it('await-all materializes all configured stills', async () => {
    const project = createDefaultProject();
    const shot = disableOptionalExports(project.shots[0]!, { peopleExportMode: 'both' });
    const render = mockRender();
    const result = await materializeShotAfterCapture({
      project,
      shotId: shot.id,
      mode: 'await-all',
      render,
    });
    expect(result.status).toBe('ready');
    expect(result.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(result.artifacts.every((a) => a.status === 'rendered' || a.status === 'current')).toBe(true);
    // Both with_people and clean_plate
    const keys = result.artifacts.map((a) => a.key);
    expect(keys.some((k) => k.includes('with_people'))).toBe(true);
    expect(keys.some((k) => k.includes('clean_plate'))).toBe(true);
  });

  it('deferred mode does not render', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const render = mockRender();
    const result = await materializeShotAfterCapture({
      project,
      shotId: shot.id,
      mode: 'deferred',
      render,
    });
    expect(result.artifacts).toEqual([]);
    expect(render).not.toHaveBeenCalled();
  });

  it('second materialization reuses without re-render', async () => {
    const project = createDefaultProject();
    const shot = disableOptionalExports(project.shots[0]!);
    const render = mockRender();
    const first = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'all-configured',
      render,
    });
    const callsAfterFirst = render.mock.calls.length;
    const second = await materializeShotStills({
      project: first.project,
      shotId: shot.id,
      reason: 'export-recovery',
      scope: 'all-configured',
      render,
    });
    expect(second.artifacts.every((a) => a.status === 'current')).toBe(true);
    expect(render.mock.calls.length).toBe(callsAfterFirst);
  });

  it('primary failure surfaces failed status; previous primary preserved', async () => {
    const project = createDefaultProject();
    const shot = disableOptionalExports(project.shots[0]!);
    const okRender = mockRender();
    const first = await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'primary',
      render: okRender,
    });
    expect(first.primaryStillAssetId).toBeTruthy();
    const primaryKey = stillArtifactKey(
      selectPrimaryStillSpecification(
        first.project,
        first.project.shots[0]!,
        buildStillArtifactSpecificationsForShot({
          project: first.project,
          shot: first.project.shots[0]!,
          purpose: 'capture',
        }),
      ),
    );

    // Invalidate by editing camera, then fail render.
    const edited = {
      ...first.project,
      shots: first.project.shots.map((item) =>
        item.id === shot.id
          ? { ...item, camera: { ...item.camera, fovDegrees: item.camera.fovDegrees + 8 } }
          : item
      ),
    };
    const failRender = vi.fn(async () => {
      throw new Error('primary render failed');
    });
    const second = await materializeShotStills({
      project: edited,
      shotId: shot.id,
      reason: 'edit',
      scope: 'primary',
      render: failRender,
    });
    // Previous asset still on the shot
    const still = second.project.shots[0]!.materializedMedia?.stills[primaryKey];
    expect(still?.assetId).toBe(first.primaryStillAssetId);
    expect(second.status).toBe('failed');
  });

  it('records capture metrics', async () => {
    const project = createDefaultProject();
    const shot = disableOptionalExports(project.shots[0]!);
    await materializeShotStills({
      project,
      shotId: shot.id,
      reason: 'capture',
      scope: 'primary',
      render: mockRender(),
    });
    const metrics = getPreparedMediaMetrics();
    expect(metrics.captureStillRequests).toBeGreaterThanOrEqual(1);
  });
});
