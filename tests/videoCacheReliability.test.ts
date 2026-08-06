import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultProject,
  createSceneObject,
} from '../src/domain/defaults';
import type { VideoArtifactFingerprint } from '../src/engine/videoArtifactFingerprint';
import { computeVideoArtifactFingerprint } from '../src/engine/videoArtifactFingerprint';
import {
  DEFAULT_VIDEO_CACHE_MAX_BYTES,
  DEFAULT_VIDEO_MEMORY_CACHE_MAX_BYTES,
  getVideoArtifactCacheLimits,
  getVideoArtifactMemoryCacheLimits,
  inspectVideoArtifactCache,
  putVideoArtifactInCache,
  resetVideoArtifactCacheForTests,
  setVideoArtifactMemoryCacheLimits,
} from '../src/engine/videoArtifactCache';

const resolvedVideo = {
  resolutionPreset: '720p' as const,
  frameRate: 24,
  width: 1280,
  height: 720,
  encoderMode: 'fast' as const,
};

function fakeFingerprint(key: string): VideoArtifactFingerprint {
  return {
    key,
    dependencyIds: [`shot:${key}`],
    details: {
      rendererVersion: 'test',
      shotId: key,
      appearance: 'clay',
      width: 1280,
      height: 720,
      frameRate: 24,
      encoderMode: 'fast',
      contentMode: 'full_scene',
    },
  };
}

describe('video cache reliability', () => {
  beforeEach(() => {
    resetVideoArtifactCacheForTests();
  });

  it('invalidates a cached render when a keyframed hidden object changes', () => {
    const project = structuredClone(createDefaultProject());
    const shot = project.shots[0]!;
    const hiddenObject = createSceneObject('box', 1);
    hiddenObject.visible = false;
    hiddenObject.color = '#111111';
    project.scene.objects = [hiddenObject];

    shot.cameraKeyframes = [
      createCameraKeyframe({
        label: 'Start hidden',
        timeSeconds: 0,
        camera: shot.camera,
        objectOverrides: {
          [hiddenObject.id]: {
            transform: structuredClone(hiddenObject.transform),
            visible: false,
          },
        },
      }),
      createCameraKeyframe({
        label: 'End visible',
        timeSeconds: 2,
        camera: {
          ...shot.camera,
          position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]],
        },
        objectOverrides: {
          [hiddenObject.id]: {
            transform: structuredClone(hiddenObject.transform),
            visible: true,
          },
        },
      }),
    ];

    const first = computeVideoArtifactFingerprint(
      project,
      shot,
      { appearance: 'clay', mode: 'render' },
      resolvedVideo,
    );
    expect(first.dependencyIds).toContain(`object:${hiddenObject.id}`);

    hiddenObject.color = '#eeeeee';
    const changed = computeVideoArtifactFingerprint(
      project,
      shot,
      { appearance: 'clay', mode: 'render' },
      resolvedVideo,
    );

    expect(changed.key).not.toBe(first.key);
  });

  it('keeps the browser-memory budget smaller than persistent storage', async () => {
    expect(DEFAULT_VIDEO_MEMORY_CACHE_MAX_BYTES).toBeLessThan(DEFAULT_VIDEO_CACHE_MAX_BYTES);
    expect(getVideoArtifactMemoryCacheLimits().maxBytes)
      .toBeLessThan(getVideoArtifactCacheLimits().maxBytes);

    setVideoArtifactMemoryCacheLimits({ maxBytes: 30, maxEntries: 10 });

    const put = (key: string) => putVideoArtifactInCache(fakeFingerprint(key), {
      blob: new Blob([new Uint8Array(20)], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 1,
      frameRate: 24,
      frameCount: 24,
      encodeMode: 'render',
      actualEncoderMode: 'fast',
      encoderModeFallback: false,
    });

    await put('first');
    await put('second');

    const inspection = inspectVideoArtifactCache();
    expect(inspection.memoryBytes).toBeLessThanOrEqual(30);
    expect(inspection.memoryEntries).toBe(1);
    expect(inspection.memoryMaxBytes).toBe(30);
  });
});
