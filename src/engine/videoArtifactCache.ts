/**
 * Persistent fingerprinted MP4 cache (memory + IndexedDB).
 *
 * Exact-match only. Eviction is true LRU by lastAccessedAt, with a primary
 * byte budget and a secondary entry ceiling so a full multi-shot package
 * (31× clay + projected, optionally with people variants) can stay warm.
 */

import type { VideoArtifactFingerprint } from './videoArtifactFingerprint';
import type { VideoEncoderMode } from '../domain/types';
import type { VideoRenderTiming } from './videoRenderTiming';

const DATABASE_NAME = 'forescene-video-artifacts';
const STORE_NAME = 'mp4-blobs';
/** Schema v2 stores Blob directly + lastAccessedAt for LRU. */
const DATABASE_VERSION = 2;

/** Default: enough for a large package of 720p/1080p motion clips. */
export const DEFAULT_VIDEO_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Secondary guard so metadata rows cannot grow without bound. */
export const DEFAULT_VIDEO_CACHE_MAX_ENTRIES = 256;

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

const memoryCache = new Map<string, VideoArtifactCacheRecord>();
let limits: VideoArtifactCacheLimits = {
  maxBytes: DEFAULT_VIDEO_CACHE_MAX_BYTES,
  maxEntries: DEFAULT_VIDEO_CACHE_MAX_ENTRIES,
};
let databasePromise: Promise<IDBDatabase | undefined> | undefined;
let operationQueue: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = operationQueue.then(operation, operation);
  operationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  if (databasePromise) return databasePromise;

  let connectionPromise: Promise<IDBDatabase | undefined>;
  connectionPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
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
    memoryCache.size > limits.maxEntries
    || memoryByteSize() > limits.maxBytes
  ) {
    if (memoryCache.size === 0) break;
    const oldest = lruMemoryKey();
    if (!oldest) break;
    memoryCache.delete(oldest);
  }
}

function normalizeStored(raw: StoredVideoArtifactRecord): VideoArtifactCacheRecord | undefined {
  let blob = raw.blob;
  if (!(blob instanceof Blob)) {
    // Migrate legacy ArrayBuffer rows.
    if (raw.bytes) {
      blob = new Blob([raw.bytes], { type: raw.mimeType || 'video/mp4' });
    } else {
      return undefined;
    }
  }
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

function toStored(record: VideoArtifactCacheRecord): StoredVideoArtifactRecord {
  return {
    key: record.key,
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
    encoderModeFallback: record.encoderModeFallback,
    dependencyIds: record.dependencyIds,
    shotId: record.shotId,
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt,
    byteSize: record.byteSize,
    timing: record.timing,
  };
}

async function readStored(key: string): Promise<VideoArtifactCacheRecord | undefined> {
  const db = await openDatabase();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      const value = request.result as StoredVideoArtifactRecord | undefined;
      resolve(value ? normalizeStored(value) : undefined);
    };
    request.onerror = () => reject(request.error ?? new Error('Video cache read failed.'));
  });
}

async function listStored(): Promise<VideoArtifactCacheRecord[]> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const rows = (request.result as StoredVideoArtifactRecord[] | undefined) ?? [];
      resolve(rows.map(normalizeStored).filter((row): row is VideoArtifactCacheRecord => Boolean(row)));
    };
    request.onerror = () => reject(request.error ?? new Error('Video cache list failed.'));
  });
}

async function deleteStored(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    for (const key of keys) store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Video cache delete failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Video cache delete aborted.'));
  });
}

async function writeStored(record: VideoArtifactCacheRecord): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(toStored(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Video cache write failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Video cache write aborted.'));
  });

  // LRU eviction by lastAccessedAt under byte + entry budgets.
  const all = await listStored();
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
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(key);
    getRequest.onsuccess = () => {
      const value = getRequest.result as StoredVideoArtifactRecord | undefined;
      if (!value) {
        resolve();
        return;
      }
      const normalized = normalizeStored(value);
      if (!normalized) {
        resolve();
        return;
      }
      normalized.lastAccessedAt = lastAccessedAt;
      store.put(toStored(normalized));
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
    return memory;
  }
  return enqueue(async () => {
    const stored = await readStored(fingerprint.key);
    if (!stored) return undefined;
    stored.lastAccessedAt = accessedAt;
    memoryCache.set(stored.key, stored);
    evictMemoryIfNeeded();
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

  // Never keep a single entry larger than the budget (still return it this session).
  if (full.byteSize <= limits.maxBytes) {
    memoryCache.set(full.key, full);
    evictMemoryIfNeeded();
    void enqueue(async () => {
      try {
        await writeStored(full);
      } catch {
        // Memory entry remains for the session.
      }
    });
  } else {
    memoryCache.set(full.key, full);
    evictMemoryIfNeeded();
  }

  return full;
}

export function getVideoArtifactCacheLimits(): VideoArtifactCacheLimits {
  return { ...limits };
}

export function setVideoArtifactCacheLimits(next: Partial<VideoArtifactCacheLimits>): VideoArtifactCacheLimits {
  if (typeof next.maxBytes === 'number' && Number.isFinite(next.maxBytes) && next.maxBytes > 0) {
    limits.maxBytes = Math.floor(next.maxBytes);
  }
  if (typeof next.maxEntries === 'number' && Number.isFinite(next.maxEntries) && next.maxEntries >= 1) {
    limits.maxEntries = Math.floor(next.maxEntries);
  }
  evictMemoryIfNeeded();
  return getVideoArtifactCacheLimits();
}

/**
 * Prefer an estimated free-quota-based budget when the Storage API is available,
 * without shrinking below a floor that can hold a modest package.
 */
export async function applyEstimatedVideoCacheBudget(): Promise<VideoArtifactCacheLimits> {
  const floor = 512 * 1024 * 1024; // 512 MiB
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      const free = Math.max(0, quota - usage);
      // Use up to 25% of free space, clamped to [floor, DEFAULT].
      const budget = Math.min(
        DEFAULT_VIDEO_CACHE_MAX_BYTES,
        Math.max(floor, Math.floor(free * 0.25)),
      );
      if (budget > 0) setVideoArtifactCacheLimits({ maxBytes: budget });
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
  keys: string[];
} {
  return {
    memoryEntries: memoryCache.size,
    memoryBytes: memoryByteSize(),
    maxBytes: limits.maxBytes,
    maxEntries: limits.maxEntries,
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
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Video cache clear failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Video cache clear aborted.'));
    });
  });
}

/** Test helper — clears memory cache and resets limits / DB handle. */
export function resetVideoArtifactCacheForTests(): void {
  memoryCache.clear();
  databasePromise = undefined;
  limits = {
    maxBytes: DEFAULT_VIDEO_CACHE_MAX_BYTES,
    maxEntries: DEFAULT_VIDEO_CACHE_MAX_ENTRIES,
  };
}

export function setVideoArtifactCacheMaxEntriesForTests(value: number): void {
  setVideoArtifactCacheLimits({ maxEntries: value });
}

export function setVideoArtifactCacheMaxBytesForTests(value: number): void {
  setVideoArtifactCacheLimits({ maxBytes: value });
}
