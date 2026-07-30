import React, { useEffect, useRef, useState } from 'react';
import type { LocationProject, PanoReference, Vec3 } from '../../domain/types';
import { selectionBounds } from '../../engine/buildSelection';
import {
  extractCoverageScene,
  runCoverageOptimization,
  type CoverageBounds,
  type CoverageOptimizationMode,
  type CoverageOptimizationResult,
  type CoverageOptimizationTask,
} from '../../engine/projectionCoverage';
import { useProjectStore } from '../../state/useProjectStore';
import { Field, Select, TextInput, Toggle } from './Field';

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function originLabel(origin: Vec3): string {
  return origin.map((value) => value.toFixed(2)).join(', ');
}

/** Default ~10×10 footprint around the capture origin with ~3.5 m of vertical room volume. */
function defaultAnalysisRegion(origin: Vec3, cameraHeight: number): CoverageBounds {
  const floorY = origin[1] - cameraHeight;
  return {
    min: [origin[0] - 5, floorY - 0.25, origin[2] - 5],
    max: [origin[0] + 5, floorY + 3.5, origin[2] + 5],
  };
}

function coverageBoundsFromSelection(objects: LocationProject['scene']['objects']): CoverageBounds | undefined {
  if (objects.length === 0) return undefined;
  const box = selectionBounds(objects);
  if (box.isEmpty()) return undefined;
  // Slight pad so wall faces on the selection edge still receive samples.
  box.expandByScalar(0.05);
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

export function CoverageOptimizerPanel({
  project,
  primaryPano,
  onSetCaptureOrigin,
}: {
  project: LocationProject;
  primaryPano?: PanoReference;
  onSetCaptureOrigin?: (origin: Vec3) => void;
}) {
  const selectedObjectIds = useProjectStore((state) => state.selectedObjectIds);
  const [mode, setMode] = useState<CoverageOptimizationMode>('fixed-first');
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'failed'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [result, setResult] = useState<CoverageOptimizationResult>();
  const cameraHeight = project.settings.defaultCameraHeightMeters ?? 1.6;
  const captureOrigin = primaryPano?.origin ?? project.scene.panoOrigin;
  const [restrictAnalysisRegion, setRestrictAnalysisRegion] = useState(false);
  const [analysisRegion, setAnalysisRegion] = useState<CoverageBounds>(() => (
    defaultAnalysisRegion(captureOrigin, cameraHeight)
  ));
  const analysisRegionIsValid = analysisRegion.min.every(Number.isFinite)
    && analysisRegion.max.every(Number.isFinite)
    && analysisRegion.min.every((value, axis) => value <= analysisRegion.max[axis]);
  const selectedObjects = project.scene.objects.filter((object) => selectedObjectIds.includes(object.id));
  const selectionRegion = coverageBoundsFromSelection(selectedObjects);
  const taskRef = useRef<CoverageOptimizationTask | undefined>(undefined);
  const analysisIdRef = useRef(0);
  const analysisRegionTouchedRef = useRef(false);
  const captureInputKey = [
    primaryPano?.id ?? 'scene-origin',
    ...captureOrigin,
    primaryPano?.width ?? 8_192,
    primaryPano?.height ?? 4_096,
    cameraHeight,
  ].join(':');
  const previousCaptureInputKeyRef = useRef(captureInputKey);

  const invalidateAnalysis = () => {
    analysisIdRef.current += 1;
    taskRef.current?.cancel();
    taskRef.current = undefined;
    setStatus('idle');
    setResult(undefined);
    setStatusMessage('');
  };

  useEffect(() => () => {
    analysisIdRef.current += 1;
    taskRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (previousCaptureInputKeyRef.current === captureInputKey) return;
    previousCaptureInputKeyRef.current = captureInputKey;
    analysisIdRef.current += 1;
    taskRef.current?.cancel();
    taskRef.current = undefined;
    setStatus('idle');
    setResult(undefined);
    setStatusMessage('');
    if (!analysisRegionTouchedRef.current) {
      setAnalysisRegion(defaultAnalysisRegion(captureOrigin, cameraHeight));
    }
  }, [cameraHeight, captureInputKey, captureOrigin]);

  const applySelectionBounds = () => {
    if (!selectionRegion) return;
    analysisRegionTouchedRef.current = true;
    setRestrictAnalysisRegion(true);
    setAnalysisRegion(selectionRegion);
    invalidateAnalysis();
  };

  const analyze = async () => {
    taskRef.current?.cancel();
    const analysisId = analysisIdRef.current + 1;
    analysisIdRef.current = analysisId;
    setResult(undefined);
    setStatus('running');
    setStatusMessage('Preparing indexed scene geometry…');
    try {
      const scene = await extractCoverageScene(
        project,
        (_progress, message) => {
          if (analysisIdRef.current === analysisId) setStatusMessage(message);
        },
        restrictAnalysisRegion ? [analysisRegion] : undefined,
      );
      if (analysisIdRef.current !== analysisId) return;
      const task = runCoverageOptimization(
        {
          mode,
          scene,
          firstOrigin: mode === 'fixed-first'
            ? primaryPano?.origin ?? project.scene.panoOrigin
            : undefined,
          options: {
            panoramaWidth: primaryPano?.width ?? 8_192,
            panoramaHeight: primaryPano?.height ?? 4_096,
            panoramaHeightMeters: project.settings.defaultCameraHeightMeters ?? 1.6,
          },
        },
        (_progress, message) => setStatusMessage(message),
      );
      taskRef.current = task;
      void task.promise.then((nextResult) => {
        if (taskRef.current !== task || analysisIdRef.current !== analysisId) return;
        taskRef.current = undefined;
        setResult(nextResult);
        setStatus('complete');
        setStatusMessage('');
      }).catch((error) => {
        if (taskRef.current !== task || analysisIdRef.current !== analysisId) return;
        taskRef.current = undefined;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setStatus('failed');
        setStatusMessage(error instanceof Error ? error.message : String(error));
      });
    } catch (error) {
      if (analysisIdRef.current !== analysisId) return;
      setStatus('failed');
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <details className="rounded-lg border border-subtle bg-surface-base px-3 py-2" data-coverage-optimizer>
      <summary className="cursor-pointer select-none text-xs font-semibold text-primary">
        Coverage optimizer
      </summary>
      <div className="mt-3 space-y-3 text-xs">
        <p className="leading-relaxed text-secondary">
          Analyze usable, geometry-visible surface area and find complementary panorama origins.
          The fixed-first mode preserves the current origin; joint mode searches both together.
        </p>

        <Field label="Search strategy">
          <Select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value === 'joint-pair' ? 'joint-pair' : 'fixed-first');
              invalidateAnalysis();
            }}
            disabled={status === 'running'}
            data-coverage-mode
          >
            <option value="fixed-first">Keep current + find second</option>
            <option value="joint-pair">Optimize both origins together</option>
          </Select>
        </Field>

        <Field
          label="Analysis region"
          hint="Limits both camera placement and scored surfaces to a world-space volume — use this for one room in a multi-room set. Expand Y to full room height so walls count."
        >
          <Toggle
            checked={restrictAnalysisRegion}
            disabled={status === 'running'}
            onChange={(value) => {
              setRestrictAnalysisRegion(value);
              invalidateAnalysis();
            }}
            label="Restrict optimizer to an analysis region"
          />
        </Field>

        {restrictAnalysisRegion && (
          <div className="space-y-2" data-coverage-floor-region>
            <button
              type="button"
              onClick={applySelectionBounds}
              disabled={status === 'running' || !selectionRegion}
              className="w-full rounded-lg border border-subtle px-3 py-2 font-semibold text-primary transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
              data-coverage-use-selection-bounds
            >
              {selectionRegion
                ? `Use selection bounds (${selectedObjects.length} object${selectedObjects.length === 1 ? '' : 's'})`
                : 'Select room objects in Build, then use their bounds'}
            </button>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-subtle p-2">
              {(['X', 'Y', 'Z'] as const).map((axis, axisIndex) => (
                <div key={axis} className="contents">
                  <Field label={`${axis} minimum`}>
                    <TextInput
                      type="number"
                      step="0.1"
                      disabled={status === 'running'}
                      value={analysisRegion.min[axisIndex]}
                      onChange={(event) => {
                        analysisRegionTouchedRef.current = true;
                        setAnalysisRegion((current) => {
                          const min = [...current.min] as Vec3;
                          min[axisIndex] = Number(event.target.value);
                          return { ...current, min };
                        });
                        invalidateAnalysis();
                      }}
                      data-coverage-floor-min={axis.toLowerCase()}
                    />
                  </Field>
                  <Field label={`${axis} maximum`}>
                    <TextInput
                      type="number"
                      step="0.1"
                      disabled={status === 'running'}
                      value={analysisRegion.max[axisIndex]}
                      onChange={(event) => {
                        analysisRegionTouchedRef.current = true;
                        setAnalysisRegion((current) => {
                          const max = [...current.max] as Vec3;
                          max[axisIndex] = Number(event.target.value);
                          return { ...current, max };
                        });
                        invalidateAnalysis();
                      }}
                      data-coverage-floor-max={axis.toLowerCase()}
                    />
                  </Field>
                </div>
              ))}
            </div>
          </div>
        )}

        {restrictAnalysisRegion && !analysisRegionIsValid && (
          <p className="text-[11px] text-amber-800 dark:text-amber-200" data-coverage-floor-region-error>
            Every minimum must be less than or equal to its matching maximum.
          </p>
        )}

        <button
          type="button"
          onClick={() => void analyze()}
          disabled={status === 'running'
            || project.scene.objects.every((object) => !object.visible)
            || (restrictAnalysisRegion && !analysisRegionIsValid)}
          className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
          data-coverage-analyze
        >
          {status === 'running' ? 'Analyzing coverage…' : 'Analyze panorama origins'}
        </button>

        {status === 'running' && (
          <div className="space-y-1" role="status" data-coverage-status="running">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
              <div className="h-full w-2/3 animate-pulse rounded-full bg-[var(--accent)]" />
            </div>
            <p className="text-[11px] text-secondary">{statusMessage}</p>
          </div>
        )}

        {status === 'failed' && (
          <p className="rounded-md border border-amber-400/50 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200" data-coverage-status="failed">
            {statusMessage}
          </p>
        )}

        {result && (
          <div
            className="space-y-3"
            data-coverage-result
            data-coverage-origin-a={result.originA.join(',')}
            data-coverage-origin-b={result.originB.join(',')}
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-subtle bg-surface-raised p-2 tabular-nums">
              <span className="text-secondary">Origin A usable</span><strong className="text-right text-primary">{percent(result.originACoverage)}</strong>
              <span className="text-secondary">Origin B usable</span><strong className="text-right text-primary">{percent(result.originBCoverage)}</strong>
              <span className="text-secondary">A only</span><strong className="text-right text-primary">{percent(result.originAOnlyCoverage)}</strong>
              <span className="text-secondary">B only</span><strong className="text-right text-primary">{percent(result.originBOnlyCoverage)}</strong>
              <span className="text-secondary">Overlap</span><strong className="text-right text-primary">{percent(result.overlapCoverage)}</strong>
              <span className="font-semibold text-primary">Combined</span><strong className="text-right text-[var(--accent)]">{percent(result.combinedCoverage)}</strong>
              <span className="text-secondary">Reachable upper bound</span><strong className="text-right text-primary">{percent(result.reachableCoverage)}</strong>
              <span className="text-secondary">Reachable captured</span><strong className="text-right text-primary">{percent(result.reachableEfficiency)}</strong>
              <span className="text-secondary">Estimated remaining</span><strong className="text-right text-primary">{percent(result.estimatedRemainingSurface)}</strong>
            </div>

            {restrictAnalysisRegion && (
              <p className="text-[11px] leading-snug text-muted" data-coverage-region-scope>
                Metrics above are room-local: only surfaces inside the analysis region are scored.
                Candidates stay on floors inside that same volume.
              </p>
            )}

            <div className="space-y-1 rounded-lg border border-subtle px-2 py-1.5 font-mono text-[10px] text-secondary">
              <div><span className="font-sans font-semibold text-primary">A</span> {originLabel(result.originA)}</div>
              <div><span className="font-sans font-semibold text-primary">B</span> {originLabel(result.originB)}</div>
              <div className="font-sans text-muted">
                {result.candidateCount} candidates · {result.sampleCount.toLocaleString()} fine samples · {(result.elapsedMilliseconds / 1000).toFixed(1)}s
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {onSetCaptureOrigin && mode === 'joint-pair' && (
                <button
                  type="button"
                  onClick={() => onSetCaptureOrigin(result.originA)}
                  className="rounded-lg border border-subtle px-3 py-2 font-semibold text-primary transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  data-coverage-apply-capture-a
                >
                  Move capture origin to A
                </button>
              )}
              {onSetCaptureOrigin && (
                <button
                  type="button"
                  onClick={() => onSetCaptureOrigin(result.originB)}
                  className="rounded-lg border border-subtle px-3 py-2 font-semibold text-primary transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  data-coverage-apply-capture
                >
                  Move capture origin to B
                </button>
              )}
            </div>

            <p className="text-[11px] leading-snug text-muted" data-coverage-capture-plan>
              Capture plan: move the capture origin, then Download Projected 360
              (Build) or use Reference → Fill missing areas → Suggest a spot
              to prepare a seed automatically. Existing panorama origins are never rewritten.
            </p>
          </div>
        )}
      </div>
    </details>
  );
}
