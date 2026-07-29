import React from 'react';
import type { AutorigBodyRegionId } from '../../engine/autorig/regions';
import { AutorigRegionToolbar } from './AutorigRegionToolbar';

export type AutorigFixTool = 'brush' | 'lasso';

/** Fix-mode chrome: tool selector, region buttons, brush size, and toggles. */
export function AutorigFixToolbar({
  tool,
  onToolChange,
  selectedRegion,
  onSelectRegion,
  restoreAutomatic,
  onRestoreAutomaticChange,
  brushRadius,
  onBrushRadiusChange,
  showAssignments,
  onShowAssignmentsChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  tool: AutorigFixTool;
  onToolChange: (tool: AutorigFixTool) => void;
  selectedRegion: AutorigBodyRegionId;
  onSelectRegion: (region: AutorigBodyRegionId) => void;
  restoreAutomatic: boolean;
  onRestoreAutomaticChange: (value: boolean) => void;
  brushRadius: number;
  onBrushRadiusChange: (radius: number) => void;
  showAssignments: boolean;
  onShowAssignmentsChange: (value: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="space-y-3" data-autorig-fix-toolbar>
      <div className="flex flex-wrap gap-1.5" data-autorig-fix-tools>
        {([
          ['brush', 'Brush'],
          ['lasso', 'Select area'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
              tool === id ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'
            }`}
            data-autorig-fix-tool={id}
            data-active={tool === id ? 'true' : 'false'}
            onClick={() => onToolChange(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <AutorigRegionToolbar selected={selectedRegion} onSelect={(region) => {
        onRestoreAutomaticChange(false);
        onSelectRegion(region);
      }} />

      <button
        type="button"
        className={`w-full rounded-lg px-2 py-1.5 text-left text-xs font-semibold ${
          restoreAutomatic ? 'bg-accent text-white' : 'bg-surface-muted text-secondary'
        }`}
        data-autorig-restore-automatic
        data-active={restoreAutomatic ? 'true' : 'false'}
        onClick={() => onRestoreAutomaticChange(!restoreAutomatic)}
      >
        Restore automatic
      </button>

      {tool === 'brush' && (
        <label className="block space-y-1" data-autorig-brush-size>
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted">
            <span>Brush size</span>
            <span className="normal-case tracking-normal text-secondary">{Math.round(brushRadius)}px</span>
          </div>
          <input
            type="range"
            min={8}
            max={64}
            step={1}
            value={brushRadius}
            onChange={(event) => onBrushRadiusChange(Number(event.target.value))}
            className="w-full accent-[var(--color-accent,#38bdf8)]"
            data-autorig-brush-radius
          />
        </label>
      )}

      <label className="flex items-center gap-2 text-xs text-secondary" data-autorig-show-assignments>
        <input
          type="checkbox"
          checked={showAssignments}
          onChange={(event) => onShowAssignmentsChange(event.target.checked)}
          data-autorig-show-assignments-toggle
        />
        Show assignments
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50"
          onClick={onUndo}
          disabled={!canUndo}
          data-autorig-region-undo
        >
          Undo
        </button>
        <button
          type="button"
          className="rounded-lg border border-subtle px-2 py-1.5 text-xs font-semibold text-secondary disabled:opacity-50"
          onClick={onRedo}
          disabled={!canRedo}
          data-autorig-region-redo
        >
          Redo
        </button>
      </div>

      <p className="text-[11px] text-muted" data-autorig-fix-hint>
        Paint with left drag · Rotate with right drag
      </p>
    </div>
  );
}
