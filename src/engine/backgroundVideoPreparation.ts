/**
 * Canonical video candidates + background preparation via prepareVideoArtifact.
 */

import type { LocationProject, Shot } from '../domain/types';
import { hasRenderableCameraMove } from './cameraKeyframes';
import {
  characterPassIncludesGreenMp4,
  shotHasVisibleCharactersForPass,
} from './characterPassExport';
import {
  resolveShotDepthRangeForExport,
  shouldExportCameraMoveDepth,
} from './depthRender';
import { getPeopleRenderVariants } from './peopleExport';
import {
  prepareVideoArtifact,
  type PreparedVideoArtifact,
} from './prepareVideoArtifact';
import { canUseProjectedAppearance } from './projectedStyle';
import { recordPreparedMediaMetric } from './preparedMediaMetrics';
import { renderWorkCoordinator } from './renderWorkCoordinator';
import type { VideoArtifactSpecification } from './videoArtifactFingerprint';
import { computeVideoArtifactFingerprint } from './videoArtifactFingerprint';
import { getVideoArtifactFromCache } from './videoArtifactCache';
import { resolveProjectVideoPerformance } from './videoPerformance';
import { resolveVideoPreset } from './videoPresets';

export type BackgroundVideoRuntimeStatus =
  | 'not-requested'
  | 'pending'
  | 'queued'
  | 'encoding'
  | 'ready'
  | 'failed';

export interface ShotVideoCandidate {
  shotId: string;
  specification: VideoArtifactSpecification;
  label: string;
}

export function buildVideoArtifactSpecificationsForShot(
  project: LocationProject,
  shot: Shot,
): ShotVideoCandidate[] {
  const candidates: ShotVideoCandidate[] = [];
  if (!hasRenderableCameraMove(shot.cameraKeyframes)) return candidates;

  const peopleVariants = getPeopleRenderVariants(shot.exportSettings.peopleExportMode);
  const projectedAvailable = canUseProjectedAppearance(project);
  const perf = resolveProjectVideoPerformance(project.exportConfiguration);
  const preset = resolveVideoPreset(perf.resolutionPreset);
  const baseDims = {
    width: preset.width,
    height: preset.height,
    frameRate: perf.frameRate,
    resolutionPreset: perf.resolutionPreset,
    encoderMode: perf.encoderMode,
  };

  if (shot.exportSettings.includeCameraMoveVideo) {
    for (const peopleVariant of peopleVariants) {
      candidates.push({
        shotId: shot.id,
        label: `clay-camera-move:${peopleVariant}`,
        specification: { appearance: 'clay', peopleVariant, mode: 'render', ...baseDims },
      });
    }
  }

  if (shot.exportSettings.includeProjectedCameraMoveVideo && projectedAvailable) {
    for (const peopleVariant of peopleVariants) {
      candidates.push({
        shotId: shot.id,
        label: `projected-camera-move:${peopleVariant}`,
        specification: { appearance: 'projected', peopleVariant, mode: 'render', ...baseDims },
      });
    }
  }

  if (shouldExportCameraMoveDepth(shot.exportSettings.depth, true)) {
    for (const peopleVariant of peopleVariants) {
      candidates.push({
        shotId: shot.id,
        label: `depth-camera-move:${peopleVariant}`,
        specification: { appearance: 'depth', peopleVariant, mode: 'render', ...baseDims },
      });
    }
  }

  const characterPass = shot.exportSettings.characterPass;
  if (
    characterPass
    && characterPass.enabled
    && characterPass.includeMotion
    && characterPassIncludesGreenMp4(characterPass.motionFormat)
    && shotHasVisibleCharactersForPass(project, shot, characterPass)
  ) {
    const appearances: Array<'clay' | 'projected'> = ['clay'];
    if (projectedAvailable) appearances.push('projected');
    for (const appearance of appearances) {
      candidates.push({
        shotId: shot.id,
        label: `character-motion:${appearance}`,
        specification: {
          appearance,
          contentMode: 'characters_only',
          includeCharacterAttachments: characterPass.includeAttachedProps !== false,
          backgroundColor: characterPass.backgroundColor,
          mode: 'render',
          ...baseDims,
        },
      });
    }
  }

  return candidates;
}

export function sortVideoCandidates(
  candidates: readonly ShotVideoCandidate[],
  preferredShotId?: string,
): ShotVideoCandidate[] {
  const appearanceRank = (appearance: string | undefined) => {
    if (appearance === 'projected') return 0;
    if (appearance === 'clay') return 1;
    if (appearance === 'depth') return 2;
    return 3;
  };
  return [...candidates].sort((a, b) => {
    const aPreferred = a.shotId === preferredShotId ? 0 : 1;
    const bPreferred = b.shotId === preferredShotId ? 0 : 1;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    const aChar = a.specification.contentMode === 'characters_only' ? 1 : 0;
    const bChar = b.specification.contentMode === 'characters_only' ? 1 : 0;
    if (aChar !== bChar) return aChar - bChar;
    return appearanceRank(a.specification.appearance) - appearanceRank(b.specification.appearance);
  });
}

export interface BackgroundVideoSchedulerOptions {
  getProject: () => LocationProject;
  onPrepared?: (shotId: string, result: PreparedVideoArtifact) => void;
  onError?: (shotId: string, error: unknown) => void;
  onStatusChange?: (shotId: string, status: BackgroundVideoRuntimeStatus) => void;
}

interface QueuedVideo {
  candidate: ShotVideoCandidate;
  fingerprintKey: string;
  controller: AbortController;
}

export function createBackgroundVideoScheduler(options: BackgroundVideoSchedulerOptions) {
  const pending = new Map<string, QueuedVideo>();
  const runningJobs = new Map<string, QueuedVideo>();
  const failedKeysByShot = new Map<string, Set<string>>();
  let running = false;
  let disposed = false;
  let paused = false;

  const pendingForShot = (shotId: string) => [...pending.values()]
    .some((job) => job.candidate.shotId === shotId);
  const runningForShot = (shotId: string) => [...runningJobs.values()]
    .some((job) => job.candidate.shotId === shotId);
  const failedForShot = (shotId: string) => (failedKeysByShot.get(shotId)?.size ?? 0) > 0;

  const markFailure = (shotId: string, key: string) => {
    let keys = failedKeysByShot.get(shotId);
    if (!keys) {
      keys = new Set();
      failedKeysByShot.set(shotId, keys);
    }
    keys.add(key);
  };
  const clearFailure = (shotId: string, key: string) => {
    const keys = failedKeysByShot.get(shotId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) failedKeysByShot.delete(shotId);
  };

  function settleShotStatus(shotId: string): void {
    if (runningForShot(shotId)) options.onStatusChange?.(shotId, 'encoding');
    else if (pendingForShot(shotId)) options.onStatusChange?.(shotId, 'queued');
    else if (failedForShot(shotId)) options.onStatusChange?.(shotId, 'failed');
    else options.onStatusChange?.(shotId, 'ready');
  }

  async function processQueue(): Promise<void> {
    if (running || disposed || paused) return;
    running = true;
    try {
      while (pending.size > 0 && !disposed && !paused) {
        const [key, job] = pending.entries().next().value as [string, QueuedVideo];
        pending.delete(key);
        if (job.controller.signal.aborted) continue;
        runningJobs.set(key, job);
        options.onStatusChange?.(job.candidate.shotId, 'encoding');

        try {
          const project = options.getProject();
          let specification = job.candidate.specification;
          if (specification.appearance === 'depth' && !specification.depthRange) {
            const shot = project.shots.find((item) => item.id === job.candidate.shotId);
            if (shot) {
              const range = await resolveShotDepthRangeForExport(project, shot);
              specification = {
                ...specification,
                depthRange: range,
                depthInvert: shot.exportSettings.depth?.invert === true,
              };
            }
          }

          const result = await renderWorkCoordinator.schedule(
            'background-video',
            () => prepareVideoArtifact({
              project,
              shotId: job.candidate.shotId,
              specification,
              priority: 'background',
              signal: job.controller.signal,
            }),
            {
              ownerId: job.candidate.shotId,
              jobId: `video:${key}`,
              abort: () => job.controller.abort(),
              signal: job.controller.signal,
            },
          );

          clearFailure(job.candidate.shotId, key);
          if (result.cacheStatus === 'hit') recordPreparedMediaMetric('videoCacheHits');
          else if (result.cacheStatus === 'joined') recordPreparedMediaMetric('videoJobsJoined');
          else recordPreparedMediaMetric('videoBackgroundRenders');
          options.onPrepared?.(job.candidate.shotId, result);
        } catch (error) {
          // prepareVideoArtifact historically throws a plain Error on abort. The
          // signal is authoritative; cancellation is not a rendering failure.
          if (job.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
            continue;
          }
          markFailure(job.candidate.shotId, key);
          options.onError?.(job.candidate.shotId, error);
        } finally {
          runningJobs.delete(key);
          if (!job.controller.signal.aborted) settleShotStatus(job.candidate.shotId);
        }
      }
    } finally {
      running = false;
      if (pending.size > 0 && !disposed && !paused) void processQueue();
    }
  }

  async function queueMissingForShot(shotId: string): Promise<void> {
    if (disposed) return;
    const project = options.getProject();
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return;

    const candidates = sortVideoCandidates(buildVideoArtifactSpecificationsForShot(project, shot), shotId);
    if (candidates.length === 0) {
      failedKeysByShot.delete(shotId);
      options.onStatusChange?.(shotId, 'not-requested');
      return;
    }

    const perf = resolveProjectVideoPerformance(project.exportConfiguration);
    const preset = resolveVideoPreset(perf.resolutionPreset);

    for (const candidate of candidates) {
      const resolved = {
        resolutionPreset: candidate.specification.resolutionPreset ?? perf.resolutionPreset,
        frameRate: candidate.specification.frameRate ?? perf.frameRate,
        width: candidate.specification.width ?? preset.width,
        height: candidate.specification.height ?? preset.height,
        encoderMode: candidate.specification.encoderMode ?? perf.encoderMode,
      };
      const fingerprint = computeVideoArtifactFingerprint(project, shot, candidate.specification, resolved);
      const cached = await getVideoArtifactFromCache(fingerprint);
      if (cached) {
        clearFailure(shotId, fingerprint.key);
        recordPreparedMediaMetric('videoCacheHits');
        continue;
      }

      const key = fingerprint.key;
      if (pending.has(key) || runningJobs.has(key)) continue;
      pending.set(key, { candidate, fingerprintKey: key, controller: new AbortController() });
    }

    settleShotStatus(shotId);
    if (!paused) void processQueue();
  }

  function discardForShot(shotId: string): void {
    let discarded = false;
    for (const [key, job] of pending) {
      if (job.candidate.shotId !== shotId) continue;
      job.controller.abort();
      pending.delete(key);
      discarded = true;
    }
    for (const job of runningJobs.values()) {
      if (job.candidate.shotId !== shotId) continue;
      job.controller.abort();
      discarded = true;
    }
    failedKeysByShot.delete(shotId);
    if (discarded) options.onStatusChange?.(shotId, 'pending');
  }

  function discardAll(): void {
    const affected = new Set<string>();
    for (const job of pending.values()) {
      affected.add(job.candidate.shotId);
      job.controller.abort();
    }
    for (const job of runningJobs.values()) {
      affected.add(job.candidate.shotId);
      job.controller.abort();
    }
    pending.clear();
    failedKeysByShot.clear();
    for (const shotId of affected) options.onStatusChange?.(shotId, 'pending');
  }

  function dispose(): void {
    disposed = true;
    paused = false;
    discardAll();
  }

  function setPaused(next: boolean): void {
    paused = next;
    if (!next) void processQueue();
  }

  function inspectForTests() {
    return {
      pending: pending.size,
      running: running || runningJobs.size > 0,
      paused,
      keys: [...pending.keys()],
      runningKeys: [...runningJobs.keys()],
      pendingShotIds: [...new Set([...pending.values()].map((job) => job.candidate.shotId))],
      runningShotIds: [...new Set([...runningJobs.values()].map((job) => job.candidate.shotId))],
      failedShotIds: [...failedKeysByShot.keys()],
    };
  }

  return {
    queueMissingForShot,
    discardForShot,
    discardAll,
    dispose,
    setPaused,
    inspectForTests,
  };
}
