/**
 * Revision synchronization helpers for the Agent API.
 * Makes stale-revision recovery inexpensive for autonomous clients.
 */

import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { projectFingerprint } from './planDiff';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  agentInfo,
  type AgentDiagnostic,
} from './diagnostics';

export function readActiveRevisionId(): string {
  return useProjectSafetyStore.getState().activeRevisionId ?? '';
}

export function readProjectFingerprint(): string {
  return projectFingerprint(useProjectStore.getState().project);
}

/** Flush persistence and return the latest verified revision id. */
export async function refreshAgentRevision(reason = 'Agent revision refresh'): Promise<{
  revisionId?: string;
  fingerprint: string;
  diagnostics: AgentDiagnostic[];
}> {
  const flushProject = useProjectSafetyStore.getState().flushProject;
  if (!flushProject) {
    return {
      fingerprint: readProjectFingerprint(),
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')],
    };
  }
  try {
    const verified = await flushProject(reason);
    return {
      revisionId: verified?.revision.id,
      fingerprint: projectFingerprint(verified?.project ?? useProjectStore.getState().project),
      diagnostics: verified
        ? [agentInfo('revision_refreshed', `Active revision is ${verified.revision.id}.`)]
        : [],
    };
  } catch (error) {
    return {
      fingerprint: readProjectFingerprint(),
      diagnostics: [agentError(
        'revision_refresh_failed',
        error instanceof Error ? error.message : 'Could not refresh project revision.',
      )],
    };
  }
}

export interface RevisionRetryOptions {
  maxAttempts?: number;
  /** Refresh revision before each retry after the first failure. */
  refreshOnStale?: boolean;
  isStale?: (error: unknown) => boolean;
}

const DEFAULT_STALE_CHECK = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  return code === AGENT_DIAGNOSTIC_CODES.staleRevision;
};

/**
 * Retry an operation when it fails with stale_revision.
 * Refreshes the verified revision between attempts by default.
 */
export async function withRevisionRetry<T extends { ok: boolean; diagnostics?: AgentDiagnostic[] }>(
  operation: () => Promise<T>,
  options: RevisionRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const refreshOnStale = options.refreshOnStale !== false;
  const isStale = options.isStale ?? ((result: T) => (
    !result.ok
    && (result.diagnostics ?? []).some((item) => item.code === AGENT_DIAGNOSTIC_CODES.staleRevision)
  ));

  let lastResult: T | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0 && refreshOnStale) {
      await refreshAgentRevision('Agent stale-revision retry');
    }
    lastResult = await operation();
    if (!isStale(lastResult)) {
      return lastResult;
    }
  }
  return lastResult!;
}
