/**
 * Small metadata database for durable project revisions.
 *
 * Binary payloads deliberately stay in the existing model/project-asset
 * databases. A revision only becomes active after all of those immutable
 * payloads have been staged and this database commits the manifest plus its
 * active-pointer update in one transaction.
 */

const DATABASE_NAME = 'panoref-project-revisions';
const DATABASE_VERSION = 1;
const REVISIONS_STORE = 'revisions';
const HEADS_STORE = 'heads';

export type ProjectRevisionKind = 'autosave' | 'snapshot' | 'import' | 'migration' | 'restore';

/** Immutable binary metadata written alongside every new recovery revision. */
export interface ProjectRevisionBinaryResource {
  key: string;
  sha256: string;
  byteLength: number;
  mimeType?: string;
}

export interface ProjectRevisionResources {
  projectAssetKeys: string[];
  modelAssetKeys: string[];
  /** Optional only for revisions written before binary metadata was introduced. */
  projectAssets?: ProjectRevisionBinaryResource[];
  /** Optional only for revisions written before binary metadata was introduced. */
  models?: ProjectRevisionBinaryResource[];
}

export interface ProjectRevisionRecord {
  id: string;
  projectId: string;
  kind: ProjectRevisionKind;
  reason: string;
  createdAt: string;
  /** A portable, validated project manifest with immutable resource keys. */
  manifest: string;
  resources: ProjectRevisionResources;
}

export interface ProjectRevisionHead {
  projectId: string;
  activeRevisionId: string;
  previousRevisionId?: string;
  updatedAt: string;
}

const memoryRevisions = new Map<string, ProjectRevisionRecord>();
const memoryHeads = new Map<string, ProjectRevisionHead>();
let nextCommitFailureForTests: Error | undefined;
let nextDeleteFailureForTests: Error | undefined;

function copy<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REVISIONS_STORE)) database.createObjectStore(REVISIONS_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(HEADS_STORE)) database.createObjectStore(HEADS_STORE, { keyPath: 'projectId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local project recovery storage.'));
  });
}

export async function writeProjectRevision(
  record: ProjectRevisionRecord,
  options: { activate?: boolean } = {},
): Promise<ProjectRevisionHead | undefined> {
  if (nextCommitFailureForTests) {
    const error = nextCommitFailureForTests;
    nextCommitFailureForTests = undefined;
    throw error;
  }
  const activate = options.activate ?? true;
  const db = await openDatabase();
  if (!db) {
    memoryRevisions.set(record.id, copy(record));
    if (!activate) return memoryHeads.get(record.projectId) ? copy(memoryHeads.get(record.projectId)!) : undefined;
    const previous = memoryHeads.get(record.projectId);
    const head: ProjectRevisionHead = {
      projectId: record.projectId,
      activeRevisionId: record.id,
      ...(previous?.activeRevisionId ? { previousRevisionId: previous.activeRevisionId } : {}),
      updatedAt: record.createdAt,
    };
    memoryHeads.set(record.projectId, copy(head));
    return head;
  }

  try {
    return await new Promise<ProjectRevisionHead | undefined>((resolve, reject) => {
      const transaction = db.transaction([REVISIONS_STORE, HEADS_STORE], 'readwrite');
      const revisions = transaction.objectStore(REVISIONS_STORE);
      const heads = transaction.objectStore(HEADS_STORE);
      let nextHead: ProjectRevisionHead | undefined;

      const persist = (previous?: ProjectRevisionHead) => {
        revisions.put(record);
        if (!activate) return;
        nextHead = {
          projectId: record.projectId,
          activeRevisionId: record.id,
          ...(previous?.activeRevisionId ? { previousRevisionId: previous.activeRevisionId } : {}),
          updatedAt: record.createdAt,
        };
        heads.put(nextHead);
      };

      if (activate) {
        const request = heads.get(record.projectId);
        request.onsuccess = () => persist(request.result as ProjectRevisionHead | undefined);
        request.onerror = () => {
          try { transaction.abort(); } catch { /* transaction already finished */ }
        };
      } else {
        persist();
      }

      transaction.oncomplete = () => resolve(nextHead ? copy(nextHead) : undefined);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not commit a project recovery revision.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Project recovery revision commit was cancelled.'));
    });
  } finally {
    db.close();
  }
}

export async function getProjectRevision(id: string): Promise<ProjectRevisionRecord | undefined> {
  const db = await openDatabase();
  if (!db) {
    const record = memoryRevisions.get(id);
    return record ? copy(record) : undefined;
  }
  try {
    return await new Promise<ProjectRevisionRecord | undefined>((resolve, reject) => {
      const request = db.transaction(REVISIONS_STORE, 'readonly').objectStore(REVISIONS_STORE).get(id);
      request.onsuccess = () => resolve(request.result ? copy(request.result as ProjectRevisionRecord) : undefined);
      request.onerror = () => reject(request.error ?? new Error('Could not read project recovery revision.'));
    });
  } finally {
    db.close();
  }
}

export async function getProjectRevisionHead(projectId: string): Promise<ProjectRevisionHead | undefined> {
  const db = await openDatabase();
  if (!db) {
    const head = memoryHeads.get(projectId);
    return head ? copy(head) : undefined;
  }
  try {
    return await new Promise<ProjectRevisionHead | undefined>((resolve, reject) => {
      const request = db.transaction(HEADS_STORE, 'readonly').objectStore(HEADS_STORE).get(projectId);
      request.onsuccess = () => resolve(request.result ? copy(request.result as ProjectRevisionHead) : undefined);
      request.onerror = () => reject(request.error ?? new Error('Could not read project recovery state.'));
    });
  } finally {
    db.close();
  }
}

export async function listProjectRevisionHeads(): Promise<ProjectRevisionHead[]> {
  const db = await openDatabase();
  if (!db) return [...memoryHeads.values()].map(copy);
  try {
    return await new Promise<ProjectRevisionHead[]>((resolve, reject) => {
      const request = db.transaction(HEADS_STORE, 'readonly').objectStore(HEADS_STORE).getAll();
      request.onsuccess = () => resolve((request.result as ProjectRevisionHead[]).map(copy));
      request.onerror = () => reject(request.error ?? new Error('Could not list local project recovery state.'));
    });
  } finally {
    db.close();
  }
}

export async function listProjectRevisions(projectId: string): Promise<ProjectRevisionRecord[]> {
  const db = await openDatabase();
  if (!db) {
    return [...memoryRevisions.values()]
      .filter((record) => record.projectId === projectId)
      .map(copy);
  }
  try {
    return await new Promise<ProjectRevisionRecord[]>((resolve, reject) => {
      const request = db.transaction(REVISIONS_STORE, 'readonly').objectStore(REVISIONS_STORE).getAll();
      request.onsuccess = () => resolve(
        (request.result as ProjectRevisionRecord[])
          .filter((record) => record.projectId === projectId)
          .map(copy),
      );
      request.onerror = () => reject(request.error ?? new Error('Could not list project recovery revisions.'));
    });
  } finally {
    db.close();
  }
}

export async function listAllProjectRevisions(): Promise<ProjectRevisionRecord[]> {
  const db = await openDatabase();
  if (!db) return [...memoryRevisions.values()].map(copy);
  try {
    return await new Promise<ProjectRevisionRecord[]>((resolve, reject) => {
      const request = db.transaction(REVISIONS_STORE, 'readonly').objectStore(REVISIONS_STORE).getAll();
      request.onsuccess = () => resolve((request.result as ProjectRevisionRecord[]).map(copy));
      request.onerror = () => reject(request.error ?? new Error('Could not list project recovery revisions.'));
    });
  } finally {
    db.close();
  }
}

/** Promote an already validated revision without replacing its immutable data. */
export async function activateProjectRevision(
  projectId: string,
  revisionId: string,
  updatedAt = new Date().toISOString(),
): Promise<ProjectRevisionHead> {
  const db = await openDatabase();
  if (!db) {
    const record = memoryRevisions.get(revisionId);
    if (!record || record.projectId !== projectId) throw new Error('The requested recovery revision is unavailable.');
    const previous = memoryHeads.get(projectId);
    const head: ProjectRevisionHead = {
      projectId,
      activeRevisionId: revisionId,
      ...(previous?.activeRevisionId ? { previousRevisionId: previous.activeRevisionId } : {}),
      updatedAt,
    };
    memoryHeads.set(projectId, copy(head));
    return head;
  }

  try {
    return await new Promise<ProjectRevisionHead>((resolve, reject) => {
      const transaction = db.transaction([REVISIONS_STORE, HEADS_STORE], 'readwrite');
      const revisions = transaction.objectStore(REVISIONS_STORE);
      const heads = transaction.objectStore(HEADS_STORE);
      let nextHead: ProjectRevisionHead | undefined;
      const recordRequest = revisions.get(revisionId);
      recordRequest.onsuccess = () => {
        const record = recordRequest.result as ProjectRevisionRecord | undefined;
        if (!record || record.projectId !== projectId) {
          try { transaction.abort(); } catch { /* transaction already finished */ }
          return;
        }
        const headRequest = heads.get(projectId);
        headRequest.onsuccess = () => {
          const previous = headRequest.result as ProjectRevisionHead | undefined;
          nextHead = {
            projectId,
            activeRevisionId: revisionId,
            ...(previous?.activeRevisionId ? { previousRevisionId: previous.activeRevisionId } : {}),
            updatedAt,
          };
          heads.put(nextHead);
        };
        headRequest.onerror = () => {
          try { transaction.abort(); } catch { /* transaction already finished */ }
        };
      };
      recordRequest.onerror = () => {
        try { transaction.abort(); } catch { /* transaction already finished */ }
      };
      transaction.oncomplete = () => {
        if (nextHead) resolve(copy(nextHead));
        else reject(new Error('The requested recovery revision is unavailable.'));
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not activate the recovery revision.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not activate the recovery revision.'));
    });
  } finally {
    db.close();
  }
}

export async function deleteProjectRevision(id: string): Promise<void> {
  if (nextDeleteFailureForTests) {
    const error = nextDeleteFailureForTests;
    nextDeleteFailureForTests = undefined;
    throw error;
  }
  const db = await openDatabase();
  if (!db) {
    memoryRevisions.delete(id);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(REVISIONS_STORE, 'readwrite');
      transaction.objectStore(REVISIONS_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove an expired project recovery revision.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Project recovery revision cleanup was cancelled.'));
    });
  } finally {
    db.close();
  }
}

/**
 * Remove an intentionally discarded local project's revision history in one
 * metadata transaction. Binary cleanup is deliberately separate so a cleanup
 * failure cannot leave a half-deleted history or invalidate another project.
 */
export async function deleteProjectHistory(projectId: string): Promise<ProjectRevisionRecord[]> {
  const db = await openDatabase();
  if (!db) {
    const removed = [...memoryRevisions.values()]
      .filter((record) => record.projectId === projectId)
      .map(copy);
    for (const record of removed) memoryRevisions.delete(record.id);
    memoryHeads.delete(projectId);
    return removed;
  }
  try {
    return await new Promise<ProjectRevisionRecord[]>((resolve, reject) => {
      const transaction = db.transaction([REVISIONS_STORE, HEADS_STORE], 'readwrite');
      const revisions = transaction.objectStore(REVISIONS_STORE);
      const heads = transaction.objectStore(HEADS_STORE);
      let removed: ProjectRevisionRecord[] = [];
      const allRequest = revisions.getAll();
      allRequest.onsuccess = () => {
        removed = (allRequest.result as ProjectRevisionRecord[])
          .filter((record) => record.projectId === projectId)
          .map(copy);
        for (const record of removed) revisions.delete(record.id);
        heads.delete(projectId);
      };
      allRequest.onerror = () => {
        try { transaction.abort(); } catch { /* transaction already finished */ }
      };
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove the local project history.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local project history removal was cancelled.'));
    });
  } finally {
    db.close();
  }
}

export async function resetProjectRevisionStoreForTests(): Promise<void> {
  memoryRevisions.clear();
  memoryHeads.clear();
  nextCommitFailureForTests = undefined;
  nextDeleteFailureForTests = undefined;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not reset project recovery storage.'));
    request.onblocked = () => resolve();
  });
}

export function failNextProjectRevisionCommitForTests(message = 'Injected project revision commit failure.'): void {
  nextCommitFailureForTests = new Error(message);
}

/** Exercise best-effort revision maintenance without affecting the active commit. */
export function failNextProjectRevisionDeleteForTests(message = 'Injected project revision cleanup failure.'): void {
  nextDeleteFailureForTests = new Error(message);
}
