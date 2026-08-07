import type { LocationProject, ProjectAsset } from '../domain/types';
import {
  PROJECT_ASSET_URI_PREFIX,
  deleteProjectAssetBlob,
  listProjectAssetBlobKeys,
} from './projectAssetStore';
import { listAllProjectRevisions } from './projectRevisionStore';

function projectAssetStorageKey(asset: ProjectAsset): string | undefined {
  return asset.storageKey ?? (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)
    ? asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length)
    : undefined);
}

function isRasterOrVideo(asset: ProjectAsset): boolean {
  return asset.type === 'image' || asset.type === 'video';
}

/**
 * Best-effort maintenance after a verified project save.
 *
 * Recovery revisions pin immutable, content-addressed copies of their binaries.
 * This routine therefore reclaims only transient project/import payloads for the
 * current project that are no longer referenced by the live asset registry and
 * are not named by any retained revision. It never sweeps shared recovery keys.
 */
export async function cleanupUnreferencedProjectAssetPayloads(
  project: LocationProject,
): Promise<{ removed: number; keys: string[] }> {
  const liveKeys = new Set(
    Object.values(project.assets.assets)
      .filter(isRasterOrVideo)
      .map(projectAssetStorageKey)
      .filter((key): key is string => Boolean(key)),
  );

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
  const staleKeys = storedKeys.filter((key) => (
    (key.startsWith(projectPrefix) || key.startsWith(importPrefix))
    && !liveKeys.has(key)
    && !retainedKeys.has(key)
  ));

  for (const key of staleKeys) {
    await deleteProjectAssetBlob(key);
  }

  return { removed: staleKeys.length, keys: staleKeys };
}
