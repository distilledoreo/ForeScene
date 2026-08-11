/**
 * Persistent fingerprinted MP4 cache (memory + IndexedDB).
 *
 * Exact-match only. Persistent and in-memory caches use separate LRU budgets:
 * IndexedDB can retain a large warm package, while the browser tab keeps only
 * a conservative working set of Blob references.
 */

import type { VideoArtifactFingerprint } from './videoArtifactFingerprint';
import type { VideoEncoderMode } from '../domain/types';
import type { VideoRenderTiming } from './videoRenderTiming';

const DATABASE_NAME = 'forescene-video-artifacts';
const STORE_NAME = 'mp4-blobs';
const METADATA_STORE_NAME = 'mp4-metadata';
const LAST_ACCESSED_INDEX = 'lastAccessedAt';
/** Schema v3 separates LRU metadata from the Blob-bearing store. */
const DATABASE_VERSION = 3;

/** Persistent cache default: enough for a large package of motion clips. */
export const DEFAULT_VIDEO_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Persistent metadata-row guard. */
export const DEFAULT_VIDEO_CACHE_MAX_ENTRIES = 256;
/** In-memory Blob budget: deliberately much smaller than persistent storage. */
export const DEFAULT_VIDEO_MEMORY_CACHE_MAX_BYTES = 128 * 1024 * 1024; // 128 MiB
/** Secondary in-memory guard for many tiny clips. */
export const DEFAULT_VIDEO_MEMORY_CACHE_MAX_ENTRIES = 24;

export interface VideoArtifactCacheLimits {
  maxBytes: number;
  maxEntries: number;
}

export interface VideoArtifactCacheRecord {
  key: string;
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  frameCount: number;
  codecString?: string;
  encodeMode: 'render' | 'quickPreview';
  actualEncoderMode: VideoEncoderMode;
  /** Whether the original encode fell back from fast → quality. */
  encoderModeFallback: boolean;
  dependencyIds: string[];
  shotId: string;
  createdAt: string;
  lastAccessedAt: string;
  byteSize: number;
  timing?: VideoRenderTiming;
}

/** IndexedDB value — stores Blob directly (no ArrayBuffer copy). */
interface StoredVideoArtifactRecord {
  key: string;
  blob?: Blob;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  frameCount: number;
  codecString?: string;
  encodeMode: 'render' | 'quickPreview';
  actualEncoderMode: VideoEncoderMode;
  encoderModeFallback?: boolean;
  dependencyIds: string[];
  shotId: string;
  createdAt: string;
  lastAccessedAt: string;
  byteSize: number;
  timing?: VideoRenderTiming;
  /** Legacy v1 field; migrated on read. */
  bytes?: ArrayBuffer;
}

type StoredVideoArtifactMetadata = Omit<StoredVideoArtifactRecord, 'blob' | 'bytes'>;

interface StoredVideoBlobRecord {
  key: string;
  blob?: Blob;
  /** Legacy v1 field. */
  bytes?: ArrayBuffer;
}

const memoryCache = new Map<string, VideoArtifactCacheRecord>();
let limits: VideoArtifactCacheLimits = {
  maxBytes: DEFAULT_VIDEO_CACHE_MAX_BYTES,
  maxEntries: DEFAULT_VIDEO_CACHE_MAX_ENTRIES,
};
let memoryLimits: VideoArtifactCacheLimits = {
  maxBytes: DEFAULT_VIDEO_MEMORY_CACHE_MAX_BYTES,
  maxEntries: DEFAULT_VIDEO_MEMORY_CACHE_MAX_ENTRIES,
};
let databasePromise: Promise<IDBDatabase | undefined> | undefined;
let operationQueue: Promise<void> = Promise.resolve();
let estimatedBudgetPromise: Promise<VideoArtifactCacheLimits> | undefined;

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = operationQueue.then(operation, operation);
  operationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function startEstimatedBudgetOnce(): Promise<VideoArtifactCacheLimits> {
  if (!estimatedBudgetPromise) {
    estimatedBudgetPromise = applyEstimatedVideoCacheBudget();
  }
  return estimatedBudgetPromise;
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  void startEstimatedBudgetOnce();
  if (databasePromise) return databasePromise;

  let connectionPromise: Promise<IDBDatabase | undefined>;
  connectionPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
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

      // Seed the metadata store while upgrading existing v1/v2 rows. The old
      // Blob-bearing rows are intentionally left readable as a migration
      // fallback; new writes use the split stores below.
      if (event.oldVersion < 3) {
        const blobs = upgradeTransaction.objectStore(STORE_NAME);
        const cursorRequest = blobs.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const raw = cursor.value as StoredVideoArtifactRecord;
          const blob = readStoredVideoBlob(raw);
          if (blob) metadata.put(toStoredMetadataFromRaw(raw, blob));
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (databasePromise === connectionPromise) databasePromise = undefined;
      };
      database.onclose = () => {
        if (databasePromise === connectionPromise) databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      if (databasePromise === connectionPromise) databasePromise = undefined;
      reject(request.error ?? new Error('Could not open video artifact cache.'));
    };
  });
  databasePromise = connectionPromise;
  return connectionPromise;
}

function nowIso(): string {
  return new Date().toISOString();
}

function memoryByteSize(): number {
  let total = 0;
  for (const record of memoryCache.values()) total += record.byteSize;
  return total;
}

function lruMemoryKey(): string | undefined {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, record] of memoryCache) {
    const stamp = Date.parse(record.lastAccessedAt) || 0;
    if (stamp < oldestAt) {
      oldestAt = stamp;
      oldestKey = key;
    }
  }
  return oldestKey;
}

function evictMemoryIfNeeded(): void {
  while (
    memoryCache.size > memoryLimits.maxEntries
    || memoryByteSize() > memoryLimits.maxBytes
  ) {
    if (memoryCache.size === 0) break;
    const oldest = lruMemoryKey();
    if (!oldest) break;
    memoryCache.delete(oldest);
  }
}

function rememberInMemory(record: VideoArtifactCacheRecord): void {
  if (record.byteSize > memoryLimits.maxBytes) return;
  memoryCache.set(record.key, record);
  evictMemoryIfNeeded();
}

function readStoredVideoBlob(raw: StoredVideoArtifactRecord | StoredVideoBlobRecord | unknown): Blob | undefined {
  if (typeof Blob !== 'undefined' && raw instanceof Blob) return raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { blob?: unknown; bytes?: unknown; mimeType?: unknown };
  if (typeof Blob !== 'undefined' && value.blob instanceof Blob) return value.blob;
  if (value.bytes instanceof ArrayBuffer) {
    return new Blob([value.bytes], { type: typeof value.mimeType === 'string' ? value.mimeType : 'video/mp4' });
  }
  return undefined;
}

function toStoredMetadataFromRaw(
  raw: StoredVideoArtifactRecord,
  blob: Blob,
): StoredVideoArtifactMetadata {
  const createdAt = raw.createdAt || nowIso();
  return {
    key: raw.key,
    mimeType: raw.mimeType || blob.type || 'video/mp4',
    width: raw.width,
    height: raw.height,
    durationSeconds: raw.durationSeconds,
    frameRate: raw.frameRate,
    frameCount: raw.frameCount,
    codecString: raw.codecString,
    encodeMode: raw.encodeMode,
    actualEncoderMode: raw.actualEncoderMode,
    encoderModeFallback: raw.encoderModeFallback === true,
    dependencyIds: raw.dependencyIds ?? [],
    shotId: raw.shotId,
    createdAt,
    lastAccessedAt: raw.lastAccessedAt || createdAt,
    byteSize: raw.byteSize || blob.size,
    timing: raw.timing,
  };
}

function normalizeStored(
  raw: StoredVideoArtifactRecord | StoredVideoArtifactMetadata,
  blobOverride?: Blob,
): VideoArtifactCacheRecord | undefined {
  const blob = blobOverride ?? readStoredVideoBlob(raw);
  if (!blob) return undefined;
  const createdAt = raw.createdAt || nowIso();
  return {
    key: raw.key,
    blob,
    mimeType: raw.mimeType || blob.type || 'video/mp4',
    width: raw.width,
    height: raw.height,
    durationSeconds: raw.durationSeconds,
    frameRate: raw.frameRate,
    frameCount: raw.frameCount,
    codecString: raw.codecString,
    encodeMode: raw.encodeMode,
    actualEncoderMode: raw.actualEncoderMode,
    encoderModeFallback: raw.encoderModeFallback === true,
    dependencyIds: raw.dependencyIds ?? [],
    shotId: raw.shotId,
    createdAt,
    lastAccessedAt: raw.lastAccessedAt || createdAt,
    byteSize: raw.byteSize || blob.size,
    timing: raw.timing,
  };
}

function toStoredMetadata(record: VideoArtifactCacheRecord): StoredVideoArtifactMetadata {
  return {
    key: record.key,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
    frameRate: record.frameRate,
    frameCount: record.frameCount,
    codecString: record.codecString,
    encodeMode: record.encodeMode,
    actualEncoderMode: record.actualEncoderMode,
    encoderModeFallback: record.encoderModeFallback,
    dependencyIds: record.dependencyIds,
    shotId: record.shotId,
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt,
    byteSize: record.byteSize,
    timing: record.timing,
  };
}

function toStoredBlob(record: VideoArtifactCacheRecord): StoredVideoBlobRecord {
  return { key: record.key, blob: record.blob };
}

async function readStored(key: string): Promise<VideoArtifactCacheRecord | undefined> {
  const db = await openDatabase();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readonly');
    const blobRequest = transaction.objectStore(STORE_NAME).get(key);
    const metadataRequest = transaction.objectStore(METADATA_STORE_NAME).get(key);
    transaction.oncomplete = () => {
      const metadata = metadataRequest.result as StoredVideoArtifactMetadata | undefined;
      const blobRow = blobRequest.result as StoredVideoBlobRecord | StoredVideoArtifactRecord | undefined;
      if (metadata) {
        resolve(normalizeStored(metadata, readStoredVideoBlob(blobRow)));
      } else {
        // Compatibility with rows written before the v3 upgrade completed.
        resolve(blobRow && 'mimeType' in blobRow
          ? normalizeStored(blobRow as StoredVideoArtifactRecord)
          : undefined);
      }
    };
    transaction.onerror = () => reject(transaction.error ?? new Error('Video cache read failed.'));
  });
}

async function listStoredMetadata(): Promise<Array<Pick<VideoArtifactCacheRecord, 'key' | 'lastAccessedAt' | 'byteSize'>>> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(METADATA_STORE_NAME, 'readonly');
    const store = transaction.objectStore(METADATA_STORE_NAME);
    const source = store.indexNames.contains(LAST_ACCESSED_INDEX)
      ? store.index(LAST_ACCESSED_INDEX)
      : store;
    const rows: Array<Pick<VideoArtifactCacheRecord, 'key' | 'lastAccessedAt' | 'byteSize'>> = [];
    const cursorRequest = source.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const row = cursor.value as StoredVideoArtifactMetadata;
      rows.push({ key: row.key, lastAccessedAt: row.lastAccessedAt, byteSize: row.byteSize });
      cursor.continue();
    };
    transaction.oncomplete = () => {
      if (rows.length > 0) {
        resolve(rows);
        return;
      }
      // Defensive fallback for a database interrupted during the v3 upgrade.
      void listLegacyStoredMetadata().then(resolve, reject);
    };
    transaction.onerror = () => reject(transaction.error ?? new Error('Video cache metadata list failed.'));
  });
}

async function listLegacyStoredMetadata(): Promise<Array<Pick<VideoArtifactCacheRecord, 'key' | 'lastAccessedAt' | 'byteSize'>>> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const rows = (request.result as StoredVideoArtifactRecord[] | undefined) ?? [];
      resolve(rows.map((raw) => {
        const blob = readStoredVideoBlob(raw);
        return blob ? toStoredMetadataFromRaw(raw, blob) : undefined;
      }).filter((row): row is StoredVideoArtifactMetadata => Boolean(row)).map((row) => ({
        key: row.key,
        lastAccessedAt: row.lastAccessedAt,
        byteSize: row.byteSize,
      })));
    };
    request.onerror = () => reject(request.error ?? new Error('Video cache legacy metadata list failed.'));
  });
}

async function deleteStored(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const metadata = transaction.objectStore(METADATA_STORE_NAME);
    for (const key of keys) {
      store.delete(key);
      metadata.delete(key);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Video cache delete failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Video cache delete aborted.'));
  });
}

async function writeStored(record: VideoArtifactCacheRecord): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  // Storage estimation starts asynchronously when the DB opens. Wait for it and
  // recheck here so an entry accepted under the initial 2 GiB default cannot
  // escape a smaller quota-derived budget.
  await startEstimatedBudgetOnce();
  if (record.byteSize > limits.maxBytes) {
    await deleteStored([record.key]);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
    transaction.objectStore(STORE_NAME).put(toStoredBlob(record));
    transaction.objectStore(METADATA_STORE_NAME).put(toStoredMetadata(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Video cache write failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Video cache write aborted.'));
  });

  // Persistent LRU eviction by lastAccessedAt under byte + entry budgets.
  const all = await listStoredMetadata();
  all.sort((a, b) => (Date.parse(a.lastAccessedAt) || 0) - (Date.parse(b.lastAccessedAt) || 0));
  let totalBytes = all.reduce((sum, row) => sum + row.byteSize, 0);
  const toDelete: string[] = [];
  while (
    (all.length - toDelete.length > limits.maxEntries)
    || (totalBytes > limits.maxBytes)
  ) {
    const candidate = all.find((row) => row.key !== record.key && !toDelete.includes(row.key));
    if (!candidate) break;
    toDelete.push(candidate.key);
    totalBytes -= candidate.byteSize;
  }
  if (toDelete.length > 0) await deleteStored(toDelete);
}

async function touchStored(key: string, lastAccessedAt: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const metadata = transaction.objectStore(METADATA_STORE_NAME);
    const getRequest = metadata.get(key);
    getRequest.onsuccess = () => {
      const value = getRequest.result as StoredVideoArtifactMetadata | undefined;
      if (value) {
        metadata.put({ ...value, lastAccessedAt });
        return;
      }
      // Lazily migrate a legacy row that was not visible during upgrade.
      const legacyRequest = store.get(key);
      legacyRequest.onsuccess = () => {
        const legacy = legacyRequest.result as StoredVideoArtifactRecord | undefined;
        const blob = legacy ? readStoredVideoBlob(legacy) : undefined;
        if (legacy && blob) metadata.put({ ...toStoredMetadataFromRaw(legacy, blob), lastAccessedAt });
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function getVideoArtifactFromCache(
  fingerprint: Pick<VideoArtifactFingerprint, 'key'>,
): Promise<VideoArtifactCacheRecord | undefined> {
  const accessedAt = nowIso();
  const memory = memoryCache.get(fingerprint.key);
  if (memory) {
    memory.lastAccessedAt = accessedAt;
    memoryCache.set(fingerprint.key, memory);
    // A memory hit is still a persistent LRU access. Best effort only.
    void enqueue(() => touchStored(memory.key, accessedAt));
    return memory;
  }
  return enqueue(async () => {
    const stored = await readStored(fingerprint.key);
    if (!stored) return undefined;
    stored.lastAccessedAt = accessedAt;
    rememberInMemory(stored);
    void touchStored(stored.key, accessedAt);
    return stored;
  });
}

export async function putVideoArtifactInCache(
  fingerprint: VideoArtifactFingerprint,
  record: Omit<
    VideoArtifactCacheRecord,
    'key' | 'dependencyIds' | 'shotId' | 'createdAt' | 'lastAccessedAt' | 'byteSize'
  > & {
    createdAt?: string;
    encoderModeFallback?: boolean;
  },
): Promise<VideoArtifactCacheRecord> {
  const stamp = nowIso();
  const full: VideoArtifactCacheRecord = {
    key: fingerprint.key,
    blob: record.blob,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
    frameRate: record.frameRate,
    frameCount: record.frameCount,
    codecString: record.codecString,
    encodeMode: record.encodeMode,
    actualEncoderMode: record.actualEncoderMode,
    encoderModeFallback: record.encoderModeFallback === true,
    dependencyIds: [...fingerprint.dependencyIds],
    shotId: fingerprint.details.shotId,
    createdAt: record.createdAt ?? stamp,
    lastAccessedAt: stamp,
    byteSize: record.blob.size,
    timing: record.timing,
  };

  rememberInMemory(full);

  // Early check avoids unnecessary DB work. writeStored repeats the check after
  // the asynchronous quota estimate settles to close the initialization race.
  if (full.byteSize <= limits.maxBytes) {
    void enqueue(async () => {
      try {
        await writeStored(full);
      } catch {
        // Memory entry remains available for the current session.
      }
    });
  }

  return full;
}

export function getVideoArtifactCacheLimits(): VideoArtifactCacheLimits {
  return { ...limits };
}

export function getVideoArtifactMemoryCacheLimits(): VideoArtifactCacheLimits {
  return { ...memoryLimits };
}

/** Update persistent IndexedDB limits. */
export function setVideoArtifactCacheLimits(next: Partial<VideoArtifactCacheLimits>): VideoArtifactCacheLimits {
  if (typeof next.maxBytes === 'number' && Number.isFinite(next.maxBytes) && next.maxBytes > 0) {
    limits.maxBytes = Math.floor(next.maxBytes);
  }
  if (typeof next.maxEntries === 'number' && Number.isFinite(next.maxEntries) && next.maxEntries >= 1) {
    limits.maxEntries = Math.floor(next.maxEntries);
  }
  return getVideoArtifactCacheLimits();
}

/** Update the conservative browser-memory working-set limits. */
export function setVideoArtifactMemoryCacheLimits(
  next: Partial<VideoArtifactCacheLimits>,
): VideoArtifactCacheLimits {
  if (typeof next.maxBytes === 'number' && Number.isFinite(next.maxBytes) && next.maxBytes > 0) {
    memoryLimits.maxBytes = Math.floor(next.maxBytes);
  }
  if (typeof next.maxEntries === 'number' && Number.isFinite(next.maxEntries) && next.maxEntries >= 1) {
    memoryLimits.maxEntries = Math.floor(next.maxEntries);
  }
  evictMemoryIfNeeded();
  return getVideoArtifactMemoryCacheLimits();
}

/**
 * Prefer a free-quota-based persistent budget when the Storage API is available.
 * The memory cache remains fixed and conservative.
 */
export async function applyEstimatedVideoCacheBudget(): Promise<VideoArtifactCacheLimits> {
  const minimumTarget = 64 * 1024 * 1024; // 64 MiB
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      const free = Math.max(0, quota - usage);
      if (free > 0) {
        const target = Math.max(minimumTarget, Math.floor(free * 0.25));
        const budget = Math.min(DEFAULT_VIDEO_CACHE_MAX_BYTES, target, free);
        if (budget > 0) setVideoArtifactCacheLimits({ maxBytes: budget });
      }
    }
  } catch {
    // Keep defaults.
  }
  return getVideoArtifactCacheLimits();
}

export function inspectVideoArtifactCache(): {
  memoryEntries: number;
  memoryBytes: number;
  maxBytes: number;
  maxEntries: number;
  memoryMaxBytes: number;
  memoryMaxEntries: number;
  keys: string[];
} {
  return {
    memoryEntries: memoryCache.size,
    memoryBytes: memoryByteSize(),
    maxBytes: limits.maxBytes,
    maxEntries: limits.maxEntries,
    memoryMaxBytes: memoryLimits.maxBytes,
    memoryMaxEntries: memoryLimits.maxEntries,
    keys: [...memoryCache.keys()],
  };
}

/** Clear memory and IndexedDB video artifact entries. */
export async function clearVideoArtifactCache(): Promise<void> {
  memoryCache.clear();
  await enqueue(async () => {
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
      transaction.objectStore(STORE_NAME).clear();
      transaction.objectStore(METADATA_STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Video cache clear failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Video cache clear aborted.'));
    });
  });
}

/** Test helper — clear only the in-memory working set, preserving IndexedDB. */
export function clearVideoArtifactMemoryCacheForTests(): void {
  memoryCache.clear();
}

/** Test helper — wait for all queued writes/touches scheduled before this call. */
export async function flushVideoArtifactCacheOperationsForTests(): Promise<void> {
  await operationQueue;
}

/** Test helper — clears memory cache and resets limits / DB handle. */
export function resetVideoArtifactCacheForTests(): void {
  memoryCache.clear();
  databasePromise = undefined;
  estimatedBudgetPromise = undefined;
  limits = {
    maxBytes: DEFAULT_VIDEO_CACHE_MAX_BYTES,
    maxEntries: DEFAULT_VIDEO_CACHE_MAX_ENTRIES,
  };
  memoryLimits = {
    maxBytes: DEFAULT_VIDEO_MEMORY_CACHE_MAX_BYTES,
    maxEntries: DEFAULT_VIDEO_MEMORY_CACHE_MAX_ENTRIES,
  };
}

export function setVideoArtifactCacheMaxEntriesForTests(value: number): void {
  setVideoArtifactCacheLimits({ maxEntries: value });
  setVideoArtifactMemoryCacheLimits({ maxEntries: value });
}

export function setVideoArtifactCacheMaxBytesForTests(value: number): void {
  setVideoArtifactCacheLimits({ maxBytes: value });
  setVideoArtifactMemoryCacheLimits({ maxBytes: value });
}
