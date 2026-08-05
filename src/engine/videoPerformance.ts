/**
 * Video performance profiles for package/camera-move export.
 *
 * Fast Control prioritizes AI-control turnaround (720p24, fast encoder).
 * Standard matches the historical 1080p30 quality path.
 * High Quality keeps 1080p30 with the quality encoder path.
 */

import type {
  ExportProfileId,
  ProjectExportConfiguration,
  ShotExportSettings,
  VideoEncoderMode,
  VideoPerformanceProfileId,
  VideoPerformanceSettings,
} from '../domain/types';
import type { VideoResolutionPresetId } from './videoPresets';
import {
  DEFAULT_VIDEO_FRAME_RATE,
  resolveVideoPreset,
} from './videoPresets';

export const FAST_CONTROL_FRAME_RATE = 24;
export const VIDEO_PERFORMANCE_CACHE_VERSION = 1;

export interface ResolvedVideoPerformance {
  profileId: VideoPerformanceProfileId;
  resolutionPreset: VideoResolutionPresetId;
  frameRate: number;
  width: number;
  height: number;
  encoderMode: VideoEncoderMode;
  label: string;
  /** Preferred motion-pass defaults when applying an export profile (user toggles still win). */
  preferredMotionPasses: {
    clay: boolean;
    projected: boolean;
  };
}

const PROFILE_DEFS: Record<VideoPerformanceProfileId, {
  label: string;
  resolutionPreset: VideoResolutionPresetId;
  frameRate: number;
  encoderMode: VideoEncoderMode;
  preferredMotionPasses: { clay: boolean; projected: boolean };
}> = {
  'fast-control': {
    label: 'Fast Control (720p24)',
    resolutionPreset: '720p',
    frameRate: FAST_CONTROL_FRAME_RATE,
    encoderMode: 'fast',
    preferredMotionPasses: { clay: false, projected: true },
  },
  standard: {
    label: 'Standard (1080p30)',
    resolutionPreset: '1080p',
    frameRate: DEFAULT_VIDEO_FRAME_RATE,
    encoderMode: 'quality',
    preferredMotionPasses: { clay: true, projected: true },
  },
  'high-quality': {
    label: 'High Quality (1080p30)',
    resolutionPreset: '1080p',
    frameRate: DEFAULT_VIDEO_FRAME_RATE,
    encoderMode: 'quality',
    preferredMotionPasses: { clay: true, projected: true },
  },
};

/** Map built-in export profiles onto a video performance default. */
export function defaultVideoPerformanceProfileForExportProfile(
  exportProfileId: ExportProfileId | undefined,
): VideoPerformanceProfileId {
  if (exportProfileId === 'ai-generation') return 'fast-control';
  if (exportProfileId === 'full-production' || exportProfileId === 'character-compositing') {
    return 'standard';
  }
  return 'standard';
}

export function createDefaultVideoPerformanceSettings(
  exportProfileId: ExportProfileId = 'custom',
): VideoPerformanceSettings {
  return {
    profileId: defaultVideoPerformanceProfileForExportProfile(exportProfileId),
  };
}

export function normalizeVideoPerformanceSettings(
  settings?: Partial<VideoPerformanceSettings> | null,
  exportProfileId: ExportProfileId = 'custom',
): VideoPerformanceSettings {
  const fallback = createDefaultVideoPerformanceSettings(exportProfileId);
  const profileIds = new Set<VideoPerformanceProfileId>([
    'fast-control',
    'standard',
    'high-quality',
  ]);
  const encoderModes = new Set<VideoEncoderMode>(['quality', 'fast']);
  const resolutionIds = new Set<VideoResolutionPresetId>(['720p', '1080p', '4k']);

  const profileId = typeof settings?.profileId === 'string' && profileIds.has(settings.profileId)
    ? settings.profileId
    : fallback.profileId;

  const next: VideoPerformanceSettings = { profileId };

  if (typeof settings?.encoderMode === 'string' && encoderModes.has(settings.encoderMode)) {
    next.encoderMode = settings.encoderMode;
  }
  if (
    typeof settings?.resolutionPreset === 'string'
    && resolutionIds.has(settings.resolutionPreset)
  ) {
    next.resolutionPreset = settings.resolutionPreset;
  }
  const frameRate = Number(settings?.frameRate);
  if (Number.isFinite(frameRate) && frameRate >= 1 && frameRate <= 120) {
    next.frameRate = Math.round(frameRate);
  }

  return next;
}

export function resolveVideoPerformance(
  settings?: Partial<VideoPerformanceSettings> | null,
  exportProfileId: ExportProfileId = 'custom',
): ResolvedVideoPerformance {
  const normalized = normalizeVideoPerformanceSettings(settings, exportProfileId);
  const def = PROFILE_DEFS[normalized.profileId] ?? PROFILE_DEFS.standard;
  const resolutionPreset = normalized.resolutionPreset ?? def.resolutionPreset;
  const preset = resolveVideoPreset(resolutionPreset);
  const frameRate = normalized.frameRate ?? def.frameRate;
  const encoderMode = normalized.encoderMode ?? def.encoderMode;

  return {
    profileId: normalized.profileId,
    resolutionPreset,
    frameRate,
    width: preset.width,
    height: preset.height,
    encoderMode,
    label: def.label,
    preferredMotionPasses: def.preferredMotionPasses,
  };
}

/** Resolve project-level video performance (AI-generation → Fast Control by default). */
export function resolveProjectVideoPerformance(
  config?: Pick<ProjectExportConfiguration, 'activeProfileId' | 'videoPerformance'> | null,
): ResolvedVideoPerformance {
  const exportProfileId = config?.activeProfileId ?? 'custom';
  return resolveVideoPerformance(config?.videoPerformance, exportProfileId);
}

/**
 * Shot-export toggles that a performance profile would prefer when first applied.
 * Does not rewrite existing project settings unless callers apply the patch.
 */
export function preferredShotExportMotionDefaults(
  profileId: VideoPerformanceProfileId,
): Pick<ShotExportSettings, 'includeCameraMoveVideo' | 'includeProjectedCameraMoveVideo'> {
  const def = PROFILE_DEFS[profileId] ?? PROFILE_DEFS.standard;
  return {
    includeCameraMoveVideo: def.preferredMotionPasses.clay,
    includeProjectedCameraMoveVideo: def.preferredMotionPasses.projected,
  };
}

/** Pixel-frame product used for workload preflight (frames × width × height). */
export function computePixelFrameCount(
  frameCount: number,
  width: number,
  height: number,
): number {
  return Math.max(0, Math.round(frameCount))
    * Math.max(0, Math.round(width))
    * Math.max(0, Math.round(height));
}

export function formatPixelFrameWorkload(pixelFrames: number): string {
  if (pixelFrames <= 0) return '0';
  if (pixelFrames >= 1_000_000_000) return `${(pixelFrames / 1_000_000_000).toFixed(2)}G`;
  if (pixelFrames >= 1_000_000) return `${(pixelFrames / 1_000_000).toFixed(1)}M`;
  if (pixelFrames >= 1_000) return `${(pixelFrames / 1_000).toFixed(1)}K`;
  return String(pixelFrames);
}
