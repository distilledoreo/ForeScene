/**
 * Normalize Agent render / export results with consistent status semantics.
 * Separates artifact production from quality diagnostics so `ok` has one meaning.
 */

import { dataUrlToBlob } from '../fileTransfers';
import { registerAgentArtifact } from './artifactRegistry';
import type { AgentDiagnostic } from './diagnostics';
import type {
  AgentArtifactHandle,
  AgentArtifactInline,
  AgentOperationStatus,
} from './protocol';

export function deriveOperationOk(status: AgentOperationStatus): boolean {
  return status === 'completed' || status === 'completed_with_warnings';
}

export function deriveOperationStatus(params: {
  hasArtifact: boolean;
  diagnostics: AgentDiagnostic[];
  stale?: boolean;
  cancelled?: boolean;
  busy?: boolean;
  /** Mutation-style operations that succeed without producing an artifact. */
  allowNoArtifact?: boolean;
}): AgentOperationStatus {
  if (params.busy) return 'busy';
  if (params.cancelled) return 'cancelled';
  if (params.stale) return 'stale_revision';
  if (!params.hasArtifact && !params.allowNoArtifact) return 'failed';
  const hasErrors = params.diagnostics.some((item) => item.severity === 'error');
  if (hasErrors) return params.hasArtifact ? 'completed_with_warnings' : 'failed';
  const hasWarnings = params.diagnostics.some((item) => item.severity === 'warning');
  if (hasWarnings) return 'completed_with_warnings';
  return 'completed';
}

export function buildInlineArtifact(params: {
  mimeType: string;
  dataUrl: string;
}): AgentArtifactInline {
  const base64 = params.dataUrl.includes(',')
    ? params.dataUrl.slice(params.dataUrl.indexOf(',') + 1)
    : params.dataUrl;
  const byteLength = Math.floor((base64.length * 3) / 4);
  return {
    kind: 'inline',
    mimeType: params.mimeType,
    dataUrl: params.dataUrl,
    byteLength,
  };
}

export function buildHandleArtifact(handle: AgentArtifactHandle): AgentArtifactHandle {
  return handle;
}

/** Register a still/storyboard PNG as a pinned download handle plus the inline payload. */
export function registerRenderedFrameArtifact(params: {
  dataUrl: string;
  fileName: string;
  revisionId?: string;
  shotId?: string;
  jobId?: string;
}): { inline: AgentArtifactInline; handle: AgentArtifactHandle } {
  const inline = buildInlineArtifact({ mimeType: 'image/png', dataUrl: params.dataUrl });
  const handle = registerAgentArtifact({
    blob: dataUrlToBlob(params.dataUrl),
    mimeType: 'image/png',
    fileName: params.fileName,
    revisionId: params.revisionId,
    shotId: params.shotId,
    jobId: params.jobId,
    authoritative: true,
  });
  return { inline, handle };
}
