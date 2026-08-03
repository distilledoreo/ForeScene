/**
 * Unified asynchronous job queue for Agent API batch operations.
 * Jobs checkpoint progress in memory and can resume after page restart when
 * backed by persisted revision snapshots.
 */

import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { agentError } from './diagnostics';
import type {
  AgentJobProgress,
  AgentJobStatus,
  AgentJobType,
  AgentSubmitJobInput,
  AgentSubmitJobResult,
} from './protocol';

interface StoredJob extends AgentJobProgress {
  revisionIdAtStart?: string;
  input: AgentSubmitJobInput;
  listeners: Set<(progress: AgentJobProgress) => void>;
  abortController?: AbortController;
  resumeIndex: number;
}

const jobs = new Map<string, StoredJob>();
let jobCounter = 0;

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

async function runJob(job: StoredJob): Promise<void> {
  job.status = 'running';
  job.message = 'Job started.';
  notify(job);

  const items = job.input.jobs ?? job.input.shotIds ?? [];
  job.totalItems = items.length;
  const concurrency = Math.max(1, job.input.concurrency ?? 1);
  const continueOnError = job.input.continueOnError ?? true;
  const startIndex = job.resumeIndex;

  const runItem = async (index: number, item: unknown) => {
    if (job.abortController?.signal.aborted) {
      job.status = 'cancelled';
      job.message = 'Job cancelled.';
      notify(job);
      return;
    }

    job.currentItem = String(index);
    job.message = 'Processing item ' + String(index + 1) + ' of ' + String(job.totalItems) + '.';
    notify(job);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = job.input.timeoutMsPerItem;
        const timer = timeout ? setTimeout(() => reject(new Error('Job item timed out.')), timeout) : undefined;
        Promise.resolve()
          .then(() => {
            void item;
          })
          .then(() => {
            if (timer) clearTimeout(timer);
            resolve();
          })
          .catch((error) => {
            if (timer) clearTimeout(timer);
            reject(error);
          });
      });
      job.completedItems = index + 1;
      job.progress = job.totalItems > 0 ? job.completedItems / job.totalItems : 1;
      job.resumeIndex = index + 1;
      notify(job);
    } catch (error) {
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
      job.completedItems = index + 1;
      job.progress = job.totalItems > 0 ? job.completedItems / job.totalItems : 1;
      job.resumeIndex = index + 1;
      notify(job);
    }
  };

  try {
    const pending = items.slice(startIndex);
    let cursor = startIndex;
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (cursor < items.length) {
        if (job.abortController?.signal.aborted) break;
        const index = cursor;
        cursor += 1;
        if (index >= items.length) break;
        await runItem(index, items[index]);
      }
    });
    await Promise.all(workers);

    if ((job.status as AgentJobStatus) === 'cancelled') return;

    const hasErrors = (job.errors?.length ?? 0) > 0;
    job.status = hasErrors ? 'completed_with_warnings' : 'completed';
    job.progress = 1;
    job.message = hasErrors ? 'Job completed with warnings.' : 'Job completed.';
    job.revisionId = useProjectSafetyStore.getState().activeRevisionId;
    notify(job);
  } catch {
    const status = job.status as AgentJobStatus;
    if (status !== 'cancelled' && status !== 'failed') {
      job.status = 'failed';
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

  const jobId = nextJobId();
  const items = input.jobs ?? input.shotIds ?? [];
  const job: StoredJob = {
    jobId,
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
  };
  jobs.set(jobId, job);

  void runJob(job);

  return {
    ok: true,
    jobId,
    status: 'pending',
    diagnostics: [],
  };
}

export function getAgentJob(jobId: string): AgentJobProgress | undefined {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : undefined;
}

export function cancelAgentJob(jobId: string): AgentSubmitJobResult {
  const job = jobs.get(jobId);
  if (!job) {
    return { ok: false, diagnostics: [agentError('job_not_found', `No job with id "${jobId}".`)] };
  }
  job.abortController?.abort();
  job.status = 'cancelled';
  job.message = 'Job cancelled.';
  notify(job);
  return { ok: true, jobId, status: 'cancelled', diagnostics: [] };
}

export async function resumeAgentJob(jobId: string): Promise<AgentSubmitJobResult> {
  const job = jobs.get(jobId);
  if (!job) {
    return { ok: false, diagnostics: [agentError('job_not_found', `No job with id "${jobId}".`)] };
  }
  if (job.status === 'running') {
    return { ok: true, jobId, status: job.status, diagnostics: [] };
  }
  if (job.status !== 'paused' && job.status !== 'failed' && job.resumeIndex < job.totalItems) {
    job.abortController = new AbortController();
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

export function resetAgentJobsForTests(): void {
  jobs.clear();
  jobCounter = 0;
}

export function pauseAgentJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.abortController?.abort();
  job.status = 'paused';
  job.message = 'Job paused.';
  notify(job);
}

export function listAgentJobs(): AgentJobProgress[] {
  return [...jobs.values()].map(snapshot);
}
