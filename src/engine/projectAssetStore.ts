import type { ProjectAsset } from '../domain/types';

const DATABASE_NAME = 'panoref-project-assets';
const STORE_NAME = 'binary-assets';
const DATABASE_VERSION = 1;

/** Portable manifest references for locally stored image and video payloads. */
export const PROJECT_ASSET_URI_PREFIX = 'panoref-asset:';

const memoryBlobs = new Map<string, Blob>();
const objectUrls = new Map<string, string>();

export interface ProjectAssetBlobWrite {
  key: string;
  blob: Blob;
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local asset storage.'));
  });
}

function makeObjectUrl(key: string, blob: Blob): string {
  const existing = objectUrls.get(key);
  if (existing && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(existing);
  }
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return `${PROJECT_ASSET_URI_PREFIX}${key}`;
  }
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

function persistProjectAssetBlob(key: string, blob: Blob) {
  void putProjectAssetBlobs([{ key, blob }]).catch(() => {
    // The in-memory blob remains available for this session and save/export.
  });
}

export function createProjectAssetStorageKey(projectId: string, assetId: string): string {
  return `project/${projectId}/asset/${assetId}`;
}

export function isStoredProjectAsset(asset: Pick<ProjectAsset, 'storageKey' | 'uri'>): boolean {
  return Boolean(asset.storageKey) || asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX);
}

/**
 * Replaces a data URL with a short blob URL immediately, then persists the Blob
 * to IndexedDB without putting base64 into React/Zustand project state.
 */
export function storeProjectAssetDataUrl<T extends ProjectAsset>(projectId: string, asset: T): T {
  if (!asset.uri.startsWith('data:') || (asset.type !== 'image' && asset.type !== 'video')) return asset;
  const storageKey = asset.storageKey ?? createProjectAssetStorageKey(projectId, asset.id);
  const blob = dataUrlToBlob(asset.uri);
  memoryBlobs.set(storageKey, blob);
  const uri = makeObjectUrl(storageKey, blob);
  persistProjectAssetBlob(storageKey, blob);
  return { ...asset, storageKey, uri };
}

export function storeProjectAssetBlob<T extends ProjectAsset>(projectId: string, asset: T, blob: Blob): T {
  const storageKey = asset.storageKey ?? createProjectAssetStorageKey(projectId, asset.id);
  const uri = registerProjectAssetBlob(storageKey, blob);
  return { ...asset, storageKey, uri };
}

export function registerProjectAssetBlob(key: string, blob: Blob): string {
  memoryBlobs.set(key, blob);
  const uri = makeObjectUrl(key, blob);
  persistProjectAssetBlob(key, blob);
  return uri;
}

export async function putProjectAssetBlobs(entries: readonly ProjectAssetBlobWrite[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDatabase();
  if (!db) {
    for (const entry of entries) memoryBlobs.set(entry.key, entry.blob);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const entry of entries) store.put(entry.blob, entry.key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not store local project assets.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local project asset storage was cancelled.'));
    });
    for (const entry of entries) memoryBlobs.set(entry.key, entry.blob);
  } finally {
    db.close();
  }
}

export async function getProjectAssetBlob(key: string): Promise<Blob | undefined> {
  const cached = memoryBlobs.get(key);
  if (cached) return cached;
  const db = await openDatabase();
  if (!db) return undefined;
  try {
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : undefined);
      request.onerror = () => reject(request.error ?? new Error('Could not read local project asset.'));
    });
    if (blob) memoryBlobs.set(key, blob);
    return blob;
  } finally {
    db.close();
  }
}

export async function resolveProjectAssetUri(asset: Pick<ProjectAsset, 'uri' | 'storageKey'>): Promise<string | undefined> {
  const key = asset.storageKey ?? (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)
    ? asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length)
    : undefined);
  if (!key) return asset.uri;
  const existing = objectUrls.get(key);
  if (existing) return existing;
  const blob = await getProjectAssetBlob(key);
  return blob ? makeObjectUrl(key, blob) : undefined;
}

export async function deleteProjectAssetBlob(key: string): Promise<void> {
  memoryBlobs.delete(key);
  const url = objectUrls.get(key);
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  objectUrls.delete(key);
  const db = await openDatabase();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete local project asset.'));
    });
  } finally {
    db.close();
  }
}

export function resetProjectAssetStoreForTests() {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  }
  memoryBlobs.clear();
  objectUrls.clear();
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Invalid data URL.');
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mimeType = header.match(/^data:([^;,]+)/i)?.[1] ?? 'application/octet-stream';
  if (!/;base64/i.test(header)) return new Blob([decodeURIComponent(payload)], { type: mimeType });
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  } catch {
    // Keep permissive legacy fixtures/imports usable; valid browser data URLs always take the fast path above.
    return new Blob([payload], { type: mimeType });
  }
}
