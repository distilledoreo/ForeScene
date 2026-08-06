/** Production-safe DaVinci Resolve target for camera-move exports. */
export const DEFAULT_VIDEO_WIDTH = 1920;
export const DEFAULT_VIDEO_HEIGHT = 1080;
export const DEFAULT_VIDEO_FRAME_RATE = 30;

export type VideoResolutionPresetId = '720p' | '1080p' | '4k';

export interface VideoResolutionPreset {
  id: VideoResolutionPresetId;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  /** Full AVC codec string for VideoEncoder / Mediabunny. */
  avcCodecString: string;
  profile: 'high';
  level: string;
  /** Target bitrate for H.264 (bits/sec). */
  bitrate: number;
}

/**
 * Resolution-aware H.264 High Profile configs.
 * 1080p30 → Level 4.0; 4K30 → Level 5.1.
 */
export const VIDEO_RESOLUTION_PRESETS: Record<VideoResolutionPresetId, VideoResolutionPreset> = {
  '720p': {
    id: '720p',
    // Frame rate is often overridden (Fast Control uses 24 fps).
    label: '720p (Fast Control / Preview)',
    width: 1280,
    height: 720,
    frameRate: DEFAULT_VIDEO_FRAME_RATE,
    avcCodecString: 'avc1.64001f',
    profile: 'high',
    level: '3.1',
    bitrate: 5_000_000,
  },
  '1080p': {
    id: '1080p',
    label: '1080p30 (Resolve)',
    width: 1920,
    height: 1080,
    frameRate: DEFAULT_VIDEO_FRAME_RATE,
    // High Profile (0x64), Level 4.0 (0x28)
    avcCodecString: 'avc1.640028',
    profile: 'high',
    level: '4.0',
    bitrate: 12_000_000,
  },
  '4k': {
    id: '4k',
    label: '4K30 (High quality)',
    width: 3840,
    height: 2160,
    frameRate: DEFAULT_VIDEO_FRAME_RATE,
    // High Profile (0x64), Level 5.1 (0x33)
    avcCodecString: 'avc1.640033',
    profile: 'high',
    level: '5.1',
    bitrate: 35_000_000,
  },
};

export function resolveVideoPreset(
  presetId: VideoResolutionPresetId = '1080p',
): VideoResolutionPreset {
  return VIDEO_RESOLUTION_PRESETS[presetId] ?? VIDEO_RESOLUTION_PRESETS['1080p'];
}

export function videoPresetForSize(width: number, height: number): VideoResolutionPreset {
  if (width >= 3840 || height >= 2160) return VIDEO_RESOLUTION_PRESETS['4k'];
  if (width <= 1280 || height <= 720) return VIDEO_RESOLUTION_PRESETS['720p'];
  return VIDEO_RESOLUTION_PRESETS['1080p'];
}

export function computeCameraMoveFrameCount(durationSeconds: number, frameRate: number): number {
  const fps = Math.max(1, frameRate);
  const duration = Math.max(0, durationSeconds);
  // CFR frame count for a clip of `duration` seconds. MP4 presentation timestamps
  // remain frameIndex / fps; camera sampling stretches across [0, duration] inclusive.
  return Math.max(1, Math.round(duration * fps));
}

/**
 * Camera timeline sample for a deterministic export frame.
 * MP4 timestamps stay at frameIndex / fps; camera time spans [0, duration] so the
 * last encoded frame hits the authored end keyframe exactly.
 */
export function cameraMoveFrameTimeSeconds(
  frameIndex: number,
  frameRate: number,
  durationSeconds: number,
): number {
  const fps = Math.max(1, frameRate);
  const totalFrames = computeCameraMoveFrameCount(durationSeconds, fps);
  if (totalFrames <= 1) return durationSeconds;
  const clampedIndex = Math.min(Math.max(0, frameIndex), totalFrames - 1);
  return (clampedIndex / (totalFrames - 1)) * durationSeconds;
}
