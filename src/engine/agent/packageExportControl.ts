/**
 * Agent-controlled package export — same engine path as Export workspace.
 * Tracks progress / cancel for window.foreScene.exportPackage().
 */

import type { LocationProject, Shot } from '../../domain/types';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import {
  buildMultiShotPackage,
  downloadBlob,
  isPackageExportCancelled,
  type PackageExportProgress,
} from '../packageExport';
import {
  createExportPlan,
  formatPlanBlockingErrors,
  planHasBlockingErrors,
} from '../exportPlan';
import { awaitAgentNotBusy } from './busy';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
  type AgentDiagnostic,
} from './diagnostics';
import type {
  AgentPackageExportProgressSnapshot,
  AgentPackageExportRequest,
  AgentPackageExportResult,
} from './protocol';

let abortController: AbortController | null = null;
let latestProgress: AgentPackageExportProgressSnapshot | null = null;

export function getAgentPackageExportProgress(): AgentPackageExportProgressSnapshot | null {
  return latestProgress;
}

export function cancelAgentPackageExport(): AgentPackageExportResult {
  if (!abortController) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          'No package export is in progress.',
        ),
      ],
      progress: latestProgress ?? undefined,
    };
  }
  abortController.abort();
  latestProgress = {
    phase: 'cancelled',
    progress: latestProgress?.progress ?? 0,
    currentShot: latestProgress?.currentShot ?? 0,
    totalShots: latestProgress?.totalShots ?? 0,
    message: 'Export cancelled',
    indeterminate: false,
  };
  return {
    ok: true,
    diagnostics: [],
    progress: latestProgress,
  };
}

function requireWriteAccess(): AgentDiagnostic[] | null {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return [writeAccessRequiredDiagnostic('exportPackage')];
  }
  return null;
}

function resolveShots(
  project: LocationProject,
  shotIds: string[] | undefined,
): { shots: Shot[]; diagnostics: AgentDiagnostic[] } {
  const diagnostics: AgentDiagnostic[] = [];
  if (shotIds !== undefined) {
    if (shotIds.length === 0) {
      diagnostics.push(agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'An explicit shotIds selection cannot be empty.',
        { path: 'shotIds' },
      ));
      return { shots: [], diagnostics };
    }
    const seen = new Set<string>();
    const shots: Shot[] = [];
    for (const id of shotIds) {
      if (seen.has(id)) {
        diagnostics.push(agentError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          `Shot id "${id}" is listed more than once.`,
          { path: 'shotIds' },
        ));
        continue;
      }
      seen.add(id);
      const shot = project.shots.find((candidate) => candidate.id === id);
      if (!shot) {
        diagnostics.push(
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No shot with id "${id}".`,
            { path: 'shotIds' },
          ),
        );
        continue;
      }
      shots.push(shot);
    }
    return { shots, diagnostics };
  }
  return { shots: [...project.shots], diagnostics };
}

function toSnapshot(progress: PackageExportProgress): AgentPackageExportProgressSnapshot {
  return {
    phase: progress.phase,
    progress: progress.progress,
    currentShot: progress.currentShot,
    totalShots: progress.totalShots,
    shotId: progress.shotId,
    shotName: progress.shotName,
    message: progress.message,
    indeterminate: progress.indeterminate,
  };
}

/**
 * Flush → plan → package → optional download.
 * Mirrors ExportWorkspace.exportSelectedShots.
 */
export async function exportAgentPackage(
  input: AgentPackageExportRequest = {},
): Promise<AgentPackageExportResult> {
  const writeBlocked = requireWriteAccess();
  if (writeBlocked) return { ok: false, diagnostics: writeBlocked };

  if (abortController || useProjectStore.getState().isExportingPackage) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.busy,
          'Package export is already in progress.',
        ),
      ],
    };
  }

  const stillBusy = await awaitAgentNotBusy();
  if (stillBusy) return { ok: false, diagnostics: stillBusy };

  const flushProject = useProjectSafetyStore.getState().flushProject;
  if (!flushProject) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.busy,
          'Local project recovery is still starting. Wait before exporting a package.',
        ),
      ],
    };
  }

  let verified;
  try {
    verified = await flushProject('Verified save before agent package export');
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          'export_flush_failed',
          error instanceof Error ? error.message : 'Failed to flush project before export.',
        ),
      ],
    };
  }
  if (!verified) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          'export_no_revision',
          'No verified project revision is available for package export.',
        ),
      ],
    };
  }

  const exportProject = verified.project;
  const { shots, diagnostics } = resolveShots(exportProject, input.shotIds);
  if (diagnostics.some((item) => item.severity === 'error')) {
    return { ok: false, diagnostics };
  }
  if (shots.length === 0) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          'No shots available to package.',
          { path: 'shotIds' },
        ),
      ],
    };
  }

  const packageType = input.packageType
    ?? (shots.length === 1 ? 'current-shot' : 'selected-shots');
  const plan = createExportPlan(exportProject, shots, { packageType });
  if (planHasBlockingErrors(plan)) {
    return {
      ok: false,
      diagnostics: [
        agentError(
          'export_blocked',
          formatPlanBlockingErrors(plan) || 'Export blocked by preflight errors.',
        ),
      ],
    };
  }

  const shouldDownload = input.download !== false;
  const controller = new AbortController();
  abortController = controller;
  latestProgress = {
    phase: 'preparing',
    progress: 0,
    currentShot: 0,
    totalShots: shots.length,
    message: 'Preparing package…',
    indeterminate: true,
  };

  const store = useProjectStore.getState();
  store.setExportingPackage(true);

  try {
    const result = await buildMultiShotPackage(exportProject, shots, {
      signal: controller.signal,
      plan,
      onProgress: (progress) => {
        latestProgress = toSnapshot(progress);
      },
    });

    if (shouldDownload) {
      downloadBlob(result.blob, result.fileName);
      for (const shot of shots) {
        store.updateShot(shot.id, { status: 'exported' });
        store.markFinalPackageExported(shot.id);
      }
    }

    latestProgress = {
      phase: 'complete',
      progress: 1,
      currentShot: shots.length,
      totalShots: shots.length,
      message: shouldDownload ? 'Package downloaded' : 'Package built',
      indeterminate: false,
    };

    return {
      ok: true,
      fileName: result.fileName,
      manifestPaths: result.manifestPaths,
      shotIds: shots.map((shot) => shot.id),
      diagnostics: [],
      progress: latestProgress,
    };
  } catch (error) {
    if (isPackageExportCancelled(error) || controller.signal.aborted) {
      latestProgress = {
        phase: 'cancelled',
        progress: latestProgress?.progress ?? 0,
        currentShot: latestProgress?.currentShot ?? 0,
        totalShots: shots.length,
        message: 'Export cancelled',
        indeterminate: false,
      };
      return {
        ok: false,
        diagnostics: [
          agentError('export_cancelled', 'Package export was cancelled.'),
        ],
        progress: latestProgress,
        shotIds: shots.map((shot) => shot.id),
      };
    }
    const message = error instanceof Error ? error.message : 'Package export failed.';
    latestProgress = {
      phase: 'failed',
      progress: latestProgress?.progress ?? 0,
      currentShot: latestProgress?.currentShot ?? 0,
      totalShots: shots.length,
      message,
      indeterminate: false,
      error: message,
    };
    return {
      ok: false,
      diagnostics: [agentError('export_failed', message)],
      progress: latestProgress,
      shotIds: shots.map((shot) => shot.id),
    };
  } finally {
    abortController = null;
    useProjectStore.getState().setExportingPackage(false);
  }
}

/** Test helper. */
export function resetAgentPackageExportControl(): void {
  abortController?.abort();
  abortController = null;
  latestProgress = null;
}
