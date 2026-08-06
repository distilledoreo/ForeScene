/**
 * Atomic commit of a prepared still into a project snapshot.
 * Recomputes fingerprint at commit time and rejects stale results.
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
  storeProjectAssetBlob,
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
  project: LocationProject;
  shotId: string;
  specification: StillArtifactSpecification;
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
    reason: 'stale' | 'shot-missing' | 'missing-blob';
    project: LocationProject;
  };

function resolveShot(project: LocationProject, shotId: string): Shot | undefined {
  return project.shots.find((item) => item.id === shotId);
}

/**
 * Apply a prepared still to the given project snapshot.
 * On success returns updated project; on stale rejects without attaching bytes.
 */
export function commitPreparedStillArtifact(
  params: CommitPreparedStillParams,
): CommitPreparedStillResult {
  const { project, shotId, specification, expectedFingerprint, prepared } = params;
  const shot = resolveShot(project, shotId);
  if (!shot) {
    return { ok: false, reason: 'shot-missing', project };
  }

  const liveFingerprint = computeStillArtifactFingerprint(project, shot, specification);
  if (liveFingerprint.key !== expectedFingerprint) {
    recordPreparedMediaMetric('staleResultsDiscarded');
    // Clean up newly rendered blob that will not be attached.
    if (prepared.blob && prepared.cacheStatus !== 'current' && !prepared.existingAssetId) {
      // Blob was never stored as a project asset yet — nothing to delete from IDB.
    }
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
      asset = storeProjectAssetBlob(project.id, base, prepared.blob);
    } catch {
      return { ok: false, reason: 'missing-blob', project };
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
    // Drop superseded asset from registry only when unreferenced after prune.
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

/**
 * Remove obsolete materialized still records whose keys are no longer desired.
 * Does not delete assets still referenced elsewhere.
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

  const nextStills = { ...stills };
  for (const key of obsolete) {
    delete nextStills[key];
  }

  const nextProject: LocationProject = {
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

  return pruneUnreferencedProjectAssets(nextProject);
}
