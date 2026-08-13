/**
 * Unified asynchronous job queue for Agent API batch operations.
 * Items execute through registered handlers and report progress from settled work.
 *
 * Pause/cancel may mark public job state immediately and abort the captured
 * controller. Resume always drains the previous generation's in-flight
 * workers/handlers first (including handlers that ignore AbortSignal) so two
 * generations never overlap GPU/render work. Timeout uses the same drain:
 * the waiter rejects, then the live handler is awaited before the next item
 * or generation can start.
 *
 * Artifact ownership is tracked by job + generation in the registry. A late
 * artifact created after abort is not published as a job result. After this
 * generation's handlers settle, unpublished job-scoped outputs are deleted
 * (persisted / project-attached / already-published artifacts are kept).
 */

import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import {
  beginAgentJobArtifactRun,
  endAgentJobArtifactRun,
  markAgentArtifactInFlight,
  sweepUnpublishedJobArtifacts,
  clearAgentJobArtifactRunsForTests,
} from './artifactRegistry';
import { recordProvenanceCancellation, recordProvenanceRetry } from './cacheTelemetry';
import { agentError } from './diagnostics';
import { expandJobItems, resolveAgentJobHandler } from './jobHandlers';
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
  /** Artifact ids whose in-flight pin was already released for this run. */
  releasedInFlightIds: Set<string>;
  /**
   * In-flight `runJob` for the current/last generation. Resume awaits this
   * so a signal-ignoring generation-1 handler cannot overlap generation 2.
   */
  activeRun?: Promise<void>;
  /** Serializes concurrent `resumeAgentJob` callers onto one drain + launch. */
  resumeChain?: Promise<void>;
}

/** Per-invocation bookkeeping. Stale closures must not share this with a later resume. */
interface JobRunContext {
  generation: number;
  abortController: AbortController;
  artifactIds: string[];
  releasedInFlightIds: Set<string>;
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

function isCurrentJobRun(job: StoredJob, run: JobRunContext): boolean {
  return job.runGeneration === run.generation && job.abortController === run.abortController;
}

function canMutateJobRun(job: StoredJob, run: JobRunContext): boolean {
  return isCurrentJobRun(job, run)
    && !run.abortController.signal.aborted
    && job.status === 'running';
}

function releaseArtifactInFlight(job: StoredJob, artifactId: string): void {
  if (job.releasedInFlightIds.has(artifactId)) return;
  job.releasedInFlightIds.add(artifactId);
  markAgentArtifactInFlight(artifactId, false);
}

function releaseRunArtifactInFlight(job: StoredJob, run: JobRunContext, artifactId: string): void {
  if (!isCurrentJobRun(job, run)) return;
  if (run.releasedInFlightIds.has(artifactId)) return;
  run.releasedInFlightIds.add(artifactId);
  releaseArtifactInFlight(job, artifactId);
}

function clearJobArtifactInFlight(job: StoredJob): void {
  for (const artifactId of job.artifactIds ?? []) {
    releaseArtifactInFlight(job, artifactId);
  }
}

function clearRunArtifactInFlight(job: StoredJob, run: JobRunContext): void {
  if (!isCurrentJobRun(job, run)) return;
  const ids = new Set([...(job.artifactIds ?? []), ...run.artifactIds]);
  for (const artifactId of ids) {
    releaseRunArtifactInFlight(job, run, artifactId);
  }
}

function publishRunArtifact(job: StoredJob, run: JobRunContext, artifactId: string): void {
  if (!canMutateJobRun(job, run)) return;
  if (!run.artifactIds.includes(artifactId)) run.artifactIds.push(artifactId);
  const published = [...(job.artifactIds ?? [])];
  if (!published.includes(artifactId)) published.push(artifactId);
  job.artifactIds = published;
  run.releasedInFlightIds.delete(artifactId);
  job.releasedInFlightIds.delete(artifactId);
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
    finishedAt: job.finishedAt,
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

function attachJobRun(job: StoredJob, run: Promise<void>): void {
  job.activeRun = run;
  void run.then(
    () => {
      if (job.activeRun === run) job.activeRun = undefined;
    },
    () => {
      if (job.activeRun === run) job.activeRun = undefined;
    },
  );
}

function launchJobRun(job: StoredJob): void {
  attachJobRun(job, runJob(job).catch(() => undefined));
}

async function drainJobRun(job: StoredJob): Promise<void> {
  const active = job.activeRun;
  if (!active) return;
  await active.catch(() => undefined);
}

function enqueueJobResume<T>(job: StoredJob, work: () => Promise<T>): Promise<T> {
  const previous = job.resumeChain ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  job.resumeChain = previous.then(() => current, () => current);
  return previous.then(work, work).finally(release);
}

/**
 * Run one item handler without abandoning it.
 *
 * Pause/cancel/timeout may reject the *waiter* immediately so public job
 * state can flip, but the already-started handler is still awaited before
 * this function returns. That is the orphan policy: a live GPU/render
 * handler is never dropped so the next worker/generation cannot start
 * concurrently behind it — even when the handler ignores AbortSignal.
 */
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
      // Same orphan policy without a per-item timeout: abort flips the waiter,
      // then drain the live handler before the worker can grab another item.
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
    // Orphan policy: timeout/abort rejects the waiter, then this still drains
    // the live handler before the worker is released. Do not start another
    // GPU/render item while that handler is still executing.
    if (timedOut || signal?.aborted) await handlerPromise.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

async function runJob(job: StoredJob): Promise<void> {
  const abortController = job.abortController ?? new AbortController();
  job.abortController = abortController;
  const runGeneration = job.runGeneration + 1;
  job.runGeneration = runGeneration;
  const run: JobRunContext = {
    generation: runGeneration,
    abortController,
    artifactIds: [],
    releasedInFlightIds: new Set(),
  };
  beginAgentJobArtifactRun(job.jobId, runGeneration);
  try {
    await executeJobRun(job, run);
  } finally {
    // Handlers have settled (including signal-ignoring late creates). Sweep
    // unpublished outputs for this generation before resume can start the next.
    sweepUnpublishedJobArtifacts({
      jobId: job.jobId,
      publishedArtifactIds: job.artifactIds ?? [],
      runGeneration,
    });
    endAgentJobArtifactRun(job.jobId, runGeneration);
  }
}

async function executeJobRun(job: StoredJob, run: JobRunContext): Promise<void> {
  const signal = run.abortController.signal;
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
  const handler = resolveAgentJobHandler(job.type);

  if (!handler) {
    if (!isCurrentJobRun(job, run)) return;
    job.status = 'failed';
    job.message = 'No handler registered for job type ' + job.type + '.';
    job.errors = [agentError('job_handler_missing', job.message)];
    job.finishedAt = Date.now();
    clearRunArtifactInFlight(job, run);
    notify(job);
    return;
  }

  const registerArtifact = (artifactId: string) => {
    publishRunArtifact(job, run, artifactId);
  };

  const runItem = async (index: number, item: unknown) => {
    if (!isCurrentJobRun(job, run) || signal.aborted) return;

    job.currentItem = String(index);
    job.message = 'Processing item ' + String(index + 1) + ' of ' + String(job.totalItems) + '.';
    notify(job);

    const itemArtifactStart = run.artifactIds.length;
    const settleItemArtifacts = () => {
      if (!isCurrentJobRun(job, run)) return;
      for (const artifactId of run.artifactIds.slice(itemArtifactStart)) {
        releaseRunArtifactInFlight(job, run, artifactId);
      }
    };

    const runHandler = () => handler(item, index, {
      jobId: job.jobId,
      revisionIdAtStart: job.revisionIdAtStart,
      signal,
      registerArtifact,
    });

    try {
      await runHandlerWithoutOrphaning(
        runHandler,
        job.input.timeoutMsPerItem,
        signal,
      );
    } catch (error) {
      // Cancel/pause owns the final state. A late handler rejection after a
      // newer generation has begun must not become an error or mark the item settled.
      if (!canMutateJobRun(job, run)) {
        settleItemArtifacts();
        return;
      }

      const diagnostic = agentError(
        'job_item_failed',
        error instanceof Error ? error.message : 'Job item failed.',
      );
      job.errors = [...(job.errors ?? []), diagnostic];
      settleItemArtifacts();
      if (!continueOnError) {
        job.status = 'failed';
        job.message = diagnostic.message;
        job.finishedAt = Date.now();
        clearRunArtifactInFlight(job, run);
        notify(job);
        throw error;
      }
      markJobItemSettled(job, index);
      notify(job);
      return;
    }

    if (!canMutateJobRun(job, run)) {
      settleItemArtifacts();
      return;
    }
    settleItemArtifacts();
    markJobItemSettled(job, index);
    notify(job);
  };

  try {
    let nextGrab = job.resumeIndex;
    const workerCount = Math.min(concurrency, Math.max(1, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (!isCurrentJobRun(job, run) || signal.aborted) break;
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

    if (!isCurrentJobRun(job, run)) return;
    if ((job.status as AgentJobStatus) === 'cancelled' || (job.status as AgentJobStatus) === 'paused') {
      clearRunArtifactInFlight(job, run);
      return;
    }
    if (signal.aborted) {
      clearRunArtifactInFlight(job, run);
      return;
    }

    const hasErrors = (job.errors?.length ?? 0) > 0;
    job.status = hasErrors ? 'completed_with_warnings' : 'completed';
    job.progress = 1;
    job.message = hasErrors ? 'Job completed with warnings.' : 'Job completed.';
    job.revisionId = useProjectSafetyStore.getState().activeRevisionId;
    job.finishedAt = Date.now();
    clearRunArtifactInFlight(job, run);
    notify(job);
  } catch {
    if (!isCurrentJobRun(job, run)) return;
    if (job.status === 'running') {
      job.status = 'failed';
      job.message = 'Job failed.';
      job.finishedAt = Date.now();
      clearRunArtifactInFlight(job, run);
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
    releasedInFlightIds: new Set(),
  };
  jobs.set(jobId, job);
  launchJobRun(job);

  return { ok: true, jobId, status: 'pending', diagnostics: [] };
}

export function getAgentJob(jobId: string): AgentJobProgress | undefined {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : undefined;
}

export function cancelAgentJob(jobId: string): AgentSubmitJobResult {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, diagnostics: [agentError('job_not_found', `No job with id "${jobId}".`)] };
  if (isTerminalStatus(job.status)) {
    return {
      ok: false,
      jobId,
      status: job.status,
      diagnostics: [agentError(
        'job_already_terminal',
        `Job is already ${job.status}.`,
      )],
    };
  }
  job.abortController?.abort();
  job.status = 'cancelled';
  job.message = 'Job cancelled.';
  job.finishedAt = Date.now();
  clearJobArtifactInFlight(job);
  recordProvenanceCancellation();
  notify(job);
  return { ok: true, jobId, status: 'cancelled', diagnostics: [] };
}

function isAlreadyActiveJob(status: AgentJobStatus): boolean {
  return status === 'running' || status === 'pending';
}

function isResumableJob(job: StoredJob): boolean {
  return (job.status === 'paused' || job.status === 'failed') && job.resumeIndex < job.totalItems;
}

export async function resumeAgentJob(jobId: string): Promise<AgentSubmitJobResult> {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, diagnostics: [agentError('job_not_found', `No job with id "${jobId}".`)] };
  if (isAlreadyActiveJob(job.status)) return { ok: true, jobId, status: job.status, diagnostics: [] };
  if (!isResumableJob(job)) {
    return { ok: false, diagnostics: [agentError('job_not_resumable', 'Job cannot be resumed.')] };
  }

  return enqueueJobResume(job, async () => {
    const current = jobs.get(jobId);
    if (!current) return { ok: false, diagnostics: [agentError('job_not_found', `No job with id "${jobId}".`)] };
    if (isAlreadyActiveJob(current.status)) {
      return { ok: true, jobId, status: current.status, diagnostics: [] };
    }
    if (!isResumableJob(current)) {
      return { ok: false, diagnostics: [agentError('job_not_resumable', 'Job cannot be resumed.')] };
    }

    // Pause/cancel already flipped public state and aborted the captured
    // controller. Drain the previous generation's workers/handlers before
    // replacing the controller or incrementing runGeneration. Generation 2
    // must not invoke a handler until every generation-1 handler has settled.
    await drainJobRun(current);

    const afterDrain = jobs.get(jobId);
    if (!afterDrain) return { ok: false, diagnostics: [agentError('job_not_found', `No job with id "${jobId}".`)] };
    if (isAlreadyActiveJob(afterDrain.status)) {
      return { ok: true, jobId, status: afterDrain.status, diagnostics: [] };
    }
    if (!isResumableJob(afterDrain)) {
      return { ok: false, diagnostics: [agentError('job_not_resumable', 'Job cannot be resumed.')] };
    }

    afterDrain.abortController = new AbortController();
    afterDrain.status = 'pending';
    afterDrain.finishedAt = undefined;
    afterDrain.releasedInFlightIds = new Set();
    recordProvenanceRetry();
    launchJobRun(afterDrain);
    return { ok: true, jobId, status: 'running', diagnostics: [] };
  });
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
  clearAgentJobArtifactRunsForTests();
}

/** Test-only view of per-run identity and shared bookkeeping. */
export function inspectAgentJobRunForTests(jobId: string): {
  runGeneration: number;
  abortAborted: boolean;
  completedIndexes: number[];
  artifactIds: string[];
  releasedInFlightIds: string[];
  status: AgentJobStatus;
  hasActiveRun: boolean;
  finishedAt?: number;
} | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  return {
    runGeneration: job.runGeneration,
    abortAborted: job.abortController?.signal.aborted === true,
    completedIndexes: [...job.completedIndexes].sort((a, b) => a - b),
    artifactIds: [...(job.artifactIds ?? [])],
    releasedInFlightIds: [...job.releasedInFlightIds],
    status: job.status,
    hasActiveRun: job.activeRun !== undefined,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
  };
}

export function pauseAgentJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  if (isTerminalStatus(job.status) || job.status === 'paused') return;
  job.abortController?.abort();
  job.status = 'paused';
  job.message = 'Job paused.';
  job.finishedAt = undefined;
  clearJobArtifactInFlight(job);
  notify(job);
}

export function listAgentJobs(): AgentJobProgress[] {
  return [...jobs.values()].map(snapshot);
}
