import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultProject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { resetVideoArtifactCacheForTests } from '../src/engine/videoArtifactCache';

vi.mock('../src/engine/videoArtifactCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/videoArtifactCache')>();
  return {
    ...actual,
    getVideoArtifactFromCache: vi.fn(async () => undefined),
  };
});

vi.mock('../src/engine/prepareVideoArtifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/prepareVideoArtifact')>();
  return {
    ...actual,
    prepareVideoArtifact: vi.fn(),
  };
});

import type { PreparedVideoArtifact } from '../src/engine/prepareVideoArtifact';
import { prepareVideoArtifact } from '../src/engine/prepareVideoArtifact';
import {
  discardBackgroundVideosForShot,
  ensureBackgroundVideoService,
  getBackgroundVideoShotStatus,
  queueBackgroundVideosForShot,
  resetBackgroundVideoServiceForTests,
} from '../src/engine/backgroundVideoService';

function result(): PreparedVideoArtifact {
  return {
    fingerprint: { key: 'runtime-video' } as PreparedVideoArtifact['fingerprint'],
    blob: new Blob(['mp4'], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    width: 64,
    height: 36,
    durationSeconds: 1,
    frameRate: 24,
    frameCount: 24,
    encodeMode: 'render',
    actualEncoderMode: 'quality',
    encoderModeFallback: false,
    cacheStatus: 'miss',
    timing: {
      setupMs: 0,
      renderMs: 0,
      encodeMs: 0,
      finalizeMs: 0,
      totalMs: 0,
      frameCount: 24,
      width: 64,
      height: 36,
      cacheHit: false,
    },
  };
}

function projectWithMove(): LocationProject {
  const project = createDefaultProject();
  const shot = project.shots[0]!;
  shot.cameraKeyframes = [
    createCameraKeyframe({ label: 'Start', timeSeconds: 0, camera: shot.camera }),
    createCameraKeyframe({
      label: 'End',
      timeSeconds: 1,
      camera: {
        ...shot.camera,
        position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]],
      },
    }),
  ];
  shot.exportSettings = {
    ...shot.exportSettings,
    includeCameraMoveVideo: true,
    includeProjectedCameraMoveVideo: false,
    peopleExportMode: 'with_people',
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
    depth: { ...defaultShotDepthSettings, enabled: false },
  };
  return project;
}

async function waitForShotStatus(
  project: LocationProject,
  expected: ReturnType<typeof getBackgroundVideoShotStatus>,
): Promise<void> {
  const shotId = project.shots[0]!.id;
  for (let index = 0; index < 100; index += 1) {
    if (getBackgroundVideoShotStatus(project, shotId) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for video status ${expected}.`);
}

describe('background video per-shot runtime status', () => {
  beforeEach(() => {
    resetBackgroundVideoServiceForTests();
    resetVideoArtifactCacheForTests();
    renderWorkCoordinator.resetForTests();
    vi.mocked(prepareVideoArtifact).mockReset();
  });

  afterEach(() => {
    resetBackgroundVideoServiceForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('reports pending, encoding, ready, and pending again after invalidation', async () => {
    const project = projectWithMove();
    const shotId = project.shots[0]!.id;
    let release: (() => void) | undefined;
    vi.mocked(prepareVideoArtifact).mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return result();
    });

    ensureBackgroundVideoService(() => project);
    expect(getBackgroundVideoShotStatus(project, shotId)).toBe('pending');

    await queueBackgroundVideosForShot(shotId);
    await waitForShotStatus(project, 'encoding');

    release?.();
    await waitForShotStatus(project, 'ready');

    discardBackgroundVideosForShot(shotId);
    expect(getBackgroundVideoShotStatus(project, shotId)).toBe('pending');
  });

  it('reports failed when encoding fails', async () => {
    const project = projectWithMove();
    const shotId = project.shots[0]!.id;
    vi.mocked(prepareVideoArtifact).mockRejectedValue(new Error('encoder failed'));

    ensureBackgroundVideoService(() => project);
    await queueBackgroundVideosForShot(shotId);
    await waitForShotStatus(project, 'failed');
  });

  it('reports not-requested when the shot has no renderable camera move', () => {
    const project = createDefaultProject();
    const shotId = project.shots[0]!.id;
    ensureBackgroundVideoService(() => project);
    expect(getBackgroundVideoShotStatus(project, shotId)).toBe('not-requested');
  });
});
