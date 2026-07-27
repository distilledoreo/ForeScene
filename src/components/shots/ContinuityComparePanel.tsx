import React, { useMemo } from 'react';
import type { LocationProject, Shot } from '../../domain/types';
import {
  compareShotsForContinuity,
  getPreviousShotInSequence,
} from '../../engine/continuityCompare';

export interface ContinuityComparePanelProps {
  project: LocationProject;
  currentShot: Shot;
  overlayOpacity?: number;
  onOverlayOpacityChange?: (value: number) => void;
  /** Optional previous-shot still for visual overlay. */
  previousPreviewUri?: string;
  currentPreviewUri?: string;
}

/** Shot-to-shot continuity: previous overlay + structured deltas. */
export function ContinuityComparePanel({
  project,
  currentShot,
  overlayOpacity = 0.45,
  onOverlayOpacityChange,
  previousPreviewUri,
  currentPreviewUri,
}: ContinuityComparePanelProps) {
  const previousShot = useMemo(
    () => getPreviousShotInSequence(project, currentShot.id),
    [project, currentShot.id],
  );

  const report = useMemo(() => {
    if (!previousShot) return undefined;
    return compareShotsForContinuity({
      project,
      previousShot,
      currentShot,
    });
  }, [project, previousShot, currentShot]);

  if (!previousShot || !report) {
    return (
      <div data-continuity-compare className="rounded-lg border border-[var(--border)] p-3 text-sm text-[var(--muted)]">
        No previous shot in the sequence to compare.
      </div>
    );
  }

  return (
    <div data-continuity-compare className="space-y-3 rounded-lg border border-[var(--border)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Continuity vs previous</h3>
        <span className="text-xs text-[var(--muted)]">{report.summary}</span>
      </div>
      <p className="text-xs text-[var(--muted)]">
        {report.previousShotLabel} → {report.currentShotLabel}
      </p>

      {(previousPreviewUri || currentPreviewUri) && (
        <div className="relative aspect-video overflow-hidden rounded-md bg-black/40">
          {currentPreviewUri && (
            <img
              src={currentPreviewUri}
              alt="Current shot"
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          {previousPreviewUri && (
            <img
              src={previousPreviewUri}
              alt="Previous shot overlay"
              data-continuity-previous-overlay
              className="absolute inset-0 h-full w-full object-cover"
              style={{ opacity: overlayOpacity }}
            />
          )}
        </div>
      )}

      {onOverlayOpacityChange && (
        <label className="flex items-center gap-2 text-xs">
          Previous overlay
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={overlayOpacity}
            onChange={(event) => onOverlayOpacityChange(Number(event.target.value))}
            data-continuity-overlay-slider
          />
        </label>
      )}

      <DeltaGroup title="Camera" items={report.camera.map((d) => `${d.label}: Δ ${formatDelta(d)}`)} />
      <DeltaGroup title="Lens" items={report.lens.map((d) => `${d.label}: ${d.previous} → ${d.current}`)} />
      <DeltaGroup title="Clipping" items={report.clipping.map((d) => `${d.label}: ${d.previous} → ${d.current}`)} />
      <DeltaGroup
        title="Staging"
        items={report.staging.map((d) => (
          `${d.objectName}: pos Δ${formatVec(d.positionDeltaMeters)}m`
          + (d.visibilityChanged ? ` (vis ${d.previousVisible ? 'on' : 'off'}→${d.currentVisible ? 'on' : 'off'})` : '')
        ))}
      />
      <DeltaGroup
        title="Visibility"
        items={report.visibility.map((d) => `${d.label}: ${String(d.previous)} → ${String(d.current)}`)}
      />
    </div>
  );
}

function DeltaGroup({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return (
      <div className="text-xs text-[var(--muted)]">
        <span className="font-medium text-[var(--fg)]">{title}:</span> no changes
      </div>
    );
  }
  return (
    <div className="text-xs">
      <div className="mb-1 font-medium">{title}</div>
      <ul className="list-disc space-y-0.5 pl-4 text-[var(--muted)]">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function formatDelta(d: { delta?: number; unit?: string; current: number | string | boolean }): string {
  if (d.delta === undefined) return String(d.current);
  const unit = d.unit ? ` ${d.unit}` : '';
  return `${d.delta >= 0 ? '+' : ''}${typeof d.delta === 'number' ? d.delta.toFixed(3) : d.delta}${unit}`;
}

function formatVec(v: [number, number, number]): string {
  return `[${v.map((n) => n.toFixed(2)).join(', ')}]`;
}
