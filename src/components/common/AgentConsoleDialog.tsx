import { useEffect, useState } from 'react';
import { Copy, Play, RotateCcw, Square, Terminal } from 'lucide-react';
import { Modal } from './Modal';
import { Field, TextArea } from './Field';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import type {
  AgentPackageExportProgressSnapshot,
  AgentPlanHistoryEntry,
  ForeSceneAgentStatus,
} from '../../engine/agent/protocol';

const SAMPLE_PLAN = `{
  "version": 1,
  "description": "Console sample",
  "commands": [
    {
      "op": "project.updateInfo",
      "name": "Touched from Agent Console"
    }
  ]
}`;

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function AgentConsoleDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [planText, setPlanText] = useState(SAMPLE_PLAN);
  const [resultText, setResultText] = useState('');
  const [status, setStatus] = useState<ForeSceneAgentStatus | null>(null);
  const [history, setHistory] = useState<AgentPlanHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<AgentPackageExportProgressSnapshot | null>(null);
  const [error, setError] = useState<string | undefined>();

  const refresh = () => {
    const api = window.foreScene;
    if (!api) {
      setError('window.foreScene is not available.');
      return;
    }
    setStatus(api.getStatus());
    setHistory(api.listPlanHistory());
    setExportProgress(api.getPackageExportProgress());
    setError(undefined);
  };

  useEffect(() => {
    if (!open) return;
    refresh();
    const timer = window.setInterval(() => {
      const api = window.foreScene;
      if (!api) return;
      setStatus(api.getStatus());
      setExportProgress(api.getPackageExportProgress());
    }, 400);
    return () => window.clearInterval(timer);
  }, [open]);

  const withApi = async <T,>(
    run: (api: NonNullable<typeof window.foreScene>) => Promise<T> | T,
  ): Promise<T | undefined> => {
    const api = window.foreScene;
    if (!api) {
      setError('window.foreScene is not available.');
      return undefined;
    }
    setBusy(true);
    setError(undefined);
    try {
      const value = await run(api);
      refresh();
      return value;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent Console action failed.');
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const parsePlan = (): unknown | undefined => {
    try {
      return JSON.parse(planText) as unknown;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Plan JSON is invalid.');
      return undefined;
    }
  };

  const handlePreview = async () => {
    const plan = parsePlan();
    if (plan === undefined) return;
    const result = await withApi((api) => api.previewPlan(plan));
    if (result) setResultText(formatJson(result));
  };

  const handleApply = async () => {
    const plan = parsePlan();
    if (plan === undefined) return;
    const result = await withApi((api) => api.applyPlan(plan));
    if (result) setResultText(formatJson(result));
  };

  const handleUndo = async () => {
    const result = await withApi((api) => api.undoLastPlan());
    if (result) setResultText(formatJson(result));
  };

  const handleCopyResult = async () => {
    if (!resultText) return;
    try {
      await navigator.clipboard.writeText(resultText);
    } catch {
      setError('Unable to copy result to clipboard.');
    }
  };

  const handleToggleWrites = async () => {
    const api = window.foreScene;
    if (!api) {
      setError('window.foreScene is not available.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (api.getStatus().controlMode === 'read-write') {
        // Public API may only demote — never escalate.
        api.disableWrites();
      } else {
        // Escalation is UI-only (same path as Project menu Enable Agent Writes).
        useAgentControlStore.getState().setControlMode('read-write');
      }
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to toggle write access.');
    } finally {
      setBusy(false);
    }
  };

  const handleExportPackage = async () => {
    const result = await withApi((api) => api.exportPackage({ download: true }));
    if (result) setResultText(formatJson(result));
  };

  const handleCancelExport = async () => {
    const result = await withApi((api) => api.cancelPackageExport());
    if (result) setResultText(formatJson(result));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Agent Console"
      size="2xl"
      scrollBody
      footer={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            Uses the same <code className="text-secondary">window.foreScene</code> API as the CLI.
          </p>
          <button
            type="button"
            className="rounded-lg border border-subtle px-3 py-1.5 text-sm text-secondary hover:text-accent"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      )}
    >
      <div className="space-y-4 p-5" data-agent-console>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-subtle bg-surface-overlay/60 px-3 py-2">
          <Terminal className="h-4 w-4 text-accent" aria-hidden />
          <span className="text-sm text-secondary">
            Mode: <strong className="text-primary">{status?.controlMode ?? '…'}</strong>
          </span>
          <span className="text-xs text-muted">
            {status?.projectName ? `· ${status.projectName}` : ''}
          </span>
          <button
            type="button"
            data-agent-console-toggle-writes
            disabled={busy}
            onClick={() => void handleToggleWrites()}
            className="ml-auto rounded-lg border border-subtle px-2.5 py-1 text-xs font-medium text-secondary hover:border-[var(--accent)] hover:text-accent disabled:opacity-50"
          >
            {status?.controlMode === 'read-write' ? 'Disable writes' : 'Enable writes'}
          </button>
        </div>

        <Field label="Plan JSON" hint="Paste a versioned ForeScene agent plan.">
          <TextArea
            data-agent-console-plan
            value={planText}
            onChange={(event) => setPlanText(event.target.value)}
            rows={12}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-agent-console-preview
            disabled={busy}
            onClick={() => void handlePreview()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-subtle bg-surface-raised px-3 py-2 text-sm font-medium text-secondary hover:border-[var(--accent)] hover:text-accent disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
            Preview
          </button>
          <button
            type="button"
            data-agent-console-apply
            disabled={busy || status?.controlMode !== 'read-write'}
            onClick={() => void handleApply()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            Apply
          </button>
          <button
            type="button"
            data-agent-console-undo
            disabled={busy || status?.controlMode !== 'read-write' || history.length === 0}
            onClick={() => void handleUndo()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-subtle px-3 py-2 text-sm font-medium text-secondary hover:text-accent disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Undo last plan
          </button>
          <button
            type="button"
            data-agent-console-copy
            disabled={!resultText}
            onClick={() => void handleCopyResult()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-subtle px-3 py-2 text-sm font-medium text-secondary hover:text-accent disabled:opacity-50"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
            Copy result
          </button>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-subtle pt-3">
          <button
            type="button"
            data-agent-console-export
            disabled={busy || status?.controlMode !== 'read-write' || status?.busy.packageExport}
            onClick={() => void handleExportPackage()}
            className="rounded-lg border border-subtle px-3 py-2 text-sm font-medium text-secondary hover:text-accent disabled:opacity-50"
          >
            Export package
          </button>
          <button
            type="button"
            data-agent-console-cancel-export
            disabled={!status?.busy.packageExport}
            onClick={() => void handleCancelExport()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-subtle px-3 py-2 text-sm font-medium text-secondary hover:text-accent disabled:opacity-50"
          >
            <Square className="h-3.5 w-3.5" aria-hidden />
            Cancel export
          </button>
          {exportProgress && (
            <span className="self-center text-xs text-muted" data-agent-console-export-progress>
              {exportProgress.phase}: {exportProgress.message}
              {exportProgress.indeterminate ? '' : ` (${Math.round(exportProgress.progress * 100)}%)`}
            </span>
          )}
        </div>

        {error && (
          <p className="rounded-lg border border-red-300/70 bg-red-50/80 px-3 py-2 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200" role="alert">
            {error}
          </p>
        )}

        <Field label="Result">
          <pre
            data-agent-console-result
            className="max-h-56 overflow-auto rounded-lg border border-subtle bg-surface-overlay/70 p-3 font-mono text-xs text-secondary"
          >
            {resultText || 'Preview or apply a plan to see diagnostics and diffs here.'}
          </pre>
        </Field>

        <Field label="Plan history (in-memory)">
          {history.length === 0 ? (
            <p className="text-sm text-muted">No applied plans in this session.</p>
          ) : (
            <ul className="space-y-1 text-sm text-secondary" data-agent-console-history>
              {[...history].reverse().map((entry) => (
                <li key={entry.planId} className="rounded-md border border-subtle/80 px-2 py-1">
                  <span className="font-mono text-xs text-muted">{entry.planId}</span>
                  {entry.description ? ` — ${entry.description}` : ''}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </div>
    </Modal>
  );
}
