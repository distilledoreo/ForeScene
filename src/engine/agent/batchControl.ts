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

export async function renderAgentShotBatch(
  jobs: AgentRenderShotFrameInput[],
  concurrency = 1,
  signal?: AbortSignal,
): Promise<AgentRenderShotFrameResult[]> {
  const render = getAgentRenderShotFrameImpl();
  return runWithConcurrency(jobs, concurrency, (job) => render(job), signal);
}

export async function frameAgentSubjectsBatch(
  shots: AgentFrameSubjectsInput[],
  concurrency = 1,
): Promise<AgentFrameSubjectsResult[]> {
  return runWithConcurrency(shots, concurrency, (shotInput) => frameAgentSubjects(shotInput));
}
