/**
 * Session-only Agent control mode.
 * Defaults to read-only so inspection works without enabling writes.
 * A dedicated CLI browser profile may seed `forescene-agent-control=read-write`
 * before launch; the Stop control clears that preference.
 */

import { create } from 'zustand';
import type { AgentControlMode } from '../engine/agent/protocol';

export const AGENT_CONTROL_PREF_KEY = 'forescene-agent-control';

function readInitialControlMode(): AgentControlMode {
  if (typeof window === 'undefined') return 'read-only';
  try {
    const value = window.localStorage.getItem(AGENT_CONTROL_PREF_KEY);
    if (value === 'read-write' || value === 'read-only' || value === 'off') {
      return value;
    }
  } catch {
    // ignore storage failures
  }
  return 'read-only';
}

function clearWritePreference(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(AGENT_CONTROL_PREF_KEY);
  } catch {
    // ignore storage failures
  }
}

interface AgentControlStore {
  controlMode: AgentControlMode;
  setControlMode: (mode: AgentControlMode) => void;
}

export const useAgentControlStore = create<AgentControlStore>((set) => ({
  controlMode: readInitialControlMode(),
  setControlMode: (mode) => {
    // Write access from the UI is session-only. Only the CLI preference seeds
    // read-write across reloads; Stop / demotion always clears that seed.
    if (mode !== 'read-write') {
      clearWritePreference();
    }
    set({ controlMode: mode });
  },
}));
