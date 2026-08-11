/**
 * In-process prepared-media counters (no external analytics).
 */

import type { StillArtifactKind } from '../domain/types';

export type StillRenderTimingByKind = Record<StillArtifactKind, number>;

export interface PreparedMediaMetrics {
  captureStillRequests: number;
  captureStillRenders: number;
  /** Number and wall time of canonical still renders, including encoding. */
  stillRenderCount: number;
  stillRenderMs: number;
  stillRenderMsByKind: StillRenderTimingByKind;
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

type NumericPreparedMediaMetric = Exclude<keyof PreparedMediaMetrics, 'stillRenderMsByKind'>;

function emptyMetrics(): PreparedMediaMetrics {
  return {
    captureStillRequests: 0,
    captureStillRenders: 0,
    stillRenderCount: 0,
    stillRenderMs: 0,
    stillRenderMsByKind: {
      'clay-viewport': 0,
      'projected-viewport': 0,
      'depth-viewport': 0,
      'character-still': 0,
      'clay-reference-frame': 0,
      'projected-reference-frame': 0,
      'depth-reference-frame': 0,
    },
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
  key: NumericPreparedMediaMetric,
  delta = 1,
): void {
  metrics[key] += delta;
}

export function recordStillRenderTiming(kind: StillArtifactKind, elapsedMs: number): void {
  metrics.stillRenderMsByKind[kind] += Math.max(0, elapsedMs);
}
