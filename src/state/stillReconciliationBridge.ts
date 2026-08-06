/**
 * Bridges project-store commits to still reconciliation without cyclic imports.
 */

import {
  bindAppStillReconciliationScheduler,
  getAppStillReconciliationScheduler,
  isMetadataOnlyShotPatch,
  type ReconciliationSchedulerOptions,
} from '../engine/stillArtifactReconciliation';
import type { LocationProject, Shot } from '../domain/types';

let bound = false;

export function ensureStillReconciliationBound(
  options: Pick<ReconciliationSchedulerOptions, 'getProject' | 'setProject'>,
): void {
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

export function resetStillReconciliationBridgeForTests(): void {
  bound = false;
}
