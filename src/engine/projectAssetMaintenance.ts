import type { LocationProject, ProjectAsset } from '../domain/types';
import {
  PROJECT_ASSET_URI_PREFIX,
  deleteProjectAssetBlob,
  getManagedProjectAssetBlobKeyForUri,
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
 * each deletion so an asset committed while the older save was in flight can
 * never be swept as an orphan.
 */
export async function cleanupUnreferencedProjectAssetPayloads(
  project: LocationProject,
  options: { getLiveProject?: () => LocationProject | undefined } = {},
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

  const projectPrefix = `project/${project.id}/`;
  const importPrefix = `import/${project.id}/`;
  const storedKeys = await listProjectAssetBlobKeys();
  const candidates = storedKeys.filter((key) => (
    (key.startsWith(projectPrefix) || key.startsWith(importPrefix))
    && !savedKeys.has(key)
    && !retainedKeys.has(key)
  ));

  const removedKeys: string[] = [];
  for (const key of candidates) {
    const currentLive = options.getLiveProject?.();
    if (currentLive?.id === project.id && referencedStorageKeys(currentLive).has(key)) {
      continue;
    }
    // There is no await between the latest-live check and queueing deletion, so
    // browser mutations cannot interleave inside this destructive edge.
    await deleteProjectAssetBlob(key);
    removedKeys.push(key);
  }

  return { removed: removedKeys.length, keys: removedKeys };
}
