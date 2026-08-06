/**
 * Application-level singleton for background MP4 preparation.
 * Survives across captures; edits can discard obsolete work per shot.
 */

import type { LocationProject } from '../domain/types';
import {
  createBackgroundVideoScheduler,
} from './backgroundVideoPreparation';
import type { PreparedVideoArtifact } from './prepareVideoArtifact';

type Scheduler = ReturnType<typeof createBackgroundVideoScheduler>;

let scheduler: Scheduler | undefined;
let boundGetProject: (() => LocationProject) | undefined;
let visibilityHandler: (() => void) | undefined;
let visibilityBound = false;

export function bindBackgroundVideoService(options: {
  getProject: () => LocationProject;
  onPrepared?: (shotId: string, result: PreparedVideoArtifact) => void;
  onError?: (shotId: string, error: unknown) => void;
}): void {
  boundGetProject = options.getProject;
  if (scheduler) {
    // Rebind getProject without dropping the queue.
    return;
  }
  scheduler = createBackgroundVideoScheduler({
    getProject: () => (boundGetProject ? boundGetProject() : options.getProject()),
    onPrepared: options.onPrepared,
    onError: options.onError,
  });
  bindVisibilityLifecycle();
}

/** Pause background MP4 work while the tab is hidden; resume when visible again. */
function bindVisibilityLifecycle(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  visibilityHandler = () => {
    if (document.hidden) scheduler?.setPaused(true);
    else scheduler?.setPaused(false);
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

export function getBackgroundVideoScheduler(): Scheduler | undefined {
  return scheduler;
}

export function getBackgroundVideoServiceStatus(): {
  bound: boolean;
  paused: boolean;
  pending: number;
  running: boolean;
} {
  const inspected = scheduler?.inspectForTests();
  return {
    bound: Boolean(scheduler),
    paused: inspected?.paused ?? false,
    pending: inspected?.pending ?? 0,
    running: inspected?.running ?? false,
  };
}

export function ensureBackgroundVideoService(
  getProject: () => LocationProject,
): Scheduler {
  if (!scheduler) {
    bindBackgroundVideoService({ getProject });
  }
  boundGetProject = getProject;
  return scheduler!;
}

export async function queueBackgroundVideosForShot(shotId: string): Promise<void> {
  if (!scheduler || !boundGetProject) return;
  await scheduler.queueMissingForShot(shotId);
}

export function discardBackgroundVideosForShot(shotId: string): void {
  scheduler?.discardForShot(shotId);
}

export function disposeBackgroundVideoService(): void {
  scheduler?.dispose();
  scheduler = undefined;
  boundGetProject = undefined;
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = undefined;
  visibilityBound = false;
}

export function resetBackgroundVideoServiceForTests(): void {
  disposeBackgroundVideoService();
}
