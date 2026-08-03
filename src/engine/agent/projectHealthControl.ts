/**
 * Agent API project health, recovery, and storage inspection.
 */

import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import {
  getPersistentProjectStorageStatus,
  getProjectStorageEstimate,
  listProjectRevisionSummaries,
  restoreProjectRevision,
  loadProjectRevision,
} from '../projectSafety';
import {
  runProjectHealthCheck,
  repairProjectHealth,
} from '../projectHealth';
import { pruneUnreferencedProjectAssets } from '../projectAssets';
import { agentError, writeAccessRequiredDiagnostic } from './diagnostics';

export async function listAgentProjectRevisions(): Promise<import('./protocol').AgentProjectRevisionSummary[]> {
  const projectId = useProjectStore.getState().project.id;
  const summaries = await listProjectRevisionSummaries(projectId);
  return summaries.map((summary) => ({
    id: summary.id,
    projectId: summary.projectId,
    kind: summary.kind,
    reason: summary.reason,
    createdAt: summary.createdAt,
    isActive: summary.isActive,
    isPreviousKnownGood: summary.isPreviousKnownGood,
  }));
}

export async function inspectAgentProjectHealth(): Promise<import('./protocol').AgentProjectHealthResult> {
  const project = useProjectStore.getState().project;
  const report = await runProjectHealthCheck(project);
  return {
    ok: report.issues.every((issue) => issue.severity !== 'danger'),
    projectId: report.projectId,
    checkedAt: report.checkedAt,
    issues: report.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      repairable: issue.repairable,
    })),
    storage: report.storage as unknown as Record<string, unknown>,
    diagnostics: report.issues
      .filter((issue) => issue.severity === 'danger')
      .map((issue) => agentError(issue.code, issue.message)),
  };
}

export async function inspectAgentBrowserStorage(): Promise<Record<string, unknown>> {
  const project = useProjectStore.getState().project;
  const [estimate, persistence] = await Promise.all([
    getProjectStorageEstimate(project),
    getPersistentProjectStorageStatus(),
  ]);
  return {
    supported: estimate.supported,
    estimatedWriteBytes: estimate.estimatedWriteBytes,
    usageBytes: estimate.usageBytes,
    quotaBytes: estimate.quotaBytes,
    availableBytes: estimate.availableBytes,
    persistentStorageSupported: persistence.supported,
    persistentStorageGranted: persistence.persistent,
  };
}

export async function restoreAgentProjectRevision(input: { revisionId: string }) {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      diagnostics: [writeAccessRequiredDiagnostic('restoreProjectRevision')],
    };
  }

  const projectId = useProjectStore.getState().project.id;
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    };
  }

  try {
    const restored = await restoreProjectRevision(projectId, input.revisionId);
    const verified = await runDestructive('Restore project revision', () => {
      if (useProjectStore.getState().project.id !== projectId) {
        throw new Error('The loaded project changed before revision restore could be committed.');
      }
      useProjectStore.setState((state) => ({
        project: structuredClone(restored.project),
        buildHistoryPast: [],
        buildHistoryFuture: [],
        buildHistoryBatchDepth: 0,
        buildHistoryBatchCaptured: false,
        buildHistoryCoalesceActive: false,
        shotCameraFlying: state.workspace === 'shots',
      }));
    });
    return {
      ok: true,
      revisionId: verified?.revision.id ?? restored.revision.id,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [agentError('restore_failed', error instanceof Error ? error.message : 'Revision restore failed.')],
    };
  }
}

export async function compareAgentProjectRevisions(input: {
  revisionIdA: string;
  revisionIdB: string;
}) {
  try {
    const [a, b] = await Promise.all([
      loadProjectRevision(input.revisionIdA),
      loadProjectRevision(input.revisionIdB),
    ]);
    const changedFields: string[] = [];
    if (a.project.name !== b.project.name) changedFields.push('name');
    if (a.project.shots.length !== b.project.shots.length) changedFields.push('shots');
    if (a.project.scene.objects.length !== b.project.scene.objects.length) changedFields.push('objects');
    if (a.project.panoRefs.length !== b.project.panoRefs.length) changedFields.push('panoRefs');
    if (a.project.updatedAt !== b.project.updatedAt) changedFields.push('updatedAt');
    return { ok: true, changedFields, diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [agentError('compare_failed', error instanceof Error ? error.message : 'Revision compare failed.')],
    };
  }
}

export async function cleanupAgentUnreferencedAssets() {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return { ok: false, diagnostics: [writeAccessRequiredDiagnostic('cleanupUnreferencedAssets')] };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')] };
  }

  let removedCount = 0;
  const verified = await runDestructive('Cleanup unreferenced assets', () => {
    useProjectStore.setState((state) => {
      const before = Object.keys(state.project.assets.assets).length;
      const nextProject = pruneUnreferencedProjectAssets(state.project);
      removedCount = before - Object.keys(nextProject.assets.assets).length;
      return { project: nextProject };
    });
  });

  return {
    ok: true,
    removedCount,
    revisionId: verified?.revision.id,
    diagnostics: [],
  };
}

export async function repairAgentProjectIntegrity() {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return { ok: false, diagnostics: [writeAccessRequiredDiagnostic('repairProjectIntegrity')] };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')] };
  }

  let repairedCount = 0;
  const verified = await runDestructive('Repair project integrity', () => {
    useProjectStore.setState((state) => {
      const repair = repairProjectHealth(state.project);
      repairedCount = repair.repairedIssueCodes.length;
      return { project: repair.project };
    });
  });

  return {
    ok: true,
    repairedCount,
    revisionId: verified?.revision.id,
    diagnostics: [],
  };
}
