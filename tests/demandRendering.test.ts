import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('interactive viewer rendering', () => {
  it('renders only after invalidation and caps high-DPI backing stores', () => {
    const sceneViewport = readFileSync(
      new URL('../src/components/viewers/SceneViewport.tsx', import.meta.url),
      'utf8',
    );
    const panoViewer = readFileSync(
      new URL('../src/components/viewers/PanoViewer.tsx', import.meta.url),
      'utf8',
    );
    const cropPreview = readFileSync(
      new URL('../src/components/viewers/ShotPanoCropPreview.tsx', import.meta.url),
      'utf8',
    );

    for (const source of [sceneViewport, panoViewer]) {
      expect(source).toContain('const requestRender = useCallback');
      expect(source).toContain('renderFrameRef.current');
      expect(source).not.toContain('requestAnimationFrame(animate)');
      expect(source).toContain('Math.min(window.devicePixelRatio || 1, MAX_INTERACTIVE_PIXEL_RATIO)');
    }

    expect(sceneViewport).toContain('const shouldAnimateFly = (framing?.flyActive || freeCameraActiveRef.current) && hasActiveFlyInput();');
    expect(sceneViewport).toContain('if (shouldAnimateFly) requestRender();');
    expect(sceneViewport).toContain('const sceneStructureKey = useMemo');
    expect(sceneViewport).toContain('applySceneObjectTransform(node, object.transform');
    expect(sceneViewport).toContain('const frustumHelpers = new Map<string, THREE.CameraHelper>();');
    expect(cropPreview).toContain('const PREVIEW_DEBOUNCE_MS = 140;');
    expect(cropPreview).toContain("await import('../../engine/renderers')");
    expect(cropPreview).toContain('window.clearTimeout(timeoutId);');
  });
});
