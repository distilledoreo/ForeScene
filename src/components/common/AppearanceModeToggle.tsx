import React from 'react';
import type { ViewportAppearanceMode } from '../../engine/projectedStyle';

export function AppearanceModeToggle({
  value,
  projectedAvailable,
  onChange,
  className = '',
  compact = false,
}: {
  value: ViewportAppearanceMode;
  projectedAvailable: boolean;
  onChange: (mode: ViewportAppearanceMode) => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`inline-flex items-center gap-1 rounded-full border border-subtle bg-surface-overlay/90 p-1 shadow-soft backdrop-blur-sm ${className}`}
      data-appearance-mode-toggle
      role="group"
      aria-label="Viewport appearance"
    >
      {!compact && (
        <span className="px-2 text-[10px] font-semibold uppercase tracking-wide text-secondary">
          Appearance
        </span>
      )}
      <ModeButton
        label="Clay"
        active={value === 'clay'}
        onClick={() => onChange('clay')}
      />
      <ModeButton
        label="Projected"
        active={value === 'projected'}
        disabled={!projectedAvailable}
        title={projectedAvailable
          ? 'Project the styled panorama onto scene geometry'
          : 'Import and align a styled panorama first.'}
        onClick={() => {
          if (projectedAvailable) onChange('projected');
        }}
      />
      <ModeButton
        label="Depth"
        active={value === 'depth'}
        title="Linear camera-space depth reference (white = near)"
        onClick={() => onChange('depth')}
      />
    </div>
  );
}

function ModeButton({
  label,
  active,
  disabled,
  title,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`min-h-9 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide transition ${
        active
          ? 'bg-accent text-white shadow-sm'
          : disabled
            ? 'cursor-not-allowed text-muted opacity-55'
            : 'text-secondary hover:bg-surface-raised hover:text-primary'
      }`}
    >
      {label}
    </button>
  );
}
