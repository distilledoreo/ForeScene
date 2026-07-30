/**
 * In-memory agent plan history for undoLastPlan().
 * Not the Build undo stack — mixed-domain plans need their own rollback.
 */

import type { LocationProject } from '../../domain/types';
import type { AgentSelectionState } from './planDiff';

export interface AgentHistoryEntry {
  planId: string;
  description?: string;
  projectBefore: LocationProject;
  projectAfterFingerprint: string;
  selectionBefore: AgentSelectionState;
  activePanoIdBefore?: string;
}

const MAX_HISTORY = 20;
const history: AgentHistoryEntry[] = [];

export function pushAgentHistory(entry: AgentHistoryEntry): void {
  history.push({
    ...entry,
    projectBefore: structuredClone(entry.projectBefore),
    selectionBefore: {
      selectedObjectIds: [...entry.selectionBefore.selectedObjectIds],
      selectedShotId: entry.selectionBefore.selectedShotId,
      workspace: entry.selectionBefore.workspace,
    },
  });
  while (history.length > MAX_HISTORY) {
    history.shift();
  }
}

export function peekAgentHistory(): AgentHistoryEntry | undefined {
  return history.length > 0 ? history[history.length - 1] : undefined;
}

export function popAgentHistory(): AgentHistoryEntry | undefined {
  return history.pop();
}

/** Test helper. */
export function clearAgentHistory(): void {
  history.length = 0;
}

export function agentHistorySize(): number {
  return history.length;
}
