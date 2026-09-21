import { useEffect } from 'react';
import { useAgentControlStore } from '../state/useAgentControlStore';
import {
  useRemoteAgentStore,
  type RemoteAgentConnection,
} from '../state/useRemoteAgentStore';

interface RemoteCommand {
  jobId: string;
  tool: string;
  arguments: unknown;
}

function authHeaders(token: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('authorization', `Bearer ${token}`);
  return headers;
}

async function executeRemoteCommand(
  command: RemoteCommand,
  connection: RemoteAgentConnection,
): Promise<unknown> {
  const api = window.foreScene;
  if (!api) throw new Error('ForeScene Agent API is not ready.');

  const args = command.arguments && typeof command.arguments === 'object'
    ? command.arguments as Record<string, unknown>
    : {};

  switch (command.tool) {
    case 'project.inspect':
      return api.inspectProject();

    case 'project.document':
      return api.getProjectDocument();

    case 'scene.query':
      return api.listObjects(
        args.query && typeof args.query === 'object'
          ? args.query as Parameters<typeof api.listObjects>[0]
          : undefined,
      );

    case 'project.preview_plan':
      return api.previewPlan(args.plan);

    case 'project.apply_plan': {
      if (connection.accessMode !== 'read-write') {
        throw new Error('Remote Agent Connection is read-only.');
      }
      if (api.getStatus().controlMode !== 'read-write') {
        throw new Error('ForeScene Agent writes are disabled in this browser tab.');
      }
      return api.applyPlan(
        args.plan,
        typeof args.expectedRevisionId === 'string'
          ? { expectedRevisionId: args.expectedRevisionId }
          : undefined,
      );
    }

    case 'shot.render': {
      const result = await api.renderShotFrame(args as Parameters<typeof api.renderShotFrame>[0]);
      const { pngDataUrl: _pngDataUrl, artifact, ...rest } = result;
      const safeArtifact = artifact
        ? Object.fromEntries(
            Object.entries(artifact).filter(([key]) => !['dataUrl', 'base64', 'data'].includes(key)),
          )
        : undefined;
      return {
        ...rest,
        ...(safeArtifact ? { artifact: safeArtifact } : {}),
        inlineImageOmitted: Boolean(result.pngDataUrl),
      };
    }

    case 'project.verify': {
      const shotIds = Array.isArray(args.shotIds)
        ? args.shotIds.filter((value): value is string => typeof value === 'string')
        : undefined;
      const [projectHealth, visualPreflight] = await Promise.all([
        api.inspectProjectHealth(),
        Promise.resolve(api.collectVisualPreflightValidation(shotIds ? { shotIds } : {})),
      ]);
      return {
        ok: projectHealth.ok && visualPreflight.ok,
        projectHealth,
        visualPreflight,
      };
    }

    default:
      throw new Error(`Unsupported remote browser command "${command.tool}".`);
  }
}

async function postResult(
  connection: RemoteAgentConnection,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch('/api/agent/result', {
    method: 'POST',
    headers: authHeaders(connection.token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Failed to return remote agent result (HTTP ${response.status}).`);
  }
}

export async function connectRemoteAgent(
  accessMode: 'read-only' | 'read-write',
): Promise<RemoteAgentConnection> {
  const store = useRemoteAgentStore.getState();
  store.setStatus('connecting');
  store.setError(undefined);

  const status = window.foreScene?.getStatus();
  const response = await fetch('/api/agent/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accessMode,
      ...(status?.projectId ? { projectId: status.projectId } : {}),
      ...(status?.projectName ? { projectName: status.projectName } : {}),
    }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text();
    const message = text || `Could not create remote agent session (HTTP ${response.status}).`;
    store.setError(message);
    throw new Error(message);
  }
  const result = await response.json() as {
    token: string;
    sessionId: string;
    mcpUrl: string;
    accessMode: 'read-only' | 'read-write';
    expiresAt: string;
  };
  const connection: RemoteAgentConnection = {
    token: result.token,
    sessionId: result.sessionId,
    mcpUrl: result.mcpUrl,
    accessMode: result.accessMode,
    expiresAt: result.expiresAt,
  };
  store.setConnection(connection);

  // Escalation remains a deliberate UI action: choosing "Allow editing" and
  // pressing Connect is equivalent to the existing Agent Console write toggle.
  useAgentControlStore.getState().setControlMode(
    connection.accessMode === 'read-write' ? 'read-write' : 'read-only',
  );
  return connection;
}

export async function disconnectRemoteAgent(): Promise<void> {
  const store = useRemoteAgentStore.getState();
  const connection = store.connection;
  store.clearConnection();
  useAgentControlStore.getState().setControlMode('read-only');
  if (!connection) return;
  await fetch('/api/agent/session', {
    method: 'DELETE',
    headers: authHeaders(connection.token),
    cache: 'no-store',
  }).catch(() => undefined);
}

export function useRemoteAgentBridge(): void {
  const connection = useRemoteAgentStore((state) => state.connection);

  useEffect(() => {
    if (!connection) return;
    let disposed = false;
    let running = false;
    let timer: number | undefined;

    const schedule = (delay = 750) => {
      if (disposed) return;
      timer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (disposed || running) return;
      running = true;
      const store = useRemoteAgentStore.getState();
      try {
        if (Date.parse(connection.expiresAt) <= Date.now()) {
          store.setError('Remote Agent Connection expired. Reconnect to continue.');
          store.clearConnection();
          useAgentControlStore.getState().setControlMode('read-only');
          return;
        }

        const response = await fetch('/api/agent/poll', {
          method: 'GET',
          headers: authHeaders(connection.token),
          cache: 'no-store',
        });
        if (response.status === 401) {
          store.clearConnection();
          useAgentControlStore.getState().setControlMode('read-only');
          return;
        }
        if (!response.ok) throw new Error(`Agent poll failed (HTTP ${response.status}).`);

        const payload = await response.json() as { command?: RemoteCommand | null };
        const command = payload.command;
        if (!command) {
          if (store.status !== 'connected') store.setStatus('connected');
          schedule();
          return;
        }

        store.setStatus('working');
        store.setLastOperation(command.tool);
        try {
          const result = await executeRemoteCommand(command, connection);
          await postResult(connection, { jobId: command.jobId, ok: true, result });
        } catch (error) {
          await postResult(connection, {
            jobId: command.jobId,
            ok: false,
            error: {
              code: 'browser_command_failed',
              message: error instanceof Error ? error.message : 'ForeScene browser command failed.',
            },
          });
        }
        store.setStatus('connected');
        schedule(100);
      } catch (error) {
        store.setError(error instanceof Error ? error.message : 'Remote Agent Connection failed.');
        schedule(2_000);
      } finally {
        running = false;
      }
    };

    schedule(100);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connection]);
}
