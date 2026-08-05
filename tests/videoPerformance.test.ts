import { describe, expect, it, beforeEach } from 'vitest';
import {
  createCameraKeyframe,
  createDefaultExportConfiguration,
  createDefaultProject,
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
  resolveProjectVideoPerformance,
  resolveVideoPerformance,
} from '../src/engine/videoPerformance';
import {
  buildDeterministicAvcEncodingConfig,
} from '../src/engine/videoEncode';

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

describe('video performance profiles', () => {
  it('maps AI-generation export profile to Fast Control 720p24', () => {
    expect(defaultVideoPerformanceProfileForExportProfile('ai-generation')).toBe('fast-control');
    const resolved = resolveVideoPerformance(undefined, 'ai-generation');
    expect(resolved.profileId).toBe('fast-control');
    expect(resolved.width).toBe(1280);
    expect(resolved.height).toBe(720);
    expect(resolved.frameRate).toBe(FAST_CONTROL_FRAME_RATE);
    expect(resolved.encoderMode).toBe('fast');
    expect(preferredShotExportMotionDefaults('fast-control')).toEqual({
      includeCameraMoveVideo: false,
      includeProjectedCameraMoveVideo: true,
    });
  });

  it('keeps Standard at 1080p30 quality encoder', () => {
    const resolved = resolveVideoPerformance({ profileId: 'standard' });
    expect(resolved.width).toBe(1920);
    expect(resolved.height).toBe(1080);
    expect(resolved.frameRate).toBe(30);
    expect(resolved.encoderMode).toBe('quality');
  });

  it('applies export profile video defaults onto a project', () => {
    let project = cloneProject();
    project = setProjectExportProfile(project, 'ai-generation');
    expect(project.exportConfiguration?.activeProfileId).toBe('ai-generation');
    expect(project.exportConfiguration?.videoPerformance?.profileId).toBe('fast-control');
    expect(project.exportConfiguration?.defaults.includeCameraMoveVideo).toBe(false);
    expect(project.exportConfiguration?.defaults.includeProjectedCameraMoveVideo).toBe(true);
    const perf = resolveProjectVideoPerformance(project.exportConfiguration);
    expect(perf.frameRate).toBe(24);
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
});

describe('video artifact fingerprint + cache', () => {
  beforeEach(() => {
    resetVideoArtifactCacheForTests();
  });

  it('changes when timeline, appearance, or encode settings change', () => {
    const project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!);
    const shot = project.shots[0]!;
    const resolved = {
      resolutionPreset: '720p' as const,
      frameRate: 24,
      width: 1280,
      height: 720,
      encoderMode: 'fast' as const,
    };
    const first = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, resolved);
    const same = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, resolved);
    expect(same.key).toBe(first.key);

    const projected = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'projected',
      mode: 'render',
    }, resolved);
    expect(projected.key).not.toBe(first.key);

    const fps30 = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, { ...resolved, frameRate: 30 });
    expect(fps30.key).not.toBe(first.key);

    shot.cameraKeyframes[1]!.camera.position[0] += 2;
    const moved = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, resolved);
    expect(moved.key).not.toBe(first.key);
  });

  it('stores and retrieves exact-match cache entries', async () => {
    const project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!);
    const shot = project.shots[0]!;
    const resolved = {
      resolutionPreset: '1080p' as const,
      frameRate: 30,
      width: 1920,
      height: 1080,
      encoderMode: 'quality' as const,
    };
    const fingerprint = computeVideoArtifactFingerprint(project, shot, {
      appearance: 'clay',
      mode: 'render',
    }, resolved);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });
    await putVideoArtifactInCache(fingerprint, {
      blob,
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
      durationSeconds: 2,
      frameRate: 30,
      frameCount: 60,
      encodeMode: 'render',
      actualEncoderMode: 'quality',
    });
    const hit = await getVideoArtifactFromCache(fingerprint);
    expect(hit?.key).toBe(fingerprint.key);
    expect(hit?.frameCount).toBe(60);
    expect(await hit!.blob.arrayBuffer()).toEqual(await blob.arrayBuffer());
  });
});

describe('export plan video workload', () => {
  it('estimates video count and pixel-frames from performance profile', () => {
    let project = cloneProject();
    project.shots[0] = withMove(project.shots[0]!, 2);
    project = setProjectVideoPerformance(project, { profileId: 'standard' });
    // Ensure clay + projected motion are planned.
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
    expect(plan.videoWorkload.height).toBe(1080);
    // clay + projected (projected may omit without projector — still counts disposition)
    expect(plan.videoWorkload.videoCount).toBeGreaterThanOrEqual(1);
    expect(plan.videoWorkload.totalFrames).toBeGreaterThan(0);
    expect(plan.videoWorkload.totalPixelFrames).toBe(
      computePixelFrameCount(
        plan.videoWorkload.totalFrames / Math.max(1, plan.videoWorkload.videoCount)
          * plan.videoWorkload.videoCount,
        1920,
        1080,
      ),
    );

    project = setProjectVideoPerformance(project, { profileId: 'fast-control' });
    const fastPlan = createExportPlan(project, project.shots);
    expect(fastPlan.videoWorkload.frameRate).toBe(24);
    expect(fastPlan.videoWorkload.width).toBe(1280);
    expect(fastPlan.videoWorkload.height).toBe(720);
    // Fewer frames at 24fps than 30fps for the same duration.
    expect(fastPlan.videoWorkload.totalFrames).toBeLessThan(plan.videoWorkload.totalFrames);
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
