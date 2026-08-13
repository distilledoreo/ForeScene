/**
 * In-memory artifact registry for Agent API exports and renders.
 * Artifacts are stable handles agents can retrieve without browser download events.
 *
 * Job-owned unpublished outputs are deleted after that job generation drains.
 * Pause/cancel may flip public job state immediately, but the orphan sweep
 * waits until the generation's handlers have settled. Published job results,
 * persisted artifacts, and project-attached artifacts are never deleted by
 * that sweep. A leftover in-flight pin on a retained durable artifact is
 * cleared so an aborted generation cannot pin the registry forever.
 */

import type { ProjectAsset } from '../../domain/types';
import { touchProject } from '../../state/slices/touchProject';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { blobSha256Digest } from '../binaryIntegrity';
import { downloadBlob } from '../fileTransfers';
import { storeProjectAssetBlob, createProjectAssetStorageKey } from '../projectAssetStore';
import { createId } from '../../utils/ids';
import { writeAccessRequiredDiagnostic } from './diagnostics';
import type {
  AgentArtifactDownloadResult,
  AgentArtifactEvictionInfo,
  AgentArtifactHandle,
  AgentArtifactPinReason,
} from './protocol';

interface StoredArtifact {
  id: string;
  blob: Blob;
  mimeType: string;
  fileName: string;
  revisionId?: string;
  createdAt: number;
  jobId?: string;
  /** Job-queue generation that owned this artifact when it was claimed. */
  runGeneration?: number;
  shotId?: string;
  persisted?: boolean;
  persistedKey?: string;
  projectAssetId?: string;
  authoritative?: boolean;
  inFlight?: boolean;
  sha256?: string;
  hashStatus: 'computed' | 'unavailable';
  lastAccessOrder: number;
}

const activeJobArtifactRuns = new Map<string, number>();

let lastEviction: AgentArtifactEvictionInfo = {
  evictedArtifactIds: [],
  pinnedCount: 0,
  evictableCount: 0,
  retainedOverBudget: false,
};

function pinReasonFor(stored: StoredArtifact): AgentArtifactPinReason | undefined {
  if (stored.inFlight) return 'in-flight';
  if (stored.persisted || stored.persistedKey) return 'persisted';
  if (stored.projectAssetId) return 'project-attached';
  if (stored.authoritative) return 'authoritative';
  return undefined;
}

function isPinned(stored: StoredArtifact): boolean {
  return pinReasonFor(stored) !== undefined;
}

function toHandle(stored: StoredArtifact): AgentArtifactHandle {
  const pinReason = pinReasonFor(stored);
  const hashComputed = stored.hashStatus === 'computed' && Boolean(stored.sha256);
  return {
    artifactId: stored.id,
    mimeType: stored.mimeType,
    fileName: stored.fileName,
    byteLength: stored.blob.size,
    revisionId: stored.revisionId,
    hashStatus: hashComputed ? 'computed' : 'unavailable',
    ...(hashComputed ? { sha256: stored.sha256 } : {}),
    ...(pinReason ? { pinned: true, pinReason } : {}),
  };
}

const registry = new Map<string, StoredArtifact>();
export const DEFAULT_MAX_RETAINED_ARTIFACTS = 64;
export const DEFAULT_MAX_RETAINED_ARTIFACT_BYTES = 512 * 1024 * 1024;
let maxRetainedArtifacts = DEFAULT_MAX_RETAINED_ARTIFACTS;
let maxRetainedArtifactBytes = DEFAULT_MAX_RETAINED_ARTIFACT_BYTES;
let artifactCounter = 0;
let artifactAccessOrder = 0;
const hashTasks = new Map<string, Promise<void>>();

function queueArtifactHash(stored: StoredArtifact): void {
  stored.hashStatus = 'unavailable';
  const task = blobSha256Digest(stored.blob)
    .then((digest) => {
      if (!registry.has(stored.id)) return;
      stored.sha256 = `sha256:${digest}`;
      stored.hashStatus = 'computed';
    })
    .catch(() => {
      if (!registry.has(stored.id)) return;
      stored.sha256 = undefined;
      stored.hashStatus = 'unavailable';
    });
  hashTasks.set(stored.id, task);
}

export async function awaitAgentArtifactHash(artifactId: string): Promise<string | undefined> {
  await hashTasks.get(artifactId);
  const stored = registry.get(artifactId);
  return stored?.hashStatus === 'computed' ? stored.sha256 : undefined;
}

export async function awaitAllAgentArtifactHashes(): Promise<void> {
  await Promise.all([...hashTasks.values()]);
}

function nextArtifactId(): string {
  artifactCounter += 1;
  return `artifact_${Date.now().toString(36)}_${artifactCounter.toString(36)}`;
}

function isDurableArtifact(stored: StoredArtifact): boolean {
  return Boolean(stored.persisted || stored.persistedKey || stored.projectAssetId);
}

function claimJobArtifactOwnership(stored: StoredArtifact, jobId: string): void {
  stored.jobId = jobId;
  if (stored.runGeneration !== undefined) return;
  const generation = activeJobArtifactRuns.get(jobId);
  if (generation !== undefined) stored.runGeneration = generation;
}

/** Mark the live job generation so later `jobId` registrations inherit ownership. */
export function beginAgentJobArtifactRun(jobId: string, generation: number): void {
  activeJobArtifactRuns.set(jobId, generation);
}

/** Drop ownership only for the generation that is actually ending. */
export function endAgentJobArtifactRun(jobId: string, generation: number): void {
  if (activeJobArtifactRuns.get(jobId) === generation) {
    activeJobArtifactRuns.delete(jobId);
  }
}

export function clearAgentJobArtifactRunsForTests(): void {
  activeJobArtifactRuns.clear();
}

/**
 * Delete unpublished job outputs after a generation drains.
 *
 * Orphan policy: a job-scoped artifact that was never published onto the job
 * result is not a successful result. After the owning generation's handlers
 * have settled it is removed so an ignored late `registerArtifact()` cannot
 * pin the registry forever. This does not require the handler to remember
 * `ctx.registerArtifact()`.
 *
 * Never deletes:
 * - artifacts listed in `publishedArtifactIds` (current or earlier published results)
 * - artifacts tagged with a different still-live `runGeneration`
 * - persisted or project-attached artifacts (in-flight is cleared instead)
 */
export function sweepUnpublishedJobArtifacts(params: {
  jobId: string;
  publishedArtifactIds?: Iterable<string>;
  runGeneration?: number;
}): { deletedArtifactIds: string[]; retainedArtifactIds: string[] } {
  const published = new Set(params.publishedArtifactIds ?? []);
  const deletedArtifactIds: string[] = [];
  const retainedArtifactIds: string[] = [];

  for (const stored of [...registry.values()]) {
    if (stored.jobId !== params.jobId) continue;
    if (published.has(stored.id)) {
      retainedArtifactIds.push(stored.id);
      continue;
    }
    if (
      params.runGeneration !== undefined
      && stored.runGeneration !== undefined
      && stored.runGeneration !== params.runGeneration
    ) {
      retainedArtifactIds.push(stored.id);
      continue;
    }
    if (isDurableArtifact(stored)) {
      stored.inFlight = false;
      retainedArtifactIds.push(stored.id);
      continue;
    }
    registry.delete(stored.id);
    hashTasks.delete(stored.id);
    deletedArtifactIds.push(stored.id);
  }

  return { deletedArtifactIds, retainedArtifactIds };
}

function touchArtifact(stored: StoredArtifact): void {
  artifactAccessOrder += 1;
  stored.lastAccessOrder = artifactAccessOrder;
}

function pruneArtifactRegistry(): AgentArtifactEvictionInfo {
  const evictedArtifactIds: string[] = [];
  let bytes = [...registry.values()].reduce((total, artifact) => total + artifact.blob.size, 0);
  while (
    registry.size > 0
    && (registry.size > maxRetainedArtifacts || bytes > maxRetainedArtifactBytes)
  ) {
    const evictable = [...registry.values()]
      .filter((artifact) => !isPinned(artifact))
      .sort((a, b) => a.lastAccessOrder - b.lastAccessOrder || a.createdAt - b.createdAt);
    const oldest = evictable[0];
    if (!oldest) break;
    registry.delete(oldest.id);
    hashTasks.delete(oldest.id);
    evictedArtifactIds.push(oldest.id);
    bytes -= oldest.blob.size;
  }
  const pinnedCount = [...registry.values()].filter(isPinned).length;
  const evictableCount = registry.size - pinnedCount;
  const retainedOverBudget = registry.size > maxRetainedArtifacts || bytes > maxRetainedArtifactBytes;
  lastEviction = {
    evictedArtifactIds,
    pinnedCount,
    evictableCount,
    retainedOverBudget,
    reason: retainedOverBudget
      ? 'Pinned persisted, authoritative, project-attached, or in-flight artifacts prevented further LRU eviction.'
      : evictedArtifactIds.length > 0
        ? `Evicted ${evictedArtifactIds.length} unpinned artifact(s) under the registry budget.`
        : undefined,
  };
  return lastEviction;
}

function assetTypeFromMime(mimeType: string): ProjectAsset['type'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/json' || mimeType.endsWith('/json')) return 'json';
  if (mimeType.startsWith('text/')) return 'text';
  return 'other';
}

export function registerAgentArtifact(params: {
  blob: Blob;
  mimeType: string;
  fileName: string;
  revisionId?: string;
  jobId?: string;
  shotId?: string;
  persisted?: boolean;
  /** Result handles default to pinned. Pass false (or evictable) for cache/temp entries. */
  authoritative?: boolean;
  /** When true, the handle is eligible for LRU eviction unless another pin applies. */
  evictable?: boolean;
  inFlight?: boolean;
  projectAssetId?: string;
}): AgentArtifactHandle {
  const id = nextArtifactId();
  const stored: StoredArtifact = {
    id,
    blob: params.blob,
    mimeType: params.mimeType,
    fileName: params.fileName,
    revisionId: params.revisionId,
    jobId: params.jobId,
    shotId: params.shotId,
    persisted: params.persisted,
    authoritative: params.evictable === true
      ? params.authoritative === true
      : params.authoritative !== false,
    inFlight: params.inFlight,
    projectAssetId: params.projectAssetId,
    hashStatus: 'unavailable',
    createdAt: Date.now(),
    lastAccessOrder: 0,
  };
  if (params.jobId) claimJobArtifactOwnership(stored, params.jobId);
  touchArtifact(stored);
  registry.set(id, stored);
  queueArtifactHash(stored);
  pruneArtifactRegistry();
  return toHandle(stored);
}

export function attachAgentArtifactContext(
  artifactId: string,
  patch: {
    jobId?: string;
    shotId?: string;
    inFlight?: boolean;
    authoritative?: boolean;
  },
): AgentArtifactHandle | undefined {
  const stored = registry.get(artifactId);
  if (!stored) return undefined;
  if (patch.jobId !== undefined) claimJobArtifactOwnership(stored, patch.jobId);
  if (patch.shotId !== undefined) stored.shotId = patch.shotId;
  if (patch.inFlight !== undefined) stored.inFlight = patch.inFlight;
  if (patch.authoritative !== undefined) stored.authoritative = patch.authoritative;
  touchArtifact(stored);
  return toHandle(stored);
}

export function getAgentArtifactBlob(artifactId: string): Blob | undefined {
  const stored = registry.get(artifactId);
  if (!stored) return undefined;
  touchArtifact(stored);
  return stored.blob;
}

export function getAgentArtifactHandle(artifactId: string): AgentArtifactHandle | undefined {
  const stored = registry.get(artifactId);
  if (!stored) return undefined;
  touchArtifact(stored);
  return toHandle(stored);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not encode artifact.'));
    reader.readAsDataURL(blob);
  });
}

export async function downloadAgentArtifact(input: {
  artifactId: string;
  /** When true (default), trigger a browser download. */
  download?: boolean;
  /** Legacy compatibility path; Blob is the default response. */
  includeDataUrl?: boolean;
}): Promise<AgentArtifactDownloadResult> {
  const stored = registry.get(input.artifactId);
  if (!stored) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [{ code: 'artifact_not_found', message: `No artifact with id "${input.artifactId}".`, severity: 'error' }],
    };
  }
  touchArtifact(stored);

  if (input.download !== false) downloadBlob(stored.blob, stored.fileName);
  const dataUrl = input.includeDataUrl ? await blobToDataUrl(stored.blob) : undefined;
  return {
    ok: true,
    status: 'completed',
    artifact: toHandle(stored),
    blob: stored.blob,
    transferMode: 'browser-blob',
    ...(dataUrl ? { dataUrl } : {}),
    diagnostics: [],
  };
}

export function resetAgentArtifactRegistryForTests(): void {
  registry.clear();
  hashTasks.clear();
  artifactCounter = 0;
  artifactAccessOrder = 0;
  clearAgentJobArtifactRunsForTests();
  maxRetainedArtifacts = DEFAULT_MAX_RETAINED_ARTIFACTS;
  maxRetainedArtifactBytes = DEFAULT_MAX_RETAINED_ARTIFACT_BYTES;
  lastEviction = {
    evictedArtifactIds: [],
    pinnedCount: 0,
    evictableCount: 0,
    retainedOverBudget: false,
  };
}

export function setAgentArtifactRegistryLimitsForTests(params: {
  maxArtifacts?: number;
  maxBytes?: number;
}): void {
  if (params.maxArtifacts !== undefined) maxRetainedArtifacts = Math.max(1, Math.floor(params.maxArtifacts));
  if (params.maxBytes !== undefined) maxRetainedArtifactBytes = Math.max(1, Math.floor(params.maxBytes));
  pruneArtifactRegistry();
}

export function inspectAgentArtifactRegistryForTests(): Array<{
  artifactId: string;
  lastAccessOrder: number;
  byteLength: number;
  pinned?: boolean;
  pinReason?: AgentArtifactPinReason;
  jobId?: string;
  runGeneration?: number;
}> {
  return [...registry.values()].map((stored) => ({
    artifactId: stored.id,
    lastAccessOrder: stored.lastAccessOrder,
    byteLength: stored.blob.size,
    pinned: isPinned(stored),
    pinReason: pinReasonFor(stored),
    jobId: stored.jobId,
    runGeneration: stored.runGeneration,
  }));
}

export function inspectAgentArtifactEviction(): AgentArtifactEvictionInfo {
  const pinnedCount = [...registry.values()].filter(isPinned).length;
  return {
    ...lastEviction,
    pinnedCount,
    evictableCount: registry.size - pinnedCount,
  };
}

export function markAgentArtifactInFlight(artifactId: string, inFlight: boolean): void {
  const stored = registry.get(artifactId);
  if (!stored) return;
  stored.inFlight = inFlight;
}

export function markAgentArtifactAuthoritative(artifactId: string, authoritative = true): void {
  const stored = registry.get(artifactId);
  if (!stored) return;
  stored.authoritative = authoritative;
}

export function listAgentArtifacts(filter: {
  jobId?: string;
  revisionId?: string;
  shotId?: string;
} = {}): import('./protocol').AgentArtifactListItem[] {
  return [...registry.values()]
    .filter((stored) => (
      (!filter.jobId || stored.jobId === filter.jobId)
      && (!filter.revisionId || stored.revisionId === filter.revisionId)
      && (!filter.shotId || stored.shotId === filter.shotId)
    ))
    .map((stored) => {
      const hashComputed = stored.hashStatus === 'computed' && Boolean(stored.sha256);
      return {
        artifactId: stored.id,
        mimeType: stored.mimeType,
        fileName: stored.fileName,
        byteLength: stored.blob.size,
        revisionId: stored.revisionId,
        createdAt: stored.createdAt,
        persisted: stored.persisted,
        pinned: isPinned(stored),
        pinReason: pinReasonFor(stored),
        hashStatus: hashComputed ? 'computed' as const : 'unavailable' as const,
        ...(hashComputed ? { sha256: stored.sha256 } : {}),
      };
    });
}

export async function persistAgentArtifact(artifactId: string): Promise<import('./protocol').AgentArtifactStatusResult> {
  const stored = registry.get(artifactId);
  if (!stored) {
    return { ok: false, diagnostics: [{ code: 'artifact_not_found', message: `No artifact with id "${artifactId}".`, severity: 'error' }] };
  }

  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return { ok: false, diagnostics: [writeAccessRequiredDiagnostic('persistArtifact')] };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [{ code: 'persistence_not_ready', message: 'Project persistence is not ready.', severity: 'error' }] };
  }

  const projectId = useProjectStore.getState().project.id;
  const assetId = createId('asset');
  const assetType = assetTypeFromMime(stored.mimeType);

  try {
    await runDestructive('Persist agent artifact', () => {
      const baseAsset: ProjectAsset = {
        id: assetId,
        type: assetType,
        name: stored.fileName,
        uri: '',
        mimeType: stored.mimeType,
        createdAt: new Date().toISOString(),
        metadata: { source: 'agent_artifact', artifactId: stored.id },
      };
      const persistedAsset = storeProjectAssetBlob(projectId, baseAsset, stored.blob);

      useProjectStore.setState((state) => ({
        project: touchProject({
          ...state.project,
          assets: { assets: { ...state.project.assets.assets, [persistedAsset.id]: persistedAsset } },
        }),
      }));

      stored.persisted = true;
      stored.persistedKey = persistedAsset.storageKey ?? createProjectAssetStorageKey(projectId, persistedAsset.id);
      stored.projectAssetId = persistedAsset.id;
    });

    return {
      ok: true,
      artifact: toHandle(stored),
      persisted: true,
      diagnostics: [],
    };
  } catch (error) {
    return { ok: false, diagnostics: [{ code: 'persist_failed', message: error instanceof Error ? error.message : 'Artifact persistence failed.', severity: 'error' }] };
  }
}

export async function deleteAgentArtifact(artifactId: string): Promise<{ ok: boolean }> {
  const stored = registry.get(artifactId);
  if (!stored) return { ok: false };

  if (stored.persisted || stored.persistedKey || stored.projectAssetId) {
    if (useAgentControlStore.getState().controlMode !== 'read-write') return { ok: false };
  }

  if (stored.persistedKey) {
    const { deleteProjectAssetBlob } = await import('../projectAssetStore');
    await deleteProjectAssetBlob(stored.persistedKey);
  }

  if (stored.projectAssetId) {
    const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
    if (!runDestructive) return { ok: false };
    await runDestructive('Remove persisted agent artifact', () => {
      useProjectStore.setState((state) => {
        const assets = { ...state.project.assets.assets };
        delete assets[stored.projectAssetId!];
        return { project: touchProject({ ...state.project, assets: { assets } }) };
      });
    });
  }

  const removed = registry.delete(artifactId);
  if (removed) hashTasks.delete(artifactId);
  return { ok: removed };
}

export function getAgentArtifactStatus(artifactId: string): import('./protocol').AgentArtifactStatusResult {
  const stored = registry.get(artifactId);
  if (!stored) {
    return { ok: false, diagnostics: [{ code: 'artifact_not_found', message: `No artifact with id "${artifactId}".`, severity: 'error' }] };
  }
  touchArtifact(stored);
  return {
    ok: true,
    artifact: toHandle(stored),
    persisted: stored.persisted,
    diagnostics: [],
  };
}
