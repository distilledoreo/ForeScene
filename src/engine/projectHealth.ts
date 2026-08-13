import type { CameraData, LocationProject, ProjectAsset, Shot, ShotAssetRefs, Vec3 } from '../domain/types';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { getModelAsset, listModelAssetKeys, deleteModelAsset } from './modelAssetStore';
import { getReferencedProjectAssetIds, pruneUnreferencedProjectAssets } from './projectAssets';
import {
  PROJECT_ASSET_URI_PREFIX,
  deleteProjectAssetBlob,
  getProjectAssetBlob,
  listProjectAssetBlobKeys,
} from './projectAssetStore';
import {
  getAllRetainedBinaryResources,
  getAllRetainedResourceKeys,
  getPersistentProjectStorageStatus,
  listProjectRevisionSummaries,
  verifyRetainedModelResource,
  verifyRetainedProjectAssetResource,
} from './projectSafety';

const PROJECT_ASSET_RESOURCE_PREFIX = 'recovery-resource/project-asset/';
const MODEL_RESOURCE_PREFIX = 'recovery-resource/model/';

export type ProjectHealthSeverity = 'info' | 'warning' | 'danger';

export interface ProjectHealthIssue {
  id: string;
  code: string;
  severity: ProjectHealthSeverity;
  message: string;
  repairable?: boolean;
}

export interface ProjectStorageSummary {
  logicalProjectBytes: number;
  essentialLocalBytes: number;
  temporaryLocalBytes: number;
  browserUsageBytes?: number;
  browserQuotaBytes?: number;
  browserAvailableBytes?: number;
  persistentStorageSupported?: boolean;
  persistentStorageGranted?: boolean;
  largestAssets: Array<{ id: string; name: string; type: ProjectAsset['type']; bytes: number }>;
  revisionCount: number;
  snapshotCount: number;
}

export interface ProjectHealthReport {
  projectId: string;
  checkedAt: string;
  issues: ProjectHealthIssue[];
  storage: ProjectStorageSummary;
}

export interface ProjectHealthRepairResult {
  project: LocationProject;
  repairedIssueCodes: string[];
}

function isRasterOrVideo(asset: ProjectAsset): boolean {
  return asset.type === 'image' || asset.type === 'video';
}

function assetStorageKey(asset: Pick<ProjectAsset, 'storageKey' | 'uri'>): string | undefined {
  return asset.storageKey ?? (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)
    ? asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length)
    : undefined);
}

function modelStorageKey(asset: ProjectAsset): string | undefined {
  return asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)
    ? asset.uri.slice(MODEL_ASSET_URI_PREFIX.length)
    : undefined;
}

function hasFiniteVec3(value: Vec3): boolean {
  return value.every(Number.isFinite);
}

function hasValidCamera(camera: CameraData): boolean {
  return hasFiniteVec3(camera.position)
    && hasFiniteVec3(camera.target)
    && Number.isFinite(camera.fovDegrees)
    && camera.fovDegrees > 0
    && camera.fovDegrees < 180
    && Number.isFinite(camera.aspectRatio)
    && camera.aspectRatio > 0
    && Number.isFinite(camera.near)
    && camera.near > 0
    && Number.isFinite(camera.far)
    && camera.far > camera.near;
}

function duplicateIds(values: readonly { id: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

function issue(
  issues: ProjectHealthIssue[],
  code: string,
  severity: ProjectHealthSeverity,
  message: string,
  repairable = false,
): void {
  issues.push({ id: `${code}-${issues.length + 1}`, code, severity, message, ...(repairable ? { repairable } : {}) });
}

function getInvalidShotAssetRefs(shot: Shot, assets: LocationProject['assets']['assets']): Array<keyof ShotAssetRefs> {
  return (Object.entries(shot.assets) as Array<[keyof ShotAssetRefs, string | undefined]>)
    .filter(([, assetId]) => Boolean(assetId) && !assets[assetId!])
    .map(([slot]) => slot);
}

async function browserStorageEstimate(): Promise<Pick<ProjectStorageSummary, 'browserUsageBytes' | 'browserQuotaBytes' | 'browserAvailableBytes'>> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') return {};
  try {
    const estimate = await navigator.storage.estimate();
    const browserUsageBytes = estimate.usage;
    const browserQuotaBytes = estimate.quota;
    return {
      ...(browserUsageBytes !== undefined ? { browserUsageBytes } : {}),
      ...(browserQuotaBytes !== undefined ? { browserQuotaBytes } : {}),
      ...(browserUsageBytes !== undefined && browserQuotaBytes !== undefined
        ? { browserAvailableBytes: Math.max(0, browserQuotaBytes - browserUsageBytes) }
        : {}),
    };
  } catch {
    return {};
  }
}

export async function runProjectHealthCheck(project: LocationProject): Promise<ProjectHealthReport> {
  const issues: ProjectHealthIssue[] = [];
  const assets = project.assets.assets;
  const referenced = getReferencedProjectAssetIds(project);
  const projectAssetSizes = new Map<string, number>();
  let logicalProjectBytes = 0;

  for (const [key, asset] of Object.entries(assets)) {
    if (asset.id !== key) issue(issues, 'inconsistent-asset-id', 'danger', `Asset registry key ${key} does not match asset id ${asset.id}.`);
    if (!referenced.has(key)) issue(issues, 'orphaned-asset-registry-entry', 'warning', `${asset.name} is no longer referenced by the scene, panoramas, or shots.`, true);

    if (isRasterOrVideo(asset)) {
      const key = assetStorageKey(asset);
      if (asset.uri.startsWith('data:')) {
        issue(issues, 'legacy-inline-raster', 'info', `${asset.name} still uses an inline data URL and will be migrated on its next verified save.`);
      } else if (!key && asset.uri.startsWith('blob:')) {
        issue(issues, 'ephemeral-raster-uri', 'warning', `${asset.name} only has a session blob URL and cannot survive a browser restart yet.`);
      } else if (!key) {
        issue(issues, 'unresolved-raster-uri', 'danger', `${asset.name} has no local binary storage key.`);
      } else {
        const blob = await getProjectAssetBlob(key);
        if (!blob) {
          issue(issues, 'missing-raster-blob', 'danger', `${asset.name} is referenced but its local binary payload is missing.`);
        } else {
          projectAssetSizes.set(asset.id, blob.size);
          logicalProjectBytes += blob.size;
        }
      }
    } else if (asset.type === 'model') {
      const key = modelStorageKey(asset);
      if (asset.uri.startsWith('data:')) {
        issue(issues, 'legacy-inline-model', 'info', `${asset.name} uses legacy inline geometry and will be migrated on its next verified save.`);
      } else if (!key) {
        issue(issues, 'unresolved-model-uri', 'danger', `${asset.name} has no local model storage key.`);
      } else {
        const bytes = await getModelAsset(key);
        if (!bytes) {
          issue(issues, 'missing-model-blob', 'danger', `${asset.name} is referenced but its local geometry payload is missing.`);
        } else {
          projectAssetSizes.set(asset.id, bytes.byteLength);
          logicalProjectBytes += bytes.byteLength;
        }
      }
    }
  }

  for (const duplicate of duplicateIds(project.scene.objects)) issue(issues, 'duplicate-scene-object-id', 'danger', `Scene object id ${duplicate} is duplicated.`);
  for (const duplicate of duplicateIds(project.panoRefs)) issue(issues, 'duplicate-pano-id', 'danger', `Panorama id ${duplicate} is duplicated.`);
  for (const duplicate of duplicateIds(project.shots)) issue(issues, 'duplicate-shot-id', 'danger', `Shot id ${duplicate} is duplicated.`);
  for (const duplicate of duplicateIds(project.landmarks)) issue(issues, 'duplicate-landmark-id', 'warning', `Landmark id ${duplicate} is duplicated.`);

  const panoIds = new Set(project.panoRefs.map((pano) => pano.id));
  for (const object of project.scene.objects) {
    if (object.modelAssetId && (!assets[object.modelAssetId] || assets[object.modelAssetId]?.type !== 'model')) {
      // Removing the model binding would leave the imported object visually
      // misleading. Report it clearly rather than offering a destructive
      // "repair" that silently changes the scene.
      issue(issues, 'missing-model-reference', 'danger', `${object.name} references a missing model asset.`);
    }
  }
  for (const pano of project.panoRefs) {
    const image = assets[pano.imageAssetId];
    // There is no deterministic replacement image, so keep the panorama
    // intact and require an explicit user decision instead of deleting it.
    if (!image || image.type !== 'image') issue(issues, 'broken-pano-image-reference', 'danger', `${pano.name} references a missing image asset.`);
    if (pano.sourcePanoId && !panoIds.has(pano.sourcePanoId)) {
      issue(issues, 'broken-pano-source-reference', 'warning', `${pano.name} references a source panorama that no longer exists.`, true);
    }
  }
  for (const shot of project.shots) {
    if (!hasValidCamera(shot.camera)) issue(issues, 'invalid-shot-camera', 'danger', `${shot.name} has invalid camera values.`);
    for (const keyframe of shot.cameraKeyframes) {
      if (!hasValidCamera(keyframe.camera)) issue(issues, 'invalid-keyframe-camera', 'danger', `${shot.name} has an invalid camera keyframe.`);
    }
    if (shot.linkedPanoId && !panoIds.has(shot.linkedPanoId)) issue(issues, 'broken-shot-pano-reference', 'warning', `${shot.name} links to a panorama that no longer exists.`, true);
    if (shot.panoCrop?.panoId && !panoIds.has(shot.panoCrop.panoId)) issue(issues, 'broken-shot-crop-reference', 'warning', `${shot.name} crops a panorama that no longer exists.`, true);
    for (const slot of getInvalidShotAssetRefs(shot, assets)) {
      issue(issues, 'missing-shot-media', 'danger', `${shot.name} references missing saved media in ${slot}.`, true);
    }
    if (shot.status === 'exported' && shot.exportSettings.includeViewport && !shot.assets.viewportRenderAssetId) {
      issue(issues, 'missing-exported-shot-thumbnail', 'warning', `${shot.name} is marked exported but has no viewport thumbnail.`, true);
    }
    if (shot.status === 'exported' && shot.exportSettings.includeCameraMoveVideo && shot.cameraKeyframes.length > 1 && !shot.assets.cameraMoveVideoAssetId) {
      issue(issues, 'missing-exported-shot-video', 'warning', `${shot.name} is marked exported but has no camera-move video.`, true);
    }
  }

  const [projectAssetKeys, modelAssetKeys, retained, retainedBinary, revisions, browser, persistence] = await Promise.all([
    listProjectAssetBlobKeys(),
    listModelAssetKeys(),
    getAllRetainedResourceKeys(),
    getAllRetainedBinaryResources(),
    listProjectRevisionSummaries(project.id),
    browserStorageEstimate(),
    getPersistentProjectStorageStatus(),
  ]);
  const currentProjectAssetKeys = new Set(Object.values(assets)
    .filter(isRasterOrVideo)
    .map(assetStorageKey)
    .filter((key): key is string => Boolean(key)));
  const currentModelKeys = new Set(Object.values(assets)
    .filter((asset) => asset.type === 'model')
    .map(modelStorageKey)
    .filter((key): key is string => Boolean(key)));
  let essentialLocalBytes = 0;
  let temporaryLocalBytes = 0;

  for (const key of projectAssetKeys) {
    const blob = await getProjectAssetBlob(key);
    if (!blob) continue;
    const essential = retained.projectAssetKeys.has(key) || currentProjectAssetKeys.has(key);
    if (essential) essentialLocalBytes += blob.size;
    else temporaryLocalBytes += blob.size;
  }
  for (const key of modelAssetKeys) {
    const bytes = await getModelAsset(key);
    if (!bytes) continue;
    const essential = retained.modelAssetKeys.has(key) || currentModelKeys.has(key);
    if (essential) essentialLocalBytes += bytes.byteLength;
    else temporaryLocalBytes += bytes.byteLength;
  }

  for (const resource of retainedBinary.projectAssets) {
    try {
      await verifyRetainedProjectAssetResource(resource);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Recovery binary ${resource.key} failed integrity verification.`;
      const missing = /missing/i.test(message);
      issue(
        issues,
        missing ? 'missing-recovery-resource' : 'corrupt-recovery-resource',
        'danger',
        missing
          ? `Recovery PNG/binary ${resource.key} is missing: ${message}`
          : `Recovery binary ${resource.key} failed integrity verification: ${message}`,
      );
    }
  }
  for (const resource of retainedBinary.models) {
    try {
      await verifyRetainedModelResource(resource);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Recovery model ${resource.key} failed integrity verification.`;
      const missing = /missing/i.test(message);
      issue(
        issues,
        missing ? 'missing-recovery-resource' : 'corrupt-recovery-resource',
        'danger',
        missing
          ? `Recovery model ${resource.key} is missing: ${message}`
          : `Recovery model ${resource.key} failed integrity verification: ${message}`,
      );
    }
  }

  const temporaryProjectAssetKeys = projectAssetKeys.filter((key) => (
    (key.startsWith(PROJECT_ASSET_RESOURCE_PREFIX) && !retained.projectAssetKeys.has(key))
    || ((key.startsWith(`project/${project.id}/`) || key.startsWith(`import/${project.id}/`)) && !currentProjectAssetKeys.has(key))
  ));
  const temporaryModelKeys = modelAssetKeys.filter((key) => (
    (key.startsWith(MODEL_RESOURCE_PREFIX) && !retained.modelAssetKeys.has(key))
    || ((key.startsWith(`project/${project.id}/`) || key.startsWith(`import/${project.id}/`)) && !currentModelKeys.has(key))
  ));
  if (temporaryProjectAssetKeys.length + temporaryModelKeys.length > 0) {
    issue(issues, 'orphaned-local-blobs', 'warning', `${temporaryProjectAssetKeys.length + temporaryModelKeys.length} local binary payload${temporaryProjectAssetKeys.length + temporaryModelKeys.length === 1 ? '' : 's'} are not used by any retained revision.`, true);
  }
  if (browser.browserAvailableBytes !== undefined && browser.browserQuotaBytes && (
    browser.browserAvailableBytes < 100 * 1024 * 1024 || browser.browserAvailableBytes / browser.browserQuotaBytes < 0.1
  )) {
    issue(issues, 'storage-near-limit', 'warning', 'Browser storage is nearly full. Export a backup or free temporary data before importing more media.');
  }
  if (persistence.supported && !persistence.persistent) {
    issue(issues, 'persistent-storage-not-granted', 'warning', 'Browser persistent storage was not granted. Local recovery remains available, but the browser may evict data under storage pressure. Export a backup regularly.');
  }

  const largestAssets = Object.values(assets)
    .map((asset) => ({ id: asset.id, name: asset.name, type: asset.type, bytes: projectAssetSizes.get(asset.id) ?? 0 }))
    .filter((asset) => asset.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8);
  return {
    projectId: project.id,
    checkedAt: new Date().toISOString(),
    issues,
    storage: {
      logicalProjectBytes,
      essentialLocalBytes,
      temporaryLocalBytes,
      ...browser,
      persistentStorageSupported: persistence.supported,
      ...(persistence.persistent !== undefined ? { persistentStorageGranted: persistence.persistent } : {}),
      largestAssets,
      revisionCount: revisions.length,
      snapshotCount: revisions.filter((revision) => revision.kind === 'snapshot').length,
    },
  };
}

/** Repair only reference bookkeeping that is unambiguously stale. */
export function repairProjectHealth(project: LocationProject): ProjectHealthRepairResult {
  const repairedIssueCodes: string[] = [];
  const assets = project.assets.assets;
  const panoIds = new Set(project.panoRefs.map((pano) => pano.id));
  let changed = false;
  const panoRefs = project.panoRefs.map((pano) => {
    if (!pano.sourcePanoId || panoIds.has(pano.sourcePanoId)) return pano;
    changed = true;
    repairedIssueCodes.push('broken-pano-source-reference');
    const { sourcePanoId: _removed, ...withoutSource } = pano;
    return withoutSource;
  });
  const shots = project.shots.map((shot) => {
    let shotChanged = false;
    const nextAssets = { ...shot.assets };
    for (const slot of getInvalidShotAssetRefs(shot, assets)) {
      nextAssets[slot] = undefined;
      shotChanged = true;
      repairedIssueCodes.push('missing-shot-media');
    }
    const linkedPanoId = shot.linkedPanoId && !panoIds.has(shot.linkedPanoId) ? undefined : shot.linkedPanoId;
    const panoCrop = shot.panoCrop?.panoId && !panoIds.has(shot.panoCrop.panoId) ? undefined : shot.panoCrop;
    if (linkedPanoId !== shot.linkedPanoId) {
      shotChanged = true;
      repairedIssueCodes.push('broken-shot-pano-reference');
    }
    if (panoCrop !== shot.panoCrop) {
      shotChanged = true;
      repairedIssueCodes.push('broken-shot-crop-reference');
    }
    if (!shotChanged) return shot;
    changed = true;
    return { ...shot, assets: nextAssets, linkedPanoId, panoCrop, updatedAt: new Date().toISOString() };
  });
  const beforeAssetCount = Object.keys(assets).length;
  const pruned = pruneUnreferencedProjectAssets({ ...project, panoRefs, shots });
  if (Object.keys(pruned.assets.assets).length !== beforeAssetCount) {
    changed = true;
    repairedIssueCodes.push('orphaned-asset-registry-entry');
  }
  return {
    project: changed ? { ...pruned, updatedAt: new Date().toISOString() } : project,
    repairedIssueCodes: [...new Set(repairedIssueCodes)],
  };
}

/**
 * Remove only keys not referenced by any retained revision or the live
 * project. This intentionally leaves unknown/other-project keys untouched.
 */
export async function cleanupTemporaryProjectStorage(project: LocationProject): Promise<{ projectAssetsRemoved: number; modelAssetsRemoved: number }> {
  const [projectAssetKeys, modelAssetKeys, retained] = await Promise.all([
    listProjectAssetBlobKeys(),
    listModelAssetKeys(),
    getAllRetainedResourceKeys(),
  ]);
  const currentProjectAssetKeys = new Set(Object.values(project.assets.assets)
    .filter(isRasterOrVideo)
    .map(assetStorageKey)
    .filter((key): key is string => Boolean(key)));
  const currentModelKeys = new Set(Object.values(project.assets.assets)
    .filter((asset) => asset.type === 'model')
    .map(modelStorageKey)
    .filter((key): key is string => Boolean(key)));
  const staleProjectAssets = projectAssetKeys.filter((key) => (
    (key.startsWith(PROJECT_ASSET_RESOURCE_PREFIX) && !retained.projectAssetKeys.has(key))
    || ((key.startsWith(`project/${project.id}/`) || key.startsWith(`import/${project.id}/`)) && !currentProjectAssetKeys.has(key))
  ));
  const staleModels = modelAssetKeys.filter((key) => (
    (key.startsWith(MODEL_RESOURCE_PREFIX) && !retained.modelAssetKeys.has(key))
    || ((key.startsWith(`project/${project.id}/`) || key.startsWith(`import/${project.id}/`)) && !currentModelKeys.has(key))
  ));
  await Promise.all(staleProjectAssets.map((key) => deleteProjectAssetBlob(key)));
  await Promise.all(staleModels.map((key) => deleteModelAsset(key)));
  return { projectAssetsRemoved: staleProjectAssets.length, modelAssetsRemoved: staleModels.length };
}
