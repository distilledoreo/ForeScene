import type { LocationProject, ProjectAsset } from '../domain/types';
import { dataUrlToBlob } from './fileTransfers';
import { getModelAssetStorageKey, MISSING_ASSET_URI_PREFIX, MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import {
  deleteModelAsset,
  getModelAsset,
  getModelAssetVersion,
  listModelAssetKeys,
  putModelAssets,
} from './modelAssetStore';
import {
  MODEL_RESOURCE_PREFIX,
  PROJECT_ASSET_RESOURCE_PREFIX,
  blobSha256Digest,
  digestFromRecoveryResourceKey,
  sha256Digest,
  verifyBinaryDigest,
  type BinaryIntegrityMetadata,
} from './binaryIntegrity';
import { getReferencedProjectAssetIds, pruneUnreferencedProjectAssets } from './projectAssets';
import {
  PROJECT_ASSET_URI_PREFIX,
  deleteProjectAssetBlob,
  getProjectAssetBlob,
  getProjectAssetBlobVersion,
  listProjectAssetBlobKeys,
  putProjectAssetBlobs,
  resolveProjectAssetUri,
} from './projectAssetStore';
import {
  activateProjectRevision,
  deleteProjectHistory,
  deleteProjectRevision,
  getProjectRevision,
  getProjectRevisionHead,
  listAllProjectRevisions,
  listProjectRevisionHeads,
  listProjectRevisions,
  type ProjectRevisionBinaryResource,
  type ProjectRevisionKind,
  type ProjectRevisionRecord,
  writeProjectRevision,
} from './projectRevisionStore';
import { parseProject } from './projectIO';

const MAX_AUTOSAVE_REVISIONS = 8;
const MAX_SNAPSHOTS = 10;

const projectAssetResourceCache = new WeakMap<Blob, ProjectRevisionBinaryResource>();
const modelResourceCache = new Map<string, {
  byteLength: number;
  sourceVersion?: number;
  resource: ProjectRevisionBinaryResource;
}>();
const verifiedProjectResourceCache = new Map<string, { sourceVersion?: number; sha256: string }>();
const verifiedModelResourceCache = new Map<string, { sourceVersion?: number; sha256: string }>();
let lastRevisionTimestamp = 0;

export type ProjectSaveStatus = 'saved' | 'saving' | 'unsaved' | 'failed' | 'recovered';

export interface ProjectRevisionSummary {
  id: string;
  projectId: string;
  kind: ProjectRevisionKind;
  reason: string;
  createdAt: string;
  isActive: boolean;
  isPreviousKnownGood: boolean;
}

export interface ProjectRevisionSaveResult {
  revision: ProjectRevisionRecord;
  previousRevisionId?: string;
  maintenanceWarning?: string;
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

export interface ProjectStoragePersistence {
  supported: boolean;
  persistent?: boolean;
  requested: boolean;
}

export interface LocalProjectHistory {
  projectId: string;
  name: string;
  updatedAt: string;
  revisionCount: number;
  activeRevisionId: string;
  previousRevisionId?: string;
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

function isRecoverableAssetFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('cannot be resolved')
    || message.includes('unavailable')
    || message.includes('missing binary')
    || message.includes('empty')
    || message.includes('invalid');
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

function toRevisionResource(metadata: BinaryIntegrityMetadata): ProjectRevisionBinaryResource {
  return {
    key: metadata.key,
    sha256: metadata.sha256,
    byteLength: metadata.byteLength,
    ...(metadata.mimeType ? { mimeType: metadata.mimeType } : {}),
  };
}

function resourceMetadataFor(
  record: ProjectRevisionRecord,
  kind: 'projectAsset' | 'model',
  key: string,
): ProjectRevisionBinaryResource | undefined {
  const resources = kind === 'projectAsset' ? record.resources.projectAssets : record.resources.models;
  return resources?.find((resource) => resource.key === key);
}

export async function verifyRetainedProjectAssetResource(resource: ProjectRevisionBinaryResource): Promise<Blob> {
  const blob = await getProjectAssetBlob(resource.key);
  if (!blob) throw new Error(`Recovery resource ${resource.key} is missing.`);
  if (resource.byteLength >= 0 && blob.size !== resource.byteLength) {
    throw new Error(`Recovery resource ${resource.key} has an unexpected byte length.`);
  }
  const sha256 = resource.sha256 || digestFromRecoveryResourceKey(resource.key);
  if (sha256) {
    const sourceVersion = getProjectAssetBlobVersion(resource.key);
    const cached = verifiedProjectResourceCache.get(resource.key);
    if (!cached || cached.sourceVersion !== sourceVersion || cached.sha256 !== sha256) {
      await verifyBinaryDigest(await blob.arrayBuffer(), sha256, `Recovery resource ${resource.key}`);
      verifiedProjectResourceCache.set(resource.key, { sourceVersion, sha256 });
    }
  }
  return blob;
}

export async function verifyRetainedModelResource(resource: ProjectRevisionBinaryResource): Promise<ArrayBuffer> {
  const bytes = await getModelAsset(resource.key);
  if (!bytes) throw new Error(`Recovery resource ${resource.key} is missing.`);
  if (resource.byteLength >= 0 && bytes.byteLength !== resource.byteLength) {
    throw new Error(`Recovery resource ${resource.key} has an unexpected byte length.`);
  }
  const sha256 = resource.sha256 || digestFromRecoveryResourceKey(resource.key);
  if (sha256) {
    const sourceVersion = getModelAssetVersion(resource.key);
    const cached = verifiedModelResourceCache.get(resource.key);
    if (!cached || cached.sourceVersion !== sourceVersion || cached.sha256 !== sha256) {
      await verifyBinaryDigest(bytes, sha256, `Recovery resource ${resource.key}`);
      verifiedModelResourceCache.set(resource.key, { sourceVersion, sha256 });
    }
  }
  return bytes;
}

async function verifyProjectAssetResource(
  asset: ProjectAsset,
  key: string,
  expected?: ProjectRevisionBinaryResource,
): Promise<Blob> {
  const blob = await verifyRetainedProjectAssetResource(expected ?? {
    key,
    sha256: digestFromRecoveryResourceKey(key) ?? '',
    byteLength: -1,
  });
  validateBlob(asset, blob);
  return blob;
}

async function verifyModelResource(
  asset: ProjectAsset,
  key: string,
  expected?: ProjectRevisionBinaryResource,
): Promise<ArrayBuffer> {
  const bytes = await verifyRetainedModelResource(expected ?? {
    key,
    sha256: digestFromRecoveryResourceKey(key) ?? '',
    byteLength: -1,
  });
  validateModelBytes(asset, bytes);
  return bytes;
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

async function ensureProjectAssetResource(asset: ProjectAsset): Promise<ProjectRevisionBinaryResource> {
  const sourceKey = storageKeyFromAsset(asset);
  if (sourceKey?.startsWith(PROJECT_ASSET_RESOURCE_PREFIX)) {
    const existing = await verifyProjectAssetResource(asset, sourceKey);
    const sha256 = digestFromRecoveryResourceKey(sourceKey) ?? await blobSha256Digest(existing);
    return toRevisionResource({ key: sourceKey, sha256, byteLength: existing.size, mimeType: existing.type || asset.mimeType });
  }

  const blob = await resolveAssetBlob(asset);
  validateBlob(asset, blob);
  const cached = projectAssetResourceCache.get(blob);
  if (cached) {
    const verified = await verifyProjectAssetResource(asset, cached.key, cached);
    if (verified.size === blob.size && verified.type === blob.type) return cached;
    projectAssetResourceCache.delete(blob);
  }
  const digest = await blobSha256Digest(blob);
  const typeSegment = encodeURIComponent(blob.type || asset.mimeType || 'application/octet-stream');
  const resourceKey = `${PROJECT_ASSET_RESOURCE_PREFIX}${digest}/${typeSegment}`;
  const resource = toRevisionResource({ key: resourceKey, sha256: digest, byteLength: blob.size, mimeType: blob.type || asset.mimeType });
  const existing = await getProjectAssetBlob(resourceKey);
  if (existing) {
    await verifyProjectAssetResource(asset, resourceKey, resource);
  } else {
    await putProjectAssetBlobs([{ key: resourceKey, blob, evictable: false }]);
    await verifyProjectAssetResource(asset, resourceKey, resource);
  }
  projectAssetResourceCache.set(blob, resource);
  return resource;
}

async function resolveModelBytes(asset: ProjectAsset): Promise<ArrayBuffer> {
  if (asset.uri.startsWith('data:')) return dataUrlToBlob(asset.uri).arrayBuffer();
  const sourceKey = getModelAssetStorageKey(asset);
  if (sourceKey) {
    const bytes = await getModelAsset(sourceKey);
    if (bytes) return bytes;
  }
  throw new Error(`Model asset ${asset.name} cannot be resolved from local storage.`);
}

async function ensureModelResource(asset: ProjectAsset): Promise<ProjectRevisionBinaryResource> {
  const sourceKey = asset.uri.startsWith('data:') ? undefined : getModelAssetStorageKey(asset);
  if (sourceKey?.startsWith(MODEL_RESOURCE_PREFIX)) {
    const existing = await verifyModelResource(asset, sourceKey);
    const sha256 = digestFromRecoveryResourceKey(sourceKey) ?? await sha256Digest(existing);
    return toRevisionResource({ key: sourceKey, sha256, byteLength: existing.byteLength });
  }

  const bytes = await resolveModelBytes(asset);
  validateModelBytes(asset, bytes);
  const sourceVersion = sourceKey ? getModelAssetVersion(sourceKey) : undefined;
  const cached = sourceKey ? modelResourceCache.get(sourceKey) : undefined;
  if (cached?.byteLength === bytes.byteLength && cached.sourceVersion === sourceVersion) {
    const verified = await verifyModelResource(asset, cached.resource.key, cached.resource);
    if (verified.byteLength === bytes.byteLength) return cached.resource;
    if (sourceKey) modelResourceCache.delete(sourceKey);
  }
  const digest = await sha256Digest(bytes);
  const resourceKey = `${MODEL_RESOURCE_PREFIX}${digest}`;
  const resource = toRevisionResource({ key: resourceKey, sha256: digest, byteLength: bytes.byteLength });
  const existing = await getModelAsset(resourceKey);
  if (existing) {
    await verifyModelResource(asset, resourceKey, resource);
  } else {
    await putModelAssets([{ key: resourceKey, bytes }]);
    await verifyModelResource(asset, resourceKey, resource);
  }
  if (sourceKey) modelResourceCache.set(sourceKey, { byteLength: bytes.byteLength, sourceVersion, resource });
  return resource;
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
      if (asset.resolutionStatus && asset.resolutionStatus !== 'available') continue;
      const key = storageKeyFromAsset(source);
      if (key?.startsWith(PROJECT_ASSET_RESOURCE_PREFIX)) continue;
      const blob = await resolveAssetBlob(source);
      if (!projectAssetResourceCache.has(blob)) estimated += blob.size;
      continue;
    }
    if (asset.type === 'model') {
      if (asset.resolutionStatus && asset.resolutionStatus !== 'available') continue;
      const key = source.uri.startsWith('data:') ? undefined : getModelAssetStorageKey(source);
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

/** Ask the browser to protect local recovery data from best-effort eviction. */
export async function requestPersistentProjectStorage(): Promise<ProjectStoragePersistence> {
  if (typeof navigator === 'undefined' || !navigator.storage) return { supported: false, requested: false };
  const storage = navigator.storage;
  if (typeof storage.persisted !== 'function' || typeof storage.persist !== 'function') {
    return { supported: false, requested: false };
  }
  try {
    if (await storage.persisted()) return { supported: true, persistent: true, requested: false };
    const persistent = await storage.persist();
    return { supported: true, persistent, requested: true };
  } catch {
    return { supported: true, persistent: false, requested: true };
  }
}

/** Read the current browser persistence state without prompting again. */
export async function getPersistentProjectStorageStatus(): Promise<ProjectStoragePersistence> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return { supported: false, requested: false };
  try {
    return { supported: true, persistent: await navigator.storage.persisted(), requested: false };
  } catch {
    return { supported: true, persistent: false, requested: false };
  }
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
  const projectAssets: ProjectRevisionBinaryResource[] = [];
  const models: ProjectRevisionBinaryResource[] = [];

  for (const asset of Object.values(portable.assets.assets)) {
    const sourceAsset = project.assets.assets[asset.id] ?? asset;
    if (isRasterOrVideoAsset(asset)) {
      if (asset.resolutionStatus && asset.resolutionStatus !== 'available') continue;
      try {
        const resource = await ensureProjectAssetResource(sourceAsset);
        asset.storageKey = resource.key;
        asset.uri = `${PROJECT_ASSET_URI_PREFIX}${resource.key}`;
        projectAssetKeys.push(resource.key);
        projectAssets.push(resource);
      } catch (error) {
        if (!isRecoverableAssetFailure(error)) throw error;
        asset.resolutionStatus = 'missing';
        asset.uri = `${MISSING_ASSET_URI_PREFIX}${asset.id}`;
      }
      continue;
    }
    if (asset.type === 'model') {
      if (asset.resolutionStatus && asset.resolutionStatus !== 'available') continue;
      try {
        const resource = await ensureModelResource(sourceAsset);
        asset.storageKey = resource.key;
        asset.uri = `${MODEL_ASSET_URI_PREFIX}${resource.key}`;
        modelAssetKeys.push(resource.key);
        models.push(resource);
      } catch (error) {
        if (!isRecoverableAssetFailure(error)) throw error;
        asset.resolutionStatus = 'missing';
        asset.uri = `${MISSING_ASSET_URI_PREFIX}${asset.id}`;
      }
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
      projectAssets: dedupeRevisionResources(projectAssets),
      models: dedupeRevisionResources(models),
    },
  };
}

function dedupeRevisionResources(resources: readonly ProjectRevisionBinaryResource[]): ProjectRevisionBinaryResource[] {
  return [...new Map(resources.map((resource) => [resource.key, resource])).values()];
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
  // The active-pointer transaction above is the durable commit boundary. A
  // failed retention cleanup must never recast that successful save as failed.
  let maintenanceWarning: string | undefined;
  try {
    await trimProjectRevisions(record.projectId);
  } catch {
    maintenanceWarning = 'The new verified save is safe, but old recovery-point cleanup will be retried later.';
  }
  return { revision: record, previousRevisionId: head?.previousRevisionId, maintenanceWarning };
}

export async function createProjectSnapshot(project: LocationProject, reason = 'Manual snapshot'): Promise<ProjectRevisionSaveResult> {
  return saveProjectRevision(project, { kind: 'snapshot', reason });
}

/**
 * Pure schema migration may attach planned storage keys to assets that still hold
 * inline data URLs (e.g. legacy keyframe previews). Stage those binaries into
 * content-addressed recovery storage before treating the asset as already persisted.
 */
async function hydrateInlineRasterOrVideoAsset(asset: ProjectAsset): Promise<void> {
  const blob = dataUrlToBlob(asset.uri);
  validateBlob(asset, blob);
  const resource = await ensureProjectAssetResource(asset);
  asset.storageKey = resource.key;
  asset.uri = `${PROJECT_ASSET_URI_PREFIX}${resource.key}`;
  const uri = await resolveProjectAssetUri(asset);
  if (!uri) throw new Error(`Recovery revision is missing binary asset ${asset.name}.`);
  asset.uri = uri;
}

function retargetKeyframePreviewStorageKeys(
  project: LocationProject,
  assetId: string,
  storageKey: string,
): void {
  for (const shot of project.shots) {
    for (const keyframe of shot.cameraKeyframes ?? []) {
      if (keyframe.previewAssetId === assetId) {
        keyframe.previewStorageKey = storageKey;
      }
    }
  }
}

async function hydrateRevision(record: ProjectRevisionRecord): Promise<LocationProject> {
  const project = validateProjectStructure(JSON.parse(record.manifest) as LocationProject);
  for (const asset of Object.values(project.assets.assets)) {
    if (isRasterOrVideoAsset(asset)) {
      // Migrated inline payloads are available on the asset itself even when the
      // planned storage key was never written to IndexedDB.
      if (asset.uri.startsWith('data:')) {
        await hydrateInlineRasterOrVideoAsset(asset);
        if (asset.storageKey) {
          retargetKeyframePreviewStorageKeys(project, asset.id, asset.storageKey);
        }
        continue;
      }
      try {
        const key = storageKeyFromAsset(asset);
        if (!key) throw new Error(`Recovery revision is missing a storage key for ${asset.name}.`);
        await verifyProjectAssetResource(asset, key, resourceMetadataFor(record, 'projectAsset', key));
        const uri = await resolveProjectAssetUri(asset);
        if (!uri) throw new Error(`Recovery revision is missing binary asset ${asset.name}.`);
        asset.storageKey = key;
        asset.uri = uri;
      } catch (error) {
        if (!isRecoverableAssetFailure(error)) throw error;
        asset.resolutionStatus = 'missing';
        asset.uri = `${MISSING_ASSET_URI_PREFIX}${asset.id}`;
      }
      continue;
    }
    if (asset.type === 'model' && asset.resolutionStatus !== 'missing' && asset.resolutionStatus !== 'corrupt' && asset.resolutionStatus !== 'unsupported') {
      const key = asset.uri.startsWith('data:') ? undefined : getModelAssetStorageKey(asset);
      if (!key) {
        if (asset.uri.startsWith('data:')) {
          continue;
        }
        asset.resolutionStatus = 'missing';
        asset.uri = `${MISSING_ASSET_URI_PREFIX}${asset.id}`;
        continue;
      }
      try {
        await verifyModelResource(asset, key, resourceMetadataFor(record, 'model', key));
        asset.storageKey = key;
        asset.uri = `${MODEL_ASSET_URI_PREFIX}${key}`;
      } catch (error) {
        if (!isRecoverableAssetFailure(error)) throw error;
        asset.resolutionStatus = 'missing';
        asset.uri = `${MISSING_ASSET_URI_PREFIX}${asset.id}`;
      }
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
    const attempted = new Set<string>();
    const tryRevision = async (revisionId: string | undefined): Promise<RecoveredProject | undefined> => {
      if (!revisionId || attempted.has(revisionId)) return undefined;
      attempted.add(revisionId);
      try {
        const loaded = await loadProjectRevision(revisionId);
        const recoveredPreviousRevision = revisionId !== head.activeRevisionId;
        if (recoveredPreviousRevision) await activateProjectRevision(head.projectId, revisionId);
        return { ...loaded, recoveredPreviousRevision };
      } catch {
        return undefined;
      }
    };
    // Read the known-good heads directly. IndexedDB getAll can fail because of
    // one unrelated damaged retained record even when both heads remain intact.
    for (const revisionId of [head.activeRevisionId, head.previousRevisionId]) {
      const recovered = await tryRevision(revisionId);
      if (recovered) return recovered;
    }
    // Keep history failures visible when neither head can be recovered; treating
    // unreadable storage as an empty history could silently create a blank project.
    const revisions = await listProjectRevisions(head.projectId);
    const newestFirst = [...revisions].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const candidates = [
      ...newestFirst.filter((revision) => revision.kind === 'snapshot'),
      ...newestFirst.filter((revision) => revision.kind !== 'snapshot'),
    ];
    for (const revision of candidates) {
      const recovered = await tryRevision(revision.id);
      if (recovered) return recovered;
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
      isPreviousKnownGood: record.id === head?.previousRevisionId,
    }));
}

/** List every retained local project head, not just the most recently opened one. */
export async function listLocalProjectHistories(): Promise<LocalProjectHistory[]> {
  const [heads, revisions] = await Promise.all([listProjectRevisionHeads(), listAllProjectRevisions()]);
  const revisionsByProject = new Map<string, ProjectRevisionRecord[]>();
  for (const revision of revisions) {
    const values = revisionsByProject.get(revision.projectId) ?? [];
    values.push(revision);
    revisionsByProject.set(revision.projectId, values);
  }
  return heads
    .map((head) => {
      const projectRevisions = revisionsByProject.get(head.projectId) ?? [];
      const active = projectRevisions.find((revision) => revision.id === head.activeRevisionId);
      let name = 'Untitled local project';
      try {
        const manifest = active ? JSON.parse(active.manifest) as { name?: unknown } : undefined;
        if (typeof manifest?.name === 'string' && manifest.name.trim()) name = manifest.name;
      } catch {
        // A corrupt manifest remains visible so the user can intentionally remove it.
        name = 'Unreadable local project';
      }
      return {
        projectId: head.projectId,
        name,
        updatedAt: head.updatedAt,
        revisionCount: projectRevisions.length,
        activeRevisionId: head.activeRevisionId,
        ...(head.previousRevisionId ? { previousRevisionId: head.previousRevisionId } : {}),
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Intentionally remove a non-open local project history and only then reclaim
 * unreferenced recovery payloads. Shared content-addressed data remains until
 * no retained revision references it.
 */
export async function removeLocalProjectHistory(projectId: string, liveProject?: LocationProject): Promise<{
  revisionsRemoved: number;
  projectAssetsRemoved: number;
  modelAssetsRemoved: number;
}>;
export async function removeLocalProjectHistory(projectId: string, liveProject?: LocationProject): Promise<{
  revisionsRemoved: number;
  projectAssetsRemoved: number;
  modelAssetsRemoved: number;
}> {
  const removed = await deleteProjectHistory(projectId);
  const [retained, projectAssetKeys, modelAssetKeys] = await Promise.all([
    getAllRetainedResourceKeys(),
    listProjectAssetBlobKeys(),
    listModelAssetKeys(),
  ]);
  const liveProjectAssetKeys = new Set(Object.values(liveProject?.assets.assets ?? {})
    .filter(isRasterOrVideoAsset)
    .map(storageKeyFromAsset)
    .filter((key): key is string => Boolean(key)));
  const liveModelKeys = new Set(Object.values(liveProject?.assets.assets ?? {})
    .filter((asset) => asset.type === 'model')
    .map((asset) => getModelAssetStorageKey(asset))
    .filter((key): key is string => Boolean(key)));
  const staleProjectAssetKeys = projectAssetKeys.filter((key) => (
    (key.startsWith(PROJECT_ASSET_RESOURCE_PREFIX) && !retained.projectAssetKeys.has(key) && !liveProjectAssetKeys.has(key))
    || key.startsWith(`project/${projectId}/`)
    || key.startsWith(`import/${projectId}/`)
  ));
  const staleModelKeys = modelAssetKeys.filter((key) => (
    (key.startsWith(MODEL_RESOURCE_PREFIX) && !retained.modelAssetKeys.has(key) && !liveModelKeys.has(key))
    || key.startsWith(`project/${projectId}/`)
    || key.startsWith(`import/${projectId}/`)
  ));
  await Promise.all(staleProjectAssetKeys.map((key) => deleteProjectAssetBlob(key)));
  await Promise.all(staleModelKeys.map((key) => deleteModelAsset(key)));
  return {
    revisionsRemoved: removed.length,
    projectAssetsRemoved: staleProjectAssetKeys.length,
    modelAssetsRemoved: staleModelKeys.length,
  };
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

/** Explicit integrity metadata for every retained binary, including legacy fallbacks. */
export async function getAllRetainedBinaryResources(): Promise<{
  projectAssets: ProjectRevisionBinaryResource[];
  models: ProjectRevisionBinaryResource[];
}> {
  const revisions = await listAllProjectRevisions();
  const projectAssets = new Map<string, ProjectRevisionBinaryResource>();
  const models = new Map<string, ProjectRevisionBinaryResource>();
  for (const revision of revisions) {
    for (const resource of revision.resources.projectAssets ?? []) projectAssets.set(resource.key, resource);
    for (const resource of revision.resources.models ?? []) models.set(resource.key, resource);
    for (const key of revision.resources.projectAssetKeys) {
      if (!projectAssets.has(key)) {
        const sha256 = digestFromRecoveryResourceKey(key);
        if (sha256) projectAssets.set(key, { key, sha256, byteLength: -1 });
      }
    }
    for (const key of revision.resources.modelAssetKeys) {
      if (!models.has(key)) {
        const sha256 = digestFromRecoveryResourceKey(key);
        if (sha256) models.set(key, { key, sha256, byteLength: -1 });
      }
    }
  }
  return { projectAssets: [...projectAssets.values()], models: [...models.values()] };
}

/** IDs referenced by the current project, useful to avoid cleanup of unsaved live data. */
export function getCurrentProjectReferencedAssetIds(project: LocationProject): Set<string> {
  return getReferencedProjectAssetIds(project);
}
