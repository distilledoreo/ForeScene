/**
 * Shared busy-wait for agent write operations.
 * Polls the same signals as getStatus().busy so apply/undo/package
 * do not race the initial autosave / criticalWrite window.
 */

import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { isAgentShotVideoRenderActive } from './videoRenderState';
import { isCharacterImportActive } from './characterImport';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  type AgentDiagnostic,
} from './diagnostics';

export function collectAgentBusyDiagnostics(): AgentDiagnostic[] {
  const safety = useProjectSafetyStore.getState();
  const projectState = useProjectStore.getState();
  if (safety.criticalWrite) {
    return [
      agentError(
        AGENT_DIAGNOSTIC_CODES.busy,
        'A critical project write is already in progress.',
      ),
    ];
  }
  if (projectState.isRenderingGraybox) {
    return [
      agentError(
        AGENT_DIAGNOSTIC_CODES.busy,
        'Graybox rendering is in progress.',
      ),
    ];
  }
  if (projectState.isExportingPackage) {
    return [
      agentError(
        AGENT_DIAGNOSTIC_CODES.busy,
        'Package export is in progress.',
      ),
    ];
  }
  if (isAgentShotVideoRenderActive()) {
    return [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Shot video rendering is in progress.')];
  }
  if (isCharacterImportActive()) {
    return [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Character import is in progress.')];
  }
  return [];
}

/** Wait until agent write ops are unblocked, or return the last busy diagnostics. */
export async function awaitAgentNotBusy(
  timeoutMs = 60_000,
): Promise<AgentDiagnostic[] | null> {
  const started = Date.now();
  let lastBusy = collectAgentBusyDiagnostics();
  while (lastBusy.length > 0) {
    if (Date.now() - started >= timeoutMs) return lastBusy;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });
    lastBusy = collectAgentBusyDiagnostics();
  }
  return null;
}
