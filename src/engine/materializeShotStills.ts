/**
 * Per-shot still materialization coordinator.
 *
 * Renders may use a frozen snapshot, but every commit re-reads the live project
 * and applies only the artifact record + asset — never a full stale project.
 */

import type { LocationProject, Shot } from '../domain/types';
import {
  commitPreparedStillArtifact,
  pruneObsoleteMaterializedStills,
} from './commitPreparedStillArtifact';
import {
  createProjectAssetStorageKey,
  deleteProjectAssetBlob,
} from './projectAssetStore';
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
  /**
   * Initial snapshot used to plan specs / start rendering.
   * Prefer pairing with getLiveProject so commits never overwrite newer live state.
   */
  project: LocationProject;
  shotId: string;
  reason: MaterializeReason;
  scope?: MaterializeScope;
  signal?: AbortSignal;
  /**
   * Read the current live project immediately before fingerprint validation / commit.
   * Required for interactive and agent paths that share a Zustand store.
   */
  getLiveProject?: () => LocationProject;
  /**
   * Apply a pure update against the live project and return the new live project.
   * The updater receives the latest live project and must only merge artifact-specific fields.
   */
  commitLiveProject?: (
    updater: (live: LocationProject) => LocationProject,
  ) => LocationProject;
  /**
   * @deprecated Prefer getLiveProject + commitLiveProject.
   * If provided alone, called after each successful commit with the commit result project.
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

/** Map prepared viewport stills into legacy camera-roll slots without re-rendering. */
function legacyViewportSlotPatch(
  specification: StillArtifactSpecification,
  assetId: string,
): Partial<Shot['assets']> {
  if (specification.kind === 'clay-viewport') {
    if (specification.peopleVariant === 'clean_plate') {
      return { viewportCleanPlateAssetId: assetId };
    }
    return { viewportRenderAssetId: assetId };
  }
  if (specification.kind === 'projected-viewport') {
    if (specification.peopleVariant === 'clean_plate') {
      return { viewportProjectedCleanPlateAssetId: assetId };
    }
    return { viewportProjectedAssetId: assetId };
  }
  return {};
}

function readLive(
  params: MaterializeShotStillsParams,
  fallback: LocationProject,
): LocationProject {
  return params.getLiveProject?.() ?? fallback;
}

/**
 * Materialize desired stills for one shot in priority order.
 */
export async function materializeShotStills(
  params: MaterializeShotStillsParams,
): Promise<ShotStillMaterializationResult> {
  const { shotId, reason, signal } = params;
  let project = readLive(params, params.project);
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

  // Prune obsolete configured artifacts against live project.
  if (scope === 'all-configured' || scope === 'stale-only') {
    const live = readLive(params, project);
    const liveShot = resolveShot(live, shotId);
    const allDesired = buildStillArtifactSpecificationsForShot({
      project: live,
      shot: liveShot,
      purpose,
    });
    const desiredKeys = new Set(allDesired.map((spec) => stillArtifactKey(spec)));
    if (params.commitLiveProject) {
      project = params.commitLiveProject((current) =>
        pruneObsoleteMaterializedStills(current, shotId, desiredKeys)
      );
    } else {
      project = pruneObsoleteMaterializedStills(live, shotId, desiredKeys);
      if (params.onProjectCommit) {
        project = params.onProjectCommit(project);
      }
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

    // Always re-read live before deciding whether to render.
    project = readLive(params, project);
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

    // Freeze a render snapshot; concurrent edits after this are caught at commit.
    const renderSnapshot = project;

    try {
      const prepared = await renderWorkCoordinator.schedule(
        priorityFor(reason, isPrimary),
        () => prepareStillArtifact({
          projectSnapshot: renderSnapshot,
          shotId,
          specification: spec,
          signal,
          render: params.render,
        }),
        { ownerId: shotId, jobId: `${shotId}:${key}` },
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

      // Transactional commit against the LIVE project — never the render snapshot.
      const liveNow = readLive(params, project);
      let commitResult = await commitPreparedStillArtifact({
        project: liveNow,
        shotId,
        specification: spec,
        expectedFingerprint: prepared.fingerprint.key,
        prepared,
      });

      if (commitResult.ok) {
        if (params.commitLiveProject) {
          // Merge only the prepared still/asset into whatever is live *now*
          // (may have advanced further during the durable write).
          let discardedAsStale = false;
          const artifact = commitResult.artifact;
          const assetId = commitResult.assetId;
          const asset = commitResult.project.assets.assets[assetId];
          project = params.commitLiveProject((live) => {
            const liveShotNow = live.shots.find((item) => item.id === shotId);
            if (!liveShotNow || !asset) {
              discardedAsStale = true;
              return live;
            }
            const liveFp = computeStillArtifactFingerprint(live, liveShotNow, spec).key;
            if (liveFp !== prepared.fingerprint.key) {
              discardedAsStale = true;
              return live;
            }
            const legacySlot = legacyViewportSlotPatch(spec, assetId);
            return {
              ...live,
              assets: {
                ...live.assets,
                assets: {
                  ...live.assets.assets,
                  [assetId]: asset,
                },
              },
              shots: live.shots.map((item) => {
                if (item.id !== shotId) return item;
                return {
                  ...item,
                  materializedMedia: {
                    stills: {
                      ...(item.materializedMedia?.stills ?? {}),
                      [key]: artifact,
                    },
                  },
                  assets: {
                    ...item.assets,
                    ...legacySlot,
                  },
                  updatedAt: new Date().toISOString(),
                };
              }),
              updatedAt: new Date().toISOString(),
            };
          });
          if (discardedAsStale) {
            if (asset) {
              const storageKey = asset.storageKey
                ?? createProjectAssetStorageKey(commitResult.project.id, assetId);
              await deleteProjectAssetBlob(storageKey).catch(() => undefined);
            }
            commitResult = { ok: false, reason: 'stale', project };
          } else {
            project = readLive(params, project);
            commitResult = { ...commitResult, project };
          }
        } else {
          project = commitResult.project;
          if (params.onProjectCommit) {
            project = params.onProjectCommit(project);
          }
        }
      } else {
        project = liveNow;
      }

      if (!commitResult.ok) {
        if (commitResult.reason === 'stale') {
          recordPreparedMediaMetric('staleResultsDiscarded');
          warnings.push(`Discarded stale still ${key} after concurrent edit.`);
          artifacts.push({ key, status: 'failed', error: 'Stale result discarded.' });
          if (isPrimary) {
            const prev = resolveShot(project, shotId).materializedMedia?.stills[key];
            if (prev) primaryStillAssetId = prev.assetId;
            else primaryFailed = true;
          }
          setStillArtifactJobStatus(shotId, key, null);
          setStillArtifactError(shotId, key, 'Stale result discarded.');
          continue;
        }
        if (commitResult.reason === 'persistence-failed') {
          recordPreparedMediaMetric('materializationFailures');
          const message = commitResult.error ?? 'Asset persistence failed.';
          warnings.push(`Failed to persist ${key}: ${message}`);
          artifacts.push({ key, status: 'failed', error: message });
          if (isPrimary) {
            primaryFailed = true;
            const prev = resolveShot(project, shotId).materializedMedia?.stills[key];
            if (prev) primaryStillAssetId = prev.assetId;
          }
          setStillArtifactJobStatus(shotId, key, null);
          setStillArtifactError(shotId, key, message);
          continue;
        }
        throw new Error(`Commit failed for still ${key}: ${commitResult.reason}`);
      }

      if (reason === 'capture') recordPreparedMediaMetric('captureStillRenders');
      if (reason === 'edit') recordPreparedMediaMetric('editStillRenders');

      artifacts.push({
        key,
        status: 'rendered',
        assetId: commitResult.assetId,
        cacheStatus: prepared.cacheStatus,
      });
      if (isPrimary) primaryStillAssetId = commitResult.assetId;
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

      project = readLive(params, project);
      const prev = resolveShot(project, shotId).materializedMedia?.stills[key];
      if (isPrimary) {
        primaryFailed = true;
        if (prev) primaryStillAssetId = prev.assetId;
      }
    }
  }

  project = readLive(params, project);

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
  getLiveProject?: () => LocationProject;
  commitLiveProject?: MaterializeShotStillsParams['commitLiveProject'];
  onProjectCommit?: (project: LocationProject) => LocationProject;
  render?: MaterializeShotStillsParams['render'];
}): Promise<ShotStillMaterializationResult> {
  if (params.mode === 'deferred') {
    return {
      project: params.getLiveProject?.() ?? params.project,
      shotId: params.shotId,
      status: 'ready',
      artifacts: [],
      warnings: ['Materialization deferred.'],
    };
  }

  const shared = {
    project: params.project,
    shotId: params.shotId,
    reason: 'capture' as const,
    signal: params.signal,
    getLiveProject: params.getLiveProject,
    commitLiveProject: params.commitLiveProject,
    onProjectCommit: params.onProjectCommit,
    render: params.render,
  };

  if (params.mode === 'await-primary') {
    const primaryResult = await materializeShotStills({
      ...shared,
      scope: 'primary',
    });

    if (primaryResult.status !== 'failed') {
      void materializeShotStills({
        ...shared,
        project: primaryResult.project,
        scope: 'stale-only',
      }).catch(() => undefined);
    }

    return primaryResult;
  }

  return materializeShotStills({
    ...shared,
    scope: 'all-configured',
  });
}
