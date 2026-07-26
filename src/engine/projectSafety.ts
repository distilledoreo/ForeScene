import type { LocationProject, ProjectAsset } from '../domain/types';
import { dataUrlToBlob } from './fileTransfers';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { getModelAsset, getModelAssetVersion, putModelAssets } from './modelAssetStore';
import { getReferencedProjectAssetIds, pruneUnreferencedProjectAssets } from './projectAssets';
import {
  PROJECT_ASSET_URI_PREFIX,
  getProjectAssetBlob,
  putProjectAssetBlobs,
  resolveProjectAssetUri,
} from './projectAssetStore';
import {
  activateProjectRevision,
  deleteProjectRevision,
  getProjectRevision,
  getProjectRevisionHead,
  listAllProjectRevisions,
  listProjectRevisionHeads,
  listProjectRevisions,
  type ProjectRevisionKind,
  type ProjectRevisionRecord,
  writeProjectRevision,
} from './projectRevisionStore';
import { parseProject } from './projectIO';

const PROJECT_ASSET_RESOURCE_PREFIX = 'recovery-resource/project-asset/';
const MODEL_RESOURCE_PREFIX = 'recovery-resource/model/';
const MAX_AUTOSAVE_REVISIONS = 8;
const MAX_SNAPSHOTS = 10;

const projectAssetResourceCache = new WeakMap<Blob, string>();
const modelResourceCache = new Map<string, { byteLength: number; sourceVersion?: number; resourceKey: string }>();
let lastRevisionTimestamp = 0;

export type ProjectSaveStatus = 'saved' | 'saving' | 'unsaved' | 'failed' | 'recovered';

export interface ProjectRevisionSummary {
  id: string;
  projectId: string;
  kind: ProjectRevisionKind;
  reason: string;
  createdAt: string;
  isActive: boolean;
}

export interface ProjectRevisionSaveResult {
  revision: ProjectRevisionRecord;
  previousRevisionId?: string;
}

export interface RecoveredProject {
  project: LocationProject;
  revision: ProjectRevisionRecord;
  recoveredPreviousRevision: boolean;
}

export interface ProjectStorageEstimate {
  supported: boolean;
  usageBytes?: number;
  quotaBytes?: number;
  availableBytes?: number;
  estimatedWriteBytes: number;
}

export class ProjectStorageQuotaError extends Error {
  readonly estimate: ProjectStorageEstimate;

  constructor(estimate: ProjectStorageEstimate) {
    super('Not enough browser storage is available to save this project safely. Your last verified save is still intact.');
    this.name = 'ProjectStorageQuotaError';
    this.estimate = estimate;
  }
}

function createRevisionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `revision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function nextRevisionCreatedAt(): string {
  const timestamp = Math.max(Date.now(), lastRevisionTimestamp + 1);
  lastRevisionTimestamp = timestamp;
  return new Date(timestamp).toISOString();
}

function copyProject(project: LocationProject): LocationProject {
  return structuredClone(pruneUnreferencedProjectAssets(project));
}

function isRasterOrVideoAsset(asset: ProjectAsset): boolean {
  return asset.type === 'image' || asset.type === 'video';
}

function storageKeyFromAsset(asset: Pick<ProjectAsset, 'storageKey' | 'uri'>): string | undefined {
  return asset.storageKey ?? (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)
    ? asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length)
    : undefined);
}

function validateBlob(asset: ProjectAsset, blob: Blob): void {
  if (blob.size <= 0) throw new Error(`Asset ${asset.name} is empty and cannot be saved safely.`);
  if (asset.mimeType && blob.type && asset.mimeType !== blob.type) {
    throw new Error(`Asset ${asset.name} has inconsistent MIME metadata (${asset.mimeType} versus ${blob.type}).`);
  }
  if (asset.type === 'image' && blob.type && !blob.type.startsWith('image/')) {
    throw new Error(`Asset ${asset.name} is not an image blob.`);
  }
  if (asset.type === 'video' && blob.type && !blob.type.startsWith('video/')) {
    throw new Error(`Asset ${asset.name} is not a video blob.`);
  }
}

function validateModelBytes(asset: ProjectAsset, bytes: ArrayBuffer): void {
  if (bytes.byteLength <= 0) throw new Error(`Model asset ${asset.name} is empty and cannot be saved safely.`);
}

async function bytesDigest(bytes: ArrayBuffer): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // The fallback keeps storage keys deterministic in runtimes without WebCrypto.
  // It is not a security primitive; integrity is still checked by byte count and
  // IndexedDB readback before an active pointer is promoted.
  let hash = 2166136261;
  for (const byte of new Uint8Array(bytes)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16)}-${bytes.byteLength}`;
}

async function blobDigest(blob: Blob): Promise<string> {
  return bytesDigest(await blob.arrayBuffer());
}

async function resolveAssetBlob(asset: ProjectAsset): Promise<Blob> {
  if (asset.uri.startsWith('data:')) return dataUrlToBlob(asset.uri);
  const key = storageKeyFromAsset(asset);
  if (key) {
    const blob = await getProjectAssetBlob(key);
    if (blob) return blob;
  }
  if (asset.uri.startsWith('blob:')) {
    const response = await fetch(asset.uri);
    if (response.ok) return response.blob();
  }
  throw new Error(`Asset ${asset.name} cannot be resolved from local storage.`);
}

async function ensureProjectAssetResource(asset: ProjectAsset): Promise<string> {
  const sourceKey = storageKeyFromAsset(asset);
  if (sourceKey?.startsWith(PROJECT_ASSET_RESOURCE_PREFIX)) {
    const existing = await getProjectAssetBlob(sourceKey);
    if (!existing) throw new Error(`Saved asset ${asset.name} is missing from local recovery storage.`);
    validateBlob(asset, existing);
    return sourceKey;
  }

  const blob = await resolveAssetBlob(asset);
  validateBlob(asset, blob);
  const cached = projectAssetResourceCache.get(blob);
  if (cached) {
    const verified = await getProjectAssetBlob(cached);
    if (verified && verified.size === blob.size && verified.type === blob.type) return cached;
    projectAssetResourceCache.delete(blob);
  }
  const digest = await blobDigest(blob);
  const typeSegment = encodeURIComponent(blob.type || asset.mimeType || 'application/octet-stream');
  const resourceKey = `${PROJECT_ASSET_RESOURCE_PREFIX}${digest}/${typeSegment}`;
  const existing = await getProjectAssetBlob(resourceKey);
  if (existing) {
    validateBlob(asset, existing);
    if (existing.size !== blob.size) throw new Error(`Saved asset ${asset.name} failed an integrity size check.`);
  } else {
    await putProjectAssetBlobs([{ key: resourceKey, blob }]);
    const verified = await getProjectAssetBlob(resourceKey);
    if (!verified) throw new Error(`Saved asset ${asset.name} could not be read back after writing.`);
    validateBlob(asset, verified);
    if (verified.size !== blob.size || verified.type !== blob.type) {
      throw new Error(`Saved asset ${asset.name} failed an integrity check after writing.`);
    }
  }
  projectAssetResourceCache.set(blob, resourceKey);
  return resourceKey;
}

async function resolveModelBytes(asset: ProjectAsset): Promise<ArrayBuffer> {
  if (asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
    const bytes = await getModelAsset(asset.uri.slice(MODEL_ASSET_URI_PREFIX.length));
    if (bytes) return bytes;
  }
  if (asset.uri.startsWith('data:')) return dataUrlToBlob(asset.uri).arrayBuffer();
  throw new Error(`Model asset ${asset.name} cannot be resolved from local storage.`);
}

async function ensureModelResource(asset: ProjectAsset): Promise<string> {
  const sourceKey = asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)
    ? asset.uri.slice(MODEL_ASSET_URI_PREFIX.length)
    : undefined;
  if (sourceKey?.startsWith(MODEL_RESOURCE_PREFIX)) {
    const existing = await getModelAsset(sourceKey);
    if (!existing) throw new Error(`Saved model ${asset.name} is missing from local recovery storage.`);
    validateModelBytes(asset, existing);
    return sourceKey;
  }

  const bytes = await resolveModelBytes(asset);
  validateModelBytes(asset, bytes);
  const sourceVersion = sourceKey ? getModelAssetVersion(sourceKey) : undefined;
  const cached = sourceKey ? modelResourceCache.get(sourceKey) : undefined;
  if (cached?.byteLength === bytes.byteLength && cached.sourceVersion === sourceVersion) {
    const verified = await getModelAsset(cached.resourceKey);
    if (verified && verified.byteLength === bytes.byteLength) return cached.resourceKey;
    if (sourceKey) modelResourceCache.delete(sourceKey);
  }
  const digest = await bytesDigest(bytes);
  const resourceKey = `${MODEL_RESOURCE_PREFIX}${digest}`;
  const existing = await getModelAsset(resourceKey);
  if (existing) {
    validateModelBytes(asset, existing);
    if (existing.byteLength !== bytes.byteLength) throw new Error(`Saved model ${asset.name} failed an integrity size check.`);
  } else {
    await putModelAssets([{ key: resourceKey, bytes }]);
    const verified = await getModelAsset(resourceKey);
    if (!verified) throw new Error(`Saved model ${asset.name} could not be read back after writing.`);
    validateModelBytes(asset, verified);
    if (verified.byteLength !== bytes.byteLength) {
      throw new Error(`Saved model ${asset.name} failed an integrity check after writing.`);
    }
  }
  if (sourceKey) modelResourceCache.set(sourceKey, { byteLength: bytes.byteLength, sourceVersion, resourceKey });
  return resourceKey;
}

function validateProjectStructure(project: LocationProject): LocationProject {
  // parseProject also normalizes accepted legacy data. It runs before any new
  // revision is staged, so malformed state can never replace a valid head.
  return parseProject(JSON.stringify(project));
}

function isDurableBrowserStorageAvailable(): boolean {
  // Unit tests intentionally use the in-memory store fallback. In an actual
  // browser, silently treating unavailable IndexedDB as a durable save would
  // violate the save-status contract.
  return typeof window === 'undefined' || typeof indexedDB !== 'undefined';
}

async function estimateNewRevisionBytes(project: LocationProject): Promise<number> {
  let estimated = new TextEncoder().encode(JSON.stringify(pruneUnreferencedProjectAssets(project))).byteLength;
  for (const asset of Object.values(pruneUnreferencedProjectAssets(project).assets.assets)) {
    const source = project.assets.assets[asset.id] ?? asset;
    if (isRasterOrVideoAsset(asset)) {
      const key = storageKeyFromAsset(source);
      if (key?.startsWith(PROJECT_ASSET_RESOURCE_PREFIX)) continue;
      const blob = await resolveAssetBlob(source);
      if (!projectAssetResourceCache.has(blob)) estimated += blob.size;
      continue;
    }
    if (asset.type === 'model') {
      const key = source.uri.startsWith(MODEL_ASSET_URI_PREFIX)
        ? source.uri.slice(MODEL_ASSET_URI_PREFIX.length)
        : undefined;
      if (key?.startsWith(MODEL_RESOURCE_PREFIX)) continue;
      const bytes = await resolveModelBytes(source);
      const cached = key ? modelResourceCache.get(key) : undefined;
      if (!cached || cached.byteLength !== bytes.byteLength || cached.sourceVersion !== (key ? getModelAssetVersion(key) : undefined)) {
        estimated += bytes.byteLength;
      }
    }
  }
  return estimated;
}

/**
 * Browser storage estimates are advisory, so saves still handle an actual
 * quota failure. This preflight prevents knowingly starting a large write
 * that cannot fit while preserving the active revision either way.
 */
export async function getProjectStorageEstimate(project: LocationProject): Promise<ProjectStorageEstimate> {
  const estimatedWriteBytes = await estimateNewRevisionBytes(project);
  if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
    return { supported: false, estimatedWriteBytes };
  }
  const estimate = await navigator.storage.estimate();
  const usageBytes = estimate.usage;
  const quotaBytes = estimate.quota;
  const availableBytes = usageBytes !== undefined && quotaBytes !== undefined
    ? Math.max(0, quotaBytes - usageBytes)
    : undefined;
  return {
    supported: usageBytes !== undefined || quotaBytes !== undefined,
    usageBytes,
    quotaBytes,
    availableBytes,
    estimatedWriteBytes,
  };
}

async function preflightProjectStorage(project: LocationProject): Promise<void> {
  if (!isDurableBrowserStorageAvailable()) {
    throw new Error('Browser local storage is unavailable. The project was not marked as saved; export a backup before continuing.');
  }
  const estimate = await getProjectStorageEstimate(project);
  // Leave a small commit margin for the revision metadata and IndexedDB
  // bookkeeping. An unsupported estimate remains a valid attempt; real quota
  // errors are still surfaced without moving the active pointer.
  if (estimate.availableBytes !== undefined && estimate.availableBytes < estimate.estimatedWriteBytes + 1024 * 1024) {
    throw new ProjectStorageQuotaError(estimate);
  }
}

async function createRevisionRecord(
  project: LocationProject,
  options: { kind: ProjectRevisionKind; reason: string },
): Promise<ProjectRevisionRecord> {
  const portable = validateProjectStructure(copyProject(project));
  const projectAssetKeys: string[] = [];
  const modelAssetKeys: string[] = [];

  for (const asset of Object.values(portable.assets.assets)) {
    const sourceAsset = project.assets.assets[asset.id] ?? asset;
    if (isRasterOrVideoAsset(asset)) {
      const resourceKey = await ensureProjectAssetResource(sourceAsset);
      asset.storageKey = resourceKey;
      asset.uri = `${PROJECT_ASSET_URI_PREFIX}${resourceKey}`;
      projectAssetKeys.push(resourceKey);
      continue;
    }
    if (asset.type === 'model') {
      const resourceKey = await ensureModelResource(sourceAsset);
      asset.uri = `${MODEL_ASSET_URI_PREFIX}${resourceKey}`;
      modelAssetKeys.push(resourceKey);
    }
  }

  const validatedManifest = validateProjectStructure(portable);
  return {
    id: createRevisionId(),
    projectId: validatedManifest.id,
    kind: options.kind,
    reason: options.reason,
    createdAt: nextRevisionCreatedAt(),
    manifest: JSON.stringify(validatedManifest),
    resources: {
      projectAssetKeys: [...new Set(projectAssetKeys)],
      modelAssetKeys: [...new Set(modelAssetKeys)],
    },
  };
}

async function trimProjectRevisions(projectId: string): Promise<void> {
  const [head, revisions] = await Promise.all([
    getProjectRevisionHead(projectId),
    listProjectRevisions(projectId),
  ]);
  const protectedIds = new Set([head?.activeRevisionId, head?.previousRevisionId].filter(Boolean));
  const newestFirst = [...revisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const autosaves = newestFirst.filter((record) => record.kind !== 'snapshot');
  const snapshots = newestFirst.filter((record) => record.kind === 'snapshot');
  const expired = [
    ...autosaves.slice(MAX_AUTOSAVE_REVISIONS),
    ...snapshots.slice(MAX_SNAPSHOTS),
  ].filter((record) => !protectedIds.has(record.id));
  await Promise.all(expired.map((record) => deleteProjectRevision(record.id)));
}

export async function saveProjectRevision(
  project: LocationProject,
  options: { kind?: ProjectRevisionKind; reason?: string } = {},
): Promise<ProjectRevisionSaveResult> {
  await preflightProjectStorage(project);
  const record = await createRevisionRecord(project, {
    kind: options.kind ?? 'autosave',
    reason: options.reason ?? 'Automatic save',
  });
  const head = await writeProjectRevision(record);
  await trimProjectRevisions(record.projectId);
  return { revision: record, previousRevisionId: head?.previousRevisionId };
}

export async function createProjectSnapshot(project: LocationProject, reason = 'Manual snapshot'): Promise<ProjectRevisionSaveResult> {
  return saveProjectRevision(project, { kind: 'snapshot', reason });
}

async function hydrateRevision(record: ProjectRevisionRecord): Promise<LocationProject> {
  const project = validateProjectStructure(JSON.parse(record.manifest) as LocationProject);
  for (const asset of Object.values(project.assets.assets)) {
    if (isRasterOrVideoAsset(asset)) {
      const key = storageKeyFromAsset(asset);
      if (!key) throw new Error(`Recovery revision is missing a storage key for ${asset.name}.`);
      const uri = await resolveProjectAssetUri(asset);
      if (!uri) throw new Error(`Recovery revision is missing binary asset ${asset.name}.`);
      asset.storageKey = key;
      asset.uri = uri;
      continue;
    }
    if (asset.type === 'model' && asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
      const bytes = await getModelAsset(asset.uri.slice(MODEL_ASSET_URI_PREFIX.length));
      if (!bytes) throw new Error(`Recovery revision is missing model asset ${asset.name}.`);
    }
  }
  return project;
}

export async function loadProjectRevision(revisionId: string): Promise<{ project: LocationProject; revision: ProjectRevisionRecord }> {
  const record = await getProjectRevision(revisionId);
  if (!record) throw new Error('The requested project revision is unavailable.');
  return { project: await hydrateRevision(record), revision: record };
}

export async function restoreProjectRevision(projectId: string, revisionId: string): Promise<{ project: LocationProject; revision: ProjectRevisionRecord }> {
  const loaded = await loadProjectRevision(revisionId);
  if (loaded.revision.projectId !== projectId) throw new Error('That snapshot belongs to another project.');
  await activateProjectRevision(projectId, revisionId);
  return loaded;
}

export async function recoverLatestProject(): Promise<RecoveredProject | undefined> {
  const heads = (await listProjectRevisionHeads())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const head of heads) {
    const candidates = [head.activeRevisionId, head.previousRevisionId].filter(Boolean) as string[];
    for (const revisionId of candidates) {
      try {
        const loaded = await loadProjectRevision(revisionId);
        const recoveredPreviousRevision = revisionId !== head.activeRevisionId;
        if (recoveredPreviousRevision) await activateProjectRevision(head.projectId, revisionId);
        return { ...loaded, recoveredPreviousRevision };
      } catch {
        // Try the prior known-good revision before considering another project.
      }
    }
  }
  return undefined;
}

export async function listProjectRevisionSummaries(projectId: string): Promise<ProjectRevisionSummary[]> {
  const [head, revisions] = await Promise.all([
    getProjectRevisionHead(projectId),
    listProjectRevisions(projectId),
  ]);
  return revisions
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((record) => ({
      id: record.id,
      projectId: record.projectId,
      kind: record.kind,
      reason: record.reason,
      createdAt: record.createdAt,
      isActive: record.id === head?.activeRevisionId,
    }));
}

export async function getRetainedResourceKeys(projectId: string): Promise<{ projectAssetKeys: Set<string>; modelAssetKeys: Set<string> }> {
  const revisions = await listProjectRevisions(projectId);
  return {
    projectAssetKeys: new Set(revisions.flatMap((revision) => revision.resources.projectAssetKeys)),
    modelAssetKeys: new Set(revisions.flatMap((revision) => revision.resources.modelAssetKeys)),
  };
}

export async function getAllRetainedResourceKeys(): Promise<{ projectAssetKeys: Set<string>; modelAssetKeys: Set<string> }> {
  const revisions = await listAllProjectRevisions();
  return {
    projectAssetKeys: new Set(revisions.flatMap((revision) => revision.resources.projectAssetKeys)),
    modelAssetKeys: new Set(revisions.flatMap((revision) => revision.resources.modelAssetKeys)),
  };
}

/** IDs referenced by the current project, useful to avoid cleanup of unsaved live data. */
export function getCurrentProjectReferencedAssetIds(project: LocationProject): Set<string> {
  return getReferencedProjectAssetIds(project);
}
