/**
 * Edit-time dependency-aware still reconciliation.
 * Debounces committed authoring changes; fingerprints gate actual re-renders.
 */

import type { LocationProject, Shot } from '../domain/types';
import { materializeShotStills } from './materializeShotStills';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import {
  buildStillArtifactSpecificationsForShot,
} from './stillArtifactPlanning';
import { stillArtifactKey } from './stillArtifactTypes';
import type { RenderedStillArtifact } from './stillArtifactRender';

const DEFAULT_DEBOUNCE_MS = 400;

export interface ReconciliationSchedulerOptions {
  debounceMs?: number;
  getProject: () => LocationProject;
  setProject: (project: LocationProject) => void;
  render?: (params: {
    project: LocationProject;
    shot: Shot;
    specification: import('./stillArtifactTypes').StillArtifactSpecification;
    signal?: AbortSignal;
  }) => Promise<RenderedStillArtifact>;
  onComplete?: (shotId: string, result: Awaited<ReturnType<typeof materializeShotStills>>) => void;
  onError?: (shotId: string, error: unknown) => void;
}

interface ShotReconcileState {
  timer: ReturnType<typeof setTimeout> | undefined;
  controller: AbortController | undefined;
  generation: number;
}

/**
 * Pure check: would reconciliation cause any still re-renders for this shot?
 */
export function shotNeedsStillReconciliation(
  project: LocationProject,
  shot: Shot,
): boolean {
  const specs = buildStillArtifactSpecificationsForShot({
    project,
    shot,
    purpose: 'reconcile',
  });
  for (const spec of specs) {
    const key = stillArtifactKey(spec);
    const existing = shot.materializedMedia?.stills[key];
    if (!existing) return true;
    const fp = computeStillArtifactFingerprint(project, shot, spec).key;
    if (existing.fingerprint !== fp) return true;
  }
  // Also check for obsolete artifacts.
  const desired = new Set(specs.map((spec) => stillArtifactKey(spec)));
  for (const key of Object.keys(shot.materializedMedia?.stills ?? {})) {
    if (!desired.has(key)) return true;
  }
  return false;
}

/**
 * Metadata-only fields that must never trigger reconciliation.
 */
export function isMetadataOnlyShotPatch(patch: Partial<Shot>): boolean {
  const keys = Object.keys(patch);
  if (keys.length === 0) return true;
  const metadataOnly = new Set([
    'name',
    'description',
    'shotNumber',
    'productionShotId',
    'promptOverrides',
    'status',
    'createdAt',
    'updatedAt',
    'metadata',
  ]);
  return keys.every((key) => metadataOnly.has(key));
}

/**
 * Identify shots whose still fingerprints may have changed after a project mutation.
 * Global scene / pano / model changes can affect many shots.
 */
export function findShotsAffectedByProjectChange(
  previous: LocationProject | undefined,
  next: LocationProject,
  hintShotIds?: readonly string[],
): string[] {
  if (hintShotIds && hintShotIds.length > 0) {
    return [...new Set(hintShotIds)].filter((id) =>
      next.shots.some((shot) => shot.id === id)
    );
  }

  if (!previous) {
    return next.shots.map((shot) => shot.id);
  }

  const affected = new Set<string>();

  // Global dependency changes: scene objects, pano refs, assets content.
  const sceneChanged =
    previous.scene !== next.scene
    || previous.scene.objects !== next.scene.objects
    || previous.scene.panoOrigin !== next.scene.panoOrigin
    || previous.scene.panoRotation !== next.scene.panoRotation;
  const panoChanged = previous.panoRefs !== next.panoRefs;
  const assetsChanged = previous.assets !== next.assets;

  if (sceneChanged || panoChanged || assetsChanged) {
    for (const shot of next.shots) affected.add(shot.id);
    return [...affected];
  }

  const prevById = new Map(previous.shots.map((shot) => [shot.id, shot]));
  for (const shot of next.shots) {
    const prev = prevById.get(shot.id);
    if (!prev) {
      affected.add(shot.id);
      continue;
    }
    if (prev === shot) continue;
    // Compare fields that affect fingerprints.
    if (
      prev.camera !== shot.camera
      || prev.cameraKeyframes !== shot.cameraKeyframes
      || prev.objectOverrides !== shot.objectOverrides
      || prev.linkedPanoId !== shot.linkedPanoId
      || prev.exportSettings !== shot.exportSettings
      || prev.exportOverrides !== shot.exportOverrides
    ) {
      affected.add(shot.id);
    }
  }

  return [...affected];
}

export function createStillReconciliationScheduler(
  options: ReconciliationSchedulerOptions,
) {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const perShot = new Map<string, ShotReconcileState>();

  function cancelShot(shotId: string): void {
    const state = perShot.get(shotId);
    if (!state) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.controller?.abort();
    state.timer = undefined;
    state.controller = undefined;
  }

  function schedule(shotIds: readonly string[]): void {
    for (const shotId of shotIds) {
      let state = perShot.get(shotId);
      if (!state) {
        state = { timer: undefined, controller: undefined, generation: 0 };
        perShot.set(shotId, state);
      }
      if (state.timer !== undefined) clearTimeout(state.timer);
      // Supersede any in-flight work for this shot.
      state.controller?.abort();
      state.controller = undefined;
      state.generation += 1;
      const generation = state.generation;

      state.timer = setTimeout(() => {
        state!.timer = undefined;
        const project = options.getProject();
        const shot = project.shots.find((item) => item.id === shotId);
        if (!shot) return;
        if (!shotNeedsStillReconciliation(project, shot)) return;

        const controller = new AbortController();
        state!.controller = controller;

        void materializeShotStills({
          project,
          shotId,
          reason: 'edit',
          scope: 'stale-only',
          signal: controller.signal,
          render: options.render,
          getLiveProject: options.getProject,
          commitLiveProject: (updater) => {
            options.setProject(updater(options.getProject()));
            return options.getProject();
          },
        }).then(
          (result) => {
            if (generation !== state!.generation) return;
            state!.controller = undefined;
            // result.project is already live-merged; avoid full stale overwrite.
            options.setProject(result.project);
            options.onComplete?.(shotId, result);
          },
          (error) => {
            if (generation !== state!.generation) return;
            state!.controller = undefined;
            if (error instanceof Error && error.name === 'AbortError') return;
            options.onError?.(shotId, error);
          },
        );
      }, debounceMs);
    }
  }

  function scheduleAfterCommit(
    previous: LocationProject | undefined,
    next: LocationProject,
    hintShotIds?: readonly string[],
    patch?: Partial<Shot>,
  ): void {
    if (patch && isMetadataOnlyShotPatch(patch)) return;
    const affected = findShotsAffectedByProjectChange(previous, next, hintShotIds);
    if (affected.length === 0) return;
    // Drop obsolete background MP4 work for affected shots.
    void import('./backgroundVideoService').then(({ discardBackgroundVideosForShot }) => {
      for (const id of affected) discardBackgroundVideosForShot(id);
    }).catch(() => undefined);
    // Filter to shots that actually need work (fingerprint gate).
    const needing = affected.filter((shotId) => {
      const shot = next.shots.find((item) => item.id === shotId);
      return shot ? shotNeedsStillReconciliation(next, shot) : false;
    });
    if (needing.length > 0) schedule(needing);
  }

  function dispose(): void {
    for (const shotId of perShot.keys()) cancelShot(shotId);
    perShot.clear();
  }

  function inspectForTests() {
    return {
      pendingShots: [...perShot.entries()]
        .filter(([, state]) => state.timer !== undefined || state.controller)
        .map(([id]) => id),
    };
  }

  return {
    schedule,
    scheduleAfterCommit,
    cancelShot,
    dispose,
    inspectForTests,
  };
}

/** Singleton used by the app store (lazily bound). */
let appScheduler: ReturnType<typeof createStillReconciliationScheduler> | undefined;

export function bindAppStillReconciliationScheduler(
  options: ReconciliationSchedulerOptions,
): ReturnType<typeof createStillReconciliationScheduler> {
  appScheduler?.dispose();
  appScheduler = createStillReconciliationScheduler(options);
  return appScheduler;
}

export function getAppStillReconciliationScheduler() {
  return appScheduler;
}

export function resetAppStillReconciliationSchedulerForTests(): void {
  appScheduler?.dispose();
  appScheduler = undefined;
}
