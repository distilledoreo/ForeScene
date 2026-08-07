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

type BridgeOptions = Pick<ReconciliationSchedulerOptions, 'getProject' | 'setProject'>;

export function ensureStillReconciliationBound(options: BridgeOptions): void {
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

/** Dispose queued/in-flight reconciliation and bind a fresh scheduler to the new project. */
export function rebindStillReconciliation(options: BridgeOptions): void {
  bound = false;
  ensureStillReconciliationBound(options);
}

export function cancelStillReconciliationForShot(shotId: string): void {
  getAppStillReconciliationScheduler()?.cancelShot(shotId);
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

export function scheduleStillReconciliationAfterProjectChange(
  previous: LocationProject,
  next: LocationProject,
): void {
  const scheduler = getAppStillReconciliationScheduler();
  if (!scheduler) return;
  if (previous === next) return;
  scheduler.scheduleAfterCommit(previous, next);
}

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