/**
 * Per-shot still materialization coordinator.
 *
 * Renders may use a frozen snapshot, but every commit re-reads the live project
 * and applies only the artifact record + asset — never a full stale project.
 */

import type { LocationProject, ProjectAsset, Shot } from '../domain/types';
import {
  commitPreparedStillArtifact,
  commitPreparedStillArtifacts,
  type PreparedStillBatchEntry,
  pruneObsoleteMaterializedStills,
} from './commitPreparedStillArtifact';
import {
  PROJECT_ASSET_URI_PREFIX,
  createProjectAssetStorageKey,
  deleteProjectAssetBlob,
  getManagedProjectAssetBlobKeyForUri,
  getProjectAssetBlob,
} from './projectAssetStore';
import { pruneUnreferencedProjectAssets } from './projectAssets';
import { resolveShotDepthRangeForExport, type DepthRangeMeters } from './depthRender';
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
  force?: boolean;
  artifactKeys?: ReadonlySet<string>;
  /** Optional sampled time for agent/capture materialization. */
  timeSeconds?: number;
  /** Stage all rendered misses and persist the shot in one asset transaction. */
  batchCommit?: boolean;
  getLiveProject?: () => LocationProject;
  commitLiveProject?: (
    updater: (live: LocationProject) => LocationProject,
  ) => LocationProject;
  onProjectCommit?: (project: LocationProject) => LocationProject;
  render?: (params: {
    project: LocationProject;
    shot: Shot;
    specification: StillArtifactSpecification;
    signal?: AbortSignal;
    depthRange?: DepthRangeMeters;
  }) => Promise<RenderedStillArtifact>;
}

function purposeForReason(reason: MaterializeReason): StillArtifactPurpose {
  if (reason === 'export-recovery') return 'export';
  if (reason === 'capture') return 'capture';
  return 'reconcile';
}

function priorityFor(reason: MaterializeReason, isPrimary: boolean): RenderWorkPriority {
  if (reason === 'export-recovery') return 'export-recovery-still';
  if (reason === 'edit') return isPrimary ? 'edit-primary-still' : 'edit-secondary-still';
  return isPrimary ? 'capture-primary-still' : 'capture-secondary-still';
}

function resolveShot(project: LocationProject, shotId: string): Shot {
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error(`Shot ${shotId} not found.`);
  return shot;
}

function legacyViewportSlotPatch(
  specification: StillArtifactSpecification,
  assetId: string,
): Partial<Shot['assets']> {
  if (specification.kind === 'clay-viewport') {
    if (specification.peopleVariant === 'clean_plate') return { viewportCleanPlateAssetId: assetId };
    return { viewportRenderAssetId: assetId };
  }
  if (specification.kind === 'projected-viewport') {
    if (specification.peopleVariant === 'clean_plate') return { viewportProjectedCleanPlateAssetId: assetId };
    return { viewportProjectedAssetId: assetId };
  }
  return {};
}

function readLive(params: MaterializeShotStillsParams, fallback: LocationProject): LocationProject {
  return params.getLiveProject?.() ?? fallback;
}

function storageKeyForAsset(projectId: string, asset: ProjectAsset): string | undefined {
  if (asset.storageKey) return asset.storageKey;
  if (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)) {
    return asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length);
  }
  return getManagedProjectAssetBlobKeyForUri(asset.uri)
    ?? (asset.metadata?.provenance === 'forescene-derived-still'
      ? createProjectAssetStorageKey(projectId, asset.id)
      : undefined);
}

async function hasUsableAssetBytes(project: LocationProject, asset: ProjectAsset): Promise<boolean> {
  if (asset.uri.startsWith('data:')) return true;
  const storageKey = storageKeyForAsset(project.id, asset);
  if (!storageKey) return Boolean(asset.uri);
  return Boolean(await getProjectAssetBlob(storageKey));
}

export async function materializeShotStills(
  params: MaterializeShotStillsParams,
): Promise<ShotStillMaterializationResult> {
  const { shotId, reason, signal } = params;
  let project = readLive(params, params.project);
  const scope = params.scope ?? 'all-configured';

  if (reason === 'capture') recordPreparedMediaMetric('captureStillRequests');

  const shot0 = resolveShot(project, shotId);
  const purpose = purposeForReason(reason);
  let specs = buildStillArtifactSpecificationsForShot({ project, shot: shot0, purpose });
  if (params.timeSeconds !== undefined) {
    specs = specs.map((spec) => spec.timeSeconds === undefined
      ? { ...spec, timeSeconds: params.timeSeconds }
      : spec);
  }
  const primary = selectPrimaryStillSpecification(project, shot0, specs);
  const primaryKey = stillArtifactKey(primary);

  if (scope === 'primary') {
    specs = [primary];
  } else if (params.artifactKeys) {
    specs = specs.filter((spec) => params.artifactKeys!.has(stillArtifactKey(spec)));
  }
  // stale-only intentionally flows all configured specs through the byte-aware
  // current fast path so a fingerprint-current artifact with missing bytes heals.

  specs = sortStillSpecificationsByPriority(specs, primaryKey);

  // Share depth analysis across every depth artifact in this shot batch. This
  // is the first layer of the shot-scoped render session: standalone callers
  // still resolve their own range, while batched capture pays the analysis cost
  // once and reuses it for all depth passes. Resolve lazily so warm artifacts
  // still take the zero-render fast path.
  let sharedDepthRange: DepthRangeMeters | undefined;
  let depthRangeResolved = false;

  if (scope === 'all-configured' || scope === 'stale-only') {
    const live = readLive(params, project);
    const liveShot = resolveShot(live, shotId);
    const allDesired = buildStillArtifactSpecificationsForShot({ project: live, shot: liveShot, purpose });
    const desiredKeys = new Set(allDesired.map((spec) => stillArtifactKey(spec)));
    if (params.commitLiveProject) {
      project = params.commitLiveProject((current) => pruneObsoleteMaterializedStills(current, shotId, desiredKeys));
    } else {
      project = pruneObsoleteMaterializedStills(live, shotId, desiredKeys);
      if (params.onProjectCommit) project = params.onProjectCommit(project);
    }
  }

  const artifacts: ArtifactMaterializationStatus[] = [];
  const warnings: string[] = [];
  let primaryStillAssetId: string | undefined;
  let primaryFailed = false;
  const pendingBatchCommits: Array<PreparedStillBatchEntry & { key: string; isPrimary: boolean }> = [];

  for (const spec of specs) {
    if (signal?.aborted) {
      const error = new Error('Still materialization was cancelled.');
      error.name = 'AbortError';
      throw error;
    }

    const key = stillArtifactKey(spec);
    const isPrimary = key === primaryKey;
    project = readLive(params, project);
    const liveShot = resolveShot(project, shotId);
    const expectedFingerprint = computeStillArtifactFingerprint(project, liveShot, spec).key;
    const existing = liveShot.materializedMedia?.stills[key];

    if (!params.force && existing && existing.fingerprint === expectedFingerprint) {
      const asset = project.assets.assets[existing.assetId];
      if (asset && await hasUsableAssetBytes(project, asset)) {
        artifacts.push({ key, status: 'current', assetId: existing.assetId, cacheStatus: 'current' });
        if (isPrimary) primaryStillAssetId = existing.assetId;
        recordPreparedMediaMetric('stillReuseCount');
        continue;
      }
    }

    setStillArtifactJobStatus(shotId, key, 'rendering');
    setStillArtifactError(shotId, key, null);
    const renderSnapshot = project;

    try {
      if (spec.appearance === 'depth' && !depthRangeResolved) {
        sharedDepthRange = await resolveShotDepthRangeForExport(renderSnapshot, liveShot);
        depthRangeResolved = true;
      }
      const prepared = await renderWorkCoordinator.schedule(
        priorityFor(reason, isPrimary),
        () => prepareStillArtifact({
          projectSnapshot: renderSnapshot,
          shotId,
          specification: spec,
          signal,
          depthRange: sharedDepthRange,
          force: params.force,
          render: params.render,
        }),
        { ownerId: shotId, jobId: `${shotId}:${key}`, signal },
      );

      if (prepared.cacheStatus === 'current' && prepared.existingAssetId) {
        artifacts.push({ key, status: 'current', assetId: prepared.existingAssetId, cacheStatus: 'current' });
        if (isPrimary) primaryStillAssetId = prepared.existingAssetId;
        setStillArtifactJobStatus(shotId, key, null);
        continue;
      }

      if (params.batchCommit) {
        pendingBatchCommits.push({
          key,
          isPrimary,
          specification: spec,
          expectedFingerprint: prepared.fingerprint.key,
          prepared,
        });
        continue;
      }

      const liveNow = readLive(params, project);
      let commitResult = await commitPreparedStillArtifact({
        project: liveNow,
        shotId,
        specification: spec,
        expectedFingerprint: prepared.fingerprint.key,
        prepared,
      });

      if (commitResult.ok) {
        const supersededAssetId = commitResult.supersededAssetId;
        const supersededAsset = supersededAssetId
          ? liveNow.assets.assets[supersededAssetId]
          : undefined;
        const supersededStorageKey = supersededAssetId
          ? (supersededAsset
            ? storageKeyForAsset(liveNow.id, supersededAsset)
            : undefined) ?? createProjectAssetStorageKey(liveNow.id, supersededAssetId)
          : undefined;

        if (params.commitLiveProject) {
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
            const merged: LocationProject = {
              ...live,
              assets: {
                ...live.assets,
                assets: { ...live.assets.assets, [assetId]: asset },
              },
              shots: live.shots.map((item) => {
                if (item.id !== shotId) return item;
                return {
                  ...item,
                  materializedMedia: {
                    stills: { ...(item.materializedMedia?.stills ?? {}), [key]: artifact },
                  },
                  assets: { ...item.assets, ...legacySlot },
                  updatedAt: new Date().toISOString(),
                };
              }),
              updatedAt: new Date().toISOString(),
            };
            return supersededAssetId ? pruneUnreferencedProjectAssets(merged) : merged;
          });
          if (discardedAsStale) {
            if (asset) {
              const storageKey = asset.storageKey ?? createProjectAssetStorageKey(commitResult.project.id, assetId);
              await deleteProjectAssetBlob(storageKey).catch(() => undefined);
            }
            commitResult = { ok: false, reason: 'stale', project };
          } else {
            project = readLive(params, project);
            if (supersededAssetId && supersededStorageKey && !project.assets.assets[supersededAssetId]) {
              await deleteProjectAssetBlob(supersededStorageKey).catch(() => undefined);
            }
            commitResult = { ...commitResult, project };
          }
        } else {
          project = commitResult.project;
          if (params.onProjectCommit) project = params.onProjectCommit(project);
          if (supersededAssetId && supersededStorageKey && !project.assets.assets[supersededAssetId]) {
            await deleteProjectAssetBlob(supersededStorageKey).catch(() => undefined);
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

  if (pendingBatchCommits.length > 0) {
    try {
      const batch = await commitPreparedStillArtifacts({
        project: readLive(params, project),
        shotId,
        entries: pendingBatchCommits,
      });
      const committedByKey = new Map(batch.ok ? batch.commits.map((commit) => [commit.key, commit]) : []);
      const discardedKeys = new Set<string>();
      const oldStorageKeys = new Map<string, string | undefined>();

      if (batch.ok && params.commitLiveProject) {
        project = params.commitLiveProject((live) => {
          let merged = live;
          for (const pending of pendingBatchCommits) {
            const commit = committedByKey.get(pending.key);
            if (!commit) continue;
            const liveShotNow = merged.shots.find((item) => item.id === shotId);
            if (!liveShotNow || computeStillArtifactFingerprint(merged, liveShotNow, pending.specification).key !== pending.expectedFingerprint) {
              discardedKeys.add(pending.key);
              continue;
            }
            const previous = liveShotNow.materializedMedia?.stills[pending.key];
            if (previous && previous.assetId !== commit.assetId) {
              const oldAsset = merged.assets.assets[previous.assetId];
              oldStorageKeys.set(previous.assetId, oldAsset
                ? storageKeyForAsset(merged.id, oldAsset)
                : createProjectAssetStorageKey(merged.id, previous.assetId));
            }
            const legacySlot = legacyViewportSlotPatch(pending.specification, commit.assetId);
            merged = {
              ...merged,
              assets: {
                ...merged.assets,
                assets: { ...merged.assets.assets, [commit.assetId]: commit.asset },
              },
              shots: merged.shots.map((item) => item.id === shotId
                ? {
                  ...item,
                  materializedMedia: {
                    stills: { ...(item.materializedMedia?.stills ?? {}), [pending.key]: commit.artifact },
                  },
                  assets: { ...item.assets, ...legacySlot },
                  updatedAt: new Date().toISOString(),
                }
                : item),
              updatedAt: new Date().toISOString(),
            };
          }
          return merged;
        });
      } else if (batch.ok) {
        project = batch.project;
        if (params.onProjectCommit) project = params.onProjectCommit(project);
      }

      project = readLive(params, project);
      const batchFailureReason = batch.ok ? undefined : batch.reason;
      for (const pending of pendingBatchCommits) {
        const commit = committedByKey.get(pending.key);
        if (!batch.ok || !commit || discardedKeys.has(pending.key)) {
          const message = !batch.ok && batch.reason === 'persistence-failed'
            ? batch.error ?? 'Asset persistence failed.'
            : discardedKeys.has(pending.key) || batchFailureReason === 'stale'
              ? 'Stale result discarded.'
              : 'Still batch commit failed.';
          warnings.push(`Failed to persist ${pending.key}: ${message}`);
          artifacts.push({ key: pending.key, status: 'failed', error: message });
          if (pending.isPrimary) primaryFailed = true;
          setStillArtifactJobStatus(shotId, pending.key, null);
          setStillArtifactError(shotId, pending.key, message);
          continue;
        }
        artifacts.push({
          key: pending.key,
          status: 'rendered',
          assetId: commit.assetId,
          cacheStatus: pending.prepared.cacheStatus,
        });
        if (pending.isPrimary) primaryStillAssetId = commit.assetId;
        setStillArtifactJobStatus(shotId, pending.key, null);
        setStillArtifactError(shotId, pending.key, null);
      }

      for (const [assetId, storageKey] of oldStorageKeys) {
        if (storageKey && !project.assets.assets[assetId]) {
          await deleteProjectAssetBlob(storageKey).catch(() => undefined);
        }
      }
      // A batch can finish its durable write just before a concurrent live
      // edit makes one of its entries stale. Those newly written assets were
      // never part of the live manifest, so remove their bytes after the live
      // merge unless another writer adopted the asset in the meantime.
      if (batch.ok) {
        for (const pending of pendingBatchCommits) {
          if (!discardedKeys.has(pending.key)) continue;
          const commit = committedByKey.get(pending.key);
          if (!commit || project.assets.assets[commit.assetId]) continue;
          const storageKey = storageKeyForAsset(project.id, commit.asset)
            ?? createProjectAssetStorageKey(project.id, commit.assetId);
          await deleteProjectAssetBlob(storageKey).catch(() => undefined);
        }
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      const message = error instanceof Error ? error.message : String(error);
      for (const pending of pendingBatchCommits) {
        warnings.push(`Failed to persist ${pending.key}: ${message}`);
        artifacts.push({ key: pending.key, status: 'failed', error: message });
        if (pending.isPrimary) primaryFailed = true;
        setStillArtifactJobStatus(shotId, pending.key, null);
        setStillArtifactError(shotId, pending.key, message);
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

  return { project, shotId, primaryStillAssetId, status, artifacts, warnings };
}

/** Capture-time entry: materialize according to mode defaults. */
export async function materializeShotAfterCapture(params: {
  project: LocationProject;
  shotId: string;
  mode: ShotCaptureMaterializationMode;
  signal?: AbortSignal;
  timeSeconds?: number;
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
    timeSeconds: params.timeSeconds,
    batchCommit: params.mode === 'await-all',
    getLiveProject: params.getLiveProject,
    commitLiveProject: params.commitLiveProject,
    onProjectCommit: params.onProjectCommit,
    render: params.render,
  };

  if (params.mode === 'await-primary') {
    const primaryResult = await materializeShotStills({ ...shared, scope: 'primary' });

    if (primaryResult.status !== 'failed' && !params.signal?.aborted) {
      void materializeShotStills({
        ...shared,
        project: primaryResult.project,
        scope: 'stale-only',
      }).catch(() => undefined);
    }

    return primaryResult;
  }

  return materializeShotStills({ ...shared, scope: 'all-configured' });
}
