import React from 'react';
import { Box, FolderOpen, LayoutTemplate } from 'lucide-react';

export interface ManualProjectOptionsProps {
  onBlank: () => void;
  onStarter: () => void;
  onImport: () => void;
  disabled?: boolean;
}

/**
 * Sub-options under “Build Manually” on the first-project launcher.
 */
export function ManualProjectOptions({
  onBlank,
  onStarter,
  onImport,
  disabled = false,
}: ManualProjectOptionsProps) {
  return (
    <div
      className="space-y-3 rounded-2xl border border-subtle bg-surface-muted/40 p-4"
      data-manual-project-options
    >
      <div>
        <h2 className="text-sm font-semibold text-primary">Build manually</h2>
        <p className="mt-1 text-xs text-secondary">
          Pick a starting set. You can still import a backup or generate geometry later from Build.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <ManualOption
          icon={<Box className="h-4 w-4" />}
          title="Blank graybox"
          outcome="Empty stage with a ground slab and light — ready for your own set."
          onClick={onBlank}
          dataOption="blank-graybox"
          disabled={disabled}
        />
        <ManualOption
          icon={<LayoutTemplate className="h-4 w-4" />}
          title="Temple starter"
          outcome="A small courtyard set with scale figure so you can frame shots immediately."
          onClick={onStarter}
          dataOption="temple-starter"
          disabled={disabled}
        />
        <ManualOption
          icon={<FolderOpen className="h-4 w-4" />}
          title="Import set / backup"
          outcome="Open an existing ForeScene project backup from disk."
          onClick={onImport}
          dataOption="import-backup"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function ManualOption({
  icon,
  title,
  outcome,
  onClick,
  dataOption,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  outcome: string;
  onClick: () => void;
  dataOption: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-manual-option={dataOption}
      className="flex flex-col items-start gap-2 rounded-xl border border-subtle bg-surface-raised p-3 text-left transition hover:border-[var(--accent)] hover:bg-accent-soft/30 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
        {icon}
      </span>
      <span className="text-sm font-semibold text-primary">{title}</span>
      <span className="text-xs leading-snug text-secondary">{outcome}</span>
    </button>
  );
}
