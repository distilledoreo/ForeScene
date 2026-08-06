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
  /** Optional live project for post-recovery commit when fingerprints still match. */
  liveProject?: LocationProject;
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
  let liveProject = params.liveProject;
  let temporaryAssetId: string | undefined;
  let assetId: string | undefined;
  let nextFrozen = frozenProject;

  if (liveProject) {
    const liveShot = liveProject.shots.find((item) => item.id === shotId);
    if (liveShot) {
      const liveFp = computeStillArtifactFingerprint(liveProject, liveShot, specification);
      if (liveFp.key === expected.key) {
        const commit = commitPreparedStillArtifact({
          project: liveProject,
          shotId,
          specification,
          expectedFingerprint: expected.key,
          prepared: { ...prepared, cacheStatus: 'rendered' },
        });
        if (commit.ok) {
          liveProject = commit.project;
          assetId = commit.assetId;
          // Mirror into frozen packaging project so asset lookup works.
          const asset = liveProject.assets.assets[commit.assetId];
          if (asset) {
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
                  [asset.id]: asset,
                },
              },
            };
          }
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

  // Temporary export media — store under frozen project id for zip packaging, then caller may delete.
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
