/**
 * Persistent fingerprinted MP4 cache (memory + IndexedDB).
 * Exact-match only — any fingerprint change is a miss.
 */

import type { VideoArtifactFingerprint } from './videoArtifactFingerprint';
import type { VideoEncoderMode } from '../domain/types';
import type { VideoRenderTiming } from './videoRenderTiming';

const DATABASE_NAME = 'forescene-video-artifacts';
const STORE_NAME = 'mp4-blobs';
const DATABASE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 48;

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
  dependencyIds: string[];
  shotId: string;
  createdAt: string;
  byteSize: number;
  timing?: VideoRenderTiming;
}

interface StoredVideoArtifactRecord {
  key: string;
  bytes: ArrayBuffer;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  frameCount: number;
  codecString?: string;
  encodeMode: 'render' | 'quickPreview';
  actualEncoderMode: VideoEncoderMode;
  dependencyIds: string[];
  shotId: string;
  createdAt: string;
  byteSize: number;
  timing?: VideoRenderTiming;
}

const memoryCache = new Map<string, VideoArtifactCacheRecord>();
const memoryOrder: string[] = [];
let maxEntries = DEFAULT_MAX_ENTRIES;
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
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
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

function touchMemory(key: string): void {
  const index = memoryOrder.indexOf(key);
  if (index >= 0) memoryOrder.splice(index, 1);
  memoryOrder.push(key);
}

function evictMemoryIfNeeded(): void {
  while (memoryOrder.length > maxEntries) {
    const oldest = memoryOrder.shift();
    if (oldest) memoryCache.delete(oldest);
  }
}

function toCacheRecord(stored: StoredVideoArtifactRecord): VideoArtifactCacheRecord {
  return {
    key: stored.key,
    blob: new Blob([stored.bytes], { type: stored.mimeType || 'video/mp4' }),
    mimeType: stored.mimeType || 'video/mp4',
    width: stored.width,
    height: stored.height,
    durationSeconds: stored.durationSeconds,
    frameRate: stored.frameRate,
    frameCount: stored.frameCount,
    codecString: stored.codecString,
    encodeMode: stored.encodeMode,
    actualEncoderMode: stored.actualEncoderMode,
    dependencyIds: stored.dependencyIds,
    shotId: stored.shotId,
    createdAt: stored.createdAt,
    byteSize: stored.byteSize,
    timing: stored.timing,
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
      resolve(value ? toCacheRecord(value) : undefined);
    };
    request.onerror = () => reject(request.error ?? new Error('Video cache read failed.'));
  });
}

async function writeStored(record: VideoArtifactCacheRecord): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  const bytes = await record.blob.arrayBuffer();
  const stored: StoredVideoArtifactRecord = {
    key: record.key,
    bytes,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    durationSeconds: record.durationSeconds,
    frameRate: record.frameRate,
    frameCount: record.frameCount,
    codecString: record.codecString,
    encodeMode: record.encodeMode,
    actualEncoderMode: record.actualEncoderMode,
    dependencyIds: record.dependencyIds,
    shotId: record.shotId,
    createdAt: record.createdAt,
    byteSize: bytes.byteLength,
    timing: record.timing,
  };
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(stored);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Video cache write failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Video cache write aborted.'));
  });

  // Best-effort eviction of oldest IDB rows beyond maxEntries.
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const keysRequest = store.getAllKeys();
    keysRequest.onsuccess = () => {
      const keys = (keysRequest.result as IDBValidKey[]).map(String);
      if (keys.length <= maxEntries) {
        resolve();
        return;
      }
      // Without timestamps on keys, drop arbitrary surplus beyond the write we just did.
      // Memory LRU remains the primary session cache; IDB is durability best-effort.
      const surplus = keys.length - maxEntries;
      for (let index = 0; index < surplus; index += 1) {
        const key = keys[index];
        if (key && key !== record.key) store.delete(key);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function getVideoArtifactFromCache(
  fingerprint: Pick<VideoArtifactFingerprint, 'key'>,
): Promise<VideoArtifactCacheRecord | undefined> {
  const memory = memoryCache.get(fingerprint.key);
  if (memory) {
    touchMemory(fingerprint.key);
    return memory;
  }
  return enqueue(async () => {
    const stored = await readStored(fingerprint.key);
    if (!stored) return undefined;
    memoryCache.set(stored.key, stored);
    touchMemory(stored.key);
    evictMemoryIfNeeded();
    return stored;
  });
}

export async function putVideoArtifactInCache(
  fingerprint: VideoArtifactFingerprint,
  record: Omit<VideoArtifactCacheRecord, 'key' | 'dependencyIds' | 'shotId' | 'createdAt' | 'byteSize'> & {
    createdAt?: string;
  },
): Promise<VideoArtifactCacheRecord> {
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
    dependencyIds: [...fingerprint.dependencyIds],
    shotId: fingerprint.details.shotId,
    createdAt: record.createdAt ?? new Date().toISOString(),
    byteSize: record.blob.size,
    timing: record.timing,
  };

  memoryCache.set(full.key, full);
  touchMemory(full.key);
  evictMemoryIfNeeded();

  void enqueue(async () => {
    try {
      await writeStored(full);
    } catch {
      // Memory entry remains for the session.
    }
  });

  return full;
}

export function inspectVideoArtifactCache(): {
  memoryEntries: number;
  maxEntries: number;
  keys: string[];
} {
  return {
    memoryEntries: memoryCache.size,
    maxEntries,
    keys: [...memoryOrder],
  };
}

/** Test helper — clears memory cache and optionally closes the DB handle. */
export function resetVideoArtifactCacheForTests(): void {
  memoryCache.clear();
  memoryOrder.length = 0;
  databasePromise = undefined;
  maxEntries = DEFAULT_MAX_ENTRIES;
}

export function setVideoArtifactCacheMaxEntriesForTests(value: number): void {
  maxEntries = Math.max(1, value);
  evictMemoryIfNeeded();
}
