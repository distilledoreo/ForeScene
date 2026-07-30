/**
 * Session-only Agent control mode.
 *
 * Default: read-only (accidental-write guard, not a security boundary against
 * hostile page scripts — those already own the origin).
 *
 * Escalation to read-write is UI-only or deliberate CLI bootstrap:
 * - Project menu / Agent Console (Zustand store)
 * - CLI `--write` → sessionStorage seed (this tab only)
 * - CLI `--persist-write` → localStorage seed (trusted profile)
 *
 * Demotion (Stop / disableWrites) clears both seeds.
 */

import { create } from 'zustand';
import type { AgentControlMode } from '../engine/agent/protocol';

export const AGENT_CONTROL_PREF_KEY = 'forescene-agent-control';
export const AGENT_CONTROL_SESSION_KEY = 'forescene-agent-control-session';

function readStorageMode(storage: Storage | undefined, key: string): AgentControlMode | undefined {
  if (!storage) return undefined;
  try {
    const value = storage.getItem(key);
    if (value === 'read-write' || value === 'read-only' || value === 'off') {
      return value;
    }
  } catch {
    // ignore storage failures
  }
  return undefined;
}

function readInitialControlMode(): AgentControlMode {
  if (typeof window === 'undefined') return 'read-only';
  return (
    readStorageMode(window.sessionStorage, AGENT_CONTROL_SESSION_KEY)
    ?? readStorageMode(window.localStorage, AGENT_CONTROL_PREF_KEY)
    ?? 'read-only'
  );
}

function clearWritePreference(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(AGENT_CONTROL_SESSION_KEY);
  } catch {
    // ignore
  }
  try {
    window.localStorage.removeItem(AGENT_CONTROL_PREF_KEY);
  } catch {
    // ignore
  }
}

interface AgentControlStore {
  controlMode: AgentControlMode;
  /** UI / CLI bootstrap may escalate; public Agent API may only demote. */
  setControlMode: (mode: AgentControlMode) => void;
}

export const useAgentControlStore = create<AgentControlStore>((set) => ({
  controlMode: readInitialControlMode(),
  setControlMode: (mode) => {
    if (mode !== 'read-write') {
      clearWritePreference();
    }
    set({ controlMode: mode });
  },
}));
