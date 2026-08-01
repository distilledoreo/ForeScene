import React from 'react';
import { Box, FolderOpen, LayoutTemplate } from 'lucide-react';

export interface ManualProjectOptionsProps {
  onBlank: () => void;
  onStarter: () => void;
  onImport: () => void;
}

/**
 * Sub-options under “Build Manually” on the first-project launcher.
 */
export function ManualProjectOptions({
  onBlank,
  onStarter,
  onImport,
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
        />
        <ManualOption
          icon={<LayoutTemplate className="h-4 w-4" />}
          title="Temple starter"
          outcome="A small courtyard set with scale figure so you can frame shots immediately."
          onClick={onStarter}
          dataOption="temple-starter"
        />
        <ManualOption
          icon={<FolderOpen className="h-4 w-4" />}
          title="Import set / backup"
          outcome="Open an existing ForeScene project backup from disk."
          onClick={onImport}
          dataOption="import-backup"
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
}: {
  icon: React.ReactNode;
  title: string;
  outcome: string;
  onClick: () => void;
  dataOption: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-manual-option={dataOption}
      className="flex flex-col items-start gap-2 rounded-xl border border-subtle bg-surface-raised p-3 text-left transition hover:border-[var(--accent)] hover:bg-accent-soft/30"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
        {icon}
      </span>
      <span className="text-sm font-semibold text-primary">{title}</span>
      <span className="text-xs leading-snug text-secondary">{outcome}</span>
    </button>
  );
}
