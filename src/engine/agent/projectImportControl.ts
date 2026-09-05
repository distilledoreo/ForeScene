/**
 * Agent API project package open, validate, and clone operations.
 */

import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useAppModeStore } from '../../state/useAppModeStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { getCanonicalPano } from '../../domain/selectors';
import { listMissingProjectAssets, type ProjectOpenResult } from '../projectAssetRecovery';
import {
  readProjectFileWithWarnings,
  validateProjectPackage as validateProjectPackageBlob,
  validateProjectFile,
} from '../projectIO';
import { loadProjectRevision, saveProjectRevision } from '../projectSafety';
import { createId } from '../../utils/ids';
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
  loadImportedProject: () => Promise<ProjectOpenResult>,
  reason: string,
  preserveCurrentAsRecovery: boolean,
): Promise<ProjectOpenResult & { revisionId?: string; persistenceConfirmed: boolean }> {
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

  let opened: ProjectOpenResult | undefined;
  await runDestructive(reason, async () => {
    // Stage imported payloads only after the old project's recovery writes.
    // Their cleanup may otherwise delete a same-ID import namespace before
    // its assets become referenced by the newly committed live project.
    opened = await loadImportedProject();
    useProjectStore.getState().setProject(opened.project);
    useAppModeStore.getState().setAppMode('studio');
  });
  if (!opened) throw new Error('Project import was not applied.');

  const verified = flushProject ? await flushProject(`Verified save after ${reason}`) : undefined;
  return {
    ...opened,
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
    const { project: importedProject, warnings, revisionId, persistenceConfirmed } = await commitImportedProject(
      () => readProjectFileWithWarnings(input.file),
      `Imported project file: ${input.file.name}`,
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
      diagnostics: warnings.map((warning) => agentError('import_warning', warning.message)),
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
      cloned.id = createId('project');
      cloned.name = `${cloned.name} (clone)`;
      const saved = await saveProjectRevision(cloned, {
        kind: 'snapshot',
        reason: `Cloned from revision ${input.revisionId}`,
      });
      return {
        ok: true,
        status: 'completed',
        projectId: cloned.id,
        revisionId: saved.revision.id,
        clonedFromRevisionId: input.revisionId,
        diagnostics: [],
      };
    }

    const { revisionId, persistenceConfirmed } = await commitImportedProject(
      async () => ({ project: cloned, warnings: [] }),
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
