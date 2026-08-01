import { describe, expect, it } from 'vitest';
import {
  VIDEO_RESOLUTION_PRESETS,
  cameraMoveFrameTimeSeconds,
  computeCameraMoveFrameCount,
  videoPresetForSize,
} from '../src/engine/videoPresets';

describe('agent video render presets', () => {
  it('supports preview, production, and 4k targets', () => {
    expect(VIDEO_RESOLUTION_PRESETS['720p']).toMatchObject({ width: 1280, height: 720 });
    expect(videoPresetForSize(1280, 720).id).toBe('720p');
    expect(videoPresetForSize(1920, 1080).id).toBe('1080p');
    expect(videoPresetForSize(3840, 2160).id).toBe('4k');
  });

  it('maps deterministic frame endpoints across the authored duration', () => {
    const total = computeCameraMoveFrameCount(2, 30);
    expect(total).toBe(60);
    expect(cameraMoveFrameTimeSeconds(0, 30, 2)).toBe(0);
    expect(cameraMoveFrameTimeSeconds(total - 1, 30, 2)).toBe(2);
  });
});
