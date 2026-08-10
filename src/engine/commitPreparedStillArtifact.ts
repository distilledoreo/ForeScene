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

  // Prune the returned snapshot for callers that use it directly, but do NOT
  // delete superseded bytes here. A newer live project may have gained another
  // reference while the durable write was in flight. Final live merge code must
  // decide whether the old asset is still unreferenced before deleting bytes.
  if (supersededAssetId) {
    nextProject = pruneUnreferencedProjectAssets(nextProject);
  }

  return {
    ok: true,
    project: nextProject,
    artifact,
    assetId: asset.id,
    supersededAssetId,
  };
}

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

function clearLegacyViewportSlotForArtifact(
  assets: Shot['assets'],
  artifact: MaterializedStillArtifact,
): Shot['assets'] {
  if (artifact.kind === 'clay-viewport') {
    if (artifact.peopleVariant === 'clean_plate') {
      return assets.viewportCleanPlateAssetId === artifact.assetId
        ? { ...assets, viewportCleanPlateAssetId: undefined }
        : assets;
    }
    return assets.viewportRenderAssetId === artifact.assetId
      ? { ...assets, viewportRenderAssetId: undefined }
      : assets;
  }
  if (artifact.kind === 'projected-viewport') {
    if (artifact.peopleVariant === 'clean_plate') {
      return assets.viewportProjectedCleanPlateAssetId === artifact.assetId
        ? { ...assets, viewportProjectedCleanPlateAssetId: undefined }
        : assets;
    }
    return assets.viewportProjectedAssetId === artifact.assetId
      ? { ...assets, viewportProjectedAssetId: undefined }
      : assets;
  }
  return assets;
}

/** Remove obsolete materialized stills and their matching legacy viewport aliases. */
export function pruneObsoleteMaterializedStills(
  project: LocationProject,
  shotId: string,
  desiredKeys: ReadonlySet<string>,
): LocationProject {
  const shot = resolveShot(project, shotId);
  if (!shot?.materializedMedia) return project;

  const stills = shot.materializedMedia.stills;
  const obsolete = Object.keys(stills).filter((key) => !desiredKeys.has(key));
  if (obsolete.length === 0) return project;

  const removedArtifacts: MaterializedStillArtifact[] = [];
  const nextStills = { ...stills };
  for (const key of obsolete) {
    const removed = nextStills[key];
    if (removed) removedArtifacts.push(removed);
    delete nextStills[key];
  }

  let nextProject: LocationProject = {
    ...project,
    shots: project.shots.map((item) => {
      if (item.id !== shotId) return item;
      const nextShotAssets = removedArtifacts.reduce(
        (assets, artifact) => clearLegacyViewportSlotForArtifact(assets, artifact),
        item.assets,
      );
      return {
        ...item,
        materializedMedia: { stills: nextStills },
        assets: nextShotAssets,
        updatedAt: new Date().toISOString(),
      };
    }),
    updatedAt: new Date().toISOString(),
  };

  nextProject = pruneUnreferencedProjectAssets(nextProject);

  // This helper works from a supplied snapshot and cannot prove a removed asset
  // is still unreferenced in the latest live project. Leave physical deletion to
  // revision-aware post-save maintenance rather than risking concurrent data loss.
  return nextProject;
}