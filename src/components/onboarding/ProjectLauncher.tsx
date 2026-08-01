import React, { useState } from 'react';
import {
  Bot,
  Clapperboard,
  FolderOpen,
  Hammer,
  X,
} from 'lucide-react';
import { BRAND } from '../../config/brand';
import { SAMPLE_PROJECTS } from '../../engine/sampleProjects';
import { ManualProjectOptions } from './ManualProjectOptions';
import { SampleProjectCard } from './SampleProjectCard';

export type ProjectLauncherAction =
  | { type: 'automated-previs' }
  | { type: 'build-blank' }
  | { type: 'build-starter' }
  | { type: 'open-existing' }
  | { type: 'load-sample'; sampleId: string }
  | { type: 'dismiss' };

export interface ProjectLauncherProps {
  onAction: (action: ProjectLauncherAction) => void;
  /** When true, show the manual sub-panel immediately. */
  initialManualOpen?: boolean;
  /**
   * False while local project recovery/persistence is still starting.
   * Project-replacement actions are disabled until ready (underlying lifecycle still awaits).
   */
  projectLifecycleReady?: boolean;
}

/**
 * Production-oriented first-project launcher shown when Studio is active
 * and the live project is effectively blank.
 *
 * Layout: three primary paths + one featured sample (no duplicate sample card).
 */
export function ProjectLauncher({
  onAction,
  initialManualOpen = false,
  projectLifecycleReady = true,
}: ProjectLauncherProps) {
  const [manualOpen, setManualOpen] = useState(initialManualOpen);
  const primarySample = SAMPLE_PROJECTS[0];
  const replacementReady = projectLifecycleReady;

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-surface-base/95 p-4 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-launcher-title"
      data-project-launcher
      data-project-lifecycle-ready={replacementReady ? 'true' : 'false'}
    >
      <div className="relative max-h-[min(92vh,52rem)] w-full max-w-3xl space-y-4 overflow-y-auto rounded-[var(--radius-card)] border border-subtle bg-surface-raised p-5 shadow-soft sm:p-7">
        <button
          type="button"
          onClick={() => onAction({ type: 'dismiss' })}
          className="absolute right-3 top-3 rounded-xl border border-transparent p-2 text-secondary transition hover:border-subtle hover:bg-surface-muted hover:text-primary"
          aria-label="Dismiss launcher and go to Build"
          data-project-launcher-dismiss
        >
          <X className="h-4 w-4" />
        </button>

        <div className="space-y-2 pr-10 text-center sm:text-left">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            {BRAND.name}
          </p>
          <h1 id="project-launcher-title" className="text-2xl font-semibold text-primary">
            How do you want to start?
          </h1>
          <p className="text-sm text-secondary">
            Choose a path into a complete production. Every option states what you will get —
            nothing leaves you in an empty workspace without context.
          </p>
          {!replacementReady && (
            <p
              className="text-xs font-medium text-accent"
              role="status"
              data-project-lifecycle-preparing
            >
              Preparing local recovery…
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <LauncherCard
            icon={<Bot className="h-6 w-6" />}
            title="Automated Previs"
            badge="Advanced"
            outcome="Opens the Agent Console for use with an external coding agent."
            detail="Paste or apply a production plan from Grok Build, Codex, Claude Code, or a generic agent. A guided setup wizard is planned next."
            onClick={() => onAction({ type: 'automated-previs' })}
            dataOption="automated-previs"
          />
          <LauncherCard
            icon={<Hammer className="h-6 w-6" />}
            title="Build Manually"
            outcome="Create a blank set, start from the temple starter, or import a backup."
            detail="Stay in control: pick a blank stage or ready-made starter and build shot by shot."
            onClick={() => setManualOpen((open) => !open)}
            dataOption="build-manually"
            active={manualOpen}
            disabled={!replacementReady}
          />
          <LauncherCard
            icon={<FolderOpen className="h-6 w-6" />}
            title="Open Existing Project"
            outcome="Import a ForeScene backup or open a locally recovered project."
            detail="Load a .fsp / .zip / .json project backup from disk. Local recovery remains available from Project Safety."
            onClick={() => onAction({ type: 'open-existing' })}
            dataOption="open-existing"
            disabled={!replacementReady}
          />
        </div>

        {manualOpen && (
          <ManualProjectOptions
            onBlank={() => onAction({ type: 'build-blank' })}
            onStarter={() => onAction({ type: 'build-starter' })}
            onImport={() => onAction({ type: 'open-existing' })}
            disabled={!replacementReady}
          />
        )}

        {primarySample && (
          <SampleProjectCard
            sample={primarySample}
            onOpen={() => onAction({ type: 'load-sample', sampleId: primarySample.id })}
            disabled={!replacementReady}
          />
        )}

        <div className="flex flex-col items-stretch justify-between gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center">
          <p className="text-xs text-muted">
            Advanced: dismiss this screen and go straight to Build. You can reopen sample and import actions from the project menu.
          </p>
          <button
            type="button"
            onClick={() => onAction({ type: 'dismiss' })}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-subtle bg-surface-muted px-4 py-2 text-sm font-medium text-primary transition hover:border-[var(--accent)] hover:bg-accent-soft/40"
            data-project-launcher-skip
          >
            <Clapperboard className="h-4 w-4 text-accent" />
            Skip to Build
          </button>
        </div>
      </div>
    </div>
  );
}

function LauncherCard({
  icon,
  title,
  badge,
  outcome,
  detail,
  onClick,
  dataOption,
  active,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  outcome: string;
  detail?: string;
  onClick: () => void;
  dataOption: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-launcher-option={dataOption}
      aria-pressed={active}
      className={`flex flex-col items-start gap-3 rounded-2xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'border-[var(--accent)] bg-accent-soft/50 shadow-card'
          : 'border-subtle bg-surface-muted/60 hover:border-[var(--accent)] hover:bg-accent-soft/40 hover:shadow-card'
      }`}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
        {icon}
      </span>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-primary">{title}</span>
          {badge && (
            <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary">
              {badge}
            </span>
          )}
        </div>
        <p className="text-sm font-medium leading-snug text-primary/90">{outcome}</p>
        {detail && <p className="text-xs leading-snug text-secondary">{detail}</p>}
      </div>
    </button>
  );
}
