import { useMemo, useState } from 'react';
import { CheckCircle2, Copy, Link2, Unplug, Wifi } from 'lucide-react';
import { Modal } from './Modal';
import {
  connectRemoteAgent,
  disconnectRemoteAgent,
} from '../../hooks/useRemoteAgentBridge';
import { useRemoteAgentStore } from '../../state/useRemoteAgentStore';

export function RemoteAgentConnectionDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const connection = useRemoteAgentStore((state) => state.connection);
  const status = useRemoteAgentStore((state) => state.status);
  const lastOperation = useRemoteAgentStore((state) => state.lastOperation);
  const error = useRemoteAgentStore((state) => state.error);
  const [accessMode, setAccessMode] = useState<'read-only' | 'read-write'>(
    connection?.accessMode ?? 'read-only',
  );
  const [copyStatus, setCopyStatus] = useState<string>();

  const setupText = useMemo(() => {
    if (!connection) return '';
    return [
      'ForeScene Remote MCP',
      `URL: ${connection.mcpUrl}`,
      `Authorization: Bearer ${connection.token}`,
    ].join('\n');
  }, [connection]);

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied.`);
    } catch {
      setCopyStatus(`Could not copy ${label.toLowerCase()}.`);
    }
  };

  const handleConnect = async () => {
    setCopyStatus(undefined);
    try {
      await connectRemoteAgent(accessMode);
    } catch {
      // Store already exposes the user-facing error.
    }
  };

  const handleDisconnect = async () => {
    setCopyStatus(undefined);
    await disconnectRemoteAgent();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Remote MCP Connection"
      size="lg"
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs text-muted">
            Projects stay in this browser tab. Netlify only relays temporary commands/results.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-subtle px-3 py-1.5 text-sm text-secondary hover:text-primary"
          >
            Close
          </button>
        </div>
      )}
    >
      <div className="space-y-4 p-5" data-remote-agent-dialog>
        <div className="flex items-center gap-2 rounded-xl border border-subtle bg-surface-overlay/60 px-3 py-2">
          <Wifi className="h-4 w-4 text-accent" aria-hidden />
          <span className="text-sm text-secondary">
            Status: <strong className="text-primary">{status}</strong>
          </span>
          {lastOperation && status === 'working' && (
            <span className="ml-auto text-xs text-muted">{lastOperation}</span>
          )}
        </div>

        {!connection ? (
          <>
            <div>
              <p className="text-sm font-medium text-primary">Access for this connection</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer gap-2 rounded-xl border border-subtle p-3">
                  <input
                    type="radio"
                    name="remote-agent-access"
                    checked={accessMode === 'read-only'}
                    onChange={() => setAccessMode('read-only')}
                  />
                  <span>
                    <span className="block text-sm font-medium text-primary">Read only</span>
                    <span className="block text-xs text-secondary">Inspect, query, preview, render, verify.</span>
                  </span>
                </label>
                <label className="flex cursor-pointer gap-2 rounded-xl border border-subtle p-3">
                  <input
                    type="radio"
                    name="remote-agent-access"
                    checked={accessMode === 'read-write'}
                    onChange={() => setAccessMode('read-write')}
                  />
                  <span>
                    <span className="block text-sm font-medium text-primary">Allow editing</span>
                    <span className="block text-xs text-secondary">Also permits explicit project_apply calls.</span>
                  </span>
                </label>
              </div>
            </div>

            <button
              type="button"
              data-remote-agent-connect
              disabled={status === 'connecting'}
              onClick={() => void handleConnect()}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              <Link2 className="h-4 w-4" aria-hidden />
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-emerald-400/50 bg-emerald-50/70 p-3 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                Agent connection active · {connection.accessMode}
              </div>
              <div className="mt-1 text-xs opacity-80">
                Expires {new Date(connection.expiresAt).toLocaleString()}
              </div>
            </div>

            <ConnectionField
              label="MCP URL"
              value={connection.mcpUrl}
              onCopy={() => void copy(connection.mcpUrl, 'MCP URL')}
            />
            <ConnectionField
              label="Bearer token"
              value={connection.token}
              secret
              onCopy={() => void copy(connection.token, 'Bearer token')}
            />

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copy(setupText, 'Setup')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-subtle px-3 py-2 text-sm text-secondary hover:text-accent"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden />
                Copy setup
              </button>
              <button
                type="button"
                data-remote-agent-disconnect
                onClick={() => void handleDisconnect()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:text-red-300"
              >
                <Unplug className="h-3.5 w-3.5" aria-hidden />
                Disconnect
              </button>
            </div>
          </>
        )}

        {copyStatus && (
          <p className="text-xs text-secondary" role="status">{copyStatus}</p>
        )}
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50/80 px-3 py-2 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ConnectionField({
  label,
  value,
  secret = false,
  onCopy,
}: {
  label: string;
  value: string;
  secret?: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-secondary">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-raised p-2">
        <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-primary">
          {secret ? `${value.slice(0, 12)}••••••••••••${value.slice(-6)}` : value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md border border-subtle p-1.5 text-secondary hover:text-accent"
          aria-label={`Copy ${label}`}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
