import React, { useState } from 'react';
import {
  Bot,
  Clapperboard,
  FolderOpen,
  Hammer,
  Sparkles,
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
}

/**
 * Production-oriented first-project launcher shown when Studio is active
 * and the live project is effectively blank.
 */
export function ProjectLauncher({
  onAction,
  initialManualOpen = false,
}: ProjectLauncherProps) {
  const [manualOpen, setManualOpen] = useState(initialManualOpen);
  const primarySample = SAMPLE_PROJECTS[0];

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-surface-base/95 p-4 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-launcher-title"
      data-project-launcher
    >
      <div className="relative w-full max-w-3xl space-y-5 rounded-[var(--radius-card)] border border-subtle bg-surface-raised p-5 shadow-soft sm:p-7">
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
            Choose a path into a complete production. Every option below states what you will get —
            nothing leaves you in an empty workspace without context.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <LauncherCard
            icon={<Bot className="h-6 w-6" />}
            title="Automated Previs"
            outcome="Start from a shot list and let a coding agent build the production."
            detail="Opens the agent workflow entry so an external coding agent can assemble sets, characters, and cameras for you."
            onClick={() => onAction({ type: 'automated-previs' })}
            dataOption="automated-previs"
          />
          <LauncherCard
            icon={<Hammer className="h-6 w-6" />}
            title="Build Manually"
            outcome="Create a blank set, generate one from a description, or start from the temple starter geometry."
            detail="Stay in control: pick a blank stage or a ready-made starter set and build shot by shot."
            onClick={() => setManualOpen((open) => !open)}
            dataOption="build-manually"
            active={manualOpen}
          />
          <LauncherCard
            icon={<Sparkles className="h-6 w-6" />}
            title="Explore a Sample"
            outcome={primarySample?.outcome ?? 'Open a complete example production.'}
            detail={primarySample?.summary}
            onClick={() => {
              if (primarySample) onAction({ type: 'load-sample', sampleId: primarySample.id });
            }}
            dataOption="explore-sample"
          />
          <LauncherCard
            icon={<FolderOpen className="h-6 w-6" />}
            title="Open Existing Project"
            outcome="Import a ForeScene backup or open a locally recovered project."
            detail="Load a .fsp / .zip / .json project backup from disk. Local recovery remains available from Project Safety."
            onClick={() => onAction({ type: 'open-existing' })}
            dataOption="open-existing"
          />
        </div>

        {manualOpen && (
          <ManualProjectOptions
            onBlank={() => onAction({ type: 'build-blank' })}
            onStarter={() => onAction({ type: 'build-starter' })}
            onImport={() => onAction({ type: 'open-existing' })}
          />
        )}

        {primarySample && (
          <SampleProjectCard
            sample={primarySample}
            onOpen={() => onAction({ type: 'load-sample', sampleId: primarySample.id })}
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
  outcome,
  detail,
  onClick,
  dataOption,
  active,
}: {
  icon: React.ReactNode;
  title: string;
  outcome: string;
  detail?: string;
  onClick: () => void;
  dataOption: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-launcher-option={dataOption}
      aria-pressed={active}
      className={`flex flex-col items-start gap-3 rounded-2xl border p-4 text-left transition ${
        active
          ? 'border-[var(--accent)] bg-accent-soft/50 shadow-card'
          : 'border-subtle bg-surface-muted/60 hover:border-[var(--accent)] hover:bg-accent-soft/40 hover:shadow-card'
      }`}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
        {icon}
      </span>
      <div className="space-y-1.5">
        <span className="text-base font-semibold text-primary">{title}</span>
        <p className="text-sm font-medium leading-snug text-primary/90">{outcome}</p>
        {detail && <p className="text-xs leading-snug text-secondary">{detail}</p>}
      </div>
    </button>
  );
}
