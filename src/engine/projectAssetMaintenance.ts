import type { LocationProject, ProjectAsset } from '../domain/types';
import {
  PROJECT_ASSET_URI_PREFIX,
  deleteProjectAssetBlob,
  getManagedProjectAssetBlobKeyForUri,
  getProjectAssetBlobWrittenAt,
  listProjectAssetBlobKeys,
} from './projectAssetStore';
import { listAllProjectRevisions } from './projectRevisionStore';

function projectAssetStorageKey(asset: ProjectAsset): string | undefined {
  if (asset.storageKey) return asset.storageKey;
  if (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)) {
    return asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length);
  }
  return getManagedProjectAssetBlobKeyForUri(asset.uri);
}

function isRasterOrVideo(asset: ProjectAsset): boolean {
  return asset.type === 'image' || asset.type === 'video';
}

function referencedStorageKeys(project: LocationProject): Set<string> {
  return new Set(
    Object.values(project.assets.assets)
      .filter(isRasterOrVideo)
      .map(projectAssetStorageKey)
      .filter((key): key is string => Boolean(key)),
  );
}

/**
 * Best-effort maintenance after a verified project save.
 *
 * `project` is the verified snapshot whose stale transient payloads may be
 * reclaimed. `getLiveProject`, when provided, is re-read immediately before
 * each deletion. `protectWrittenAtOrAfter` closes the smaller durable-write /
 * live-manifest-merge window: bytes written after the save began are never
 * eligible for that save's cleanup even if the live merge has not happened yet.
 */
export async function cleanupUnreferencedProjectAssetPayloads(
  project: LocationProject,
  options: {
    getLiveProject?: () => LocationProject | undefined;
    protectWrittenAtOrAfter?: number;
  } = {},
): Promise<{ removed: number; keys: string[] }> {
  const savedKeys = referencedStorageKeys(project);

  const revisions = await listAllProjectRevisions();
  const retainedKeys = new Set(
    revisions.flatMap((revision) => revision.resources.projectAssetKeys),
  );
  for (const revision of revisions) {
    for (const resource of revision.resources.projectAssets ?? []) {
      retainedKeys.add(resource.key);
    }
  }

  const wasWrittenDuringSave = (key: string): boolean => {
    const cutoff = options.protectWrittenAtOrAfter;
    if (cutoff === undefined) return false;
    const writtenAt = getProjectAssetBlobWrittenAt(key);
    return writtenAt !== undefined && writtenAt >= cutoff;
  };

  const projectPrefix = `project/${project.id}/`;
  const importPrefix = `import/${project.id}/`;
  const storedKeys = await listProjectAssetBlobKeys();
  const candidates = storedKeys.filter((key) => (
    (key.startsWith(projectPrefix) || key.startsWith(importPrefix))
    && !savedKeys.has(key)
    && !retainedKeys.has(key)
    && !wasWrittenDuringSave(key)
  ));

  const removedKeys: string[] = [];
  for (const key of candidates) {
    const currentLive = options.getLiveProject?.();
    if (currentLive?.id === project.id && referencedStorageKeys(currentLive).has(key)) {
      continue;
    }
    if (wasWrittenDuringSave(key)) continue;
    await deleteProjectAssetBlob(key);
    removedKeys.push(key);
  }

  return { removed: removedKeys.length, keys: removedKeys };
}
