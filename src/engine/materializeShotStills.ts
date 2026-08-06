/**
 * Per-shot still materialization coordinator.
 */

import type { LocationProject, Shot } from '../domain/types';
import {
  commitPreparedStillArtifact,
  pruneObsoleteMaterializedStills,
} from './commitPreparedStillArtifact';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import {
  buildStillArtifactSpecificationsForShot,
  selectPrimaryStillSpecification,
  sortStillSpecificationsByPriority,
  type StillArtifactPurpose,
} from './stillArtifactPlanning';
import {
  prepareStillArtifact,
  type PreparedStillArtifact,
} from './prepareStillArtifact';
import { recordPreparedMediaMetric } from './preparedMediaMetrics';
import {
  renderWorkCoordinator,
  type RenderWorkPriority,
} from './renderWorkCoordinator';
import {
  setStillArtifactError,
  setStillArtifactJobStatus,
} from './stillArtifactRuntime';
import { stillArtifactKey, type StillArtifactSpecification } from './stillArtifactTypes';
import type { RenderedStillArtifact } from './stillArtifactRender';

export type MaterializeReason = 'capture' | 'edit' | 'manual' | 'export-recovery';
export type MaterializeScope = 'primary' | 'all-configured' | 'stale-only';

export type ShotCaptureMaterializationMode =
  | 'await-primary'
  | 'await-all'
  | 'deferred';

export interface ArtifactMaterializationStatus {
  key: string;
  status: 'current' | 'rendered' | 'failed' | 'skipped';
  assetId?: string;
  cacheStatus?: PreparedStillArtifact['cacheStatus'];
  error?: string;
}

export interface ShotStillMaterializationResult {
  project: LocationProject;
  shotId: string;
  primaryStillAssetId?: string;
  status: 'ready' | 'ready-with-warnings' | 'failed';
  artifacts: ArtifactMaterializationStatus[];
  warnings: string[];
}

export interface MaterializeShotStillsParams {
  project: LocationProject;
  shotId: string;
  reason: MaterializeReason;
  scope?: MaterializeScope;
  signal?: AbortSignal;
  /**
   * When provided, called after each successful commit so live store can update
   * incrementally. Must return the latest live project for the next artifact.
   */
  onProjectCommit?: (project: LocationProject) => LocationProject;
  render?: (params: {
    project: LocationProject;
    shot: Shot;
    specification: StillArtifactSpecification;
    signal?: AbortSignal;
  }) => Promise<RenderedStillArtifact>;
}

function purposeForReason(reason: MaterializeReason): StillArtifactPurpose {
  if (reason === 'export-recovery') return 'export';
  if (reason === 'capture') return 'capture';
  return 'reconcile';
}

function priorityFor(
  reason: MaterializeReason,
  isPrimary: boolean,
): RenderWorkPriority {
  if (reason === 'export-recovery') return 'export-recovery-still';
  if (reason === 'edit') {
    return isPrimary ? 'edit-primary-still' : 'edit-secondary-still';
  }
  return isPrimary ? 'capture-primary-still' : 'capture-secondary-still';
}

function resolveShot(project: LocationProject, shotId: string): Shot {
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error(`Shot ${shotId} not found.`);
  return shot;
}

/**
 * Materialize desired stills for one shot in priority order.
 */
export async function materializeShotStills(
  params: MaterializeShotStillsParams,
): Promise<ShotStillMaterializationResult> {
  const { shotId, reason, signal } = params;
  let project = params.project;
  const scope = params.scope ?? 'all-configured';

  if (reason === 'capture') {
    recordPreparedMediaMetric('captureStillRequests');
  }

  const shot0 = resolveShot(project, shotId);
  const purpose = purposeForReason(reason);
  let specs = buildStillArtifactSpecificationsForShot({
    project,
    shot: shot0,
    purpose,
  });
  const primary = selectPrimaryStillSpecification(project, shot0, specs);
  const primaryKey = stillArtifactKey(primary);

  if (scope === 'primary') {
    specs = [primary];
  } else if (scope === 'stale-only') {
    specs = specs.filter((spec) => {
      const key = stillArtifactKey(spec);
      const existing = shot0.materializedMedia?.stills[key];
      if (!existing) return true;
      const fp = computeStillArtifactFingerprint(project, shot0, spec).key;
      return existing.fingerprint !== fp;
    });
  }

  specs = sortStillSpecificationsByPriority(specs, primaryKey);

  // Prune obsolete configured artifacts (safe; GC retains referenced assets).
  if (scope === 'all-configured' || scope === 'stale-only') {
    const allDesired = buildStillArtifactSpecificationsForShot({
      project,
      shot: shot0,
      purpose,
    });
    const desiredKeys = new Set(allDesired.map((spec) => stillArtifactKey(spec)));
    project = pruneObsoleteMaterializedStills(project, shotId, desiredKeys);
    if (params.onProjectCommit) {
      project = params.onProjectCommit(project);
    }
  }

  const artifacts: ArtifactMaterializationStatus[] = [];
  const warnings: string[] = [];
  let primaryStillAssetId: string | undefined;
  let primaryFailed = false;

  for (const spec of specs) {
    if (signal?.aborted) {
      const error = new Error('Still materialization was cancelled.');
      error.name = 'AbortError';
      throw error;
    }

    const key = stillArtifactKey(spec);
    const isPrimary = key === primaryKey;
    const liveShot = resolveShot(project, shotId);
    const expectedFingerprint = computeStillArtifactFingerprint(project, liveShot, spec).key;
    const existing = liveShot.materializedMedia?.stills[key];

    if (existing && existing.fingerprint === expectedFingerprint) {
      const asset = project.assets.assets[existing.assetId];
      if (asset) {
        artifacts.push({
          key,
          status: 'current',
          assetId: existing.assetId,
          cacheStatus: 'current',
        });
        if (isPrimary) primaryStillAssetId = existing.assetId;
        recordPreparedMediaMetric('stillReuseCount');
        continue;
      }
    }

    setStillArtifactJobStatus(shotId, key, 'rendering');
    setStillArtifactError(shotId, key, null);

    try {
      const prepared = await renderWorkCoordinator.schedule(
        priorityFor(reason, isPrimary),
        () => prepareStillArtifact({
          projectSnapshot: project,
          shotId,
          specification: spec,
          signal,
          render: params.render,
        }),
      );

      if (prepared.cacheStatus === 'current' && prepared.existingAssetId) {
        artifacts.push({
          key,
          status: 'current',
          assetId: prepared.existingAssetId,
          cacheStatus: 'current',
        });
        if (isPrimary) primaryStillAssetId = prepared.existingAssetId;
        setStillArtifactJobStatus(shotId, key, null);
        continue;
      }

      // Re-read live project before commit if a commit hook is provided.
      if (params.onProjectCommit) {
        // Caller may have updated project externally; use our last known until commit.
      }

      const commit = commitPreparedStillArtifact({
        project,
        shotId,
        specification: spec,
        expectedFingerprint,
        prepared,
      });

      if (!commit.ok) {
        if (commit.reason === 'stale') {
          recordPreparedMediaMetric('staleResultsDiscarded');
          warnings.push(`Discarded stale still ${key} after concurrent edit.`);
          artifacts.push({ key, status: 'failed', error: 'Stale result discarded.' });
          if (isPrimary) {
            // Keep previous primary if any.
            const prev = resolveShot(commit.project, shotId).materializedMedia?.stills[key];
            if (prev) primaryStillAssetId = prev.assetId;
            else primaryFailed = true;
          }
          setStillArtifactJobStatus(shotId, key, null);
          setStillArtifactError(shotId, key, 'Stale result discarded.');
          continue;
        }
        throw new Error(`Commit failed for still ${key}: ${commit.reason}`);
      }

      project = commit.project;
      if (params.onProjectCommit) {
        project = params.onProjectCommit(project);
      }

      if (reason === 'capture') recordPreparedMediaMetric('captureStillRenders');
      if (reason === 'edit') recordPreparedMediaMetric('editStillRenders');

      artifacts.push({
        key,
        status: 'rendered',
        assetId: commit.assetId,
        cacheStatus: prepared.cacheStatus,
      });
      if (isPrimary) primaryStillAssetId = commit.assetId;
      setStillArtifactJobStatus(shotId, key, null);
      setStillArtifactError(shotId, key, null);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        setStillArtifactJobStatus(shotId, key, null);
        throw error;
      }
      recordPreparedMediaMetric('materializationFailures');
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to materialize ${key}: ${message}`);
      artifacts.push({ key, status: 'failed', error: message });
      setStillArtifactJobStatus(shotId, key, null);
      setStillArtifactError(shotId, key, message);

      // Preserve previous artifact on failure — do not clear materializedMedia.
      const prev = resolveShot(project, shotId).materializedMedia?.stills[key];
      if (isPrimary) {
        // Surface primary failure even when a previous preview remains visible.
        primaryFailed = true;
        if (prev) primaryStillAssetId = prev.assetId;
      }
      // Continue secondary artifacts.
    }
  }

  let status: ShotStillMaterializationResult['status'] = 'ready';
  if (primaryFailed || (scope === 'primary' && !primaryStillAssetId)) {
    status = 'failed';
  } else if (artifacts.some((item) => item.status === 'failed')) {
    status = 'ready-with-warnings';
  }

  return {
    project,
    shotId,
    primaryStillAssetId,
    status,
    artifacts,
    warnings,
  };
}

/**
 * Capture-time entry: materialize according to mode defaults.
 */
export async function materializeShotAfterCapture(params: {
  project: LocationProject;
  shotId: string;
  mode: ShotCaptureMaterializationMode;
  signal?: AbortSignal;
  onProjectCommit?: (project: LocationProject) => LocationProject;
  render?: MaterializeShotStillsParams['render'];
}): Promise<ShotStillMaterializationResult> {
  if (params.mode === 'deferred') {
    return {
      project: params.project,
      shotId: params.shotId,
      status: 'ready',
      artifacts: [],
      warnings: ['Materialization deferred.'],
    };
  }

  if (params.mode === 'await-primary') {
    const primaryResult = await materializeShotStills({
      project: params.project,
      shotId: params.shotId,
      reason: 'capture',
      scope: 'primary',
      signal: params.signal,
      onProjectCommit: params.onProjectCommit,
      render: params.render,
    });

    // Fire remaining configured stills without blocking the caller if they only
    // awaited primary — but for await-primary we still schedule the rest.
    if (primaryResult.status !== 'failed') {
      void materializeShotStills({
        project: primaryResult.project,
        shotId: params.shotId,
        reason: 'capture',
        scope: 'stale-only',
        signal: params.signal,
        onProjectCommit: params.onProjectCommit,
        render: params.render,
      }).catch(() => undefined);
    }

    return primaryResult;
  }

  // await-all
  return materializeShotStills({
    project: params.project,
    shotId: params.shotId,
    reason: 'capture',
    scope: 'all-configured',
    signal: params.signal,
    onProjectCommit: params.onProjectCommit,
    render: params.render,
  });
}
