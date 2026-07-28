import { describe, expect, it } from 'vitest';
import {
  buildKeyframeThumbCacheFromKeyframes,
  commitKeyframeThumbIfCurrent,
  shouldCommitKeyframeThumb,
} from '../src/engine/keyframePreviewThumbs';

describe('keyframe preview thumb generation guard', () => {
  it('rebuilds local cache from restored keyframe previewUri values only', () => {
    const cache = buildKeyframeThumbCacheFromKeyframes([
      { id: 's', previewUri: 'data:image/png;base64,START' },
      { id: 'm' },
      { id: 'e', previewUri: 'data:image/png;base64,END' },
    ]);
    expect(cache).toEqual({
      s: 'data:image/png;base64,START',
      e: 'data:image/png;base64,END',
    });
    expect(cache.m).toBeUndefined();
  });

  it('rejects stale thumbnail commits after generation advances (undo race)', () => {
    // Recapture keyframe starts render at generation 5.
    const renderGeneration = 5;
    // Undo bumps generation to 6 and rebuilds cache from restored previews.
    const currentGeneration = 6;
    expect(shouldCommitKeyframeThumb({
      renderGeneration,
      currentGeneration,
    })).toBe(false);

    const restored = [
      { id: 's', previewUri: 'data:image/png;base64,OLD_START' },
      { id: 'e', previewUri: 'data:image/png;base64,OLD_END' },
    ];
    const lateResult = commitKeyframeThumbIfCurrent({
      renderGeneration: 5,
      currentGeneration: 6,
      keyframeId: 's',
      dataUrl: 'data:image/png;base64,UNDONE_POSE',
      keyframes: restored,
    });
    expect(lateResult).toBeUndefined();
  });

  it('allows commit when generation still matches', () => {
    const keyframes = [
      { id: 's', previewUri: 'data:image/png;base64,OLD' },
      { id: 'e', previewUri: 'data:image/png;base64,END' },
    ];
    const result = commitKeyframeThumbIfCurrent({
      renderGeneration: 3,
      currentGeneration: 3,
      keyframeId: 's',
      dataUrl: 'data:image/png;base64,NEW',
      keyframes,
    });
    expect(result).toBeDefined();
    expect(result!.nextCache.s).toBe('data:image/png;base64,NEW');
    expect(result!.nextKeyframes.find((k) => k.id === 's')?.previewUri).toBe('data:image/png;base64,NEW');
    expect(result!.nextKeyframes.find((k) => k.id === 'e')?.previewUri).toBe('data:image/png;base64,END');
  });

  it('models the full Recapture keyframe → pending render → Undo → resolve sequence', () => {
    let generation = 0;
    let cache: Record<string, string> = {
      s: 'data:image/png;base64,START_V1',
      e: 'data:image/png;base64,END_V1',
    };
    let keyframes = [
      { id: 's', previewUri: cache.s },
      { id: 'e', previewUri: cache.e },
    ];

    // Recapture keyframe starts a thumb render for Start at generation 1.
    generation += 1;
    const renderGeneration = generation;

    // User undoes before the render resolves → restore + invalidate.
    generation += 1;
    keyframes = [
      { id: 's', previewUri: 'data:image/png;base64,START_V1' },
      { id: 'e', previewUri: 'data:image/png;base64,END_V1' },
    ];
    cache = buildKeyframeThumbCacheFromKeyframes(keyframes);

    // Late render for the undone pose must not write.
    const late = commitKeyframeThumbIfCurrent({
      renderGeneration,
      currentGeneration: generation,
      keyframeId: 's',
      dataUrl: 'data:image/png;base64,START_UNDONE',
      keyframes,
    });
    expect(late).toBeUndefined();
    expect(cache.s).toBe('data:image/png;base64,START_V1');
    expect(keyframes.find((k) => k.id === 's')?.previewUri).toBe('data:image/png;base64,START_V1');
  });
});
