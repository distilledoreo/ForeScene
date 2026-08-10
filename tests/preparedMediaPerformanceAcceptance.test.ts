import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import {
  getPreparedMediaMetrics,
  resetPreparedMediaMetrics,
} from '../src/engine/preparedMediaMetrics';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import type { StillArtifactSpecification } from '../src/engine/stillArtifactTypes';

function renderMock() {
  return vi.fn(async ({ specification }: { specification: StillArtifactSpecification }) => ({
    blob: new Blob([`${specification.kind}:${specification.appearance}`], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

function twoShotProject(): LocationProject {
  const project = createDefaultProject();
  const first = project.shots[0]!;
  const second = structuredClone(first);
  second.id = 'shot-performance-2';
  second.shotNumber = '2';
  second.name = 'Performance Shot 2';
  second.materializedMedia = undefined;
  second.assets = {};
  project.shots = [first, second];
  return project;
}

async function preparePrimary(
  project: LocationProject,
  shotId: string,
  render: ReturnType<typeof renderMock>,
  reason: 'capture' | 'edit' | 'manual' = 'capture',
): Promise<LocationProject> {
  const result = await materializeShotStills({
    project,
    shotId,
    reason,
    scope: 'primary',
    render,
  });
  expect(result.status).toBe('ready');
  return result.project;
}

describe('prepared-media performance acceptance', () => {
  beforeEach(() => {
    resetPreparedMediaMetrics();
    resetProjectAssetStoreForTests();
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  afterEach(() => {
    resetPreparedMediaMetrics();
    resetProjectAssetStoreForTests();
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('reuses warm stills, ignores metadata edits, and regenerates only the edited shot', async () => {
    let project = twoShotProject();
    const firstId = project.shots[0]!.id;
    const secondId = project.shots[1]!.id;
    const render = renderMock();

    project = await preparePrimary(project, firstId, render);
    project = await preparePrimary(project, secondId, render);
    expect(render).toHaveBeenCalledTimes(2);

    resetPreparedMediaMetrics();
    render.mockClear();

    // Warm preparation must reuse both persisted primary stills.
    project = await preparePrimary(project, firstId, render, 'edit');
    project = await preparePrimary(project, secondId, render, 'edit');
    expect(render).not.toHaveBeenCalled();
    expect(getPreparedMediaMetrics().stillReuseCount).toBeGreaterThanOrEqual(2);
    expect(getPreparedMediaMetrics().editStillRenders).toBe(0);

    // Metadata-only edits do not affect still fingerprints.
    project = {
      ...project,
      shots: project.shots.map((shot) =>
        shot.id === firstId
          ? { ...shot, name: 'Metadata only rename', notes: 'No render should occur.' }
          : shot
      ),
    };
    render.mockClear();
    project = await preparePrimary(project, firstId, render, 'edit');
    expect(render).not.toHaveBeenCalled();

    // Camera edits invalidate only the affected shot.
    project = {
      ...project,
      shots: project.shots.map((shot) =>
        shot.id === firstId
          ? {
            ...shot,
            camera: {
              ...shot.camera,
              fovDegrees: shot.camera.fovDegrees + 7,
            },
          }
          : shot
      ),
    };
    resetPreparedMediaMetrics();
    render.mockClear();

    project = await preparePrimary(project, firstId, render, 'edit');
    expect(render).toHaveBeenCalledTimes(1);
    expect(getPreparedMediaMetrics().editStillRenders).toBe(1);

    render.mockClear();
    project = await preparePrimary(project, secondId, render, 'edit');
    expect(render).not.toHaveBeenCalled();
    expect(getPreparedMediaMetrics().editStillRenders).toBe(1);
  });
});
