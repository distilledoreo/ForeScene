import React from 'react';
import { FlipHorizontal2 } from 'lucide-react';
import type { AutorigBodyRegionId } from '../../engine/autorig/regions';
import { AutorigRegionToolbar } from './AutorigRegionToolbar';

export type AutorigBodyPartsView = 'front' | 'back' | 'side';

/** Body-parts chrome: instructions, view toggles, region toolbar, and actions. */
export function AutorigBodyPartsStep({
  view,
  onViewChange,
  selectedRegion,
  onSelectRegion,
  meshReady,
  labeling,
  uncertainHint,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onMirrorLabels,
}: {
  view: AutorigBodyPartsView;
  onViewChange: (view: AutorigBodyPartsView) => void;
  selectedRegion: AutorigBodyRegionId;
  onSelectRegion: (region: AutorigBodyRegionId) => void;
  meshReady: boolean;
  labeling: boolean;
  uncertainHint?: string | null;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onMirrorLabels: () => void;
}) {
  return (
    <div className="space-y-3" data-autorig-body-parts-step>
      <p className="text-sm text-secondary">
        Check the body-part colors. Loosely circle anything assigned incorrectly.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {([
          ['front', 'Front'],
          ['back', 'Back'],
          ['side', 'Side'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-semibold ${view === id ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'}`}
            onClick={() => onViewChange(id)}
            data-autorig-view={id}
          >
            {label}
          </button>
        ))}
        {labeling && (
          <span className="text-[10px] text-muted" data-autorig-region-status>
            Assigning body parts…
          </span>
        )}
        {!labeling && !meshReady && (
          <span className="text-[10px] text-muted">Loading mesh…</span>
        )}
      </div>

      <AutorigRegionToolbar selected={selectedRegion} onSelect={onSelectRegion} />

      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50" onClick={onUndo} disabled={!canUndo} data-autorig-region-undo>Undo</button>
        <button type="button" className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50" onClick={onRedo} disabled={!canRedo} data-autorig-region-redo>Redo</button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary"
          onClick={onMirrorLabels}
          data-autorig-mirror-labels
        >
          <FlipHorizontal2 className="h-3.5 w-3.5" /> Mirror labels
        </button>
      </div>

      {uncertainHint && (
        <p className="text-[11px] text-muted" data-autorig-uncertain-hint>{uncertainHint}</p>
      )}
    </div>
  );
}
