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
  revisionIdAtStart?: string;
  input: AgentSubmitJobInput;
  listeners: Set<(progress: AgentJobProgress) => void>;
  abortController?: AbortController;
  resumeIndex: number;
  completedIndexes: Set<number>;
}

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

function isTerminalStatus(status: AgentJobStatus): boolean {
  return status === 'completed'
    || status === 'completed_with_warnings'
    || status === 'failed'
    || status === 'cancelled';
}

async function runJob(job: StoredJob): Promise<void> {
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

  let settledCount = job.completedIndexes.size;
  const artifactIds = [...(job.artifactIds ?? [])];
  const registerArtifact = (artifactId: string) => {
    if (!artifactIds.includes(artifactId)) artifactIds.push(artifactId);
    job.artifactIds = [...artifactIds];
  };

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

    const runHandler = () => handler(item, index, {
      jobId: job.jobId,
      revisionIdAtStart: job.revisionIdAtStart,
      registerArtifact,
    });

    try {
      if (job.input.timeoutMsPerItem) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Job item timed out.')), job.input.timeoutMsPerItem);
          runHandler()
            .then(() => {
              clearTimeout(timer);
              resolve();
            })
            .catch((error) => {
              clearTimeout(timer);
              reject(error);
            });
        });
      } else {
        await runHandler();
      }
    } catch (error) {
      const diagnostic = agentError(
        'job_item_failed',
        error instanceof Error ? error.message : 'Job item failed.',
      );
      job.errors = [...(job.errors ?? []), diagnostic];
      if (!continueOnError) {
        job.status = 'failed';
        job.message = diagnostic.message;
        markJobItemSettled(job, index);
        settledCount = job.completedIndexes.size;
        notify(job);
        throw error;
      }
    }

    markJobItemSettled(job, index);
    settledCount = job.completedIndexes.size;
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

    if ((job.status as AgentJobStatus) === 'cancelled') return;

    const hasErrors = (job.errors?.length ?? 0) > 0;
    job.status = hasErrors ? 'completed_with_warnings' : 'completed';
    job.progress = 1;
    job.message = hasErrors ? 'Job completed with warnings.' : 'Job completed.';
    job.revisionId = useProjectSafetyStore.getState().activeRevisionId;
    notify(job);
  } catch {
    const status = job.status as AgentJobStatus;
    if (!isTerminalStatus(status)) {
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

  const items = expandJobItems({
    type: input.type,
    jobs: input.jobs,
    shotIds: input.shotIds,
    passes: input.passes,
  });
  const jobId = nextJobId();
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
    artifactIds: [],
    completedIndexes: new Set(),
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
  if (
    (job.status === 'paused' || job.status === 'failed')
    && job.resumeIndex < job.totalItems
  ) {
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

export function waitForAgentJob(
  jobId: string,
  options: { timeoutMs?: number } = {},
): Promise<AgentJobProgress> {
  const existing = getAgentJob(jobId);
  if (existing && isTerminalStatus(existing.status)) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          unsub?.();
          reject(new Error(`Job ${jobId} did not finish within ${options.timeoutMs}ms.`));
        }, options.timeoutMs)
      : undefined;

    unsub = subscribeToAgentJobProgress(jobId, (progress) => {
      if (isTerminalStatus(progress.status)) {
        if (timer) clearTimeout(timer);
        unsub?.();
        resolve(progress);
      }
    });
  });
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
