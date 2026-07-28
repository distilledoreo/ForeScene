import React from 'react';
import type { ShotDepthSettings } from '../../domain/types';
import {
  formatDepthRangeLegend,
  type DepthRangeMeters,
} from '../../engine/depthRender';
import { Field, Select, TextInput } from './Field';

export function DepthSettingsPanel({
  depth,
  resolvedRange,
  onChange,
  className = '',
  compact = false,
}: {
  depth: ShotDepthSettings;
  resolvedRange: DepthRangeMeters;
  onChange: (next: ShotDepthSettings) => void;
  className?: string;
  compact?: boolean;
}) {
  const nearValue = depth.rangeMode === 'manual' && depth.nearMeters != null
    ? depth.nearMeters
    : resolvedRange.nearMeters;
  const farValue = depth.rangeMode === 'manual' && depth.farMeters != null
    ? depth.farMeters
    : resolvedRange.farMeters;

  return (
    <div
      className={`space-y-2 ${className}`}
      data-depth-settings-panel
    >
      <div className={`flex flex-wrap items-center gap-2 ${compact ? 'text-[11px]' : 'text-xs'}`}>
        <span className="font-semibold uppercase tracking-wide text-secondary">Depth range</span>
        <span
          className="rounded-md bg-surface-muted px-2 py-1 font-medium text-primary"
          data-depth-range-legend
        >
          {formatDepthRangeLegend(resolvedRange)}
        </span>
      </div>

      <div className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}>
        <Field label="Range">
          <Select
            value={depth.rangeMode}
            onChange={(event) => onChange({
              ...depth,
              rangeMode: event.target.value === 'manual' ? 'manual' : 'auto',
            })}
            data-depth-range-mode
          >
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </Select>
        </Field>
        <label className="flex items-end gap-2 rounded-lg border border-subtle px-3 py-2 text-sm text-secondary">
          <input
            type="checkbox"
            checked={depth.invert === true}
            onChange={(event) => onChange({ ...depth, invert: event.target.checked })}
            className="accent-[var(--accent)]"
            data-depth-invert
          />
          Invert (black = near)
        </label>
      </div>

      {depth.rangeMode === 'manual' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Near (m)">
            <TextInput
              type="number"
              min={0.01}
              step={0.1}
              value={nearValue}
              onChange={(event) => onChange({
                ...depth,
                nearMeters: Number(event.target.value),
              })}
              data-depth-near-meters
            />
          </Field>
          <Field label="Far (m)">
            <TextInput
              type="number"
              min={0.02}
              step={0.1}
              value={farValue}
              onChange={(event) => onChange({
                ...depth,
                farMeters: Number(event.target.value),
              })}
              data-depth-far-meters
            />
          </Field>
        </div>
      )}
    </div>
  );
}
