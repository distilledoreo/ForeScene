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
  /** Owning shot (or other entity) for scoped cancellation. */
  ownerId?: string;
  jobId?: string;
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
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cancelled: boolean;
}

let nextId = 1;
const queue: QueuedWork[] = [];
let activeCount = 0;
const MAX_CONCURRENT = 1;

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
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    sortQueue();
    const nextIndex = queue.findIndex((item) => {
      if (item.cancelled) return true;
      if (item.priority === 'background-video') {
        const interactiveWaiting = queue.some(
          (other) => !other.cancelled && isInteractiveStill(other.priority),
        );
        if (interactiveWaiting) return false;
      }
      return true;
    });
    if (nextIndex < 0) break;

    const item = queue.splice(nextIndex, 1)[0]!;
    if (item.cancelled) {
      item.reject(Object.assign(new Error('Render work was cancelled.'), { name: 'AbortError' }));
      continue;
    }

    activeCount += 1;
    try {
      const value = await item.run();
      item.resolve(value);
    } catch (error) {
      item.reject(error);
    } finally {
      activeCount -= 1;
      await Promise.resolve();
    }
  }
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
        run: work as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        cancelled: false,
      };
      queue.push(entry);
      void pump();
    });
  },

  /**
   * Cancel queued (not running) work.
   * Prefer ownerId for shot-scoped cancellation.
   */
  cancelQueued(
    predicate: (entry: {
      priority: RenderWorkPriority;
      ownerId?: string;
      jobId?: string;
    }) => boolean,
  ): number {
    let cancelled = 0;
    for (const item of queue) {
      if (
        !item.cancelled
        && predicate({
          priority: item.priority,
          ownerId: item.ownerId,
          jobId: item.jobId,
        })
      ) {
        item.cancelled = true;
        cancelled += 1;
      }
    }
    return cancelled;
  },

  cancelByOwner(ownerId: string): number {
    return this.cancelQueued((entry) => entry.ownerId === ownerId);
  },

  inspectForTests() {
    return {
      queueLength: queue.filter((item) => !item.cancelled).length,
      activeCount,
      priorities: queue.filter((item) => !item.cancelled).map((item) => item.priority),
      owners: queue.filter((item) => !item.cancelled).map((item) => item.ownerId),
    };
  },

  resetForTests() {
    for (const item of queue) {
      item.cancelled = true;
      item.reject(Object.assign(new Error('Render work coordinator reset.'), { name: 'AbortError' }));
    }
    queue.length = 0;
    activeCount = 0;
    nextId = 1;
  },
};
