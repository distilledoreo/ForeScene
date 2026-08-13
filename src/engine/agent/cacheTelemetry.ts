/**
 * Per-operation cache decision log. Distinct from render-cache entry totals.
 *
 * Retry and cancellation counters are scoped to the current provenance
 * session. `resetProvenanceSessionTelemetry` (also called from
 * `beginAgentRunSession`) clears them so a later CLI/API invocation cannot
 * inherit another run's retries or cancel flag.
 */

import type { AgentCacheOperationTelemetry } from './protocol';

const operations: AgentCacheOperationTelemetry[] = [];
const timings: Array<{ name: string; durationMs: number; startedAt?: string }> = [];
let retries = 0;
let cancelled = false;
let sessionId: string | undefined;

export function recordCacheOperation(entry: AgentCacheOperationTelemetry): void {
  operations.push(entry);
}

export function recordOperationTiming(entry: { name: string; durationMs: number; startedAt?: string }): void {
  timings.push(entry);
}

export function recordProvenanceRetry(): void {
  retries += 1;
}

export function recordProvenanceCancellation(): void {
  cancelled = true;
}

export function getCacheOperations(): AgentCacheOperationTelemetry[] {
  return [...operations];
}

export function getOperationTimings(): Array<{ name: string; durationMs: number; startedAt?: string }> {
  return [...timings];
}

export function getProvenanceRetryCount(): number {
  return retries;
}

export function getProvenanceCancelled(): boolean {
  return cancelled;
}

export function getProvenanceSessionId(): string | undefined {
  return sessionId;
}

/**
 * Start or replace the current provenance session.
 * A new `sessionId` always resets retry/cancel so process-wide leftovers
 * cannot leak into an unrelated run.
 */
export function resetProvenanceSessionTelemetry(nextSessionId?: string): void {
  operations.length = 0;
  timings.length = 0;
  retries = 0;
  cancelled = false;
  sessionId = nextSessionId;
}

export function resetCacheTelemetryForTests(): void {
  resetProvenanceSessionTelemetry();
}
