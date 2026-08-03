/**
 * Agent API project package open, validate, and clone operations.
 */

import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useAppModeStore } from '../../state/useAppModeStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { getCanonicalPano } from '../../domain/selectors';
import { listMissingProjectAssets } from '../projectAssetRecovery';
import {
  readProjectFileWithWarnings,
  validateProjectPackage as validateProjectPackageBlob,
  validateProjectFile,
} from '../projectIO';
import { loadProjectRevision } from '../projectSafety';
import { awaitAgentNotBusy } from './busy';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  writeAccessRequiredDiagnostic,
} from './diagnostics';
import type {
  AgentCloneProjectRevisionInput,
  AgentCloneProjectRevisionResult,
  AgentLoadedProjectSource,
  AgentMissingAssetSummary,
  AgentProjectPackageOpenInput,
  AgentProjectPackageOpenResult,
  AgentProjectPackageValidateResult,
  AgentProjectPackageSource,
} from './protocol';
import { deriveOperationOk, deriveOperationStatus } from './renderResult';

let loadedProjectSource: AgentLoadedProjectSource = {
  projectId: '',
  source: 'unknown',
  loadedAt: new Date().toISOString(),
};

export function getAgentLoadedProjectSource(): AgentLoadedProjectSource {
  const project = useProjectStore.getState().project;
  const revisionId = useProjectSafetyStore.getState().activeRevisionId;
  return {
    ...loadedProjectSource,
    projectId: project.id,
    revisionId,
  };
}

function setLoadedProjectSource(source: AgentProjectPackageSource, sourceLabel?: string) {
  loadedProjectSource = {
    projectId: useProjectStore.getState().project.id,
    revisionId: useProjectSafetyStore.getState().activeRevisionId,
    source,
    sourceLabel,
    loadedAt: new Date().toISOString(),
  };
}

function missingAssetSummaries(project: ReturnType<typeof useProjectStore.getState>['project']): AgentMissingAssetSummary[] {
  return listMissingProjectAssets(project).map((asset) => ({
    assetId: asset.id,
    name: asset.name,
    originalFileName: asset.originalFileName,
    status: asset.resolutionStatus as AgentMissingAssetSummary['status'],
    instanceObjectIds: [],
    affectedShotIds: [],
  }));
}

async function commitImportedProject(
  importedProject: ReturnType<typeof useProjectStore.getState>['project'],
  reason: string,
  preserveCurrentAsRecovery: boolean,
): Promise<{ revisionId?: string; persistenceConfirmed: boolean }> {
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  const flushProject = useProjectSafetyStore.getState().flushProject;
  if (!runDestructive) {
    throw new Error('Project persistence is not ready.');
  }

  if (preserveCurrentAsRecovery) {
    await runDestructive('Before opening another project', async () => {
      // Snapshot only — mutation is the subsequent import commit.
    });
  }

  await runDestructive(reason, async () => {
    useProjectStore.getState().setProject(importedProject);
    useAppModeStore.getState().setAppMode('studio');
  });

  const verified = flushProject ? await flushProject(`Verified save after ${reason}`) : undefined;
  return {
    revisionId: verified?.revision.id,
    persistenceConfirmed: Boolean(verified),
  };
}

export async function openAgentProjectPackage(
  input: AgentProjectPackageOpenInput,
): Promise<AgentProjectPackageOpenResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic('openProjectPackage')],
    };
  }

  const busy = await awaitAgentNotBusy();
  if (busy) {
    return { ok: false, status: 'busy', diagnostics: busy };
  }

  try {
    const opened = await readProjectFileWithWarnings(input.file);
    const importedProject = opened.project;
    const { revisionId, persistenceConfirmed } = await commitImportedProject(
      importedProject,
      `Imported project: ${importedProject.name}`,
      input.preserveCurrentAsRecovery ?? true,
    );
    setLoadedProjectSource('import', input.file.name);

    const canonical = getCanonicalPano(importedProject);
    const status = deriveOperationStatus({ hasArtifact: false, diagnostics: [], allowNoArtifact: true });
    return {
      ok: deriveOperationOk(status),
      status,
      projectId: importedProject.id,
      revisionId,
      projectName: importedProject.name,
      missingAssetCount: listMissingProjectAssets(importedProject).length,
      missingAssets: missingAssetSummaries(importedProject),
      panoCount: importedProject.panoRefs.length,
      canonicalPanoId: canonical?.id,
      persistenceConfirmed,
      diagnostics: opened.warnings.map((warning) => agentError('import_warning', warning.message)),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(
        'import_failed',
        error instanceof Error ? error.message : 'Project import failed.',
      )],
    };
  }
}

export async function validateAgentProjectPackage(
  input: { file: File },
): Promise<AgentProjectPackageValidateResult> {
  try {
    if (input.file.type === 'application/json' || input.file.name.endsWith('.json')) {
      const project = await validateProjectFile(input.file);
      return {
        ok: true,
        projectName: project.name,
        objectCount: project.scene.objects.length,
        shotCount: project.shots.length,
        panoCount: project.panoRefs.length,
        diagnostics: [],
      };
    }
    await validateProjectPackageBlob(input.file);
    const opened = await readProjectFileWithWarnings(input.file);
    const project = opened.project;
    return {
      ok: true,
      projectName: project.name,
      objectCount: project.scene.objects.length,
      shotCount: project.shots.length,
      panoCount: project.panoRefs.length,
      diagnostics: opened.warnings.map((warning) => agentError('import_warning', warning.message)),
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        error instanceof Error ? error.message : 'Project package validation failed.',
      )],
    };
  }
}

export async function cloneAgentProjectRevision(
  input: AgentCloneProjectRevisionInput,
): Promise<AgentCloneProjectRevisionResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic('cloneProjectRevision')],
    };
  }

  try {
    const loaded = await loadProjectRevision(input.revisionId);
    const cloned = structuredClone(loaded.project);
    if (!input.loadAsCurrent) {
      return {
        ok: true,
        status: 'completed',
        projectId: cloned.id,
        clonedFromRevisionId: input.revisionId,
        diagnostics: [],
      };
    }

    const { revisionId, persistenceConfirmed } = await commitImportedProject(
      cloned,
      `Cloned revision ${input.revisionId}`,
      true,
    );
    setLoadedProjectSource('clone', input.revisionId);

    return {
      ok: persistenceConfirmed,
      status: persistenceConfirmed ? 'completed' : 'failed',
      projectId: cloned.id,
      revisionId,
      clonedFromRevisionId: input.revisionId,
      diagnostics: persistenceConfirmed ? [] : [agentError('clone_persistence_failed', 'Cloned project could not be verified.')],
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError(
        'clone_failed',
        error instanceof Error ? error.message : 'Revision clone failed.',
      )],
    };
  }
}

export function markAgentProjectSource(source: AgentProjectPackageSource, sourceLabel?: string) {
  setLoadedProjectSource(source, sourceLabel);
}
