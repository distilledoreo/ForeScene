import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultProject,
} from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import {
  inspectPrepareVideoArtifactInflightForTests,
  prepareVideoArtifact,
  resetPrepareVideoArtifactInflightForTests,
} from '../src/engine/prepareVideoArtifact';
import { resetVideoArtifactCacheForTests } from '../src/engine/videoArtifactCache';
import * as renderers from '../src/engine/renderers';

function projectWithMove(): LocationProject {
  const project = structuredClone(createDefaultProject());
  const shot = project.shots[0]!;
  shot.cameraKeyframes = [
    createCameraKeyframe({
      label: 'Start',
      timeSeconds: 0,
      camera: shot.camera,
    }),
    createCameraKeyframe({
      label: 'End',
      timeSeconds: 2,
      camera: {
        ...shot.camera,
        position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]],
      },
    }),
  ];
  return project;
}

function request(project: LocationProject, signal: AbortSignal) {
  return prepareVideoArtifact({
    project,
    shotId: project.shots[0]!.id,
    signal,
    specification: {
      appearance: 'clay',
      mode: 'render',
      resolutionPreset: '720p',
      frameRate: 24,
      encoderMode: 'fast',
    },
  });
}

function videoResult() {
  return {
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    width: 1280,
    height: 720,
    durationSeconds: 2,
    frameRate: 24,
    fileExtension: 'mp4' as const,
    encodeMode: 'render' as const,
    frameCount: 48,
    codecString: 'avc1.64001f',
    actualEncoderMode: 'fast' as const,
    encoderModeFallback: false,
  };
}

describe('shared video artifact cancellation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetVideoArtifactCacheForTests();
    resetPrepareVideoArtifactInflightForTests();
  });

  it('lets one caller cancel without aborting another subscriber', async () => {
    const project = projectWithMove();
    let resolveRender!: (value: ReturnType<typeof videoResult>) => void;
    let sharedSignal: AbortSignal | undefined;

    const renderSpy = vi.spyOn(renderers, 'renderShotCameraMoveMp4').mockImplementation(
      async (_project, _shot, options) => new Promise((resolve, reject) => {
        const signal = options?.signal;
        sharedSignal = signal;
        resolveRender = resolve;
        signal?.addEventListener(
          'abort',
          () => reject(new Error('MP4 export was cancelled.')),
          { once: true },
        );
      }),
    );

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = request(project, firstController.signal);
    const second = request(project, secondController.signal);

    await vi.waitFor(() => {
      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(inspectPrepareVideoArtifactInflightForTests().subscribers).toBe(2);
    });

    firstController.abort();
    await expect(first).rejects.toThrow('MP4 export was cancelled');
    expect(sharedSignal?.aborted).toBe(false);
    expect(inspectPrepareVideoArtifactInflightForTests().subscribers).toBe(1);

    resolveRender(videoResult());
    const completed = await second;
    expect(completed.cacheStatus).toBe('joined');
    expect(sharedSignal?.aborted).toBe(false);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts the shared renderer after every subscriber cancels', async () => {
    const project = projectWithMove();
    let sharedSignal: AbortSignal | undefined;

    const renderSpy = vi.spyOn(renderers, 'renderShotCameraMoveMp4').mockImplementation(
      async (_project, _shot, options) => new Promise((_resolve, reject) => {
        const signal = options?.signal;
        sharedSignal = signal;
        signal?.addEventListener(
          'abort',
          () => reject(new Error('MP4 export was cancelled.')),
          { once: true },
        );
      }),
    );

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = request(project, firstController.signal);
    const second = request(project, secondController.signal);

    await vi.waitFor(() => {
      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(inspectPrepareVideoArtifactInflightForTests().subscribers).toBe(2);
    });

    firstController.abort();
    secondController.abort();

    await expect(first).rejects.toThrow('MP4 export was cancelled');
    await expect(second).rejects.toThrow('MP4 export was cancelled');
    await vi.waitFor(() => expect(sharedSignal?.aborted).toBe(true));
    expect(inspectPrepareVideoArtifactInflightForTests().jobs).toBe(0);
  });
});
