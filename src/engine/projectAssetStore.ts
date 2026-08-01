import type { ProjectAsset } from '../domain/types';

/** Legacy PanoRef database name preserved so existing local binary assets keep opening. */
const LEGACY_DATABASE_NAME = 'panoref-project-assets';
const STORE_NAME = 'binary-assets';
const DATABASE_VERSION = 1;

/**
 * Portable manifest references for locally stored image and video payloads.
 * Legacy PanoRef URI scheme — the value is written into saved project manifests,
 * so it stays verbatim across the ForeScene rebrand.
 */
export const PROJECT_ASSET_URI_PREFIX = 'panoref-asset:';

const memoryBlobs = new Map<string, Blob>();
const memoryBlobVersions = new Map<string, number>();
const objectUrls = new Map<string, string>();
const persistenceFailureListeners = new Set<(event: ProjectAssetPersistenceFailure) => void>();
let nextBlobWriteFailureForTests: Error | undefined;
/** Serialize fire-and-forget IDB writes — WebKit is sensitive to overlapping open/put/close. */
let assetWriteQueue: Promise<void> = Promise.resolve();

export interface ProjectAssetBlobWrite {
  key: string;
  blob: Blob;
}

export interface ProjectAssetPersistenceFailure {
  key: string;
  error: unknown;
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DATABASE_NAME, DATABASE_VERSION);
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
  void putProjectAssetBlobs([{ key, blob }]).catch((error) => {
    // The in-memory blob remains usable for the current session, but this is
    // now observable by the project safety controller instead of being a
    // silent durability failure.
    for (const listener of persistenceFailureListeners) listener({ key, error });
  });
}

/** Observe asynchronous cache-write failures from synchronous asset actions. */
export function subscribeProjectAssetPersistenceFailures(
  listener: (event: ProjectAssetPersistenceFailure) => void,
): () => void {
  persistenceFailureListeners.add(listener);
  return () => persistenceFailureListeners.delete(listener);
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
  cacheProjectAssetBlob(storageKey, blob, true);
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
  cacheProjectAssetBlob(key, blob, true);
  const uri = makeObjectUrl(key, blob);
  persistProjectAssetBlob(key, blob);
  return uri;
}

function cacheProjectAssetBlob(key: string, blob: Blob, replace: boolean): void {
  memoryBlobs.set(key, blob);
  if (replace) memoryBlobVersions.set(key, (memoryBlobVersions.get(key) ?? 0) + 1);
}

/** Changes whenever a local raster/video key is explicitly replaced or removed. */
export function getProjectAssetBlobVersion(key: string): number | undefined {
  return memoryBlobVersions.get(key);
}

async function putProjectAssetBlobsNow(entries: readonly ProjectAssetBlobWrite[]): Promise<void> {
  if (nextBlobWriteFailureForTests) {
    const error = nextBlobWriteFailureForTests;
    nextBlobWriteFailureForTests = undefined;
    throw error;
  }
  const db = await openDatabase();
  if (!db) {
    for (const entry of entries) cacheProjectAssetBlob(entry.key, entry.blob, true);
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
    for (const entry of entries) cacheProjectAssetBlob(entry.key, entry.blob, true);
  } finally {
    db.close();
  }
}

export function putProjectAssetBlobs(entries: readonly ProjectAssetBlobWrite[]): Promise<void> {
  if (entries.length === 0) return Promise.resolve();

  const write = assetWriteQueue.then(() => putProjectAssetBlobsNow(entries));
  // Keep the queue usable after a failed operation while still rejecting the
  // current caller so persistence failures remain observable.
  assetWriteQueue = write.catch(() => undefined);
  return write;
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
    if (blob) cacheProjectAssetBlob(key, blob, false);
    return blob;
  } finally {
    db.close();
  }
}

/** List local keys for diagnostics and deferred, revision-aware cleanup. */
export async function listProjectAssetBlobKeys(): Promise<string[]> {
  const db = await openDatabase();
  if (!db) return [...memoryBlobs.keys()];
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === 'string'));
      request.onerror = () => reject(request.error ?? new Error('Could not list local project assets.'));
    });
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
  memoryBlobVersions.set(key, (memoryBlobVersions.get(key) ?? 0) + 1);
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
  memoryBlobVersions.clear();
  objectUrls.clear();
  persistenceFailureListeners.clear();
  nextBlobWriteFailureForTests = undefined;
  assetWriteQueue = Promise.resolve();
}

/** Deterministically exercise a durable binary-write failure in regression tests. */
export function failNextProjectAssetBlobWriteForTests(message = 'Injected project asset storage write failure.'): void {
  nextBlobWriteFailureForTests = new Error(message);
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
