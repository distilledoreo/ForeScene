import type { ProjectAsset } from '../domain/types';
import { getReferencedProjectAssetIds } from './projectAssets';
import { listAllProjectRevisions } from './projectRevisionStore';

/** Legacy PanoRef database name preserved so existing local binary assets keep opening. */
const LEGACY_DATABASE_NAME = 'panoref-project-assets';
const STORE_NAME = 'binary-assets';
const METADATA_STORE_NAME = 'binary-assets-metadata';
const LAST_ACCESSED_INDEX = 'lastAccessedAt';
/** Schema v3 adds evictable vs authoritative classification for durable LRU. */
const DATABASE_VERSION = 3;

/**
 * Portable manifest references for locally stored image and video payloads.
 * Legacy PanoRef URI scheme — the value is written into saved project manifests,
 * so it stays verbatim across the ForeScene rebrand.
 */
export const PROJECT_ASSET_URI_PREFIX = 'panoref-asset:';

const memoryBlobs = new Map<string, Blob>();
const memoryBlobVersions = new Map<string, number>();
const memoryBlobWrittenAt = new Map<string, number>();
const memoryBlobLastAccessed = new Map<string, number>();
const objectUrls = new Map<string, string>();
const persistenceFailureListeners = new Set<(event: ProjectAssetPersistenceFailure) => void>();
let nextBlobWriteFailureForTests: Error | undefined;
let memoryBlobBytes = 0;
let memoryAccessCounter = 0;
let activeProjectId: string | undefined;
/** Serialize all asset-database operations — WebKit is sensitive to contention between connections and transactions. */
let assetOperationQueue: Promise<void> = Promise.resolve();
let assetDatabasePromise: Promise<IDBDatabase | undefined> | undefined;

/** Working-set guard for decoded image/video Blobs and their object URLs. */
export const DEFAULT_PROJECT_ASSET_MEMORY_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_PROJECT_ASSET_MEMORY_MAX_ENTRIES = 256;
/** Persistent IndexedDB budget for prepared stills and other local raster/video payloads. */
export const DEFAULT_PROJECT_ASSET_PERSISTENT_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_PROJECT_ASSET_PERSISTENT_MAX_ENTRIES = 2048;
let memoryLimits = {
  maxBytes: DEFAULT_PROJECT_ASSET_MEMORY_MAX_BYTES,
  maxEntries: DEFAULT_PROJECT_ASSET_MEMORY_MAX_ENTRIES,
};
let persistentLimits = {
  maxBytes: DEFAULT_PROJECT_ASSET_PERSISTENT_MAX_BYTES,
  maxEntries: DEFAULT_PROJECT_ASSET_PERSISTENT_MAX_ENTRIES,
};
let estimatedPersistentBudgetPromise: Promise<typeof persistentLimits> | undefined;

export interface ProjectAssetBlobWrite {
  key: string;
  blob: Blob;
  /**
   * When true, the payload may be LRU-evicted under the evictable byte budget.
   * Authoritative project media (imports, retainInProject, revision-retained)
   * must remain false.
   */
  evictable?: boolean;
}

export class ProjectAssetStorageQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectAssetStorageQuotaError';
  }
}

export interface ProjectAssetPersistenceFailure {
  key: string;
  error: unknown;
}

interface StoredProjectAssetRecord {
  bytes: ArrayBuffer;
  type: string;
}

interface StoredProjectAssetMetadata {
  key: string;
  byteSize: number;
  type: string;
  createdAt: string;
  lastAccessedAt: string;
  /** False (default) for authoritative project media; true for reconstructable cache rows. */
  evictable?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function startEstimatedPersistentBudgetOnce(): Promise<typeof persistentLimits> {
  if (!estimatedPersistentBudgetPromise) {
    estimatedPersistentBudgetPromise = applyEstimatedProjectAssetBudget();
  }
  return estimatedPersistentBudgetPromise;
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  void startEstimatedPersistentBudgetOnce();
  if (assetDatabasePromise) return assetDatabasePromise;

  let connectionPromise: Promise<IDBDatabase | undefined>;
  connectionPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(METADATA_STORE_NAME)) {
        db.createObjectStore(METADATA_STORE_NAME, { keyPath: 'key' });
      }
      const upgradeTransaction = request.transaction;
      if (!upgradeTransaction) return;
      const metadata = upgradeTransaction.objectStore(METADATA_STORE_NAME);
      if (!metadata.indexNames.contains(LAST_ACCESSED_INDEX)) {
        metadata.createIndex(LAST_ACCESSED_INDEX, 'lastAccessedAt', { unique: false });
      }

      if (event.oldVersion < 3) {
        const metadataStore = upgradeTransaction.objectStore(METADATA_STORE_NAME);
        const cursorRequest = metadataStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const row = cursor.value as StoredProjectAssetMetadata;
          if (row && row.evictable === undefined) {
            cursor.update({ ...row, evictable: false });
          }
          cursor.continue();
        };
      }

      if (event.oldVersion < 2) {
        const blobs = upgradeTransaction.objectStore(STORE_NAME);
        const cursorRequest = blobs.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const key = typeof cursor.key === 'string' ? cursor.key : undefined;
          const blob = readStoredProjectAsset(cursor.value);
          if (key && blob) {
            const stamp = nowIso();
            metadata.put({
              key,
              byteSize: blob.size,
              type: blob.type,
              createdAt: stamp,
              lastAccessedAt: stamp,
              evictable: false,
            } satisfies StoredProjectAssetMetadata);
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (assetDatabasePromise === connectionPromise) assetDatabasePromise = undefined;
      };
      database.onclose = () => {
        if (assetDatabasePromise === connectionPromise) assetDatabasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      if (assetDatabasePromise === connectionPromise) assetDatabasePromise = undefined;
      reject(request.error ?? new Error('Could not open local asset storage.'));
    };
  });
  assetDatabasePromise = connectionPromise;
  return connectionPromise;
}

function makeObjectUrl(key: string, blob: Blob): string {
  touchMemoryBlob(key);
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

/**
 * Return the backing local-storage key for an object URL created by this store.
 * Some legacy/sample manifests kept the managed blob URL but did not persist the
 * storageKey field. Maintenance must still treat that backing payload as live.
 */
export function getManagedProjectAssetBlobKeyForUri(uri: string): string | undefined {
  if (!uri.startsWith('blob:')) return undefined;
  for (const [key, objectUrl] of objectUrls) {
    if (objectUrl === uri) return key;
  }
  return undefined;
}

export function hasResidentProjectAssetBlob(key: string): boolean {
  touchMemoryBlob(key);
  return memoryBlobs.has(key) || objectUrls.has(key);
}

/** Timestamp of the most recent explicit local write/replacement for this key. */
export function getProjectAssetBlobWrittenAt(key: string): number | undefined {
  return memoryBlobWrittenAt.get(key);
}

/**
 * Release only in-memory payloads/object URLs for a departed project. Durable
 * IndexedDB rows remain available for local-first reopening and quota/LRU policy.
 */
export function releaseProjectAssetMemoryForProject(projectId: string): void {
  const prefixes = [`project/${projectId}/`, `import/${projectId}/`];
  const matches = (key: string) => prefixes.some((prefix) => key.startsWith(prefix));
  for (const key of [...memoryBlobs.keys()]) {
    if (!matches(key)) continue;
    removeMemoryBlob(key);
    memoryBlobVersions.delete(key);
    memoryBlobWrittenAt.delete(key);
  }
  for (const [key, url] of [...objectUrls.entries()]) {
    if (!matches(key)) continue;
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
    objectUrls.delete(key);
  }
}

/** Mark the project whose decoded media must remain immediately available. */
export function setProjectAssetMemoryActiveProject(projectId: string | undefined): void {
  activeProjectId = projectId;
  evictMemoryIfNeeded();
}

function isPinnedMemoryKey(key: string): boolean {
  if (!activeProjectId) return false;
  return key.startsWith(`project/${activeProjectId}/`) || key.startsWith(`import/${activeProjectId}/`);
}

function storageKeyForAsset(asset: Pick<ProjectAsset, 'storageKey' | 'uri'>): string | undefined {
  if (asset.storageKey) return asset.storageKey;
  if (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)) {
    return asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length);
  }
  return undefined;
}

/** Mark durable rows as authoritative so LRU eviction cannot delete them. */
export async function markProjectAssetBlobsAuthoritative(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const unique = [...new Set(keys)];
  return enqueueAssetDatabaseOperation(async () => {
    const db = await openDatabase();
    if (!db || !db.objectStoreNames.contains(METADATA_STORE_NAME)) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(METADATA_STORE_NAME, 'readwrite');
      const metadata = transaction.objectStore(METADATA_STORE_NAME);
      for (const key of unique) {
        const getRequest = metadata.get(key);
        getRequest.onsuccess = () => {
          const value = getRequest.result as StoredProjectAssetMetadata | undefined;
          if (value) metadata.put({ ...value, evictable: false });
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not mark project assets authoritative.'));
    });
  });
}

/** Protect every manifest- and revision-referenced payload from durable LRU eviction. */
export async function synchronizeAuthoritativeProjectAssetKeys(
  project: import('../domain/types').LocationProject,
): Promise<void> {
  const keys = new Set<string>();
  for (const assetId of getReferencedProjectAssetIds(project)) {
    const asset = project.assets.assets[assetId];
    if (!asset) continue;
    const key = storageKeyForAsset(asset);
    if (key) keys.add(key);
  }
  const revisions = await listAllProjectRevisions();
  for (const revision of revisions) {
    for (const key of revision.resources.projectAssetKeys ?? []) keys.add(key);
    for (const resource of revision.resources.projectAssets ?? []) keys.add(resource.key);
  }
  await markProjectAssetBlobsAuthoritative([...keys]);
}

async function listStoredMetadata(): Promise<StoredProjectAssetMetadata[]> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise<StoredProjectAssetMetadata[]>((resolve, reject) => {
    const request = db.transaction(METADATA_STORE_NAME, 'readonly').objectStore(METADATA_STORE_NAME).getAll();
    request.onsuccess = () => {
      const rows = (request.result as StoredProjectAssetMetadata[]).filter((row) => (
        row && typeof row.key === 'string' && typeof row.byteSize === 'number'
      ));
      resolve(rows);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not list local project asset metadata.'));
  });
}

async function deleteStoredKeys(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDatabase();
  for (const key of keys) {
    removeMemoryBlob(key);
    memoryBlobVersions.set(key, (memoryBlobVersions.get(key) ?? 0) + 1);
    memoryBlobWrittenAt.delete(key);
    revokeObjectUrlForKey(key);
  }
  if (!db) return;
  const storeNames = db.objectStoreNames.contains(METADATA_STORE_NAME)
    ? [STORE_NAME, METADATA_STORE_NAME]
    : [STORE_NAME];
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeNames, 'readwrite');
    const blobs = transaction.objectStore(STORE_NAME);
    const metadata = storeNames.length > 1
      ? transaction.objectStore(METADATA_STORE_NAME)
      : undefined;
    for (const key of keys) {
      blobs.delete(key);
      metadata?.delete(key);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete local project assets.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local project asset deletion was cancelled.'));
  });
}

async function touchStoredMetadata(key: string, lastAccessedAt = nowIso()): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(METADATA_STORE_NAME, 'readwrite');
    const metadata = transaction.objectStore(METADATA_STORE_NAME);
    const getRequest = metadata.get(key);
    getRequest.onsuccess = () => {
      const value = getRequest.result as StoredProjectAssetMetadata | undefined;
      if (value) metadata.put({ ...value, lastAccessedAt });
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

async function evictPersistentIfNeeded(protectedKey?: string): Promise<void> {
  await startEstimatedPersistentBudgetOnce();
  const all = await listStoredMetadata();
  const evictable = all.filter((row) => row.evictable === true);
  evictable.sort((a, b) => (Date.parse(a.lastAccessedAt) || 0) - (Date.parse(b.lastAccessedAt) || 0));
  let totalBytes = evictable.reduce((sum, row) => sum + row.byteSize, 0);
  const toDelete: string[] = [];
  const isProtected = (key: string) => key === protectedKey || toDelete.includes(key);

  while (
    (evictable.length - toDelete.length > persistentLimits.maxEntries)
    || (totalBytes > persistentLimits.maxBytes)
  ) {
    const candidate = evictable.find((row) => !isProtected(row.key));
    if (!candidate) break;
    toDelete.push(candidate.key);
    totalBytes -= candidate.byteSize;
  }

  if (toDelete.length > 0) await deleteStoredKeys(toDelete);
}

async function writeStoredMetadata(
  key: string,
  blob: Blob,
  options: { replace: boolean; evictable: boolean },
): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  const stamp = nowIso();
  const existing = options.replace
    ? undefined
    : await new Promise<StoredProjectAssetMetadata | undefined>((resolve, reject) => {
      const request = db.transaction(METADATA_STORE_NAME, 'readonly').objectStore(METADATA_STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as StoredProjectAssetMetadata | undefined);
      request.onerror = () => reject(request.error ?? new Error('Could not read local project asset metadata.'));
    });
  const metadata: StoredProjectAssetMetadata = {
    key,
    byteSize: blob.size,
    type: blob.type,
    createdAt: existing?.createdAt ?? stamp,
    lastAccessedAt: stamp,
    evictable: options.evictable,
  };
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(METADATA_STORE_NAME, 'readwrite');
    transaction.objectStore(METADATA_STORE_NAME).put(metadata);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not store local project asset metadata.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local project asset metadata write was cancelled.'));
  });
}

function touchMemoryBlob(key: string): void {
  if (!memoryBlobs.has(key)) return;
  memoryAccessCounter += 1;
  memoryBlobLastAccessed.set(key, memoryAccessCounter);
}

function removeMemoryBlob(key: string): void {
  const previous = memoryBlobs.get(key);
  if (!previous) return;
  memoryBlobBytes = Math.max(0, memoryBlobBytes - previous.size);
  memoryBlobs.delete(key);
  memoryBlobLastAccessed.delete(key);
}

function revokeObjectUrlForKey(key: string): void {
  const url = objectUrls.get(key);
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
  objectUrls.delete(key);
}

function oldestEvictableMemoryKey(): string | undefined {
  let oldestKey: string | undefined;
  let oldestAccess = Number.POSITIVE_INFINITY;
  for (const [key, accessed] of memoryBlobLastAccessed) {
    if (isPinnedMemoryKey(key)) continue;
    if (accessed < oldestAccess) {
      oldestAccess = accessed;
      oldestKey = key;
    }
  }
  return oldestKey;
}

function evictMemoryIfNeeded(): void {
  while (
    memoryBlobs.size > memoryLimits.maxEntries
    || memoryBlobBytes > memoryLimits.maxBytes
  ) {
    // Keep one oversized entry available for the current operation. It can
    // still be released on project switch or explicit deletion.
    if (memoryBlobs.size <= 1) break;
    const key = oldestEvictableMemoryKey();
    if (!key) break;
    removeMemoryBlob(key);
    // A revoked URL can be recreated from the durable row on demand. Keeping
    // it alive would retain the Blob even after the memory entry was evicted.
    revokeObjectUrlForKey(key);
  }
}

function persistProjectAssetBlob(key: string, blob: Blob) {
  void putProjectAssetBlobs([{ key, blob, evictable: false }]).catch((error) => {
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

/**
 * Store a Blob in memory and await durable IndexedDB write before returning.
 * Use for prepared-media commits where the project must not reference unpersisted bytes.
 * On failure, removes the in-memory/object-URL registration so callers stay clean.
 */
export interface StoreProjectAssetBlobDurableOptions {
  /** When true, the payload may participate in the evictable LRU budget. Defaults to false. */
  evictable?: boolean;
}

export function resolveProjectAssetDurableEvictable(
  asset: Pick<ProjectAsset, 'metadata'>,
  options?: StoreProjectAssetBlobDurableOptions,
): boolean {
  if (asset.metadata?.retainInProject === true) return false;
  return options?.evictable === true;
}

export async function storeProjectAssetBlobDurable<T extends ProjectAsset>(
  projectId: string,
  asset: T,
  blob: Blob,
  options?: StoreProjectAssetBlobDurableOptions,
): Promise<T> {
  const storageKey = asset.storageKey ?? createProjectAssetStorageKey(projectId, asset.id);
  const evictable = resolveProjectAssetDurableEvictable(asset, options);
  cacheProjectAssetBlob(storageKey, blob, true);
  try {
    await putProjectAssetBlobs([{ key: storageKey, blob, evictable }]);
  } catch (error) {
    removeMemoryBlob(storageKey);
    memoryBlobVersions.set(storageKey, (memoryBlobVersions.get(storageKey) ?? 0) + 1);
    memoryBlobWrittenAt.delete(storageKey);
    revokeObjectUrlForKey(storageKey);
    throw error;
  }
  const uri = makeObjectUrl(storageKey, blob);
  return { ...asset, storageKey, uri };
}

export function registerProjectAssetBlob(key: string, blob: Blob): string {
  cacheProjectAssetBlob(key, blob, true);
  const uri = makeObjectUrl(key, blob);
  persistProjectAssetBlob(key, blob);
  return uri;
}

function cacheProjectAssetBlob(key: string, blob: Blob, replace: boolean): void {
  const previous = memoryBlobs.get(key);
  if (previous) memoryBlobBytes = Math.max(0, memoryBlobBytes - previous.size);
  memoryBlobs.set(key, blob);
  memoryBlobBytes += blob.size;
  touchMemoryBlob(key);
  if (replace) {
    memoryBlobVersions.set(key, (memoryBlobVersions.get(key) ?? 0) + 1);
    memoryBlobWrittenAt.set(key, Date.now());
  }
  evictMemoryIfNeeded();
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
  const storedEntries: Array<{ key: string; value: StoredProjectAssetRecord; evictable: boolean }> = [];
  for (const entry of entries) {
    if (entry.blob.size > persistentLimits.maxBytes) {
      throw new ProjectAssetStorageQuotaError(
        `Project asset "${entry.key}" (${entry.blob.size} bytes) exceeds the persistent storage limit (${persistentLimits.maxBytes} bytes).`,
      );
    }
    storedEntries.push({
      key: entry.key,
      value: { bytes: await entry.blob.arrayBuffer(), type: entry.blob.type },
      evictable: entry.evictable === true,
    });
  }
  if (storedEntries.length === 0) return;

  await startEstimatedPersistentBudgetOnce();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    for (const entry of storedEntries) store.put(entry.value, entry.key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not store local project assets.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local project asset storage was cancelled.'));
  });
  for (const entry of storedEntries) {
    const source = entries.find((candidate) => candidate.key === entry.key);
    if (!source) continue;
    await writeStoredMetadata(entry.key, source.blob, { replace: true, evictable: entry.evictable });
    cacheProjectAssetBlob(entry.key, source.blob, true);
    await evictPersistentIfNeeded(entry.key);
  }
}

function readStoredProjectAsset(value: unknown): Blob | undefined {
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return new Blob([value]);
  if (ArrayBuffer.isView(value)) {
    return new Blob([value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)]);
  }
  if (!value || typeof value !== 'object' || !('bytes' in value)) return undefined;
  const record = value as Partial<StoredProjectAssetRecord>;
  if (!(record.bytes instanceof ArrayBuffer)) return undefined;
  return new Blob([record.bytes], { type: typeof record.type === 'string' ? record.type : '' });
}

function enqueueAssetDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = assetOperationQueue.then(operation);
  assetOperationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function putProjectAssetBlobs(entries: readonly ProjectAssetBlobWrite[]): Promise<void> {
  if (entries.length === 0) return Promise.resolve();
  return enqueueAssetDatabaseOperation(() => putProjectAssetBlobsNow(entries));
}

export async function getProjectAssetBlob(key: string): Promise<Blob | undefined> {
  const cached = memoryBlobs.get(key);
  if (cached) {
    touchMemoryBlob(key);
    void enqueueAssetDatabaseOperation(() => touchStoredMetadata(key));
    return cached;
  }
  return enqueueAssetDatabaseOperation(async () => {
    const cachedAfterQueue = memoryBlobs.get(key);
    if (cachedAfterQueue) {
      touchMemoryBlob(key);
      void touchStoredMetadata(key);
      return cachedAfterQueue;
    }
    const db = await openDatabase();
    if (!db) return undefined;
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(readStoredProjectAsset(request.result));
      request.onerror = () => reject(request.error ?? new Error('Could not read local project asset.'));
    });
    if (blob) {
      cacheProjectAssetBlob(key, blob, false);
      await touchStoredMetadata(key);
    }
    return blob;
  });
}

/** List local keys for diagnostics and deferred, revision-aware cleanup. */
export async function listProjectAssetBlobKeys(): Promise<string[]> {
  return enqueueAssetDatabaseOperation(async () => {
    const metadata = await listStoredMetadata();
    if (metadata.length > 0) return metadata.map((row) => row.key);
    const db = await openDatabase();
    if (!db) return [...memoryBlobs.keys()];
    return new Promise<string[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === 'string'));
      request.onerror = () => reject(request.error ?? new Error('Could not list local project assets.'));
    });
  });
}

export async function resolveProjectAssetUri(asset: Pick<ProjectAsset, 'uri' | 'storageKey'>): Promise<string | undefined> {
  const key = asset.storageKey ?? (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)
    ? asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length)
    : undefined);
  if (!key) return asset.uri;
  const existing = objectUrls.get(key);
  if (existing) {
    touchMemoryBlob(key);
    return existing;
  }
  const blob = await getProjectAssetBlob(key);
  return blob ? makeObjectUrl(key, blob) : undefined;
}

export async function deleteProjectAssetBlob(key: string): Promise<void> {
  return enqueueAssetDatabaseOperation(async () => {
    await deleteStoredKeys([key]);
  });
}

export function resetProjectAssetStoreForTests() {
  const databasePromise = assetDatabasePromise;
  assetDatabasePromise = undefined;
  void assetOperationQueue.then(() => databasePromise?.then((database) => database?.close())).catch(() => undefined);
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  }
  memoryBlobs.clear();
  memoryBlobBytes = 0;
  memoryBlobLastAccessed.clear();
  memoryAccessCounter = 0;
  memoryBlobVersions.clear();
  memoryBlobWrittenAt.clear();
  objectUrls.clear();
  persistenceFailureListeners.clear();
  nextBlobWriteFailureForTests = undefined;
  activeProjectId = undefined;
  memoryLimits = {
    maxBytes: DEFAULT_PROJECT_ASSET_MEMORY_MAX_BYTES,
    maxEntries: DEFAULT_PROJECT_ASSET_MEMORY_MAX_ENTRIES,
  };
  persistentLimits = {
    maxBytes: DEFAULT_PROJECT_ASSET_PERSISTENT_MAX_BYTES,
    maxEntries: DEFAULT_PROJECT_ASSET_PERSISTENT_MAX_ENTRIES,
  };
  estimatedPersistentBudgetPromise = undefined;
  assetOperationQueue = Promise.resolve();
}

export function getProjectAssetPersistentLimits(): typeof persistentLimits {
  return { ...persistentLimits };
}

export function setProjectAssetPersistentLimitsForTests(limits: {
  maxBytes?: number;
  maxEntries?: number;
}): void {
  if (typeof limits.maxBytes === 'number' && Number.isFinite(limits.maxBytes) && limits.maxBytes > 0) {
    persistentLimits.maxBytes = Math.floor(limits.maxBytes);
  }
  if (typeof limits.maxEntries === 'number' && Number.isFinite(limits.maxEntries) && limits.maxEntries >= 1) {
    persistentLimits.maxEntries = Math.floor(limits.maxEntries);
  }
}

/** Wait for queued durable asset operations scheduled before this call. */
export async function flushProjectAssetStoreOperationsForTests(): Promise<void> {
  await assetOperationQueue;
}

/**
 * Prefer a free-quota-based persistent budget when the Storage API is available.
 * The in-memory working set remains fixed and conservative.
 */
export async function applyEstimatedProjectAssetBudget(): Promise<typeof persistentLimits> {
  const minimumTarget = 128 * 1024 * 1024; // 128 MiB
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      const free = Math.max(0, quota - usage);
      if (free > 0) {
        const target = Math.max(minimumTarget, Math.floor(free * 0.2));
        const budget = Math.min(DEFAULT_PROJECT_ASSET_PERSISTENT_MAX_BYTES, target, free);
        if (budget > 0) persistentLimits.maxBytes = budget;
      }
    }
  } catch {
    // Keep defaults.
  }
  return getProjectAssetPersistentLimits();
}

export function setProjectAssetMemoryLimitsForTests(limits: {
  maxBytes?: number;
  maxEntries?: number;
}): void {
  memoryLimits = {
    maxBytes: Math.max(1, limits.maxBytes ?? memoryLimits.maxBytes),
    maxEntries: Math.max(1, Math.floor(limits.maxEntries ?? memoryLimits.maxEntries)),
  };
  evictMemoryIfNeeded();
}

export function inspectProjectAssetMemoryForTests(): {
  bytes: number;
  keys: string[];
  activeProjectId?: string;
} {
  return {
    bytes: memoryBlobBytes,
    keys: [...memoryBlobs.keys()],
    activeProjectId,
  };
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
    return new Blob([payload], { type: mimeType });
  }
}
