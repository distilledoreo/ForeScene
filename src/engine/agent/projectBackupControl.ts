/**
 * Agent-controlled verified project backup export.
 */

import { projectDownloadFileName } from '../../config/brand';
import { createProjectPackage, validateProjectPackage } from '../projectIO';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { awaitAgentNotBusy } from './busy';
import { registerAgentArtifact } from './artifactRegistry';
import { downloadBlob } from '../fileTransfers';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
} from './diagnostics';
import type { AgentProjectBackupResult } from './protocol';
import { deriveOperationOk, deriveOperationStatus } from './renderResult';

export async function exportAgentProjectBackup(input: {
  download?: boolean;
} = {}): Promise<AgentProjectBackupResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic('exportProjectBackup')],
    };
  }

  const busy = await awaitAgentNotBusy();
  if (busy) {
    return { ok: false, status: 'busy', diagnostics: busy };
  }

  const flushProject = useProjectSafetyStore.getState().flushProject;
  if (!flushProject) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')],
    };
  }

  let verified;
  try {
    verified = await flushProject('Verified save before agent project backup export');
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(
        'backup_flush_failed',
        error instanceof Error ? error.message : 'Failed to flush project before backup export.',
      )],
    };
  }
  if (!verified) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('backup_no_revision', 'No verified project revision is available.')],
    };
  }

  try {
    const blob = await createProjectPackage(verified.project);
    await validateProjectPackage(blob);
    const fileName = projectDownloadFileName(verified.project.name);
    const artifact = registerAgentArtifact({
      blob,
      mimeType: 'application/zip',
      fileName,
      revisionId: verified.revision.id,
    });
    if (input.download !== false) {
      downloadBlob(blob, fileName);
    }
    const status = deriveOperationStatus({ hasArtifact: true, diagnostics: [] });
    return {
      ok: deriveOperationOk(status),
      status,
      artifact,
      fileName,
      revisionId: verified.revision.id,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(
        'backup_export_failed',
        error instanceof Error ? error.message : 'Project backup export failed.',
      )],
    };
  }
}
