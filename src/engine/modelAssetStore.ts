const DATABASE_NAME = 'panoref-model-assets';
const STORE_NAME = 'mesh-binaries';
const DATABASE_VERSION = 1;

const memoryAssets = new Map<string, ArrayBuffer>();

function cloneBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open model asset storage.'));
  });
}

export function registerModelAssetBytes(key: string, bytes: ArrayBuffer): void {
  memoryAssets.set(key, cloneBuffer(bytes));
}

export function getRegisteredModelAssetBytes(key: string): ArrayBuffer | undefined {
  const bytes = memoryAssets.get(key);
  return bytes ? cloneBuffer(bytes) : undefined;
}

export interface ModelAssetWrite {
  key: string;
  bytes: ArrayBuffer;
}

/**
 * Persist a package's model payloads in one IndexedDB transaction. The memory
 * cache is only updated after that transaction commits, so a broken package
 * cannot partially replace an existing model import.
 */
export async function putModelAssets(entries: readonly ModelAssetWrite[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  if (entries.length === 0) return;

  const db = await openDatabase();
  if (!db) {
    if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    for (const entry of entries) registerModelAssetBytes(entry.key, entry.bytes);
    return;
  }

  try {
    if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const abort = () => {
        try {
          transaction.abort();
        } catch {
          // The transaction already completed between the signal and callback.
        }
      };
      const finish = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const store = transaction.objectStore(STORE_NAME);
        for (const entry of entries) store.put(entry.bytes, entry.key);
      } catch (error) {
        finish();
        transaction.abort();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        finish();
        resolve();
      };
      transaction.onerror = () => {
        finish();
        reject(transaction.error ?? new Error('Could not store model geometry.'));
      };
      transaction.onabort = () => {
        finish();
        reject(transaction.error ?? new Error('Model geometry storage was cancelled.'));
      };
    });
    for (const entry of entries) registerModelAssetBytes(entry.key, entry.bytes);
  } finally {
    db.close();
  }
}

export async function putModelAsset(key: string, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void> {
  await putModelAssets([{ key, bytes }], signal);
}

export async function getModelAsset(key: string): Promise<ArrayBuffer | undefined> {
  const cached = getRegisteredModelAssetBytes(key);
  if (cached) return cached;
  const db = await openDatabase();
  if (!db) return undefined;
  try {
    const value = await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result instanceof ArrayBuffer ? request.result : undefined);
      request.onerror = () => reject(request.error ?? new Error('Could not read model geometry.'));
    });
    if (value) registerModelAssetBytes(key, value);
    return value;
  } finally {
    db.close();
  }
}

export async function deleteModelAsset(key: string): Promise<void> {
  memoryAssets.delete(key);
  const db = await openDatabase();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete model geometry.'));
    });
  } finally {
    db.close();
  }
}

export async function hydrateModelAssetKeys(keys: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    if (!await getModelAsset(key)) missing.push(key);
  }
  return missing;
}

export function resetModelAssetStoreForTests(): void {
  memoryAssets.clear();
}
