import React, { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, MapPin, Sparkles, Wrench } from 'lucide-react';
import { useThemeStore } from '../../state/useThemeStore';
import { useProjectStore } from '../../state/useProjectStore';
import { downloadDataUrl } from '../../engine/fileTransfers';
import { downloadPanoImage } from '../../engine/panoImage';
import { createPendingSecondCapturePlan, primaryStyledPano } from '../../engine/panoProjectionCore';
import {
  estimateRemainingSeconds,
  formatDurationSeconds,
  SUGGESTED_CAPTURE_ANALYSIS_ETA_SECONDS,
  SUGGESTED_CAPTURE_RENDER_ETA_SECONDS,
} from '../../engine/secondCaptureProgress';
import type {
  SuggestedSecondCapturePhase,
  SuggestedSecondCaptureProgress,
  SuggestedSecondCaptureResult,
  SuggestedSecondCaptureTask,
} from '../../engine/prepareSuggestedSecondCapture';
import { ContextualPanel } from './ContextualPanel';
import { StyledPanoImportButton } from './StyledPanoImportButton';

type ForkStep = 'choose' | 'place_method' | 'running' | 'awaiting_import' | 'failed';

type SeedDownloadStatus = 'idle' | 'succeeded' | 'failed';

export function SecondCaptureForkContent({
  open,
  onClose,
  onContinue,
  onAwaitingImport,
  onPlaceInBuild,
  compactIntro = false,
  initialStep = 'choose',
}: {
  open: boolean;
  onClose: () => void;
  onContinue: () => void;
  onAwaitingImport: () => void;
  /** Called after switching to Build origin mode (default closes). */
  onPlaceInBuild?: () => void;
  /** Hide the small “Reference ready” eyebrow when the parent modal already titles the step. */
  compactIntro?: boolean;
  /** Start after the lightweight choice when the planner was opened from guidance. */
  initialStep?: Extract<ForkStep, 'choose' | 'place_method'>;
}) {
  const project = useProjectStore((state) => state.project);
  const setPanoOrigin = useProjectStore((state) => state.setPanoOrigin);
  const setPendingSecondCapturePlan = useProjectStore(
    (state) => state.setPendingSecondCapturePlan,
  );
  const setWorkspace = useProjectStore((state) => state.setWorkspace);
  const setBuildMode = useProjectStore((state) => state.setBuildMode);
  const theme = useThemeStore((state) => state.theme);

  const [step, setStep] = useState<ForkStep>(initialStep);
  const [progress, setProgress] = useState<SuggestedSecondCaptureProgress | undefined>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [optimizationSucceeded, setOptimizationSucceeded] = useState(false);
  const [projectedSeedReady, setProjectedSeedReady] = useState(false);
  const [seedDownloadStatus, setSeedDownloadStatus] = useState<SeedDownloadStatus>('idle');
  const [seedResult, setSeedResult] = useState<SuggestedSecondCaptureResult | undefined>();
  const [seedRedownloading, setSeedRedownloading] = useState(false);
  const taskRef = useRef<SuggestedSecondCaptureTask | undefined>(undefined);
  const suggestionRequestRef = useRef(0);
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    if (!open) {
      suggestionRequestRef.current += 1;
      taskRef.current?.cancel();
      taskRef.current = undefined;
      setStep(initialStep);
      setProgress(undefined);
      setElapsedMs(0);
      setError(undefined);
      setOptimizationSucceeded(false);
      setProjectedSeedReady(false);
      setSeedDownloadStatus('idle');
      setSeedResult(undefined);
      setSeedRedownloading(false);
    }

    return () => {
      suggestionRequestRef.current += 1;
      taskRef.current?.cancel();
      taskRef.current = undefined;
    };
  }, [initialStep, open]);

  useEffect(() => {
    if (step !== 'running') return;
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 500);
    return () => window.clearInterval(id);
  }, [step]);

  if (!open) return null;

  const phaseDefault = progress?.phase === 'rendering' || progress?.phase === 'moving_origin'
    ? SUGGESTED_CAPTURE_RENDER_ETA_SECONDS
    : SUGGESTED_CAPTURE_ANALYSIS_ETA_SECONDS;
  const remainingSeconds = progress
    ? estimateRemainingSeconds({
      elapsedMs,
      progress: progress.progress,
      phaseDefaultSeconds: phaseDefault,
    })
    : SUGGESTED_CAPTURE_ANALYSIS_ETA_SECONDS
      + SUGGESTED_CAPTURE_RENDER_ETA_SECONDS;

  const latchFrozenPlan = (originB: SuggestedSecondCaptureResult['originB']) => {
    const primary = primaryStyledPano(project);
    if (!primary) return;
    setPendingSecondCapturePlan(createPendingSecondCapturePlan({
      primaryPanoId: primary.id,
      origin: originB,
      rotation: project.scene.panoRotation,
      trackLiveOrigin: false,
    }));
    setPanoOrigin(originB);
  };

  const downloadSeed = async (result: SuggestedSecondCaptureResult) => {
    await downloadPanoImage(
      result.projected.dataUrl,
      result.projected.width,
      result.projected.height,
      'projected_360_second_capture.png',
      {
        letterboxEnabled: false,
        targetWidth: project.settings.defaultShotWidth,
        targetHeight: project.settings.defaultShotHeight,
      },
      downloadDataUrl,
    );
  };

  const startAutoSuggest = () => {
    const requestId = suggestionRequestRef.current + 1;
    suggestionRequestRef.current = requestId;
    taskRef.current?.cancel();
    setError(undefined);
    setOptimizationSucceeded(false);
    setProjectedSeedReady(false);
    setSeedDownloadStatus('idle');
    setSeedResult(undefined);
    setStep('running');
    setProgress({
      phase: 'preparing',
      progress: 0.01,
      message: 'Starting coverage analysis…',
    });
    startedAtRef.current = Date.now();
    setElapsedMs(0);

    void (async () => {
      try {
        const { prepareSuggestedSecondCapture } = await import('../../engine/prepareSuggestedSecondCapture');
        if (suggestionRequestRef.current !== requestId) return;
        const task = prepareSuggestedSecondCapture(project, theme, (next) => {
          setProgress(next);
        });
        taskRef.current = task;

        const result = await task.promise;
        // Latch frozen plan even if the panel closed between resolve and this microtask.
        latchFrozenPlan(result.originB);
        setOptimizationSucceeded(true);
        setProjectedSeedReady(true);
        setSeedResult(result);
        if (taskRef.current !== task) return;
        let downloadOk = false;
        try {
          await downloadSeed(result);
          downloadOk = true;
        } catch {
          downloadOk = false;
        }
        setSeedDownloadStatus(downloadOk ? 'succeeded' : 'failed');
        taskRef.current = undefined;
        setStep('awaiting_import');
        onAwaitingImport();
      } catch (err) {
        if (suggestionRequestRef.current !== requestId) return;
        taskRef.current = undefined;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Could not suggest a second vantage.');
        setOptimizationSucceeded(false);
        setProjectedSeedReady(false);
        setSeedDownloadStatus('idle');
        setStep('failed');
      }
    })();
  };

  const retrySeedDownload = async () => {
    if (!seedResult || seedRedownloading) return;
    setSeedRedownloading(true);
    try {
      await downloadSeed(seedResult);
      setSeedDownloadStatus('succeeded');
    } catch {
      setSeedDownloadStatus('failed');
    } finally {
      setSeedRedownloading(false);
    }
  };

  const cancelRunning = () => {
    suggestionRequestRef.current += 1;
    taskRef.current?.cancel();
    taskRef.current = undefined;
    setStep('place_method');
    setProgress(undefined);
  };

  const goPlaceInBuild = () => {
    const primary = primaryStyledPano(project);
    if (primary) {
      setPendingSecondCapturePlan(createPendingSecondCapturePlan({
        primaryPanoId: primary.id,
        origin: project.scene.panoOrigin,
        rotation: project.scene.panoRotation,
        trackLiveOrigin: true,
      }));
    }
    setBuildMode('pano_origin');
    setWorkspace('build');
    onPlaceInBuild?.();
    onClose();
  };

  const awaitingMessage = (() => {
    if (!optimizationSucceeded || !projectedSeedReady) {
      return 'Capture origin moved to the suggested spot. Import a styled second capture to blend.';
    }
    if (seedDownloadStatus === 'succeeded') {
      return 'Capture origin moved to the suggested spot. A projected 360 seed was downloaded — style or inpaint it, then import here to blend.';
    }
    if (seedDownloadStatus === 'failed') {
      return 'Capture origin moved to the suggested spot and a projected seed was rendered, but the download failed. Download the seed again, then style or inpaint it and import here.';
    }
    return 'Capture origin moved to the suggested spot. Import a styled second capture to blend.';
  })();

  return (
    <div className="space-y-3" data-second-capture-fork>
      {step === 'choose' && (
        <>
          <div>
            {!compactIntro && (
              <div className="text-xs font-semibold uppercase tracking-wide text-secondary">Reference ready</div>
            )}
            <p className={`text-sm text-primary ${compactIntro ? '' : 'mt-1'}`}>
              Continue with this capture, or add a second vantage to fill areas that look thin far from the origin.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setPendingSecondCapturePlan(undefined);
              onContinue();
            }}
            className="w-full rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--accent-hover)]"
            data-second-capture-continue
          >
            Continue with this reference
          </button>
          <button
            type="button"
            onClick={() => setStep('place_method')}
            className="w-full rounded-lg border border-subtle px-3 py-2.5 text-sm font-medium text-primary transition hover:border-[var(--accent)] hover:text-accent"
            data-second-capture-fill-gaps
          >
            Fill missing areas
          </button>
          <p className="text-[11px] leading-snug text-muted">
            Projection is strongest near this capture. Distant walls and corners can look weak — a second vantage fills those gaps when blended.
          </p>
        </>
      )}

      {step === 'place_method' && (
        <>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-secondary">Second vantage</div>
            <p className="mt-1 text-sm text-primary">
              How do you want to pick the next capture point?
            </p>
          </div>
          <button
            type="button"
            onClick={startAutoSuggest}
            className="flex w-full items-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2.5 text-left text-sm font-semibold text-white transition hover:bg-[var(--accent-hover)]"
            data-second-capture-suggest
          >
            <Sparkles className="h-4 w-4 shrink-0" />
            <span>
              Suggest a spot for me
              <span className="mt-0.5 block text-[11px] font-normal text-white/85">
                Finds a complementary origin, moves capture there, and downloads a projected 360 seed.
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={goPlaceInBuild}
            className="flex w-full items-center gap-2 rounded-lg border border-subtle px-3 py-2.5 text-left text-sm font-medium text-primary transition hover:border-[var(--accent)] hover:text-accent"
            data-second-capture-place-build
          >
            <Wrench className="h-4 w-4 shrink-0" />
            <span>
              I&apos;ll place it in Build
              <span className="mt-0.5 block text-[11px] font-normal text-muted">
                Opens Origin mode so you can move the capture yourself.
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setStep('choose')}
            className="text-xs font-medium text-secondary hover:text-accent"
          >
            Back
          </button>
        </>
      )}

      {step === 'running' && (
        <div className="space-y-3" data-second-capture-progress aria-live="polite">
          <div className="flex items-start gap-2">
            <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />
            <div>
              <div className="text-sm font-semibold text-primary">
                {phaseLabel(progress?.phase)}
              </div>
              <p className="mt-0.5 text-xs text-secondary">
                {progress?.message ?? 'Working…'}
              </p>
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
              style={{ width: `${Math.round((progress?.progress ?? 0.05) * 100)}%` }}
              data-second-capture-progress-bar
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
            <span data-second-capture-eta>
              About {formatDurationSeconds(remainingSeconds)} remaining
              <span className="text-secondary"> · {formatElapsed(elapsedMs)} elapsed</span>
            </span>
            <span>{Math.round((progress?.progress ?? 0) * 100)}%</span>
          </div>
          <p className="text-[11px] leading-snug text-muted">
            Coverage search can take half a minute on larger sets — the app is still working.
          </p>
          <button
            type="button"
            onClick={cancelRunning}
            className="text-xs font-medium text-secondary hover:text-accent"
            data-second-capture-cancel
          >
            Cancel
          </button>
        </div>
      )}

      {step === 'awaiting_import' && (
        <>
          <div
            data-second-capture-seed-status={seedDownloadStatus}
            data-second-capture-optimization={optimizationSucceeded ? 'succeeded' : 'pending'}
            data-second-capture-projected={projectedSeedReady ? 'ready' : 'pending'}
            data-second-capture-plan-origin={seedResult?.originB.map((v) => v.toFixed(3)).join(',') ?? ''}
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-secondary">
              <MapPin className="h-3.5 w-3.5 text-accent" />
              Ready for second capture
            </div>
            <p className="mt-1 text-sm text-primary">
              {awaitingMessage}
            </p>
          </div>
          {seedDownloadStatus === 'failed' && seedResult && (
            <button
              type="button"
              onClick={() => void retrySeedDownload()}
              disabled={seedRedownloading}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-subtle px-3 py-2.5 text-sm font-medium text-primary transition hover:border-[var(--accent)] hover:text-accent disabled:opacity-60"
              data-second-capture-download-seed-again
            >
              {seedRedownloading
                ? <LoaderCircle className="h-4 w-4 animate-spin" />
                : <Download className="h-4 w-4" />}
              {seedRedownloading ? 'Downloading…' : 'Download seed again'}
            </button>
          )}
          <StyledPanoImportButton
            modeAware
            primary
            onImported={(mode) => {
              if (mode === 'add_secondary') {
                onAwaitingImport();
                onClose();
              }
            }}
          />
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium text-secondary hover:text-accent"
            data-second-capture-dismiss
          >
            Dismiss
          </button>
        </>
      )}

      {step === 'failed' && (
        <>
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error ?? 'Could not suggest a second vantage.'}
          </p>
          <p className="text-xs text-secondary">
            You can place the second origin manually in Build instead.
          </p>
          <button
            type="button"
            onClick={goPlaceInBuild}
            className="w-full rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-white"
            data-second-capture-fallback-build
          >
            Place in Build
          </button>
          <button
            type="button"
            onClick={() => setStep('place_method')}
            className="text-xs font-medium text-secondary hover:text-accent"
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}

export function SecondCaptureForkPanel({
  open,
  onClose,
  onContinue,
  onAwaitingImport,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: () => void;
  onAwaitingImport: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-x-3 top-3 z-30 mx-auto max-w-md sm:inset-x-auto sm:left-5 sm:right-auto"
      data-second-capture-fork-panel
    >
      <ContextualPanel className="shadow-soft">
        <SecondCaptureForkContent
          open={open}
          onClose={onClose}
          onContinue={onContinue}
          onAwaitingImport={onAwaitingImport}
        />
      </ContextualPanel>
    </div>
  );
}

function phaseLabel(phase?: SuggestedSecondCapturePhase): string {
  switch (phase) {
    case 'preparing':
      return 'Preparing geometry…';
    case 'analyzing':
      return 'Finding a second vantage…';
    case 'moving_origin':
      return 'Moving capture origin…';
    case 'rendering':
      return 'Rendering projected 360…';
    case 'complete':
      return 'Done';
    case 'failed':
      return 'Something went wrong';
    default:
      return 'Working…';
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
