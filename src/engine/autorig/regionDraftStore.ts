/**
 * Temporary IndexedDB draft storage for the guided autorig wizard.
 * Closing the dialog accidentally must not lose in-progress markers / region edits.
 */

/** Legacy PanoRef database name preserved so in-progress local drafts keep opening. */
const LEGACY_DATABASE_NAME = 'panoref-autorig-drafts';
const STORE_NAME = 'wizard-drafts';
const DATABASE_VERSION = 1;

/** Current two-step wizard. Legacy `regions` / `preview` map to `pose-fix`. */
export type AutorigWizardStepId = 'joints' | 'pose-fix';

/** Legacy three-step IDs still present in older drafts. */
export type AutorigWizardLegacyStepId = 'joints' | 'regions' | 'preview' | AutorigWizardStepId;

export type AutorigPoseFixMode = 'inspect' | 'paint' | 'lasso';

export interface AutorigWizardDraftRecord {
  rigId: string;
  /** Draft schema version. Missing / 1 = legacy three-step. */
  version?: 1 | 2;
  step: AutorigWizardStepId;
  /** JSON-serializable marker list */
  markersJson: string;
  topologyHash?: string;
  /** Base64 of suggested Uint8 labels */
  suggestedB64?: string;
  /** Base64 of hard override Uint8 labels */
  overridesB64?: string;
  previewPoseId?: string;
  mode?: AutorigPoseFixMode;
  selectedRegion?: string;
  brushRadius?: number;
  updatedAt: number;
}

/** Accepts current or legacy draft shapes before normalization. */
export type AutorigWizardDraftInput = Omit<AutorigWizardDraftRecord, 'step' | 'version'> & {
  version?: 1 | 2;
  step: AutorigWizardLegacyStepId | string;
};

/** Map old draft / caller step IDs onto the two-step wizard. */
export function migrateAutorigWizardStep(
  step: AutorigWizardLegacyStepId | string | null | undefined,
): AutorigWizardStepId {
  if (step === 'joints') return 'joints';
  if (step === 'pose-fix' || step === 'regions' || step === 'preview') return 'pose-fix';
  return 'joints';
}

export function normalizeAutorigWizardDraft(
  record: AutorigWizardDraftInput,
): AutorigWizardDraftRecord {
  return {
    ...record,
    version: 2,
    step: migrateAutorigWizardStep(record.step),
    mode: record.mode === 'paint' || record.mode === 'lasso' || record.mode === 'inspect'
      ? record.mode
      : undefined,
  };
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'rigId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open autorig draft storage.'));
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeRegionDraftBytes(labels: Uint8Array): string {
  return bytesToBase64(labels);
}

export function decodeRegionDraftBytes(b64: string | undefined | null): Uint8Array | null {
  if (!b64) return null;
  try {
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}

export async function loadAutorigWizardDraft(rigId: string): Promise<AutorigWizardDraftRecord | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(rigId);
    request.onsuccess = () => {
      const raw = (request.result as AutorigWizardDraftRecord | undefined) ?? null;
      db.close();
      resolve(raw ? normalizeAutorigWizardDraft(raw) : null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error ?? new Error('Failed to load autorig draft.'));
    };
  });
}

export async function saveAutorigWizardDraft(record: AutorigWizardDraftInput): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  const normalized = normalizeAutorigWizardDraft(record);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(normalized);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Failed to save autorig draft.'));
    };
  });
}

export async function clearAutorigWizardDraft(rigId: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(rigId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Failed to clear autorig draft.'));
    };
  });
}

/** In-memory fallback used by unit tests when IndexedDB is unavailable. */
const memoryDrafts = new Map<string, AutorigWizardDraftRecord>();

export function saveAutorigWizardDraftSyncForTests(record: AutorigWizardDraftInput): void {
  memoryDrafts.set(record.rigId, normalizeAutorigWizardDraft(record));
}

export function loadAutorigWizardDraftSyncForTests(rigId: string): AutorigWizardDraftRecord | null {
  const raw = memoryDrafts.get(rigId);
  return raw ? normalizeAutorigWizardDraft(raw) : null;
}

export function clearAutorigWizardDraftSyncForTests(rigId?: string): void {
  if (rigId) memoryDrafts.delete(rigId);
  else memoryDrafts.clear();
}
