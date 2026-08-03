/**
 * In-memory artifact registry for Agent API exports and renders.
 * Artifacts are stable handles agents can retrieve without browser download events.
 */

import { downloadBlob } from '../fileTransfers';
import type { AgentArtifactHandle, AgentArtifactDownloadResult } from './protocol';

interface StoredArtifact {
  id: string;
  blob: Blob;
  mimeType: string;
  fileName: string;
  revisionId?: string;
  createdAt: number;
}

const registry = new Map<string, StoredArtifact>();
let artifactCounter = 0;

function nextArtifactId(): string {
  artifactCounter += 1;
  return `artifact_${Date.now().toString(36)}_${artifactCounter.toString(36)}`;
}

export function registerAgentArtifact(params: {
  blob: Blob;
  mimeType: string;
  fileName: string;
  revisionId?: string;
}): AgentArtifactHandle {
  const id = nextArtifactId();
  registry.set(id, {
    id,
    blob: params.blob,
    mimeType: params.mimeType,
    fileName: params.fileName,
    revisionId: params.revisionId,
    createdAt: Date.now(),
  });
  return {
    artifactId: id,
    mimeType: params.mimeType,
    fileName: params.fileName,
    byteLength: params.blob.size,
    revisionId: params.revisionId,
  };
}

export function getAgentArtifactBlob(artifactId: string): Blob | undefined {
  return registry.get(artifactId)?.blob;
}

export function getAgentArtifactHandle(artifactId: string): AgentArtifactHandle | undefined {
  const stored = registry.get(artifactId);
  if (!stored) return undefined;
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
      diagnostics: [{
        code: 'artifact_not_found',
        message: `No artifact with id "${input.artifactId}".`,
        severity: 'error',
      }],
    };
  }

  const shouldDownload = input.download !== false;
  if (shouldDownload) {
    downloadBlob(stored.blob, stored.fileName);
  }

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

/** Test helper — clears the in-memory registry. */
export function resetAgentArtifactRegistryForTests(): void {
  registry.clear();
  artifactCounter = 0;
}
