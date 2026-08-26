import * as THREE from 'three';
import { AssetRegistry, ProjectAsset, SceneObject } from '../domain/types';
import { getRegisteredModelAssetBytes } from './modelAssetStore';
import {
  LEGACY_PANOREF_MESH_MIME,
  LEGACY_PANOREF_MESH_VERSION,
  MAX_PACKED_MESH_BYTES,
  MODEL_ASSET_URI_PREFIX,
  MISSING_ASSET_URI_PREFIX,
} from './importedMeshConstants';
export {
  LEGACY_PANOREF_MESH_MIME,
  LEGACY_PANOREF_MESH_VERSION,
  MAX_PACKED_MESH_BYTES,
  MODEL_ASSET_URI_PREFIX,
  MISSING_ASSET_URI_PREFIX,
} from './importedMeshConstants';

const HEADER_BYTES = 40;
const MAGIC = [0x50, 0x52, 0x47, 0x4d] as const; // PRGM
const CACHE_IDLE_MS = 30_000;

interface GeometryCacheEntry {
  assetUri: string;
  geometry: THREE.BufferGeometry;
  references: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
}

const geometryCache = new Map<string, GeometryCacheEntry>();

export interface PackedGrayboxMesh {
  uri: string;
  byteLength: number;
  vertexCount: number;
  triangleCount: number;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface BinaryPackedGrayboxMesh extends Omit<PackedGrayboxMesh, 'uri'> {
  buffer: ArrayBuffer;
}

export function encodeBinaryGrayboxMesh(positions: Float32Array, indices: Uint32Array): BinaryPackedGrayboxMesh {
  const legacy = encodePackedBuffer(positions, indices);
  return { buffer: legacy.buffer, byteLength: legacy.byteLength, vertexCount: legacy.vertexCount, triangleCount: legacy.triangleCount, bounds: legacy.bounds };
}

/**
 * Encode exact triangle positions/indices into ForeScene's small synchronous runtime format.
 * Materials, texture coordinates, animation and hierarchy intentionally do not belong here.
 */
export function encodePackedGrayboxMesh(
  positions: Float32Array,
  indices: Uint32Array,
): PackedGrayboxMesh {
  const packed = encodePackedBuffer(positions, indices);
  return { ...packed, uri: `data:${LEGACY_PANOREF_MESH_MIME};base64,${bytesToBase64(new Uint8Array(packed.buffer))}` };
}

function encodePackedBuffer(positions: Float32Array, indices: Uint32Array): BinaryPackedGrayboxMesh {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new Error('Imported geometry must contain XYZ vertex positions.');
  }
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new Error('Imported geometry must contain triangle indices.');
  }

  const vertexCount = positions.length / 3;
  for (let index = 0; index < indices.length; index += 1) {
    if (indices[index] >= vertexCount) {
      throw new Error('Imported geometry contains an out-of-range triangle index.');
    }
  }

  const bounds = positionBounds(positions);
  const normals = computeIndexedNormals(positions, indices);
  const byteLength = HEADER_BYTES + positions.byteLength + indices.byteLength + normals.byteLength;
  if (byteLength > MAX_PACKED_MESH_BYTES) {
    throw new Error(
      `The texture-free mesh would use ${formatMegabytes(byteLength)}, above the ${formatMegabytes(MAX_PACKED_MESH_BYTES)} safety limit. No geometry was simplified.`,
    );
  }

  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(MAGIC, 0);
  const view = new DataView(buffer);
  view.setUint16(4, LEGACY_PANOREF_MESH_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, vertexCount, true);
  view.setUint32(12, indices.length, true);
  bounds.min.forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  bounds.max.forEach((value, index) => view.setFloat32(28 + index * 4, value, true));
  new Float32Array(buffer, HEADER_BYTES, positions.length).set(positions);
  new Uint32Array(buffer, HEADER_BYTES + positions.byteLength, indices.length).set(indices);
  new Float32Array(buffer, HEADER_BYTES + positions.byteLength + indices.byteLength, normals.length).set(normals);

  return {
    buffer,
    byteLength,
    vertexCount,
    triangleCount: indices.length / 3,
    bounds,
  };
}

export function createImportedMeshNode(
  object: SceneObject,
  assets: AssetRegistry | undefined,
  material: THREE.Material,
  options?: { centerNonSetMesh?: boolean },
): THREE.Object3D {
  const root = new THREE.Group();
  const asset = object.modelAssetId ? assets?.assets[object.modelAssetId] : undefined;
  if (!asset) return createMissingMeshPlaceholder(root, object, undefined, 'The imported mesh asset is missing.');
  if (asset.resolutionStatus && asset.resolutionStatus !== 'available') {
    return createMissingMeshPlaceholder(root, object, asset, `The ${asset.resolutionStatus} model asset is unavailable.`);
  }

  try {
    const geometry = acquireGeometry(asset);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.importedModelAssetId = asset.id;
    const sourceSize = geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);
    mesh.scale.set(
      safeDimensionRatio(object.dimensions[0], sourceSize.x) * object.transform.scale[0],
      safeDimensionRatio(object.dimensions[1], sourceSize.y) * object.transform.scale[1],
      safeDimensionRatio(object.dimensions[2], sourceSize.z) * object.transform.scale[2],
    );
    if (object.stagingRole !== 'set' && options?.centerNonSetMesh !== false) {
      centerMeshOnGeometryBounds(mesh);
    }
    root.add(mesh);
    root.userData.importedModelAssetId = asset.id;
    // Keep the historical geometry/material surface available to importer
    // integrations while the scene graph now uses a stable root node.
    Object.defineProperty(root, 'geometry', { configurable: true, get: () => mesh.geometry });
    Object.defineProperty(root, 'material', { configurable: true, get: () => mesh.material });
    return root;
  } catch (error) {
    return createMissingMeshPlaceholder(
      root,
      object,
      asset,
      error instanceof Error ? error.message : 'The imported mesh asset is invalid.',
    );
  }
}

/** Release a cached geometry reference instead of invalidating shared GPU buffers. */
export function releaseImportedGeometry(geometry: THREE.BufferGeometry): boolean {
  const cacheKey = geometry.userData.panorefImportedCacheKey;
  if (typeof cacheKey !== 'string') return false;
  const entry = geometryCache.get(cacheKey);
  if (!entry || entry.geometry !== geometry) return true;
  entry.references = Math.max(0, entry.references - 1);
  if (entry.references === 0 && !entry.disposeTimer) {
    entry.disposeTimer = setTimeout(() => {
      const current = geometryCache.get(cacheKey);
      if (!current || current.references > 0) return;
      current.geometry.dispose();
      geometryCache.delete(cacheKey);
    }, CACHE_IDLE_MS);
    if (typeof entry.disposeTimer === 'object' && 'unref' in entry.disposeTimer) {
      entry.disposeTimer.unref();
    }
  }
  return true;
}

export function resetImportedMeshCacheForTests() {
  geometryCache.forEach((entry) => {
    if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
    entry.geometry.dispose();
  });
  geometryCache.clear();
}

function acquireGeometry(asset: ProjectAsset): THREE.BufferGeometry {
  // A durable save may rekey an imported model from its transient import URI
  // to an immutable recovery-resource URI while the live viewport still owns
  // the old geometry. Keep those identities side by side until their own
  // references drain instead of turning the export rebuild into a placeholder.
  const cacheKey = `${asset.id}\u0000${asset.uri}`;
  const cached = geometryCache.get(cacheKey);
  if (cached) {
    if (cached.disposeTimer) clearTimeout(cached.disposeTimer);
    cached.disposeTimer = undefined;
    cached.references += 1;
    return cached.geometry;
  }

  const geometry = decodeGeometry(asset);
  geometry.userData.panorefImportedCacheKey = cacheKey;
  geometryCache.set(cacheKey, {
    assetUri: asset.uri,
    geometry,
    references: 1,
  });
  return geometry;
}

function decodeGeometry(asset: ProjectAsset): THREE.BufferGeometry {
  const prefix = `data:${LEGACY_PANOREF_MESH_MIME};base64,`;
  if (asset.type !== 'model') {
    throw new Error('Unsupported imported mesh asset encoding.');
  }
  const bytes = asset.uri.startsWith(prefix)
    ? base64ToBytes(asset.uri.slice(prefix.length))
    : asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)
      ? (() => {
        const stored = getRegisteredModelAssetBytes(asset.uri.slice(MODEL_ASSET_URI_PREFIX.length));
        if (!stored) throw new Error('The binary model asset is unavailable. Reopen the project package or reimport the source model.');
        return new Uint8Array(stored);
      })()
      : (() => { throw new Error('Unsupported imported mesh asset encoding.'); })();
  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_PACKED_MESH_BYTES) {
    throw new Error('Imported mesh asset size is invalid.');
  }
  if (MAGIC.some((value, index) => bytes[index] !== value)) {
    throw new Error('Imported mesh asset header is invalid.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== 1 && version !== LEGACY_PANOREF_MESH_VERSION) {
    throw new Error(`Imported mesh asset version ${version} is not supported.`);
  }
  const vertexCount = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  if (vertexCount === 0 || indexCount === 0 || indexCount % 3 !== 0) {
    throw new Error('Imported mesh asset contains no triangles.');
  }
  const positionBytes = vertexCount * 3 * 4;
  const indexBytes = indexCount * 4;
  const expectedBytes = HEADER_BYTES + positionBytes + indexBytes + (version >= 2 ? positionBytes : 0);
  if (expectedBytes !== bytes.byteLength) {
    throw new Error('Imported mesh asset payload length is invalid.');
  }

  // Typed-array views share the binary payload; decoding does not duplicate the
  // complete position and index buffers.
  const positions = new Float32Array(bytes.buffer, bytes.byteOffset + HEADER_BYTES, vertexCount * 3);
  const indexOffset = HEADER_BYTES + positionBytes;
  const indices = new Uint32Array(bytes.buffer, bytes.byteOffset + indexOffset, indexCount);
  for (let index = 0; index < indices.length; index += 1) {
    const value = indices[index];
    if (value >= vertexCount) throw new Error('Imported mesh asset has an out-of-range index.');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (version >= 2) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bytes.buffer, bytes.byteOffset + indexOffset + indexBytes, vertexCount * 3), 3));
  else geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function computeIndexedNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] * 3; const b = indices[offset + 1] * 3; const c = indices[offset + 2] * 3;
    const abx = positions[b] - positions[a]; const aby = positions[b + 1] - positions[a + 1]; const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a]; const acy = positions[c + 1] - positions[a + 1]; const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy; const ny = abz * acx - abx * acz; const nz = abx * acy - aby * acx;
    for (const vertex of [a, b, c]) { normals[vertex] += nx; normals[vertex + 1] += ny; normals[vertex + 2] += nz; }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    normals[offset] /= length; normals[offset + 1] /= length; normals[offset + 2] /= length;
  }
  return normals;
}

function createMissingMeshPlaceholder(
  root: THREE.Group,
  object: SceneObject,
  asset: ProjectAsset | undefined,
  error: string,
): THREE.Group {
  const dimensions = asset?.dimensions ?? object.dimensions;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...dimensions),
    new THREE.MeshStandardMaterial({
      color: 0xd97706,
      emissive: 0x4a2600,
      emissiveIntensity: 0.45,
      transparent: true,
      opacity: 0.82,
      wireframe: true,
    }),
  );
  mesh.scale.fromArray(object.transform.scale);
  mesh.userData.importedModelError = error;
  mesh.userData.missingAssetPlaceholder = true;
  if (asset) mesh.userData.missingAssetId = asset.id;
  root.add(mesh);
  Object.defineProperty(root, 'geometry', { configurable: true, get: () => mesh.geometry });
  Object.defineProperty(root, 'material', { configurable: true, get: () => mesh.material });
  root.userData.missingAssetPlaceholder = true;
  if (asset) root.userData.missingAssetId = asset.id;
  const label = createMissingAssetLabel(asset?.originalFileName ?? asset?.name ?? object.name);
  if (label) {
    label.position.y = Math.max(dimensions[1], 0.5) * 0.65;
    root.add(label);
  }
  return root;
}

function createMissingAssetLabel(name: string): THREE.Sprite | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.fillStyle = 'rgba(78, 45, 8, 0.9)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#fff7ed';
  context.font = 'bold 28px sans-serif';
  context.fillText(`Missing asset: ${name}`, 18, 58);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
    depthTest: false,
  }));
  sprite.scale.set(2.4, 0.45, 1);
  sprite.userData.missingAssetLabel = true;
  return sprite;
}

function centerMeshOnGeometryBounds(mesh: THREE.Mesh): void {
  const box = mesh.geometry.boundingBox;
  if (!box) return;
  mesh.position.set(
    -0.5 * (box.min.x + box.max.x) * mesh.scale.x,
    -0.5 * (box.min.y + box.max.y) * mesh.scale.y,
    -0.5 * (box.min.z + box.max.z) * mesh.scale.z,
  );
}

function safeDimensionRatio(current: number, source: number) {
  return current / Math.max(Math.abs(source), 1e-6);
}

function positionBounds(positions: Float32Array): PackedGrayboxMesh['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      if (!Number.isFinite(value)) throw new Error('Imported geometry contains a non-finite vertex.');
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error('Imported mesh asset is not valid base64 data.');
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function formatMegabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
