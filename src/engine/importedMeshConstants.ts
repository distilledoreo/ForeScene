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
