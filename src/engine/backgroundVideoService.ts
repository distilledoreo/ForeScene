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
const runtimeListeners = new Set<() => void>();

function notifyRuntimeListeners(): void {
  for (const listener of runtimeListeners) listener();
}

/** Subscribe to per-shot background-video runtime transitions. */
export function subscribeBackgroundVideoRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener);
  return () => runtimeListeners.delete(listener);
}

function setShotStatus(shotId: string, status: BackgroundVideoRuntimeStatus): void {
  if (shotStatuses.get(shotId) === status) return;
  shotStatuses.set(shotId, status);
  notifyRuntimeListeners();
}

export function bindBackgroundVideoService(options: {
  getProject: () => LocationProject;
  onPrepared?: (shotId: string, result: PreparedVideoArtifact) => void;
  onError?: (shotId: string, error: unknown) => void;
}): void {
  boundGetProject = options.getProject;
  if (scheduler) return;
  scheduler = createBackgroundVideoScheduler({
    getProject: () => (boundGetProject ? boundGetProject() : options.getProject()),
    onPrepared: options.onPrepared,
    onError: options.onError,
    onStatusChange: setShotStatus,
  });
  bindVisibilityLifecycle();
}

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

/** Remove all queued/running/status state for a shot that no longer exists. */
export function forgetBackgroundVideosForShot(shotId: string): void {
  scheduler?.discardForShot(shotId);
  if (shotStatuses.delete(shotId)) notifyRuntimeListeners();
}

export function disposeBackgroundVideoService(): void {
  const hadRuntimeState = Boolean(scheduler) || shotStatuses.size > 0;
  scheduler?.dispose();
  scheduler = undefined;
  boundGetProject = undefined;
  shotStatuses.clear();
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = undefined;
  visibilityBound = false;
  if (hadRuntimeState) notifyRuntimeListeners();
}

export function resetBackgroundVideoServiceForTests(): void {
  disposeBackgroundVideoService();
}
