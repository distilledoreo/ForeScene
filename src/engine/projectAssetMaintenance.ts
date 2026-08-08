import type { LocationProject, ProjectAsset } from '../domain/types';
import {
  PROJECT_ASSET_URI_PREFIX,
  deleteProjectAssetBlob,
  getManagedProjectAssetBlobKeyForUri,
  hasResidentProjectAssetBlob,
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

/**
 * Best-effort maintenance after a verified project save.
 *
 * Recovery revisions pin immutable, content-addressed copies of their binaries.
 * This routine therefore reclaims only transient project/import payloads for the
 * current project that are no longer referenced by the saved asset registry and
 * are not named by any retained revision.
 *
 * A save may finish while a newer prepared asset is being durably written and
 * merged into live state. Those newer bytes are resident in the active asset
 * store even though the older save snapshot cannot reference them yet. Resident
 * keys are therefore protected from maintenance and reconsidered only after an
 * explicit release/project switch or a later session. This prevents save-time
 * cleanup from deleting newer unsaved assets.
 *
 * Legacy/sample manifests may hold a managed blob: URL without an explicit
 * storageKey. The project-asset store can reverse-map those URLs; they must be
 * treated as live or cleanup would revoke the URL underneath the open project.
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
    && !hasResidentProjectAssetBlob(key)
  ));

  for (const key of staleKeys) {
    // A key could become resident after the candidate scan but before deletion
    // because asset DB work is asynchronous. Re-check at the destructive edge.
    if (hasResidentProjectAssetBlob(key)) continue;
    await deleteProjectAssetBlob(key);
  }

  return { removed: staleKeys.filter((key) => !hasResidentProjectAssetBlob(key)).length, keys: staleKeys };
}
