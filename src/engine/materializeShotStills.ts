/**
 * Per-shot still materialization coordinator.
 *
 * Renders may use a frozen snapshot, but every commit re-reads the live project
 * and applies only the artifact record + asset — never a full stale project.
 */

import type { LocationProject, ProjectAsset, Shot } from '../domain/types';
import {
  commitPreparedStillArtifact,
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
  const primary = selectPrimaryStillSpecification(project, shot0, specs);
  const primaryKey = stillArtifactKey(primary);

  if (scope === 'primary') {
    specs = [primary];
  } else if (params.artifactKeys) {
    specs = specs.filter((spec) => params.artifactKeys!.has(stillArtifactKey(spec)));
  }
  // Do not pre-filter stale-only by fingerprint alone. A fingerprint-current
  // record with evicted/missing backing bytes must flow through the fast-path
  // byte check below and recover with one render.

  specs = sortStillSpecificationsByPriority(specs, primaryKey);

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
      const prepared = await renderWorkCoordinator.schedule(
        priorityFor(reason, isPrimary),
        () => prepareStillArtifact({
          projectSnapshot: renderSnapshot,
          shotId,
          specification: spec,
          signal,
          force: params.force,
          render: params.render,
        }),
        { ownerId: shotId, jobId: `${shotId}:${key}` },
      );

      if (prepared.cacheStatus === 'current' && prepared.existingAssetId) {
        artifacts.push({ key, status: 'current', assetId: prepared.existingAssetId, cacheStatus: 'current' });
        if (isPrimary) primaryStillAssetId = prepared.existingAssetId;
        setStillArtifactJobStatus(shotId, key, null);
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
        const supersededStorageKey = supersededAssetId
          ? storageKeyForAsset(liveNow.id, liveNow.assets.assets[supersededAssetId] ?? {
            id: supersededAssetId,
            type: 'image',
            name: supersededAssetId,
            uri: '',
            createdAt: '',
          }) ?? createProjectAssetStorageKey(liveNow.id, supersededAssetId)
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

  project = readLive(params, project);

  let status: ShotStillMaterializationResult['status'] = 'ready';
  if (primaryFailed || (scope === 'primary' && !primaryStillAssetId)) {
    status = 'failed';
  } else if (artifacts.some((item) => item.status === 'failed')) {
    status = 'ready-with-warnings';
  }

  return { project, shotId, primaryStillAssetId, status, artifacts, warnings };
}
