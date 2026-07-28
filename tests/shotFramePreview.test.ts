import { describe, expect, it } from 'vitest';
import { shouldStartAutomaticShotFrameRender } from '../src/engine/shotFramePreview';

/**
 * Simulates the automatic still-preview gate the same way ShotsWorkspace does:
 * Stage / fly clear the in-flight key, then the helper decides whether to call renderShotFrame.
 */
function countAutomaticRenderShotFrameInvocations(options: {
  transitions: Array<{ shotCameraFlying: boolean; stagingMode: boolean; framePreviewKey: string }>;
}): number {
  let activeFrameRenderKey: string | undefined;
  let invocations = 0;

  for (const step of options.transitions) {
    if (step.shotCameraFlying || step.stagingMode) {
      activeFrameRenderKey = undefined;
    }
    if (!shouldStartAutomaticShotFrameRender({
      shotCameraFlying: step.shotCameraFlying,
      stagingMode: step.stagingMode,
      framePreviewKey: step.framePreviewKey,
      activeFrameRenderKey,
    })) {
      continue;
    }
    activeFrameRenderKey = step.framePreviewKey;
    invocations += 1;
  }

  return invocations;
}

describe('automatic shot frame preview gate', () => {
  it('invokes renderShotFrame zero times when opening Stage', () => {
    const framePreviewKey = JSON.stringify({ scene: 'large-set', camera: { y: 1.6 } });

    // Typical Stage click: lands the fly camera and opens staging together.
    // Previously this activated the unstable preview loop; now Stage must start zero renders.
    expect(countAutomaticRenderShotFrameInvocations({
      transitions: [
        { shotCameraFlying: true, stagingMode: false, framePreviewKey },
        { shotCameraFlying: false, stagingMode: true, framePreviewKey },
        { shotCameraFlying: false, stagingMode: true, framePreviewKey },
        { shotCameraFlying: false, stagingMode: true, framePreviewKey },
      ],
    })).toBe(0);

    // Already landed, then open Stage — still zero Stage-time renders.
    expect(countAutomaticRenderShotFrameInvocations({
      transitions: [
        { shotCameraFlying: false, stagingMode: true, framePreviewKey },
        { shotCameraFlying: false, stagingMode: true, framePreviewKey },
      ],
    })).toBe(0);
  });

  it('skips duplicate renders for the same preview key (in-flight guard)', () => {
    const framePreviewKey = 'same-key';
    expect(shouldStartAutomaticShotFrameRender({
      shotCameraFlying: false,
      stagingMode: false,
      framePreviewKey,
      activeFrameRenderKey: framePreviewKey,
    })).toBe(false);
  });

  it('allows a refresh after leaving Stage or landing the camera', () => {
    const framePreviewKey = 'refresh-me';
    expect(countAutomaticRenderShotFrameInvocations({
      transitions: [
        { shotCameraFlying: false, stagingMode: false, framePreviewKey },
        { shotCameraFlying: false, stagingMode: true, framePreviewKey },
        { shotCameraFlying: false, stagingMode: false, framePreviewKey },
      ],
    })).toBe(2);

    expect(countAutomaticRenderShotFrameInvocations({
      transitions: [
        { shotCameraFlying: true, stagingMode: false, framePreviewKey },
        { shotCameraFlying: false, stagingMode: false, framePreviewKey },
      ],
    })).toBe(1);
  });
});
