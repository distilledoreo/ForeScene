/**
 * Atomic commit of a prepared still into a live project snapshot.
 * Recomputes fingerprint at commit time and rejects stale results.
 * Awaits durable Blob persistence before attaching the asset record.
 */

import type {
  LocationProject,
  MaterializedStillArtifact,
  ProjectAsset,
  Shot,
} from '../domain/types';
import { createId } from '../utils/ids';
import {
  createProjectAssetStorageKey,
  deleteProjectAssetBlob,
  storeProjectAssetBlobDurable,
} from './projectAssetStore';
import { pruneUnreferencedProjectAssets } from './projectAssets';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import {
  stillArtifactKey,
  type StillArtifactSpecification,
} from './stillArtifactTypes';
import type { PreparedStillArtifact } from './prepareStillArtifact';
import { recordPreparedMediaMetric } from './preparedMediaMetrics';

export interface CommitPreparedStillParams {
  /** Must be the current live project at commit time (not a render snapshot). */
  project: LocationProject;
  shotId: string;
  specification: StillArtifactSpecification;
  /** Fingerprint of the prepared render; rejected when live state no longer matches. */
  expectedFingerprint: string;
  prepared: PreparedStillArtifact;
}

export type CommitPreparedStillResult =
  | {
    ok: true;
    project: LocationProject;
    artifact: MaterializedStillArtifact;
    assetId: string;
    supersededAssetId?: string;
  }
  | {
    ok: false;
    reason: 'stale' | 'shot-missing' | 'missing-blob' | 'persistence-failed';
    project: LocationProject;
    error?: string;
  };

function resolveShot(project: LocationProject, shotId: string): Shot | undefined {
  return project.shots.find((item) => item.id === shotId);
}

/**
 * Apply a prepared still to the given (live) project.
 * Only mutates that shot's materializedMedia entry and the asset registry for the new asset —
 * other concurrent shot/scene fields on `project` are preserved.
 * Awaits durable storage before attaching the record.
 */
export async function commitPreparedStillArtifact(
  params: CommitPreparedStillParams,
): Promise<CommitPreparedStillResult> {
  const { project, shotId, specification, expectedFingerprint, prepared } = params;
  const shot = resolveShot(project, shotId);
  if (!shot) {
    return { ok: false, reason: 'shot-missing', project };
  }

  const liveFingerprint = computeStillArtifactFingerprint(project, shot, specification);
  if (liveFingerprint.key !== expectedFingerprint) {
    recordPreparedMediaMetric('staleResultsDiscarded');
    return { ok: false, reason: 'stale', project };
  }

  const artifactKey = stillArtifactKey(specification);
  const previous = shot.materializedMedia?.stills[artifactKey];

  // Reuse existing asset when preparation confirmed current bytes.
  if (
    prepared.cacheStatus === 'current'
    && prepared.existingAssetId
    && previous?.assetId === prepared.existingAssetId
    && previous.fingerprint === expectedFingerprint
  ) {
    return {
      ok: true,
      project,
      artifact: previous,
      assetId: previous.assetId,
    };
  }

  if (!prepared.blob && !prepared.existingAssetId) {
    return { ok: false, reason: 'missing-blob', project };
  }

  let assetId: string;
  let asset: ProjectAsset;
  let nextAssets = project.assets.assets;

  if (prepared.existingAssetId && prepared.cacheStatus === 'current') {
    assetId = prepared.existingAssetId;
    const existing = project.assets.assets[assetId];
    if (!existing) {
      return { ok: false, reason: 'missing-blob', project };
    }
    asset = existing;
  } else {
    if (!prepared.blob) {
      return { ok: false, reason: 'missing-blob', project };
    }
    assetId = createId('asset');
    const base: ProjectAsset = {
      id: assetId,
      type: 'image',
      name: `${shot.shotNumber}_${artifactKey}.png`,
      uri: '',
      storageKey: createProjectAssetStorageKey(project.id, assetId),
      mimeType: 'image/png',
      width: prepared.width,
      height: prepared.height,
      createdAt: new Date().toISOString(),
      metadata: {
        provenance: 'forescene-derived-still',
        ownerShotId: shotId,
        artifactKey,
        fingerprint: expectedFingerprint,
      },
    };
    try {
      // Durable write must succeed before the project references the asset.
      asset = await storeProjectAssetBlobDurable(project.id, base, prepared.blob);
    } catch (error) {
      return {
        ok: false,
        reason: 'persistence-failed',
        project,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    nextAssets = { ...project.assets.assets, [asset.id]: asset };
  }

  const artifact: MaterializedStillArtifact = {
    id: previous?.id ?? createId('still-artifact'),
    key: artifactKey,
    kind: specification.kind,
    assetId: asset.id,
    fingerprint: expectedFingerprint,
    dependencyIds: liveFingerprint.dependencyIds,
    width: prepared.width,
    height: prepared.height,
    mimeType: 'image/png',
    peopleVariant: specification.peopleVariant,
    appearance: specification.appearance,
    timeSeconds: specification.timeSeconds,
    frameRole: specification.frameRole,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };

  const nextStills = {
    ...(shot.materializedMedia?.stills ?? {}),
    [artifactKey]: artifact,
  };

  let nextProject: LocationProject = {
    ...project,
    shots: project.shots.map((item) =>
      item.id === shotId
        ? {
          ...item,
          materializedMedia: { stills: nextStills },
          // Also map viewport stills into legacy camera-roll slots when applicable.
          assets: mapLegacyViewportSlot(item.assets, specification, asset.id),
          updatedAt: new Date().toISOString(),
        }
        : item
    ),
    assets: {
      ...project.assets,
      assets: nextAssets,
    },
    updatedAt: new Date().toISOString(),
  };

  const supersededAssetId =
    previous && previous.assetId !== asset.id ? previous.assetId : undefined;

  if (supersededAssetId) {
    nextProject = pruneUnreferencedProjectAssets(nextProject);
    if (!nextProject.assets.assets[supersededAssetId]) {
      const oldAsset = project.assets.assets[supersededAssetId];
      const key = oldAsset?.storageKey
        ?? createProjectAssetStorageKey(project.id, supersededAssetId);
      void deleteProjectAssetBlob(key).catch(() => undefined);
    }
  }

  return {
    ok: true,
    project: nextProject,
    artifact,
    assetId: asset.id,
    supersededAssetId,
  };
}

/** Map prepared viewport stills into legacy shot.assets slots without re-rendering. */
function mapLegacyViewportSlot(
  assets: Shot['assets'],
  specification: StillArtifactSpecification,
  assetId: string,
): Shot['assets'] {
  if (specification.kind === 'clay-viewport') {
    if (specification.peopleVariant === 'clean_plate') {
      return { ...assets, viewportCleanPlateAssetId: assetId };
    }
    return { ...assets, viewportRenderAssetId: assetId };
  }
  if (specification.kind === 'projected-viewport') {
    if (specification.peopleVariant === 'clean_plate') {
      return { ...assets, viewportProjectedCleanPlateAssetId: assetId };
    }
    return { ...assets, viewportProjectedAssetId: assetId };
  }
  return assets;
}

/**
 * Remove obsolete materialized still records whose keys are no longer desired.
 * Also deletes IndexedDB blobs for assets that become unreferenced.
 */
export function pruneObsoleteMaterializedStills(
  project: LocationProject,
  shotId: string,
  desiredKeys: ReadonlySet<string>,
): LocationProject {
  const shot = resolveShot(project, shotId);
  if (!shot?.materializedMedia) return project;

  const stills = shot.materializedMedia.stills;
  const keys = Object.keys(stills);
  const obsolete = keys.filter((key) => !desiredKeys.has(key));
  if (obsolete.length === 0) return project;

  const removedAssetIds: string[] = [];
  const nextStills = { ...stills };
  for (const key of obsolete) {
    const removed = nextStills[key];
    if (removed) removedAssetIds.push(removed.assetId);
    delete nextStills[key];
  }

  let nextProject: LocationProject = {
    ...project,
    shots: project.shots.map((item) =>
      item.id === shotId
        ? {
          ...item,
          materializedMedia: { stills: nextStills },
          updatedAt: new Date().toISOString(),
        }
        : item
    ),
    updatedAt: new Date().toISOString(),
  };

  nextProject = pruneUnreferencedProjectAssets(nextProject);

  for (const assetId of removedAssetIds) {
    if (nextProject.assets.assets[assetId]) continue;
    const oldAsset = project.assets.assets[assetId];
    const key = oldAsset?.storageKey ?? createProjectAssetStorageKey(project.id, assetId);
    void deleteProjectAssetBlob(key).catch(() => undefined);
  }

  return nextProject;
}
