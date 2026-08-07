/**
 * Application-level singleton for background MP4 preparation.
 * Survives across captures; edits can discard obsolete work per shot.
 */

import type { LocationProject } from '../domain/types';
import {
  buildVideoArtifactSpecificationsForShot,
  createBackgroundVideoScheduler,
  type BackgroundVideoRuntimeStatus,
} from './backgroundVideoPreparation';
import type { PreparedVideoArtifact } from './prepareVideoArtifact';

type Scheduler = ReturnType<typeof createBackgroundVideoScheduler>;

let scheduler: Scheduler | undefined;
let boundGetProject: (() => LocationProject) | undefined;
let visibilityHandler: (() => void) | undefined;
let visibilityBound = false;
const shotStatuses = new Map<string, BackgroundVideoRuntimeStatus>();

function setShotStatus(shotId: string, status: BackgroundVideoRuntimeStatus): void {
  shotStatuses.set(shotId, status);
}

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
    onStatusChange: setShotStatus,
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

/**
 * Resolve a user-facing per-shot video preparation state.
 * Configured-but-never-queued shots report pending; shots with no requested
 * MP4 candidates report not-requested.
 */
export function getBackgroundVideoShotStatus(
  project: LocationProject,
  shotId: string,
): BackgroundVideoRuntimeStatus {
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) return 'not-requested';
  if (buildVideoArtifactSpecificationsForShot(project, shot).length === 0) {
    return 'not-requested';
  }
  return shotStatuses.get(shotId) ?? 'pending';
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
  const project = boundGetProject();
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot || buildVideoArtifactSpecificationsForShot(project, shot).length === 0) {
    setShotStatus(shotId, 'not-requested');
    return;
  }
  setShotStatus(shotId, 'queued');
  await scheduler.queueMissingForShot(shotId);
}

export function discardBackgroundVideosForShot(shotId: string): void {
  scheduler?.discardForShot(shotId);
  if (shotStatuses.get(shotId) !== 'not-requested') {
    setShotStatus(shotId, 'pending');
  }
}

export function disposeBackgroundVideoService(): void {
  scheduler?.dispose();
  scheduler = undefined;
  boundGetProject = undefined;
  shotStatuses.clear();
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = undefined;
  visibilityBound = false;
}

export function resetBackgroundVideoServiceForTests(): void {
  disposeBackgroundVideoService();
}
