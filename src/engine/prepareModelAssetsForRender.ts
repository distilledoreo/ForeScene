/**
 * Async preparation for binary scene models consumed by the synchronous
 * imported-mesh scene builder.
 *
 * Project safety may replace an import key with a durable recovery-resource
 * key. Those bytes can already be present in IndexedDB without being present
 * in the renderer's process-local cache. Export must hydrate that cache before
 * constructing Three.js nodes; otherwise a valid persisted asset is rendered
 * as a missing-asset placeholder.
 */

import type { LocationProject } from '../domain/types';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { hydrateModelAssetKeys } from './modelAssetStore';

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Model asset preparation was cancelled.');
  error.name = 'AbortError';
  throw error;
}

export async function prepareModelAssetsForRender(
  project: Pick<LocationProject, 'scene' | 'assets'>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  const keys: string[] = [];

  for (const object of project.scene.objects) {
    // Callers pass the shot/content-mode-resolved scene. Hidden objects cannot
    // participate in this render and must not make an otherwise valid pass fail.
    if (!object.visible) continue;
    if (!object.modelAssetId) continue;
    const asset = project.assets.assets[object.modelAssetId];
    if (!asset) {
      throw new Error(
        `Scene object "${object.name}" (${object.id}) references missing model asset "${object.modelAssetId}".`,
      );
    }
    if (asset.resolutionStatus && asset.resolutionStatus !== 'available') {
      throw new Error(
        `Scene object "${object.name}" (${object.id}) references ${asset.resolutionStatus} model asset "${asset.name}" (${asset.id}).`,
      );
    }
    if (asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
      keys.push(asset.uri.slice(MODEL_ASSET_URI_PREFIX.length));
    }
  }

  const missing = await hydrateModelAssetKeys(keys);
  throwIfCancelled(signal);
  if (missing.length > 0) {
    throw new Error(
      `Required model asset bytes are unavailable for rendering: ${missing.join(', ')}. Reopen the project package or reimport the source model.`,
    );
  }
}
