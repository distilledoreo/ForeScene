/**
 * Agent-controlled verified project backup export.
 */

import { projectDownloadFileName } from '../../config/brand';
import {
  inspectProjectBackupBytes,
  persistAndVerifyProject,
  verifyBackupMatchesProject,
} from '../projectDurability';
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
import { reconcileAndVerifyRecoveryResources } from '../recoveryResources';
import { useProjectStore } from '../../state/useProjectStore';

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

  const recovery = await reconcileAndVerifyRecoveryResources(useProjectStore.getState().project);
  const recoveryDiagnostics = recovery.issues.map((issue) => (
    issue.currentProject
      ? agentError(issue.code, issue.message)
      : { code: issue.code, message: issue.message, severity: 'warning' as const }
  ));
  if (!recovery.ok) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: recoveryDiagnostics,
      recovery: {
        ok: false,
        rematerialized: recovery.rematerialized,
        prunedHistoricalResources: recovery.prunedHistoricalResources,
        issueCount: recovery.issues.length,
      },
    };
  }

  const flushProject = useProjectSafetyStore.getState().flushProject;
  if (!flushProject) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')],
    };
  }

  const liveProject = useProjectStore.getState().project;
  let verified;
  try {
    const persistResult = await persistAndVerifyProject({
      liveProject,
      persist: async () => {
        const flushed = await flushProject('Verified save before agent project backup export');
        if (!flushed) return undefined;
        return { project: flushed.project, revisionId: flushed.revision.id };
      },
    });
    if (!persistResult.ok || !persistResult.project) {
      return {
        ok: false,
        status: 'failed',
        diagnostics: [agentError(
          'application_defect',
          persistResult.mismatches.length > 0
            ? `Persist/rehydrate mismatch: ${persistResult.mismatches.join('; ')}`
            : 'No verified project revision is available after persist.',
        )],
      };
    }
    verified = {
      project: persistResult.project,
      revision: { id: persistResult.revisionId ?? '' },
    };
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

  try {
    const blob = await createProjectPackage(verified.project);
    await validateProjectPackage(blob);
    const inspected = await inspectProjectBackupBytes(await blob.arrayBuffer());
    const identity = verifyBackupMatchesProject(inspected, liveProject);
    if (!identity.ok) {
      return {
        ok: false,
        status: 'failed',
        diagnostics: [agentError(
          'application_defect',
          `Backup package identity mismatch vs live project: ${identity.mismatches.join('; ')}`,
        )],
      };
    }
    const fileName = projectDownloadFileName(verified.project.name);
    const artifact = registerAgentArtifact({
      blob,
      mimeType: 'application/zip',
      fileName,
      revisionId: verified.revision.id,
      authoritative: true,
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
      diagnostics: recoveryDiagnostics,
      recovery: {
        ok: recovery.ok,
        rematerialized: recovery.rematerialized,
        prunedHistoricalResources: recovery.prunedHistoricalResources,
        issueCount: recovery.issues.length,
      },
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
