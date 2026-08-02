import type { LocationProject, Vec3 } from '../domain/types';
import type { SceneVisualTheme } from './sceneObjects';
import { primaryStyledPano } from './panoProjectionCore';
import {
  extractCoverageScene,
  runCoverageOptimization,
  type CoverageOptimizationResult,
  type CoverageOptimizationTask,
} from './projectionCoverage';

export type SuggestedSecondCapturePhase =
  | 'preparing'
  | 'analyzing'
  | 'moving_origin'
  | 'rendering'
  | 'complete'
  | 'failed';

export interface SuggestedSecondCaptureProgress {
  phase: SuggestedSecondCapturePhase;
  /** 0–1 overall progress across analyze + render. */
  progress: number;
  message: string;
}

export interface SuggestedSecondCaptureResult {
  originB: Vec3;
  coverage: CoverageOptimizationResult;
  projected: { dataUrl: string; width: number; height: number };
}

export interface SuggestedSecondCaptureTask {
  promise: Promise<SuggestedSecondCaptureResult>;
  cancel(): void;
}

export {
  SUGGESTED_CAPTURE_ANALYSIS_ETA_SECONDS,
  SUGGESTED_CAPTURE_RENDER_ETA_SECONDS,
  estimateRemainingSeconds,
  formatDurationSeconds,
} from './secondCaptureProgress';

/**
 * Find a complementary second origin, move capture there, and render a projected 360 seed.
 * Does not rewrite existing pano origins. Caller downloads the PNG and awaits import.
 */
export function prepareSuggestedSecondCapture(
  project: LocationProject,
  theme: SceneVisualTheme,
  onProgress?: (progress: SuggestedSecondCaptureProgress) => void,
): SuggestedSecondCaptureTask {
  let cancelled = false;
  let coverageTask: CoverageOptimizationTask | undefined;
  let rejectTask: (reason?: unknown) => void = () => undefined;

  const report = (update: SuggestedSecondCaptureProgress) => {
    if (!cancelled) onProgress?.(update);
  };

  const promise = new Promise<SuggestedSecondCaptureResult>((resolve, reject) => {
    rejectTask = reject;
    void (async () => {
      try {
        const primary = primaryStyledPano(project);
        if (!primary) {
          throw new Error('Import and approve a styled reference before suggesting a second capture.');
        }

        report({
          phase: 'preparing',
          progress: 0.02,
          message: 'Preparing scene geometry for coverage analysis…',
        });

        const scene = await extractCoverageScene(
          project,
          (_progress, message) => {
            report({
              phase: 'preparing',
              progress: 0.02 + Math.min(0.08, _progress * 0.08),
              message,
            });
          },
        );
        if (cancelled) throw new DOMException('Cancelled.', 'AbortError');

        report({
          phase: 'analyzing',
          progress: 0.12,
          message: 'Searching for a complementary second vantage…',
        });

        coverageTask = runCoverageOptimization(
          {
            mode: 'fixed-first',
            scene,
            firstOrigin: primary.origin,
            options: {
              panoramaWidth: primary.width ?? 8_192,
              panoramaHeight: primary.height ?? 4_096,
              panoramaHeightMeters: project.settings.defaultCameraHeightMeters ?? 1.6,
            },
          },
          (progress, message) => {
            report({
              phase: 'analyzing',
              progress: 0.12 + progress * 0.68,
              message: message || 'Analyzing coverage…',
            });
          },
        );

        const coverage = await coverageTask.promise;
        coverageTask = undefined;
        if (cancelled) throw new DOMException('Cancelled.', 'AbortError');

        report({
          phase: 'moving_origin',
          progress: 0.82,
          message: 'Moving capture origin to the suggested vantage…',
        });

        // Yield so UI can paint before the WebGL bake blocks the main thread.
        await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
        if (cancelled) throw new DOMException('Cancelled.', 'AbortError');

        report({
          phase: 'rendering',
          progress: 0.86,
          message: 'Rendering projected 360 from the new origin…',
        });

        const projectAtB: LocationProject = {
          ...project,
          scene: {
            ...project.scene,
            panoOrigin: [...coverage.originB] as Vec3,
          },
        };

        const { renderProjectedEquirectangularPano } = await import('./renderers');
        const projected = await renderProjectedEquirectangularPano(
          projectAtB,
          undefined,
          undefined,
          theme,
        );
        if (cancelled) throw new DOMException('Cancelled.', 'AbortError');

        report({
          phase: 'complete',
          progress: 1,
          message: 'Ready — import your second styled capture.',
        });

        resolve({
          originB: [...coverage.originB] as Vec3,
          coverage,
          projected,
        });
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) {
          reject(error instanceof DOMException ? error : new DOMException('Cancelled.', 'AbortError'));
          return;
        }
        report({
          phase: 'failed',
          progress: 0,
          message: error instanceof Error ? error.message : 'Could not prepare a second capture.',
        });
        reject(error);
      }
    })();
  });

  return {
    promise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      coverageTask?.cancel();
      rejectTask(new DOMException('Cancelled.', 'AbortError'));
    },
  };
}
