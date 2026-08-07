/**
 * Edit-time dependency-aware still reconciliation.
 * Debounces committed authoring changes; fingerprints gate actual re-renders.
 */

import type { LocationProject, Shot } from '../domain/types';
import { materializeShotStills } from './materializeShotStills';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import { buildStillArtifactSpecificationsForShot } from './stillArtifactPlanning';
import { stillArtifactKey } from './stillArtifactTypes';
import type { RenderedStillArtifact } from './stillArtifactRender';
import { resolveProjectVideoPerformance } from './videoPerformance';

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

export function shotHasPreparedMediaLifecycle(shot: Shot): boolean {
  if (Object.keys(shot.materializedMedia?.stills ?? {}).length > 0) return true;
  return Boolean(
    shot.assets.viewportRenderAssetId
    || shot.assets.viewportCleanPlateAssetId
    || shot.assets.viewportProjectedAssetId
    || shot.assets.viewportProjectedCleanPlateAssetId
  );
}

export function shotNeedsStillReconciliation(
  project: LocationProject,
  shot: Shot,
): boolean {
  const specs = buildStillArtifactSpecificationsForShot({ project, shot, purpose: 'reconcile' });
  for (const spec of specs) {
    const key = stillArtifactKey(spec);
    const existing = shot.materializedMedia?.stills[key];
    if (!existing) return true;
    const fp = computeStillArtifactFingerprint(project, shot, spec).key;
    if (existing.fingerprint !== fp) return true;
  }
  const desired = new Set(specs.map((spec) => stillArtifactKey(spec)));
  for (const key of Object.keys(shot.materializedMedia?.stills ?? {})) {
    if (!desired.has(key)) return true;
  }
  return false;
}

export function isMetadataOnlyShotPatch(patch: Partial<Shot>): boolean {
  const keys = Object.keys(patch);
  if (keys.length === 0) return true;
  const metadataOnly = new Set([
    'name', 'description', 'shotNumber', 'productionShotId', 'promptOverrides',
    'status', 'createdAt', 'updatedAt', 'metadata',
  ]);
  return keys.every((key) => metadataOnly.has(key));
}

function videoPerformanceChanged(previous: LocationProject, next: LocationProject): boolean {
  const before = resolveProjectVideoPerformance(previous.exportConfiguration);
  const after = resolveProjectVideoPerformance(next.exportConfiguration);
  return before.profileId !== after.profileId
    || before.resolutionPreset !== after.resolutionPreset
    || before.frameRate !== after.frameRate
    || before.encoderMode !== after.encoderMode;
}

/** Export settings/overrides are plain persisted data; compare values, not rebuilt object identity. */
function persistedSettingsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function findShotsAffectedByProjectChange(
  previous: LocationProject | undefined,
  next: LocationProject,
  hintShotIds?: readonly string[],
): string[] {
  if (hintShotIds && hintShotIds.length > 0) {
    return [...new Set(hintShotIds)].filter((id) => next.shots.some((shot) => shot.id === id));
  }
  if (!previous) return next.shots.map((shot) => shot.id);

  const affected = new Set<string>();
  const sceneChanged =
    previous.scene !== next.scene
    || previous.scene.objects !== next.scene.objects
    || previous.scene.panoOrigin !== next.scene.panoOrigin
    || previous.scene.panoRotation !== next.scene.panoRotation;
  const panoChanged = previous.panoRefs !== next.panoRefs;
  const assetsChanged = previous.assets !== next.assets;
  const videoChanged = videoPerformanceChanged(previous, next);

  if (sceneChanged || panoChanged || assetsChanged || videoChanged) {
    for (const shot of next.shots) affected.add(shot.id);
    return [...affected];
  }

  // Package-format changes can reconstruct equivalent resolved export objects.
  // Compare their persisted values so packaging-only changes remain a true no-op.
  const prevById = new Map(previous.shots.map((shot) => [shot.id, shot]));
  for (const shot of next.shots) {
    const prev = prevById.get(shot.id);
    if (!prev) {
      affected.add(shot.id);
      continue;
    }
    if (prev === shot) continue;
    if (
      prev.camera !== shot.camera
      || prev.cameraKeyframes !== shot.cameraKeyframes
      || prev.objectOverrides !== shot.objectOverrides
      || prev.linkedPanoId !== shot.linkedPanoId
      || !persistedSettingsEqual(prev.exportSettings, shot.exportSettings)
      || !persistedSettingsEqual(prev.exportOverrides, shot.exportOverrides)
    ) {
      affected.add(shot.id);
    }
  }
  return [...affected];
}

async function queueBackgroundVideoAfterEdit(shotId: string): Promise<void> {
  try {
    const {
      getBackgroundVideoScheduler,
      queueBackgroundVideosForShot,
    } = await import('./backgroundVideoService');
    if (!getBackgroundVideoScheduler()) return;
    await queueBackgroundVideosForShot(shotId);
  } catch {
    // Background video preparation is best-effort and must not fail authoring.
  }
}

export function createStillReconciliationScheduler(options: ReconciliationSchedulerOptions) {
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
      state.controller?.abort();
      state.controller = undefined;
      state.generation += 1;
      const generation = state.generation;

      state.timer = setTimeout(() => {
        state!.timer = undefined;
        const project = options.getProject();
        const shot = project.shots.find((item) => item.id === shotId);
        if (!shot || !shotHasPreparedMediaLifecycle(shot)) return;

        if (!shotNeedsStillReconciliation(project, shot)) {
          void queueBackgroundVideoAfterEdit(shotId);
          return;
        }

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
            options.setProject(result.project);
            options.onComplete?.(shotId, result);
            if (result.status !== 'failed') void queueBackgroundVideoAfterEdit(shotId);
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
    const affected = findShotsAffectedByProjectChange(previous, next, hintShotIds)
      .filter((shotId) => {
        const shot = next.shots.find((item) => item.id === shotId);
        return Boolean(shot && shotHasPreparedMediaLifecycle(shot));
      });
    if (affected.length === 0) return;

    void import('./backgroundVideoService').then(({ discardBackgroundVideosForShot }) => {
      for (const id of affected) discardBackgroundVideosForShot(id);
    }).catch(() => undefined);

    schedule(affected);
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

  return { schedule, scheduleAfterCommit, cancelShot, dispose, inspectForTests };
}

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