/**
 * In-memory artifact registry for Agent API exports and renders.
 * Artifacts are stable handles agents can retrieve without browser download events.
 */

import type { ProjectAsset } from '../../domain/types';
import { touchProject } from '../../state/slices/touchProject';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { downloadBlob } from '../fileTransfers';
import { storeProjectAssetBlob, createProjectAssetStorageKey } from '../projectAssetStore';
import { createId } from '../../utils/ids';
import { writeAccessRequiredDiagnostic } from './diagnostics';
import type { AgentArtifactHandle, AgentArtifactDownloadResult } from './protocol';

interface StoredArtifact {
  id: string;
  blob: Blob;
  mimeType: string;
  fileName: string;
  revisionId?: string;
  createdAt: number;
  jobId?: string;
  shotId?: string;
  persisted?: boolean;
  persistedKey?: string;
  projectAssetId?: string;
  lastAccessOrder: number;
}

const registry = new Map<string, StoredArtifact>();
export const DEFAULT_MAX_RETAINED_ARTIFACTS = 64;
export const DEFAULT_MAX_RETAINED_ARTIFACT_BYTES = 512 * 1024 * 1024;
let maxRetainedArtifacts = DEFAULT_MAX_RETAINED_ARTIFACTS;
let maxRetainedArtifactBytes = DEFAULT_MAX_RETAINED_ARTIFACT_BYTES;
let artifactCounter = 0;
let artifactAccessOrder = 0;

function nextArtifactId(): string {
  artifactCounter += 1;
  return `artifact_${Date.now().toString(36)}_${artifactCounter.toString(36)}`;
}

function touchArtifact(stored: StoredArtifact): void {
  artifactAccessOrder += 1;
  stored.lastAccessOrder = artifactAccessOrder;
}

function pruneArtifactRegistry(): void {
  let bytes = [...registry.values()].reduce((total, artifact) => total + artifact.blob.size, 0);
  while (
    registry.size > 1
    && (registry.size > maxRetainedArtifacts || bytes > maxRetainedArtifactBytes)
  ) {
    const oldest = [...registry.values()]
      .sort((a, b) => a.lastAccessOrder - b.lastAccessOrder || a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    registry.delete(oldest.id);
    bytes -= oldest.blob.size;
  }
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
    createdAt: Date.now(),
    lastAccessOrder: 0,
  };
  touchArtifact(stored);
  registry.set(id, stored);
  pruneArtifactRegistry();
  return {
    artifactId: id,
    mimeType: params.mimeType,
    fileName: params.fileName,
    byteLength: params.blob.size,
    revisionId: params.revisionId,
  };
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
  return {
    artifactId: stored.id,
    mimeType: stored.mimeType,
    fileName: stored.fileName,
    byteLength: stored.blob.size,
    revisionId: stored.revisionId,
  };
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
  const dataUrl = await blobToDataUrl(stored.blob);
  return {
    ok: true,
    status: 'completed',
    artifact: {
      artifactId: stored.id,
      mimeType: stored.mimeType,
      fileName: stored.fileName,
      byteLength: stored.blob.size,
      revisionId: stored.revisionId,
    },
    dataUrl,
    diagnostics: [],
  };
}

export function resetAgentArtifactRegistryForTests(): void {
  registry.clear();
  artifactCounter = 0;
  artifactAccessOrder = 0;
  maxRetainedArtifacts = DEFAULT_MAX_RETAINED_ARTIFACTS;
  maxRetainedArtifactBytes = DEFAULT_MAX_RETAINED_ARTIFACT_BYTES;
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
}> {
  return [...registry.values()].map((stored) => ({
    artifactId: stored.id,
    lastAccessOrder: stored.lastAccessOrder,
    byteLength: stored.blob.size,
  }));
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
    .map((stored) => ({
      artifactId: stored.id,
      mimeType: stored.mimeType,
      fileName: stored.fileName,
      byteLength: stored.blob.size,
      revisionId: stored.revisionId,
      createdAt: stored.createdAt,
      persisted: stored.persisted,
    }));
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
      artifact: {
        artifactId: stored.id,
        mimeType: stored.mimeType,
        fileName: stored.fileName,
        byteLength: stored.blob.size,
        revisionId: stored.revisionId,
      },
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

  return { ok: registry.delete(artifactId) };
}

export function getAgentArtifactStatus(artifactId: string): import('./protocol').AgentArtifactStatusResult {
  const stored = registry.get(artifactId);
  if (!stored) {
    return { ok: false, diagnostics: [{ code: 'artifact_not_found', message: `No artifact with id "${artifactId}".`, severity: 'error' }] };
  }
  touchArtifact(stored);
  return {
    ok: true,
    artifact: {
      artifactId: stored.id,
      mimeType: stored.mimeType,
      fileName: stored.fileName,
      byteLength: stored.blob.size,
      revisionId: stored.revisionId,
    },
    persisted: stored.persisted,
    diagnostics: [],
  };
}
