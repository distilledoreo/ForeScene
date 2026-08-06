/**
 * Bridges project-store commits to still reconciliation without cyclic imports.
 * Covers shot edits, build/scene commits, pano pose, and global asset changes.
 */

import {
  bindAppStillReconciliationScheduler,
  getAppStillReconciliationScheduler,
  isMetadataOnlyShotPatch,
  type ReconciliationSchedulerOptions,
} from '../engine/stillArtifactReconciliation';
import type { LocationProject, Shot } from '../domain/types';

let bound = false;
let getProjectFn: (() => LocationProject) | undefined;
let setProjectFn: ((project: LocationProject) => void) | undefined;

export function ensureStillReconciliationBound(
  options: Pick<ReconciliationSchedulerOptions, 'getProject' | 'setProject'>,
): void {
  getProjectFn = options.getProject;
  setProjectFn = options.setProject;
  if (bound && getAppStillReconciliationScheduler()) return;
  bindAppStillReconciliationScheduler({
    debounceMs: 400,
    getProject: options.getProject,
    setProject: options.setProject,
  });
  bound = true;
}

export function scheduleStillReconciliationAfterShotUpdate(
  previous: LocationProject,
  next: LocationProject,
  shotId: string,
  patch: Partial<Shot>,
): void {
  const scheduler = getAppStillReconciliationScheduler();
  if (!scheduler) return;
  if (isMetadataOnlyShotPatch(patch)) return;
  scheduler.scheduleAfterCommit(previous, next, [shotId], patch);
}

/**
 * After any project mutation that may affect still fingerprints
 * (scene objects, poses, pano origin/rotation, model assets, etc.).
 */
export function scheduleStillReconciliationAfterProjectChange(
  previous: LocationProject,
  next: LocationProject,
): void {
  const scheduler = getAppStillReconciliationScheduler();
  if (!scheduler) return;
  if (previous === next) return;
  scheduler.scheduleAfterCommit(previous, next);
}

/**
 * Schedule from inside a Zustand reducer after a build-scene commit.
 * Defers to a microtask so get() sees the committed project.
 */
export function scheduleStillReconciliationAfterBuildSceneCommit(
  previousProject: LocationProject,
): void {
  if (!getProjectFn || !setProjectFn) return;
  queueMicrotask(() => {
    if (!getProjectFn || !setProjectFn) return;
    ensureStillReconciliationBound({
      getProject: getProjectFn,
      setProject: setProjectFn,
    });
    scheduleStillReconciliationAfterProjectChange(previousProject, getProjectFn());
  });
}

export function resetStillReconciliationBridgeForTests(): void {
  bound = false;
  getProjectFn = undefined;
  setProjectFn = undefined;
}
