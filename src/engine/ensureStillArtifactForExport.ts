/**
 * Export assurance: package current materialized stills or recover once via the shared materializer.
 */

import type { LocationProject, Shot } from '../domain/types';
import {
  commitPreparedStillArtifact,
} from './commitPreparedStillArtifact';
import {
  createProjectAssetStorageKey,
  deleteProjectAssetBlob,
  getProjectAssetBlob,
  storeProjectAssetBlob,
} from './projectAssetStore';
import { createId } from '../utils/ids';
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
  /** Optional live project snapshot at recovery start. Prefer getLiveProject. */
  liveProject?: LocationProject;
  /** Read live project immediately before committing recovery into the store. */
  getLiveProject?: () => LocationProject;
  /** Apply recovery commit result into the live store (merge only still fields). */
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
  /** Updated frozen project when recovery committed into the frozen snapshot assets. */
  frozenProject: LocationProject;
  /**
   * Live project when recovery was committed to live (fingerprints matched).
   * Undefined when recovery was temporary export-only media.
   */
  liveProject?: LocationProject;
  temporaryAssetId?: string;
}

async function loadAssetBlob(
  project: LocationProject,
  assetId: string,
): Promise<Blob | undefined> {
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

async function cleanupPersistedRecoveryAsset(
  projectId: string,
  assetId: string,
  storageKey?: string,
): Promise<void> {
  const key = storageKey ?? createProjectAssetStorageKey(projectId, assetId);
  await deleteProjectAssetBlob(key).catch(() => undefined);
}

/**
 * Ensure a still is available for packaging against a frozen export snapshot.
 */
export async function ensureStillArtifactForExport(
  params: EnsureStillArtifactForExportParams,
): Promise<EnsureStillArtifactForExportResult> {
  const { frozenProject, shotId, specification, signal } = params;
  const shot = frozenProject.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error(`Shot ${shotId} not found for export.`);

  const expected = computeStillArtifactFingerprint(frozenProject, shot, specification);
  const key = stillArtifactKey(specification);
  const existing = shot.materializedMedia?.stills[key];

  if (existing && existing.fingerprint === expected.key) {
    const blob = await loadAssetBlob(frozenProject, existing.assetId);
    if (blob) {
      recordPreparedMediaMetric('exportStillAssetHits');
      return {
        blob,
        assetId: existing.assetId,
        source: 'materialized-asset',
        frozenProject,
        liveProject: params.liveProject,
      };
    }
  }

  // Recovery through shared materializer (never packages stale bytes silently).
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
  );

  if (!prepared.blob) {
    throw new Error(`Still recovery for ${key} produced no blob.`);
  }

  // Always package the recovered blob for the frozen snapshot.
  // Commit to live only when live fingerprint still matches frozen expected.
  let liveProject = params.getLiveProject?.() ?? params.liveProject;
  let temporaryAssetId: string | undefined;
  let assetId: string | undefined;
  let nextFrozen = frozenProject;

  if (liveProject) {
    const liveShot = liveProject.shots.find((item) => item.id === shotId);
    if (liveShot) {
      const liveFp = computeStillArtifactFingerprint(liveProject, liveShot, specification);
      if (liveFp.key === expected.key) {
        const commit = await commitPreparedStillArtifact({
          project: liveProject,
          shotId,
          specification,
          expectedFingerprint: expected.key,
          prepared: { ...prepared, cacheStatus: 'rendered' },
        });
        if (commit.ok) {
          const committedAsset = commit.project.assets.assets[commit.assetId];
          if (!committedAsset) {
            throw new Error(`Recovered still ${key} committed without an asset record.`);
          }

          if (params.commitLiveProject) {
            let mergedIntoLive = false;
            liveProject = params.commitLiveProject((live) => {
              const liveShotNow = live.shots.find((item) => item.id === shotId);
              if (!liveShotNow) return live;

              const liveFingerprintNow = computeStillArtifactFingerprint(
                live,
                liveShotNow,
                specification,
              );
              if (liveFingerprintNow.key !== expected.key) return live;

              mergedIntoLive = true;
              const legacySlot = legacyViewportSlotPatch(specification, commit.assetId);
              return {
                ...live,
                assets: {
                  ...live.assets,
                  assets: {
                    ...live.assets.assets,
                    [commit.assetId]: committedAsset,
                  },
                },
                shots: live.shots.map((item) => {
                  if (item.id !== shotId) return item;
                  return {
                    ...item,
                    materializedMedia: {
                      stills: {
                        ...(item.materializedMedia?.stills ?? {}),
                        [key]: commit.artifact,
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

            if (!mergedIntoLive) {
              await cleanupPersistedRecoveryAsset(
                frozenProject.id,
                commit.assetId,
                committedAsset.storageKey,
              );
              return {
                blob: prepared.blob,
                source: 'render-recovery',
                frozenProject,
                liveProject,
              };
            }
          } else {
            liveProject = commit.project;
          }

          assetId = commit.assetId;
          nextFrozen = {
            ...frozenProject,
            shots: frozenProject.shots.map((item) =>
              item.id === shotId
                ? {
                  ...item,
                  materializedMedia: {
                    stills: {
                      ...(item.materializedMedia?.stills ?? {}),
                      [key]: commit.artifact,
                    },
                  },
                }
                : item
            ),
            assets: {
              ...frozenProject.assets,
              assets: {
                ...frozenProject.assets.assets,
                [committedAsset.id]: committedAsset,
              },
            },
          };
          return {
            blob: prepared.blob,
            assetId,
            source: 'render-recovery',
            frozenProject: nextFrozen,
            liveProject,
          };
        }
      }
    }
  }

  // Temporary export media — only the returned Blob is required for packaging,
  // but retain the existing temporary-asset lifecycle for callers that inspect it.
  temporaryAssetId = createId('asset');
  const tempAsset = storeProjectAssetBlob(
    frozenProject.id,
    {
      id: temporaryAssetId,
      type: 'image',
      name: `export_recovery_${key}.png`,
      uri: '',
      storageKey: createProjectAssetStorageKey(frozenProject.id, temporaryAssetId),
      mimeType: 'image/png',
      width: prepared.width,
      height: prepared.height,
      createdAt: new Date().toISOString(),
      metadata: {
        provenance: 'forescene-export-recovery-temporary',
        ownerShotId: shotId,
        artifactKey: key,
      },
    },
    prepared.blob,
  );

  nextFrozen = {
    ...frozenProject,
    assets: {
      ...frozenProject.assets,
      assets: {
        ...frozenProject.assets.assets,
        [tempAsset.id]: tempAsset,
      },
    },
  };

  return {
    blob: prepared.blob,
    assetId: temporaryAssetId,
    source: 'render-recovery',
    frozenProject: nextFrozen,
    liveProject,
    temporaryAssetId,
  };
}

/** Remove temporary export recovery assets after packaging. */
export async function cleanupTemporaryExportStill(
  projectId: string,
  temporaryAssetId: string | undefined,
): Promise<void> {
  if (!temporaryAssetId) return;
  const key = createProjectAssetStorageKey(projectId, temporaryAssetId);
  await deleteProjectAssetBlob(key).catch(() => undefined);
}
