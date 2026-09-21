import { create } from 'zustand';

export type RemoteAgentConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'working'
  | 'error';

export interface RemoteAgentConnection {
  token: string;
  sessionId: string;
  mcpUrl: string;
  accessMode: 'read-only' | 'read-write';
  expiresAt: string;
}

const STORAGE_KEY = 'forescene-remote-agent-session';

function readStoredConnection(): RemoteAgentConnection | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as RemoteAgentConnection;
    if (
      typeof parsed?.token !== 'string'
      || typeof parsed?.sessionId !== 'string'
      || typeof parsed?.mcpUrl !== 'string'
      || (parsed.accessMode !== 'read-only' && parsed.accessMode !== 'read-write')
      || typeof parsed?.expiresAt !== 'string'
      || Date.parse(parsed.expiresAt) <= Date.now()
    ) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

interface RemoteAgentStore {
  connection?: RemoteAgentConnection;
  status: RemoteAgentConnectionStatus;
  lastOperation?: string;
  error?: string;
  setConnection: (connection: RemoteAgentConnection) => void;
  clearConnection: () => void;
  setStatus: (status: RemoteAgentConnectionStatus) => void;
  setLastOperation: (operation?: string) => void;
  setError: (error?: string) => void;
}

const initialConnection = readStoredConnection();

export const useRemoteAgentStore = create<RemoteAgentStore>((set) => ({
  connection: initialConnection,
  status: initialConnection ? 'connected' : 'disconnected',

  setConnection(connection) {
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
      } catch {
        // A live connection can still work even when sessionStorage is unavailable.
      }
    }
    set({ connection, status: 'connected', error: undefined });
  },

  clearConnection() {
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    set({
      connection: undefined,
      status: 'disconnected',
      lastOperation: undefined,
      error: undefined,
    });
  },

  setStatus(status) {
    set({ status });
  },

  setLastOperation(lastOperation) {
    set({ lastOperation });
  },

  setError(error) {
    set({ error, ...(error ? { status: 'error' as const } : {}) });
  },
}));
