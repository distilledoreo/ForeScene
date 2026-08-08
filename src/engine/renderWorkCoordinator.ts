/**
 * Single coordinator for GPU-intensive prepared-media work.
 * Interactive stills outrank secondary stills and background video.
 * Queue entries carry owner metadata so cancellation can be shot-scoped.
 */

export type RenderWorkPriority =
  | 'capture-primary-still'
  | 'capture-secondary-still'
  | 'edit-primary-still'
  | 'edit-secondary-still'
  | 'export-recovery-still'
  | 'foreground-export-video'
  | 'background-video';

export interface RenderWorkOptions {
  ownerId?: string;
  jobId?: string;
  /** Optional active-job abort hook for work that owns an AbortController. */
  abort?: () => void;
}

const PRIORITY_ORDER: Record<RenderWorkPriority, number> = {
  'capture-primary-still': 0,
  'edit-primary-still': 1,
  'capture-secondary-still': 2,
  'edit-secondary-still': 3,
  'export-recovery-still': 4,
  'foreground-export-video': 5,
  'background-video': 6,
};

interface QueuedWork {
  id: number;
  priority: RenderWorkPriority;
  ownerId?: string;
  jobId?: string;
  abort?: () => void;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cancelled: boolean;
}

let nextId = 1;
const queue: QueuedWork[] = [];
const active = new Map<number, QueuedWork>();
const MAX_CONCURRENT = 1;

function abortError(message = 'Render work was cancelled.'): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

function isInteractiveStill(priority: RenderWorkPriority): boolean {
  return (
    priority === 'capture-primary-still'
    || priority === 'capture-secondary-still'
    || priority === 'edit-primary-still'
    || priority === 'edit-secondary-still'
  );
}

function sortQueue(): void {
  queue.sort((a, b) => {
    const rank = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (rank !== 0) return rank;
    return a.id - b.id;
  });
}

async function pump(): Promise<void> {
  while (active.size < MAX_CONCURRENT && queue.length > 0) {
    sortQueue();
    const nextIndex = queue.findIndex((item) => {
      if (item.priority === 'background-video') {
        const interactiveWaiting = queue.some((other) => isInteractiveStill(other.priority));
        if (interactiveWaiting) return false;
      }
      return true;
    });
    if (nextIndex < 0) break;

    const item = queue.splice(nextIndex, 1)[0]!;
    if (item.cancelled) continue;

    active.set(item.id, item);
    try {
      const value = await item.run();
      if (item.cancelled) item.reject(abortError());
      else item.resolve(value);
    } catch (error) {
      item.reject(error);
    } finally {
      active.delete(item.id);
      await Promise.resolve();
    }
  }
}

function removeQueued(
  predicate: (entry: QueuedWork) => boolean,
  message = 'Render work was cancelled.',
): number {
  let cancelled = 0;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index]!;
    if (!predicate(item)) continue;
    queue.splice(index, 1);
    item.cancelled = true;
    item.abort?.();
    item.reject(abortError(message));
    cancelled += 1;
  }
  if (cancelled > 0) void pump();
  return cancelled;
}

export const renderWorkCoordinator = {
  schedule<T>(
    priority: RenderWorkPriority,
    work: () => Promise<T>,
    options?: RenderWorkOptions,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedWork = {
        id: nextId++,
        priority,
        ownerId: options?.ownerId,
        jobId: options?.jobId,
        abort: options?.abort,
        run: work as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        cancelled: false,
      };
      queue.push(entry);
      void pump();
    });
  },

  cancelQueued(
    predicate: (entry: {
      priority: RenderWorkPriority;
      ownerId?: string;
      jobId?: string;
    }) => boolean,
  ): number {
    return removeQueued((item) => predicate({
      priority: item.priority,
      ownerId: item.ownerId,
      jobId: item.jobId,
    }));
  },

  cancelByOwner(ownerId: string): number {
    let cancelled = removeQueued((item) => item.ownerId === ownerId);
    for (const item of active.values()) {
      if (item.ownerId !== ownerId || item.cancelled) continue;
      item.cancelled = true;
      item.abort?.();
      cancelled += 1;
    }
    return cancelled;
  },

  getStatus() {
    return {
      queueLength: queue.length,
      activeCount: active.size,
      activePriorities: [...active.values()].map((item) => item.priority),
      queuedPriorities: queue.map((item) => item.priority),
      activeOwners: [...active.values()].map((item) => item.ownerId),
    };
  },

  inspectForTests() {
    const status = this.getStatus();
    return {
      queueLength: status.queueLength,
      activeCount: status.activeCount,
      priorities: status.queuedPriorities,
      owners: queue.map((item) => item.ownerId),
      activePriorities: status.activePriorities,
      activeOwners: status.activeOwners,
    };
  },

  resetForTests() {
    removeQueued(() => true, 'Render work coordinator reset.');
    for (const item of active.values()) {
      item.cancelled = true;
      item.abort?.();
    }
    nextId = 1;
  },
};
