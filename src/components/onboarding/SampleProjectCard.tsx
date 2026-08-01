import React from 'react';
import { RotateCcw, Sparkles } from 'lucide-react';
import type { SampleProjectDefinition } from '../../engine/sampleProjects';

export interface SampleProjectCardProps {
  sample: SampleProjectDefinition;
  onOpen: () => void;
  /** When the sample is already loaded, offer reset. */
  onReset?: () => void;
  isActiveSample?: boolean;
  /** Disable open/reset while project lifecycle is still preparing. */
  disabled?: boolean;
}

/**
 * Highlight card for the bundled sample production.
 */
export function SampleProjectCard({
  sample,
  onOpen,
  onReset,
  isActiveSample = false,
  disabled = false,
}: SampleProjectCardProps) {
  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-dashed border-[var(--accent)]/50 bg-accent-soft/20 p-4 sm:flex-row sm:items-center sm:justify-between"
      data-sample-project-card
      data-sample-id={sample.id}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-primary">{sample.title}</h2>
            <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary">
              Sample
            </span>
          </div>
          <p className="text-xs leading-snug text-secondary">{sample.outcome}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {isActiveSample && onReset ? (
          <button
            type="button"
            onClick={onReset}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-xl border border-subtle bg-surface-raised px-3 py-2 text-xs font-semibold text-primary transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            data-sample-reset
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset sample
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            data-sample-open
          >
            <Sparkles className="h-3.5 w-3.5" />
            Open sample
          </button>
        )}
      </div>
    </div>
  );
}
