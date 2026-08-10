/**
 * Export assurance: package current materialized stills or recover once via the shared materializer.
 */

import type { LocationProject, Shot } from '../domain/types';
import { commitPreparedStillArtifact } from './commitPreparedStillArtifact';
import { getLiveProjectAccess } from './liveProjectAccess';
import {
  createProjectAssetStorageKey,
  deleteProjectAssetBlob,
  getProjectAssetBlob,
} from './projectAssetStore';
import { pruneUnreferencedProjectAssets } from './projectAssets';
import { prepareStillArtifact } from './prepareStillArtifact';
import { recordPreparedMediaMetric } from './preparedMediaMetrics';
import { renderWorkCoordinator } from './renderWorkCoordinator';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import { stillArtifactKey, type StillArtifactSpecification } from './stillArtifactTypes';
import type { RenderedStillArtifact } from './stillArtifactRender';

export type PlannedArtifactSource =
  | 'materialized-asset'
  | 'source-asset'
  | 'shared-preparation'
  | 'video-cache'
  | 'render-recovery';

export interface EnsureStillArtifactForExportParams {
  frozenProject: LocationProject;
  liveProject?: LocationProject;
  getLiveProject?: () => LocationProject;
  commitLiveProject?: (updater: (live: LocationProject) => LocationProject) => LocationProject;
  shotId: string;
  specification: StillArtifactSpecification;
  signal?: AbortSignal;
  render?: (params: {
    project: LocationProject;
    shot: Shot;
    specification: StillArtifactSpecification;
    signal?: AbortSignal;
  }) => Promise<RenderedStillArtifact>;
}

export interface EnsureStillArtifactForExportResult {
  blob: Blob;
  assetId?: string;
  source: 'materialized-asset' | 'render-recovery';
  frozenProject: LocationProject;
  liveProject?: LocationProject;
  /** Retained for compatibility; export-only recovery no longer persists a temp asset. */
  temporaryAssetId?: string;
}

async function loadAssetBlob(project: LocationProject, assetId: string): Promise<Blob | undefined> {
  const asset = project.assets.assets[assetId];
  if (!asset) return undefined;
  if (asset.uri?.startsWith('data:')) {
    const { dataUrlToBlob } = await import('./fileTransfers');
    return dataUrlToBlob(asset.uri);
  }
  const key = asset.storageKey ?? createProjectAssetStorageKey(project.id, assetId);
  return getProjectAssetBlob(key);
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

async function cleanupPersistedRecoveryAsset(
  projectId: string,
  assetId: string,
  storageKey?: string,
): Promise<void> {
  const key = storageKey ?? createProjectAssetStorageKey(projectId, assetId);
  await deleteProjectAssetBlob(key).catch(() => undefined);
}

function resolveLiveAccess(params: EnsureStillArtifactForExportParams): {
  getLiveProject?: () => LocationProject;
  commitLiveProject?: (updater: (live: LocationProject) => LocationProject) => LocationProject;
  initialLiveProject?: LocationProject;
} {
  if (params.getLiveProject || params.commitLiveProject || params.liveProject) {
    const explicit = params.getLiveProject?.() ?? params.liveProject;
    return explicit?.id === params.frozenProject.id
      ? {
        getLiveProject: params.getLiveProject,
        commitLiveProject: params.commitLiveProject,
        initialLiveProject: explicit,
      }
      : {};
  }

  const bound = getLiveProjectAccess();
  const active = bound?.getProject();
  if (!bound || !active || active.id !== params.frozenProject.id) return {};
  return {
    getLiveProject: bound.getProject,
    commitLiveProject: bound.commitProject,
    initialLiveProject: active,
  };
}

export async function ensureStillArtifactForExport(
  params: EnsureStillArtifactForExportParams,
): Promise<EnsureStillArtifactForExportResult> {
  const { frozenProject, shotId, specification, signal } = params;
  const shot = frozenProject.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error(`Shot ${shotId} not found for export.`);

  const expected = computeStillArtifactFingerprint(frozenProject, shot, specification);
  const key = stillArtifactKey(specification);
  const existing = shot.materializedMedia?.stills[key];
  const liveAccess = resolveLiveAccess(params);

  if (existing && existing.fingerprint === expected.key) {
    const blob = await loadAssetBlob(frozenProject, existing.assetId);
    if (blob) {
      recordPreparedMediaMetric('exportStillAssetHits');
      return {
        blob,
        assetId: existing.assetId,
        source: 'materialized-asset',
        frozenProject,
        liveProject: liveAccess.initialLiveProject,
      };
    }
  }

  recordPreparedMediaMetric('exportStillRecoveryRenders');
  const prepared = await renderWorkCoordinator.schedule(
    'export-recovery-still',
    () => prepareStillArtifact({
      projectSnapshot: frozenProject,
      shotId,
      specification,
      signal,
      force: true,
      render: params.render,
    }),
    { ownerId: shotId, jobId: `export-still:${key}` },
  );

  if (!prepared.blob) throw new Error(`Still recovery for ${key} produced no blob.`);

  let liveProject = liveAccess.getLiveProject?.() ?? liveAccess.initialLiveProject;
  let nextFrozen = frozenProject;

  if (liveProject?.id === frozenProject.id) {
    const liveShot = liveProject.shots.find((item) => item.id === shotId);
    if (liveShot) {
      const liveFp = computeStillArtifactFingerprint(liveProject, liveShot, specification);
      if (liveFp.key === expected.key) {
        const previousArtifact = liveShot.materializedMedia?.stills[key];
        const previousAsset = previousArtifact
          ? liveProject.assets.assets[previousArtifact.assetId]
          : undefined;
        const commit = await commitPreparedStillArtifact({
          project: liveProject,
          shotId,
          specification,
          expectedFingerprint: expected.key,
          prepared: { ...prepared, cacheStatus: 'rendered' },
        });
        if (commit.ok) {
          const committedAsset = commit.project.assets.assets[commit.assetId];
          if (!committedAsset) throw new Error(`Recovered still ${key} committed without an asset record.`);
          const supersededAssetId = commit.supersededAssetId;
          const supersededStorageKey = supersededAssetId
            ? previousAsset?.storageKey ?? createProjectAssetStorageKey(frozenProject.id, supersededAssetId)
            : undefined;

          if (liveAccess.commitLiveProject) {
            let mergedIntoLive = false;
            liveProject = liveAccess.commitLiveProject((live) => {
              if (live.id !== frozenProject.id) return live;
              const liveShotNow = live.shots.find((item) => item.id === shotId);
              if (!liveShotNow) return live;
              const liveFingerprintNow = computeStillArtifactFingerprint(live, liveShotNow, specification);
              if (liveFingerprintNow.key !== expected.key) return live;

              mergedIntoLive = true;
              const legacySlot = legacyViewportSlotPatch(specification, commit.assetId);
              const merged: LocationProject = {
                ...live,
                assets: {
                  ...live.assets,
                  assets: { ...live.assets.assets, [commit.assetId]: committedAsset },
                },
                shots: live.shots.map((item) => item.id === shotId ? {
                  ...item,
                  materializedMedia: {
                    stills: { ...(item.materializedMedia?.stills ?? {}), [key]: commit.artifact },
                  },
                  assets: { ...item.assets, ...legacySlot },
                  updatedAt: new Date().toISOString(),
                } : item),
                updatedAt: new Date().toISOString(),
              };
              return supersededAssetId ? pruneUnreferencedProjectAssets(merged) : merged;
            });

            if (!mergedIntoLive) {
              await cleanupPersistedRecoveryAsset(frozenProject.id, commit.assetId, committedAsset.storageKey);
              return { blob: prepared.blob, source: 'render-recovery', frozenProject, liveProject };
            }
          } else {
            liveProject = commit.project;
          }

          if (
            supersededAssetId
            && supersededStorageKey
            && liveProject
            && !liveProject.assets.assets[supersededAssetId]
          ) {
            await deleteProjectAssetBlob(supersededStorageKey).catch(() => undefined);
          }

          nextFrozen = {
            ...frozenProject,
            shots: frozenProject.shots.map((item) => item.id === shotId ? {
              ...item,
              materializedMedia: {
                stills: { ...(item.materializedMedia?.stills ?? {}), [key]: commit.artifact },
              },
            } : item),
            assets: {
              ...frozenProject.assets,
              assets: { ...frozenProject.assets.assets, [committedAsset.id]: committedAsset },
            },
          };
          return {
            blob: prepared.blob,
            assetId: commit.assetId,
            source: 'render-recovery',
            frozenProject: nextFrozen,
            liveProject,
          };
        }
      }
    }
  }

  // Export-only recovery is deliberately ephemeral. The package writer only
  // needs this Blob; persisting a temporary project asset creates quota risk and
  // leak paths on cancellation/failure. No temp IDB row or object URL is created.
  return {
    blob: prepared.blob,
    source: 'render-recovery',
    frozenProject,
    liveProject,
  };
}

/** Compatibility no-op for writers that still call cleanup unconditionally. */
export async function cleanupTemporaryExportStill(
  projectId: string,
  temporaryAssetId: string | undefined,
): Promise<void> {
  if (!temporaryAssetId) return;
  const key = createProjectAssetStorageKey(projectId, temporaryAssetId);
  await deleteProjectAssetBlob(key).catch(() => undefined);
}
