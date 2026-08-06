/**
 * In-process prepared-media counters (no external analytics).
 */

export interface PreparedMediaMetrics {
  captureStillRequests: number;
  captureStillRenders: number;
  stillReuseCount: number;
  editStillRenders: number;
  staleResultsDiscarded: number;
  materializationFailures: number;
  exportStillAssetHits: number;
  exportStillRecoveryRenders: number;
  videoCacheHits: number;
  videoJobsJoined: number;
  videoBackgroundRenders: number;
  exportVideoWaitMs: number;
  zipAssemblyMs: number;
}

function emptyMetrics(): PreparedMediaMetrics {
  return {
    captureStillRequests: 0,
    captureStillRenders: 0,
    stillReuseCount: 0,
    editStillRenders: 0,
    staleResultsDiscarded: 0,
    materializationFailures: 0,
    exportStillAssetHits: 0,
    exportStillRecoveryRenders: 0,
    videoCacheHits: 0,
    videoJobsJoined: 0,
    videoBackgroundRenders: 0,
    exportVideoWaitMs: 0,
    zipAssemblyMs: 0,
  };
}

let metrics = emptyMetrics();

export function getPreparedMediaMetrics(): Readonly<PreparedMediaMetrics> {
  return { ...metrics };
}

export function resetPreparedMediaMetrics(): void {
  metrics = emptyMetrics();
}

export function recordPreparedMediaMetric(
  key: keyof PreparedMediaMetrics,
  delta = 1,
): void {
  metrics[key] += delta;
}
