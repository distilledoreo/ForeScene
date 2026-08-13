/**
 * Concurrency-limited batch helpers for Agent review renders and framing.
 */

import type {
  AgentFrameSubjectsInput,
  AgentFrameSubjectsResult,
  AgentRenderShotFrameInput,
  AgentRenderShotFrameResult,
} from './protocol';
import { frameAgentSubjects } from './spatialPrimitives';
import { getAgentRenderShotFrameImpl } from './renderCallbackRegistry';

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) {
        const error = new Error('Batch render was cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      const index = cursor;
      cursor += 1;
      if (index >= items.length) break;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export const DEFAULT_BATCH_CONCURRENCY = 1;
export const MAX_BATCH_CONCURRENCY = 4;

export function resolveBatchConcurrency(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Math.floor(override)));
  }
  const envValue = typeof process !== 'undefined'
    ? Number(process.env?.FORESCENE_BATCH_CONCURRENCY)
    : Number.NaN;
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Math.floor(envValue)));
  }
  return DEFAULT_BATCH_CONCURRENCY;
}

export async function renderAgentShotBatch(
  jobs: AgentRenderShotFrameInput[],
  concurrency = resolveBatchConcurrency(),
  signal?: AbortSignal,
): Promise<AgentRenderShotFrameResult[]> {
  const render = getAgentRenderShotFrameImpl();
  return runWithConcurrency(jobs, resolveBatchConcurrency(concurrency), (job) => render(job), signal);
}

export async function frameAgentSubjectsBatch(
  shots: AgentFrameSubjectsInput[],
  concurrency = resolveBatchConcurrency(),
): Promise<AgentFrameSubjectsResult[]> {
  return runWithConcurrency(shots, resolveBatchConcurrency(concurrency), (shotInput) => frameAgentSubjects(shotInput));
}
