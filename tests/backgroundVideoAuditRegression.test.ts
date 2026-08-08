import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultProject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';

vi.mock('../src/engine/videoArtifactCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/videoArtifactCache')>();
  return { ...actual, getVideoArtifactFromCache: vi.fn(async () => undefined) };
});

vi.mock('../src/engine/prepareVideoArtifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/prepareVideoArtifact')>();
  return { ...actual, prepareVideoArtifact: vi.fn() };
});

import { prepareVideoArtifact, type PreparedVideoArtifact } from '../src/engine/prepareVideoArtifact';
import {
  discardBackgroundVideosForShot,
  ensureBackgroundVideoService,
  getBackgroundVideoServiceStatus,
  getBackgroundVideoShotStatus,
  queueBackgroundVideosForShot,
  resetBackgroundVideoServiceForTests,
} from '../src/engine/backgroundVideoService';

function projectWithTwoVideoCandidates(): LocationProject {
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
    peopleExportMode: 'both',
    depth: { ...defaultShotDepthSettings, enabled: false },
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
  };
  return project;
}

function fakeResult(): PreparedVideoArtifact {
  return {
    fingerprint: { key: `mock-${Math.random()}` } as PreparedVideoArtifact['fingerprint'],
    blob: new Blob(['video'], { type: 'video/mp4' }),
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

async function waitUntilIdle(): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const status = getBackgroundVideoServiceStatus();
    if (!status.running && status.pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for background video scheduler.');
}

describe('background video audit regressions', () => {
  let project: LocationProject;

  beforeEach(() => {
    project = projectWithTwoVideoCandidates();
    resetBackgroundVideoServiceForTests();
    renderWorkCoordinator.resetForTests();
    vi.mocked(prepareVideoArtifact).mockReset();
  });

  afterEach(() => {
    resetBackgroundVideoServiceForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('treats an aborted running candidate as cancellation rather than failure', async () => {
    let release!: () => void;
    vi.mocked(prepareVideoArtifact).mockImplementation(async ({ signal }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (signal?.aborted) throw new Error('MP4 export was cancelled.');
      return fakeResult();
    });

    const shotId = project.shots[0]!.id;
    ensureBackgroundVideoService(() => project);
    await queueBackgroundVideosForShot(shotId);
    for (let index = 0; index < 100 && !getBackgroundVideoServiceStatus().running; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    discardBackgroundVideosForShot(shotId);
    release();
    await waitUntilIdle();

    expect(getBackgroundVideoShotStatus(project, shotId)).toBe('pending');
  });

  it('keeps the shot failed when one required candidate fails and a later candidate succeeds', async () => {
    let calls = 0;
    vi.mocked(prepareVideoArtifact).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first variant failed');
      return fakeResult();
    });

    const shotId = project.shots[0]!.id;
    ensureBackgroundVideoService(() => project);
    await queueBackgroundVideosForShot(shotId);
    await waitUntilIdle();

    expect(calls).toBe(2);
    expect(getBackgroundVideoShotStatus(project, shotId)).toBe('failed');
  });
});
