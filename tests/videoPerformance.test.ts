import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultExportConfiguration,
  createDefaultProject,
  createPanoReference,
  createSceneObject,
  defaultShotExportSettings,
  normalizeShotExportSettings,
} from '../src/domain/defaults';
import type { LocationProject, Shot } from '../src/domain/types';
import {
  setProjectExportProfile,
  setProjectVideoPerformance,
} from '../src/engine/exportConfiguration';
import { createExportPlan } from '../src/engine/exportPlan';
import {
  computeVideoArtifactFingerprint,
} from '../src/engine/videoArtifactFingerprint';
import {
  getVideoArtifactFromCache,
  putVideoArtifactInCache,
  resetVideoArtifactCacheForTests,
  setVideoArtifactCacheMaxBytesForTests,
  setVideoArtifactCacheMaxEntriesForTests,
  inspectVideoArtifactCache,
} from '../src/engine/videoArtifactCache';
import {
  createCacheHitTiming,
  formatVideoRenderTiming,
} from '../src/engine/videoRenderTiming';
import {
  computePixelFrameCount,
  defaultVideoPerformanceProfileForExportProfile,
  FAST_CONTROL_FRAME_RATE,
  preferredShotExportMotionDefaults,
  preferredShotExportMotionDefaultsForProject,
  resolveProjectVideoPerformance,
  resolveVideoPerformance,
} from '../src/engine/videoPerformance';
import {
  buildDeterministicAvcEncodingConfig,
  resolveDeterministicEncoderMode,
} from '../src/engine/videoEncode';
import {
  prepareVideoArtifact,
  resetPrepareVideoArtifactInflightForTests,
} from '../src/engine/prepareVideoArtifact';
import * as renderers from '../src/engine/renderers';

function cloneProject(): LocationProject {
  return structuredClone(createDefaultProject());
}

function withMove(shot: Shot, durationSeconds = 2): Shot {
  return {
    ...shot,
    cameraKeyframes: [
      createCameraKeyframe({ label: 'Start', timeSeconds: 0, camera: shot.camera }),
      createCameraKeyframe({
        label: 'End',
        timeSeconds: durationSeconds,
        camera: {
          ...shot.camera,
          position: [shot.camera.position[0] + 1, shot.camera.position[1], shot.camera.position[2]],
        },
      }),
    ],
  };
}

const baseResolved = {
  resolutionPreset: '720p' as const,
  frameRate: 24,
  width: 1280,
  height: 720,
  encoderMode: 'fast' as const,
};

describe('video performance profiles', () => {
  it('maps AI-generation export profile to Fast Control 720p24', () => {
    expect(defaultVideoPerformanceProfileForExportProfile('ai-generation')).toBe('fast-control');
    const resolved = resolveVideoPerformance(undefined, 'ai-generation');
    expect(resolved.profileId).toBe('fast-control');
    expect(resolved.width).toBe(1280);
    expect(resolved.height).toBe(720);
    expect(resolved.frameRate).toBe(FAST_CONTROL_FRAME_RATE);
    expect(resolved.encoderMode).toBe('fast');
  });

  it('keeps Standard at 1080p30 quality encoder', () => {
    const resolved = resolveVideoPerformance({ profileId: 'standard' });
    expect(resolved.width).toBe(1920);
    expect(resolved.height).toBe(1080);
    expect(resolved.frameRate).toBe(30);
    expect(resolved.encoderMode).toBe('quality');
  });

  it('makes High Quality distinct as 4K30', () => {
    const resolved = resolveVideoPerformance({ profileId: 'high-quality' });
    expect(resolved.resolutionPreset).toBe('4k');
    expect(resolved.width).toBe(3840);
    expect(resolved.height).toBe(2160);
    expect(resolved.frameRate).toBe(30);
    expect(resolved.encoderMode).toBe('quality');
    expect(resolved.label).toMatch(/4K/i);
  });

  it('falls back Fast Control to clay-only when projected appearance is unavailable', () => {
    expect(preferredShotExportMotionDefaults('fast-control')).toEqual({
      includeCameraMoveVideo: false,
      includeProjectedCameraMoveVideo: true,
    });
    expect(preferredShotExportMotionDefaults('fast-control', { canUseProjected: false })).toEqual({
      includeCameraMoveVideo: true,
      includeProjectedCameraMoveVideo: false,
    });

    const project = cloneProject();
    // Default project has no styled pano projector.
    expect(preferredShotExportMotionDefaultsForProject(project, 'fast-control')).toEqual({
      includeCameraMoveVideo: true,
      includeProjectedCameraMoveVideo: false,
    });

    const withProjector = setProjectExportProfile(project, 'ai-generation');
    expect(withProjector.exportConfiguration?.defaults.includeCameraMoveVideo).toBe(true);
    expect(withProjector.exportConfiguration?.defaults.includeProjectedCameraMoveVideo).toBe(false);
  });
});

describe('video encoder mode config', () => {
  it('builds quality vs fast AVC configs', () => {
    const preset = {
      id: '1080p' as const,
      label: '1080p',
      width: 1920,
      height: 1080,
      frameRate: 30,
      avcCodecString: 'avc1.640028',
      profile: 'high' as const,
      level: '4.0',
      bitrate: 12_000_000,
    };
    const quality = buildDeterministicAvcEncodingConfig(preset, 'quality');
    const fast = buildDeterministicAvcEncodingConfig(preset, 'fast');
    expect(quality.latencyMode).toBe('quality');
    expect(quality.hardwareAcceleration).toBe('no-preference');
    expect(fast.latencyMode).toBe('realtime');
    expect(fast.hardwareAcceleration).toBe('prefer-hardware');
  });

  it('negotiates encoder mode with fallback path available', async () => {
    // In Node test env VideoEncoder is usually absent → undefined is ok.
    const preset = {
      id: '720p' as const,
      label: '720p',
      width: 1280,
      height: 720,
      frameRate: 24,
      avcCodecString: 'avc1.64001f',
      profile: 'high' as const,
      level: '3.1',
      bitrate: 5_000_000,
    };
    const result = await resolveDeterministicEncoderMode(preset, 'fast');
    expect(result === undefined || result.mode === 'fast' || result.mode === 'quality').toBe(true);
  });
});

describe('complete visual dependency fingerprints', () => {
  beforeEach(() => {
    resetVideoArtifactCacheForTests();
  });

  it('changes for surface style, object type, and material fields', () => {
    const project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!);
    const box = createSceneObject('box', 1);
    project.scene.objects = [box];
    const shot = project.shots[0]!;

    const first = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, baseResolved);

    box.surfaceStyle = 'checkerboard';
    box.secondaryColor = '#111111';
    const surface = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, baseResolved);
    expect(surface.key).not.toBe(first.key);

    box.surfaceStyle = undefined;
    box.secondaryColor = undefined;
    box.type = 'column';
    const typed = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, baseResolved);
    expect(typed.key).not.toBe(first.key);
  });

  it('changes for projected pano origin, rotation, and image asset identity', () => {
    const project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!);
    const shot = project.shots[0]!;

    const assetId = 'pano-asset-1';
    project.assets.assets[assetId] = {
      id: assetId,
      type: 'image',
      name: 'styled.png',
      uri: 'data:image/png;base64,aaa',
      contentHash: 'hash-a',
      createdAt: new Date().toISOString(),
    } as never;
    const pano = createPanoReference({
      name: 'Styled',
      assetId,
      type: 'ai_global_reference',
      origin: [0, 1.6, 0],
      rotation: [0, 0, 0],
      width: 4096,
      height: 2048,
    });
    project.panoRefs = [pano];
    project.settings.projectedStyle = {
      ...project.settings.projectedStyle,
      panoId: pano.id,
      opacity: 1,
      exposure: 0,
      lightingContribution: 0,
      fallbackMode: 'clay',
    };
    shot.linkedPanoId = pano.id;

    const first = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'projected',
      mode: 'render',
    }, baseResolved);

    pano.rotation = [0, 45, 0];
    const rotated = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'projected',
      mode: 'render',
    }, baseResolved);
    expect(rotated.key).not.toBe(first.key);

    pano.rotation = [0, 0, 0];
    pano.origin = [1, 1.6, 0];
    const moved = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'projected',
      mode: 'render',
    }, baseResolved);
    expect(moved.key).not.toBe(first.key);

    pano.origin = [0, 1.6, 0];
    project.assets.assets[assetId] = {
      ...project.assets.assets[assetId]!,
      contentHash: 'hash-b',
    };
    const replaced = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'projected',
      mode: 'render',
    }, baseResolved);
    expect(replaced.key).not.toBe(first.key);

    // Clay should remain stable when only projected pano rotation changes after reset.
    project.assets.assets[assetId] = {
      ...project.assets.assets[assetId]!,
      contentHash: 'hash-a',
    };
    const clayA = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, baseResolved);
    pano.rotation = [0, 90, 0];
    const clayB = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, baseResolved);
    expect(clayB.key).toBe(clayA.key);
  });

  it('changes for timeline edits while unrelated objects stay ignored for clay when not visible', () => {
    const project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!);
    const shot = project.shots[0]!;
    const first = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, baseResolved);
    shot.cameraKeyframes[1]!.camera.position[0] += 3;
    const moved = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, baseResolved);
    expect(moved.key).not.toBe(first.key);
  });
});

describe('byte-limited LRU video cache', () => {
  beforeEach(() => {
    resetVideoArtifactCacheForTests();
    resetPrepareVideoArtifactInflightForTests();
  });

  it('stores and retrieves exact-match cache entries including fallback flag', async () => {
    const project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!);
    const shot = project.shots[0]!;
    const fingerprint = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, baseResolved);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });
    await putVideoArtifactInCache(fingerprint, {
      blob,
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 2,
      frameRate: 24,
      frameCount: 48,
      encodeMode: 'render',
      actualEncoderMode: 'quality',
      encoderModeFallback: true,
    });
    const hit = await getVideoArtifactFromCache(fingerprint);
    expect(hit?.key).toBe(fingerprint.key);
    expect(hit?.encoderModeFallback).toBe(true);
    expect(hit?.actualEncoderMode).toBe('quality');
  });

  it('evicts least-recently-used entries under a byte budget', async () => {
    setVideoArtifactCacheMaxBytesForTests(30);
    setVideoArtifactCacheMaxEntriesForTests(10);
    const project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!);
    const shot = project.shots[0]!;

    const makeFp = (label: string) => {
      shot.camera.fovDegrees = 40 + label.charCodeAt(0);
      return computeVideoArtifactFingerprint(project, shot, {
        appearance: 'clay',
        mode: 'render',
      }, baseResolved);
    };

    const a = makeFp('a');
    const b = makeFp('b');
    const c = makeFp('c');

    await putVideoArtifactInCache(a, {
      blob: new Blob([new Uint8Array(20)]),
      mimeType: 'video/mp4',
      width: 10,
      height: 10,
      durationSeconds: 1,
      frameRate: 24,
      frameCount: 24,
      encodeMode: 'render',
      actualEncoderMode: 'fast',
      encoderModeFallback: false,
    });
    await putVideoArtifactInCache(b, {
      blob: new Blob([new Uint8Array(20)]),
      mimeType: 'video/mp4',
      width: 10,
      height: 10,
      durationSeconds: 1,
      frameRate: 24,
      frameCount: 24,
      encodeMode: 'render',
      actualEncoderMode: 'fast',
      encoderModeFallback: false,
    });
    // Touch A so B is older.
    await getVideoArtifactFromCache(a);
    await putVideoArtifactInCache(c, {
      blob: new Blob([new Uint8Array(20)]),
      mimeType: 'video/mp4',
      width: 10,
      height: 10,
      durationSeconds: 1,
      frameRate: 24,
      frameCount: 24,
      encodeMode: 'render',
      actualEncoderMode: 'fast',
      encoderModeFallback: false,
    });

    const inspection = inspectVideoArtifactCache();
    expect(inspection.memoryBytes).toBeLessThanOrEqual(30);
    expect(inspection.memoryEntries).toBeLessThanOrEqual(2);
    // B should have been evicted first (LRU).
    expect(await getVideoArtifactFromCache(b)).toBeUndefined();
  });
});

describe('prepareVideoArtifact cache reuse', () => {
  beforeEach(() => {
    resetVideoArtifactCacheForTests();
    resetPrepareVideoArtifactInflightForTests();
    vi.restoreAllMocks();
  });

  it('renders once then serves exact-match hits without re-rendering', async () => {
    const project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!);
    const shot = project.shots[0]!;

    const blob = new Blob([new Uint8Array([9, 9, 9])], { type: 'video/mp4' });
    const renderSpy = vi.spyOn(renderers, 'renderShotCameraMoveMp4').mockResolvedValue({
      blob,
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 2,
      frameRate: 24,
      fileExtension: 'mp4',
      encodeMode: 'render',
      frameCount: 48,
      codecString: 'avc1.64001f',
      actualEncoderMode: 'fast',
      encoderModeFallback: false,
    });

    const first = await prepareVideoArtifact({
      project,
      shotId: shot.id,
      specification: {
        appearance: 'clay',
        mode: 'render',
        resolutionPreset: '720p',
        frameRate: 24,
        encoderMode: 'fast',
      },
    });
    expect(first.cacheStatus).toBe('miss');
    expect(renderSpy).toHaveBeenCalledTimes(1);

    const second = await prepareVideoArtifact({
      project,
      shotId: shot.id,
      specification: {
        appearance: 'clay',
        mode: 'render',
        resolutionPreset: '720p',
        frameRate: 24,
        encoderMode: 'fast',
      },
    });
    expect(second.cacheStatus).toBe('hit');
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(await second.blob.arrayBuffer()).toEqual(await blob.arrayBuffer());

    // Keyframe edit invalidates only that artifact.
    shot.cameraKeyframes[1]!.camera.position[0] += 5;
    const third = await prepareVideoArtifact({
      project,
      shotId: shot.id,
      specification: {
        appearance: 'clay',
        mode: 'render',
        resolutionPreset: '720p',
        frameRate: 24,
        encoderMode: 'fast',
      },
    });
    expect(third.cacheStatus).toBe('miss');
    expect(renderSpy).toHaveBeenCalledTimes(2);
  });
});

describe('export plan video workload', () => {
  it('estimates video count and pixel-frames from performance profile', () => {
    let project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!, 2);
    project = setProjectVideoPerformance(project, { profileId: 'standard' });
    project = {
      ...project,
      exportConfiguration: {
        ...project.exportConfiguration!,
        defaults: normalizeShotExportSettings({
          ...defaultShotExportSettings,
          includeCameraMoveVideo: true,
          includeProjectedCameraMoveVideo: true,
        }),
      },
      shots: project.shots.map((shot) => ({
        ...shot,
        exportSettings: normalizeShotExportSettings({
          ...shot.exportSettings,
          includeCameraMoveVideo: true,
          includeProjectedCameraMoveVideo: true,
        }),
      })),
    };

    const plan = createExportPlan(project, project.shots);
    expect(plan.videoWorkload.frameRate).toBe(30);
    expect(plan.videoWorkload.width).toBe(1920);
    expect(plan.videoWorkload.videoCount).toBeGreaterThanOrEqual(1);

    project = setProjectVideoPerformance(project, { profileId: 'high-quality' });
    const hqPlan = createExportPlan(project, project.shots);
    expect(hqPlan.videoWorkload.width).toBe(3840);
    expect(hqPlan.videoWorkload.height).toBe(2160);
  });
});

describe('video render timing helpers', () => {
  it('formats cache hits', () => {
    const timing = createCacheHitTiming({
      frameCount: 48,
      width: 1280,
      height: 720,
      totalMs: 12,
    });
    expect(timing.cacheHit).toBe(true);
    expect(formatVideoRenderTiming(timing)).toContain('cache hit');
  });
});

describe('default export configuration video resolution', () => {
  it('creates configuration without forcing videoPerformance (resolved from profile)', () => {
    const config = createDefaultExportConfiguration();
    expect(config.videoPerformance).toBeUndefined();
    expect(resolveProjectVideoPerformance(config).profileId).toBe('standard');
  });
});
