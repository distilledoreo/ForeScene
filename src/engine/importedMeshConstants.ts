import { IMPORT_BUDGET_POLICY } from './modelImportBudget';

/** Shared imported-mesh format constants kept free of Three.js for startup paths. */

/**
 * Legacy PanoRef protocol identifiers. The string values are persisted inside
 * project manifests and IndexedDB keys, so they are preserved verbatim across
 * the ForeScene rebrand. `LEGACY_PANOREF_MESH_VERSION` is the current revision
 * of that wire format, not a deprecated one.
 */
export const LEGACY_PANOREF_MESH_MIME = 'application/vnd.panoref.graybox-mesh';
export const LEGACY_PANOREF_MESH_VERSION = 2;
export const MAX_PACKED_MESH_BYTES = IMPORT_BUDGET_POLICY.maxPackedAssetBytes;
/** Legacy PanoRef IndexedDB URI scheme; kept for existing local model assets. */
export const MODEL_ASSET_URI_PREFIX = 'panoref-idb:';
/** Pre-storage model URI used by older poseable-character preflight paths. */
export const LEGACY_MODEL_ASSET_URI_PREFIX = 'panoref-model:';
/** Model packages created before the model/project stores were separated. */
export const LEGACY_PROJECT_ASSET_URI_PREFIX = 'panoref-asset:';
/** Runtime-only marker for a logical asset whose binary could not be restored. */
export const MISSING_ASSET_URI_PREFIX = 'panoref-missing:';

/**
 * Return the local model-store key regardless of which persisted URI form was
 * used. Model assets can carry the key explicitly after schema migration, or
 * encode it in one of the historical URI schemes.
 */
export function getModelAssetStorageKey(asset: { uri: string; storageKey?: string }): string | undefined {
  if (typeof asset.storageKey === 'string' && asset.storageKey.trim()) return asset.storageKey;
  for (const prefix of [MODEL_ASSET_URI_PREFIX, LEGACY_MODEL_ASSET_URI_PREFIX, LEGACY_PROJECT_ASSET_URI_PREFIX]) {
    if (asset.uri.startsWith(prefix)) return asset.uri.slice(prefix.length);
  }
  return undefined;
}
