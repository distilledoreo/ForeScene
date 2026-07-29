import type { PoseableRegionMapReference, PoseableRigAsset, ProjectAsset } from '../../domain/types';
import { createId } from '../../utils/ids';
import { MODEL_ASSET_URI_PREFIX } from '../importedMeshConstants';
import { putModelAsset, getRegisteredModelAssetBytes, getModelAsset } from '../modelAssetStore';

/** Magic ASCII "PNRG" as little-endian Uint32. */
export const REGION_MAP_MAGIC = 0x47524e50; // 'P''N''R''G' little-endian → PNRG
export const REGION_MAP_FORMAT_VERSION = 1;

export interface DecodedRegionMapAsset {
  formatVersion: number;
  vertexCount: number;
  topologyHash: string;
  labels: Uint8Array;
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Serialize region labels to the PNRG binary format:
 * Header: magic, formatVersion, vertexCount, topologyHashLength, topologyHash
 * Payload: Uint8 region code per vertex
 */
export function encodeRegionMapBinary(params: {
  labels: Uint8Array;
  topologyHash: string;
}): ArrayBuffer {
  const hashBytes = encodeUtf8(params.topologyHash);
  if (hashBytes.length > 0xffff) {
    throw new Error('Topology hash exceeds binary header capacity.');
  }
  const headerWords = new Uint32Array([
    REGION_MAP_MAGIC,
    REGION_MAP_FORMAT_VERSION,
    params.labels.length >>> 0,
    hashBytes.length >>> 0,
  ]);
  const bytes = new Uint8Array(
    headerWords.byteLength + hashBytes.length + params.labels.length,
  );
  bytes.set(new Uint8Array(headerWords.buffer), 0);
  bytes.set(hashBytes, headerWords.byteLength);
  bytes.set(params.labels, headerWords.byteLength + hashBytes.length);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function decodeRegionMapBinary(buffer: ArrayBuffer): DecodedRegionMapAsset {
  if (buffer.byteLength < 16) {
    throw new Error('Region map binary is truncated.');
  }
  const header = new Uint32Array(buffer.slice(0, 16));
  const magic = header[0]!;
  const formatVersion = header[1]!;
  const vertexCount = header[2]!;
  const hashLength = header[3]!;
  if (magic !== REGION_MAP_MAGIC) {
    throw new Error('Region map binary has unexpected magic.');
  }
  if (formatVersion !== REGION_MAP_FORMAT_VERSION) {
    throw new Error(`Unsupported region map format version ${formatVersion}.`);
  }
  const hashStart = 16;
  const hashEnd = hashStart + hashLength;
  const labelsStart = hashEnd;
  const labelsEnd = labelsStart + vertexCount;
  if (buffer.byteLength < labelsEnd) {
    throw new Error('Region map binary payload is truncated.');
  }
  const hashBytes = new Uint8Array(buffer, hashStart, hashLength);
  const labels = new Uint8Array(buffer.slice(labelsStart, labelsEnd));
  return {
    formatVersion,
    vertexCount,
    topologyHash: decodeUtf8(hashBytes),
    labels,
  };
}

/** True when a stored region map no longer matches current topology. */
export function regionMapMatchesTopology(
  reference: PoseableRegionMapReference | undefined,
  topologyHash: string,
  vertexCount: number,
): boolean {
  if (!reference) return false;
  return reference.topologyHash === topologyHash && reference.vertexCount === vertexCount;
}

export async function writeRegionMapBinaryAsset(params: {
  labels: Uint8Array;
  topologyHash: string;
  sourceAssetId: string;
}): Promise<{ assetId: string; uri: string; byteLength: number; reference: PoseableRegionMapReference }> {
  const payload = encodeRegionMapBinary({
    labels: params.labels,
    topologyHash: params.topologyHash,
  });
  const assetId = createId('poseable_region');
  const key = `poseable-region-${assetId}`;
  await putModelAsset(key, payload);
  const reference: PoseableRegionMapReference = {
    version: 1,
    regionAssetId: assetId,
    vertexCount: params.labels.length,
    topologyHash: params.topologyHash,
    sourceAssetId: params.sourceAssetId,
  };
  return {
    assetId,
    uri: `${MODEL_ASSET_URI_PREFIX}${key}`,
    byteLength: payload.byteLength,
    reference,
  };
}

export function createRegionMapProjectAsset(params: {
  assetId: string;
  uri: string;
  byteLength: number;
  rigId: string;
  topologyHash: string;
  vertexCount: number;
}): ProjectAsset {
  return {
    id: params.assetId,
    type: 'model',
    name: `${params.rigId}-regions.bin`,
    uri: params.uri,
    mimeType: 'application/octet-stream',
    createdAt: new Date().toISOString(),
    metadata: {
      poseableRegionMap: true,
      byteLength: params.byteLength,
      topologyHash: params.topologyHash,
      vertexCount: params.vertexCount,
    },
  };
}

export function applyRegionMapToRig(
  rig: PoseableRigAsset,
  reference: PoseableRegionMapReference,
  binderVersion?: number,
): PoseableRigAsset {
  return {
    ...rig,
    regionMap: reference,
    ...(typeof binderVersion === 'number' ? { binderVersion } : {}),
  };
}

/** Load region labels from a panoref-idb URI or memory-registered key. */
export async function loadRegionMapLabelsFromUri(uri: string): Promise<DecodedRegionMapAsset> {
  const prefix = MODEL_ASSET_URI_PREFIX;
  if (!uri.startsWith(prefix)) {
    throw new Error('Region map URI must use the local model asset store.');
  }
  const key = uri.slice(prefix.length);
  const memory = getRegisteredModelAssetBytes(key);
  const bytes = memory ?? await getModelAsset(key);
  if (!bytes) throw new Error('Region map binary is missing from local storage.');
  return decodeRegionMapBinary(bytes);
}

export async function loadRegionMapLabelsForRig(
  rig: PoseableRigAsset,
  assets?: Record<string, ProjectAsset>,
): Promise<DecodedRegionMapAsset | null> {
  const reference = rig.regionMap;
  if (!reference?.regionAssetId) return null;
  const asset = assets?.[reference.regionAssetId];
  if (asset?.uri) {
    return loadRegionMapLabelsFromUri(asset.uri);
  }
  // Fall back to conventional key when registry entry is unavailable.
  const key = `poseable-region-${reference.regionAssetId}`;
  const memory = getRegisteredModelAssetBytes(key);
  const bytes = memory ?? await getModelAsset(key);
  if (!bytes) return null;
  return decodeRegionMapBinary(bytes);
}
