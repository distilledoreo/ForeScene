/**
 * Unified asynchronous job queue for Agent API batch operations.
 * Items execute through registered handlers and report progress from settled work.
 */

import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { agentError } from './diagnostics';
import { AGENT_JOB_HANDLERS, expandJobItems } from './jobHandlers';
import type {
  AgentJobProgress,
  AgentJobStatus,
  AgentSubmitJobInput,
  AgentSubmitJobResult,
} from './protocol';

interface StoredJob extends AgentJobProgress {
  createdAt: number;
  finishedAt?: number;
  revisionIdAtStart?: string;
  input: AgentSubmitJobInput;
  listeners: Set<(progress: AgentJobProgress) => void>;
  abortController?: AbortController;
  resumeIndex: number;
  completedIndexes: Set<number>;
  /** Bumps on each runJob invocation so stale catch blocks cannot clobber a newer run. */
  runGeneration: number;
}

const jobs = new Map<string, StoredJob>();
const MAX_RETAINED_JOBS = 100;
const TERMINAL_JOB_TTL_MS = 30 * 60 * 1000;
let jobCounter = 0;

function updateJobCheckpoint(job: StoredJob) {
  job.completedItems = job.completedIndexes.size;
  job.progress = job.totalItems > 0 ? job.completedIndexes.size / job.totalItems : 1;
  let prefix = 0;
  while (job.completedIndexes.has(prefix)) prefix += 1;
  job.resumeIndex = prefix;
}

function markJobItemSettled(job: StoredJob, index: number) {
  job.completedIndexes.add(index);
  updateJobCheckpoint(job);
}

function nextJobId(): string {
  jobCounter += 1;
  return `job_${Date.now().toString(36)}_${jobCounter.toString(36)}`;
}

function snapshot(job: StoredJob): AgentJobProgress {
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    progress: job.progress,
    completedItems: job.completedItems,
    totalItems: job.totalItems,
    currentItem: job.currentItem,
    message: job.message,
    revisionId: job.revisionId,
    errors: job.errors,
    artifactIds: job.artifactIds,
  };
}

function notify(job: StoredJob) {
  const snap = snapshot(job);
  for (const listener of job.listeners) listener(snap);
}

function isTerminalStatus(status: AgentJobStatus): boolean {
  return status === 'completed'
    || status === 'completed_with_warnings'
    || status === 'failed'
    || status === 'cancelled';
}

function pruneRetainedJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!isTerminalStatus(job.status) || job.listeners.size > 0) continue;
    const finishedAt = job.finishedAt ?? job.createdAt;
    if (now - finishedAt >= TERMINAL_JOB_TTL_MS) jobs.delete(id);
  }
  if (jobs.size < MAX_RETAINED_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size < MAX_RETAINED_JOBS) break;
    if (!isTerminalStatus(job.status) || job.listeners.size > 0) continue;
    jobs.delete(id);
  }
}

function isJobWaitComplete(progress: AgentJobProgress): boolean {
  return progress.status !== 'pending' && progress.status !== 'running';
}

async function runHandlerWithoutOrphaning(
  runHandler: () => Promise<void>,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    const error = new Error('Job item cancelled.');
    error.name = 'AbortError';
    throw error;
  }
  if (!timeoutMs) {
    const handlerPromise = runHandler();
    if (!signal) {
      await handlerPromise;
      return;
    }
    let removeAbortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error('Job item cancelled.');
        error.name = 'AbortError';
        reject(error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });
    try {
      await Promise.race([handlerPromise, abortPromise]);
    } catch (error) {
      if (signal.aborted) await handlerPromise.catch(() => undefined);
      throw error;
    } finally {
      removeAbortListener?.();
    }
    return;
  }

  const handlerPromise = runHandler();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let removeAbortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('Job item timed out.'));
    }, timeoutMs);
  });
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error('Job item cancelled.');
        error.name = 'AbortError';
        reject(error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    })
    : undefined;

  try {
    await Promise.race(
      abortPromise ? [handlerPromise, timeoutPromise, abortPromise] : [handlerPromise, timeoutPromise],
    );
  } catch (error) {
    // Legacy handlers do not all accept AbortSignal yet. If timeout wins, wait for
    // the already-started handler to settle before releasing the worker so a
    // second GPU render can never begin concurrently behind an orphaned timeout
    // or cancellation.
    if (timedOut || signal?.aborted) await handlerPromise.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

async function runJob(job: StoredJob): Promise<void> {
  const runGeneration = job.runGeneration + 1;
  job.runGeneration = runGeneration;
  job.status = 'running';
  job.message = 'Job started.';
  notify(job);

  const items = expandJobItems({
    type: job.type,
    jobs: job.input.jobs,
    shotIds: job.input.shotIds,
    passes: job.input.passes,
  });
  job.totalItems = items.length;
  const concurrency = Math.max(1, job.input.concurrency ?? 1);
  const continueOnError = job.input.continueOnError ?? true;
  const handler = AGENT_JOB_HANDLERS[job.type];

  if (!handler) {
    job.status = 'failed';
    job.message = 'No handler registered for job type ' + job.type + '.';
    job.errors = [agentError('job_handler_missing', job.message)];
    notify(job);
    return;
  }

  const artifactIds = [...(job.artifactIds ?? [])];
  const registerArtifact = (artifactId: string) => {
    if (!artifactIds.includes(artifactId)) artifactIds.push(artifactId);
    job.artifactIds = [...artifactIds];
  };

  const runItem = async (index: number, item: unknown) => {
    if (job.abortController?.signal.aborted) return;

    job.currentItem = String(index);
    job.message = 'Processing item ' + String(index + 1) + ' of ' + String(job.totalItems) + '.';
    notify(job);

    const runHandler = () => handler(item, index, {
      jobId: job.jobId,
      revisionIdAtStart: job.revisionIdAtStart,
      signal: job.abortController!.signal,
      registerArtifact,
    });

    try {
      await runHandlerWithoutOrphaning(
        runHandler,
        job.input.timeoutMsPerItem,
        job.abortController?.signal,
      );
    } catch (error) {
      // Cancel/pause owns the final state. A late handler rejection after either
      // must not become an error or mark the item settled.
      if (job.abortController?.signal.aborted) return;

      const diagnostic = agentError(
        'job_item_failed',
        error instanceof Error ? error.message : 'Job item failed.',
      );
      job.errors = [...(job.errors ?? []), diagnostic];
      if (!continueOnError) {
        job.status = 'failed';
        job.message = diagnostic.message;
        notify(job);
        throw error;
      }
      markJobItemSettled(job, index);
      notify(job);
      return;
    }

    if (job.abortController?.signal.aborted) return;
    markJobItemSettled(job, index);
    notify(job);
  };

  try {
    let nextGrab = job.resumeIndex;
    const workerCount = Math.min(concurrency, Math.max(1, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (job.abortController?.signal.aborted) break;
        let index: number | undefined;
        while (nextGrab < items.length) {
          const candidate = nextGrab;
          nextGrab += 1;
          if (!job.completedIndexes.has(candidate)) {
            index = candidate;
            break;
          }
        }
        if (index === undefined) break;
        await runItem(index, items[index]!);
      }
    });
    await Promise.all(workers);

    if ((job.status as AgentJobStatus) === 'cancelled' || (job.status as AgentJobStatus) === 'paused') return;
    if (job.abortController?.signal.aborted) return;

    const hasErrors = (job.errors?.length ?? 0) > 0;
    job.status = hasErrors ? 'completed_with_warnings' : 'completed';
    job.progress = 1;
    job.message = hasErrors ? 'Job completed with warnings.' : 'Job completed.';
    job.revisionId = useProjectSafetyStore.getState().activeRevisionId;
    job.finishedAt = Date.now();
    notify(job);
  } catch {
    if (job.runGeneration !== runGeneration) return;
    if (job.status === 'running') {
      job.status = 'failed';
      job.message = 'Job failed.';
      job.finishedAt = Date.now();
      notify(job);
    }
  }
}

export function submitAgentJob(input: AgentSubmitJobInput): AgentSubmitJobResult {
  const revisionIdAtStart = input.revisionId ?? useProjectSafetyStore.getState().activeRevisionId;
  const liveRevision = useProjectSafetyStore.getState().activeRevisionId;
  if (revisionIdAtStart && liveRevision && revisionIdAtStart !== liveRevision) {
    return {
      ok: false,
      diagnostics: [agentError('stale_revision', 'Job revisionId does not match the active project revision.')],
    };
  }

  const items = expandJobItems({
    type: input.type,
    jobs: input.jobs,
    shotIds: input.shotIds,
    passes: input.passes,
  });
  pruneRetainedJobs();
  const jobId = nextJobId();
  const job: StoredJob = {
    jobId,
    createdAt: Date.now(),
    type: input.type,
    status: 'pending',
    progress: 0,
    completedItems: 0,
    totalItems: items.length,
    message: 'Job queued.',
    revisionIdAtStart,
    input,
    listeners: new Set(),
    resumeIndex: 0,
    abortController: new AbortController(),
    artifactIds: [],
    completedIndexes: new Set(),
    runGeneration: 0,
  };
  jobs.set(jobId, job);
  void runJob(job);

  return { ok: true, jobId, status: 'pending', diagnostics: [] };
}

export function getAgentJob(jobId: string): AgentJobProgress | undefined {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : undefined;
}

export function cancelAgentJob(jobId: string): AgentSubmitJobResult {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, diagnostics: [agentError('job_not_found', `No job with id "${jobId}".`)] };
  job.abortController?.abort();
  job.status = 'cancelled';
  job.message = 'Job cancelled.';
  job.finishedAt = Date.now();
  notify(job);
  return { ok: true, jobId, status: 'cancelled', diagnostics: [] };
}

export async function resumeAgentJob(jobId: string): Promise<AgentSubmitJobResult> {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, diagnostics: [agentError('job_not_found', `No job with id "${jobId}".`)] };
  if (job.status === 'running') return { ok: true, jobId, status: job.status, diagnostics: [] };
  if ((job.status === 'paused' || job.status === 'failed') && job.resumeIndex < job.totalItems) {
    job.abortController = new AbortController();
    job.status = 'pending';
    void runJob(job);
    return { ok: true, jobId, status: 'running', diagnostics: [] };
  }
  return { ok: false, diagnostics: [agentError('job_not_resumable', 'Job cannot be resumed.')] };
}

export function subscribeToAgentJobProgress(
  jobId: string,
  listener: (progress: AgentJobProgress) => void,
): () => void {
  const job = jobs.get(jobId);
  if (!job) return () => undefined;
  job.listeners.add(listener);
  listener(snapshot(job));
  return () => job.listeners.delete(listener);
}

export function waitForAgentJob(
  jobId: string,
  options: { timeoutMs?: number } = {},
): Promise<AgentJobProgress> {
  const existing = getAgentJob(jobId);
  if (existing && isJobWaitComplete(existing)) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          unsub?.();
          reject(new Error(`Job ${jobId} did not finish within ${options.timeoutMs}ms.`));
        }, options.timeoutMs)
      : undefined;

    unsub = subscribeToAgentJobProgress(jobId, (progress) => {
      if (isJobWaitComplete(progress)) {
        if (timer) clearTimeout(timer);
        unsub?.();
        resolve(progress);
      }
    });
  });
}

export function resetAgentJobsForTests(): void {
  for (const job of jobs.values()) job.abortController?.abort();
  jobs.clear();
  jobCounter = 0;
}

export function pauseAgentJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.abortController?.abort();
  job.status = 'paused';
  job.message = 'Job paused.';
  job.finishedAt = Date.now();
  notify(job);
}

export function listAgentJobs(): AgentJobProgress[] {
  return [...jobs.values()].map(snapshot);
}
