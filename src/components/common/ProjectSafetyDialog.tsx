import { useEffect, useState } from 'react';
import {
  ArchiveRestore,
  Download,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type { LocationProject } from '../../domain/types';
import {
  cleanupTemporaryProjectStorage,
  repairProjectHealth,
  runProjectHealthCheck,
  type ProjectHealthReport,
} from '../../engine/projectHealth';
import {
  listLocalProjectHistories,
  listProjectRevisionSummaries,
  type LocalProjectHistory,
  type ProjectRevisionSummary,
} from '../../engine/projectSafety';

type RevisionFilter = 'all' | 'milestones' | 'automatic' | 'autosaves';

function revisionFilterLabel(filter: RevisionFilter): string {
  if (filter === 'milestones') return 'Milestones';
  if (filter === 'automatic') return 'Automatic recovery';
  if (filter === 'autosaves') return 'Autosaves';
  return 'All revisions';
}

function revisionMatchesFilter(revision: ProjectRevisionSummary, filter: RevisionFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'autosaves') return revision.kind === 'autosave';
  const automatic = revision.kind !== 'snapshot' || revision.reason.startsWith('Before ');
  return filter === 'automatic' ? automatic && revision.kind !== 'autosave' : !automatic && revision.kind === 'snapshot';
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toneClass(severity: 'info' | 'warning' | 'danger'): string {
  if (severity === 'danger') return 'border-red-300/80 bg-red-50/80 text-red-800 dark:border-red-900/80 dark:bg-red-950/30 dark:text-red-200';
  if (severity === 'warning') return 'border-amber-300/80 bg-amber-50/80 text-amber-800 dark:border-amber-900/80 dark:bg-amber-950/30 dark:text-amber-200';
  return 'border-sky-300/80 bg-sky-50/80 text-sky-800 dark:border-sky-900/80 dark:bg-sky-950/30 dark:text-sky-200';
}

export function ProjectSafetyDialog({
  open,
  project,
  lastSavedAt,
  onClose,
  onCreateSnapshot,
  onRestoreRevision,
  onOpenProjectHistory,
  onRemoveProjectHistory,
  onApplyRepair,
  onExportBackup,
}: {
  open: boolean;
  project: LocationProject;
  lastSavedAt?: string;
  onClose: () => void;
  onCreateSnapshot: (reason: string) => Promise<void>;
  onRestoreRevision: (revisionId: string) => Promise<void>;
  onOpenProjectHistory: (projectId: string, revisionId: string) => Promise<void>;
  onRemoveProjectHistory: (projectId: string) => Promise<void>;
  onApplyRepair: (project: LocationProject) => Promise<void>;
  onExportBackup: () => void;
}) {
  const [report, setReport] = useState<ProjectHealthReport>();
  const [revisions, setRevisions] = useState<ProjectRevisionSummary[]>([]);
  const [histories, setHistories] = useState<LocalProjectHistory[]>([]);
  const [revisionFilter, setRevisionFilter] = useState<RevisionFilter>('all');
  const [snapshotReason, setSnapshotReason] = useState('Manual snapshot');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmRestore, setConfirmRestore] = useState<ProjectRevisionSummary>();
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [confirmRemoveHistory, setConfirmRemoveHistory] = useState<LocalProjectHistory>();

  const refresh = async () => {
    const [nextReport, nextRevisions, nextHistories] = await Promise.all([
      runProjectHealthCheck(project),
      listProjectRevisionSummaries(project.id),
      listLocalProjectHistories(),
    ]);
    setReport(nextReport);
    setRevisions(nextRevisions);
    setHistories(nextHistories);
  };

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    void refresh().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Could not inspect local project safety data.');
    });
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The project safety operation could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const safeRepair = report ? repairProjectHealth(project) : undefined;
  const visibleRevisions = revisions.filter((revision) => revisionMatchesFilter(revision, revisionFilter));
  const temporaryBytes = report?.storage.temporaryLocalBytes ?? 0;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-safety-title"
        className="flex max-h-[min(48rem,calc(100vh-2rem))] w-full max-w-4xl flex-col overflow-hidden rounded-[var(--radius-card)] border border-subtle bg-surface-overlay shadow-soft"
        data-project-safety-dialog
      >
        <header className="flex items-start justify-between gap-4 border-b border-subtle px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-accent">
              <ShieldCheck className="h-5 w-5" />
              <h2 id="project-safety-title" className="text-base font-semibold text-primary">Project Safety & Recovery</h2>
            </div>
            <p className="mt-1 text-sm text-secondary">Inspect local storage, create recovery points, and restore a verified version without discarding the current one.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close Project Safety"
            className="rounded-lg p-2 text-secondary transition hover:bg-surface-muted hover:text-primary disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 rounded-lg border border-red-300/80 bg-red-50/80 px-3 py-2 text-sm text-red-800 dark:border-red-900/80 dark:bg-red-950/30 dark:text-red-200" role="alert">
              {error}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-subtle bg-surface-raised p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-primary">Recovery points</h3>
                  <p className="mt-1 text-xs text-secondary">The current version and the previous known-good revision are retained during every verified save.</p>
                </div>
                <ArchiveRestore className="h-5 w-5 shrink-0 text-accent" />
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  value={snapshotReason}
                  onChange={(event) => setSnapshotReason(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-subtle bg-surface-overlay px-2.5 py-2 text-sm text-primary outline-none focus:border-[var(--accent)]"
                  aria-label="Snapshot reason"
                  placeholder="Snapshot reason"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => onCreateSnapshot(snapshotReason.trim() || 'Manual snapshot'))}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:brightness-105 disabled:opacity-50"
                >
                  <ArchiveRestore className="h-4 w-4" />
                  Snapshot
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Recovery point filters">
                {(['all', 'milestones', 'automatic', 'autosaves'] as RevisionFilter[]).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setRevisionFilter(filter)}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                      revisionFilter === filter ? 'bg-accent-soft text-accent' : 'text-secondary hover:bg-surface-muted hover:text-primary'
                    }`}
                  >
                    {revisionFilterLabel(filter)}
                  </button>
                ))}
              </div>
              <div className="mt-2 max-h-56 space-y-2 overflow-y-auto" data-revision-timeline>
                {visibleRevisions.length === 0 ? (
                  <p className="text-sm text-secondary">No {revisionFilterLabel(revisionFilter).toLowerCase()} yet.</p>
                ) : visibleRevisions.map((revision) => (
                  <div key={revision.id} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${revision.isActive ? 'border-accent/60 bg-accent-soft/40' : 'border-subtle'}`}>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-primary">{revision.reason}</div>
                      <div className="text-xs text-secondary">
                        {formatDate(revision.createdAt)}
                        {revision.isActive ? ' · Current verified revision' : ''}
                        {revision.isPreviousKnownGood ? ' · Previous known-good' : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy || revision.isActive}
                      onClick={() => setConfirmRestore(revision)}
                      className="shrink-0 rounded-md border border-subtle px-2 py-1 text-xs font-medium text-secondary transition hover:bg-surface-muted hover:text-primary disabled:opacity-40"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-subtle bg-surface-raised p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-primary">Storage</h3>
                  <p className="mt-1 text-xs text-secondary">Local project media stays in this browser until you export a portable backup.</p>
                </div>
                <HardDrive className="h-5 w-5 shrink-0 text-accent" />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <StorageRow label="Project" value={formatBytes(report?.storage.logicalProjectBytes)} />
                <StorageRow label="Essential local" value={formatBytes(report?.storage.essentialLocalBytes)} />
                <StorageRow label="Temporary local" value={formatBytes(temporaryBytes)} />
                <StorageRow label="Browser used" value={formatBytes(report?.storage.browserUsageBytes)} />
                <StorageRow label="Browser remaining" value={formatBytes(report?.storage.browserAvailableBytes)} />
                <StorageRow label="Revisions" value={String(report?.storage.revisionCount ?? 0)} />
                <StorageRow label="Snapshots" value={String(report?.storage.snapshotCount ?? 0)} />
                <StorageRow label="Last verified save" value={lastSavedAt ? formatDate(lastSavedAt) : 'Not yet saved'} />
                <StorageRow
                  label="Persistent storage"
                  value={report?.storage.persistentStorageSupported
                    ? report.storage.persistentStorageGranted ? 'Granted' : 'Not granted'
                    : 'Unavailable'}
                />
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onExportBackup}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-subtle px-3 py-2 text-sm font-medium text-secondary transition hover:bg-surface-muted hover:text-primary disabled:opacity-50"
                >
                  <Download className="h-4 w-4" />
                  Export backup
                </button>
                <button
                  type="button"
                  disabled={busy || temporaryBytes === 0}
                  onClick={() => setConfirmCleanup(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-subtle px-3 py-2 text-sm font-medium text-secondary transition hover:bg-surface-muted hover:text-primary disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Free temporary data
                </button>
              </div>
              {report?.storage.largestAssets.length ? (
                <div className="mt-3 border-t border-subtle pt-3">
                  <div className="mb-1 text-xs font-medium text-secondary">Largest assets</div>
                  <div className="space-y-1.5">
                    {report.storage.largestAssets.slice(0, 4).map((asset) => (
                      <div key={asset.id} className="flex justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate text-primary">{asset.name}</span>
                        <span className="shrink-0 text-secondary">{formatBytes(asset.bytes)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          </div>

          <section className="mt-4 rounded-xl border border-subtle bg-surface-raised p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-primary">Local project histories</h3>
                <p className="mt-1 text-xs text-secondary">Open an older local project deliberately, or remove a history you no longer need to keep its retained media from using browser storage.</p>
              </div>
              <HardDrive className="h-5 w-5 shrink-0 text-accent" />
            </div>
            <div className="mt-3 max-h-44 space-y-2 overflow-y-auto" data-local-project-histories>
              {histories.length === 0 ? (
                <p className="text-sm text-secondary">No local project histories are available yet.</p>
              ) : histories.map((history) => {
                const isCurrentProject = history.projectId === project.id;
                return (
                  <div key={history.projectId} className="flex items-center justify-between gap-3 rounded-lg border border-subtle px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-primary">{history.name}{isCurrentProject ? ' · Open now' : ''}</div>
                      <div className="text-xs text-secondary">{history.revisionCount} revision{history.revisionCount === 1 ? '' : 's'} · {formatDate(history.updatedAt)}</div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        disabled={busy || isCurrentProject}
                        onClick={() => void run(() => onOpenProjectHistory(history.projectId, history.activeRevisionId))}
                        className="rounded-md border border-subtle px-2 py-1 text-xs font-medium text-secondary transition hover:bg-surface-muted hover:text-primary disabled:opacity-40"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        disabled={busy || isCurrentProject}
                        onClick={() => setConfirmRemoveHistory(history)}
                        className="rounded-md border border-red-300/70 px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-40 dark:border-red-900/70 dark:hover:bg-red-950/30"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-subtle bg-surface-raised p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-primary">Project Health</h3>
                <p className="mt-1 text-xs text-secondary">Checks references, local media, IDs, camera values, legacy data, and storage pressure.</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(async () => undefined)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-subtle px-3 py-2 text-sm font-medium text-secondary transition hover:bg-surface-muted hover:text-primary disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                  Scan again
                </button>
                <button
                  type="button"
                  disabled={busy || !safeRepair?.repairedIssueCodes.length}
                  onClick={() => void run(() => onApplyRepair(safeRepair!.project))}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:brightness-105 disabled:opacity-50"
                >
                  <Wrench className="h-4 w-4" />
                  Repair safe issues
                </button>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {!report ? (
                <p className="text-sm text-secondary">Scanning local project data…</p>
              ) : report.issues.length === 0 ? (
                <p className="rounded-lg border border-emerald-300/70 bg-emerald-50/70 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/80 dark:bg-emerald-950/30 dark:text-emerald-200">No integrity problems found.</p>
              ) : report.issues.map((entry) => (
                <div key={entry.id} className={`rounded-lg border px-3 py-2 text-sm ${toneClass(entry.severity)}`}>
                  <div className="flex items-start justify-between gap-3">
                    <span>{entry.message}</span>
                    {entry.repairable && <span className="shrink-0 text-xs font-medium">Safe repair available</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {confirmRestore && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle bg-surface-raised px-5 py-3">
            <p className="text-sm text-secondary">Restore “{confirmRestore.reason}”? The current revision will remain available for rollback.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmRestore(undefined)} disabled={busy} className="rounded-lg border border-subtle px-3 py-2 text-sm text-secondary">Cancel</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const revision = confirmRestore;
                  setConfirmRestore(undefined);
                  void run(() => onRestoreRevision(revision.id));
                }}
                className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Restore revision
              </button>
            </div>
          </footer>
        )}

        {confirmRemoveHistory && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle bg-surface-raised px-5 py-3">
            <p className="text-sm text-secondary">Remove the local history for “{confirmRemoveHistory.name}” and reclaim recovery media that no other project references?</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmRemoveHistory(undefined)} disabled={busy} className="rounded-lg border border-subtle px-3 py-2 text-sm text-secondary">Cancel</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const history = confirmRemoveHistory;
                  setConfirmRemoveHistory(undefined);
                  void run(() => onRemoveProjectHistory(history.projectId));
                }}
                className="rounded-lg border border-red-500/70 bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Remove local history
              </button>
            </div>
          </footer>
        )}

        {confirmCleanup && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle bg-surface-raised px-5 py-3">
            <p className="text-sm text-secondary">Free {formatBytes(temporaryBytes)} of local data that no retained revision references?</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmCleanup(false)} disabled={busy} className="rounded-lg border border-subtle px-3 py-2 text-sm text-secondary">Cancel</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmCleanup(false);
                  void run(async () => {
                    await onCreateSnapshot('Before freeing temporary local data');
                    await cleanupTemporaryProjectStorage(project);
                  });
                }}
                className="rounded-lg border border-red-500/70 bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Free temporary data
              </button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}

function StorageRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-secondary">{label}</dt>
      <dd className="mt-0.5 font-medium text-primary">{value}</dd>
    </div>
  );
}
