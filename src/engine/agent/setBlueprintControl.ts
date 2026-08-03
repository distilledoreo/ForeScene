/**
 * Agent API SetBlueprint validation and application.
 */

import { compileSetBlueprint } from '../setBlueprintCompiler';
import { parseSetBlueprint } from '../setBlueprintValidation';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectStore } from '../../state/useProjectStore';
import { useAppModeStore } from '../../state/useAppModeStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { agentError, writeAccessRequiredDiagnostic } from './diagnostics';
import type { AgentProjectPackageOpenResult, AgentSetBlueprintApplyInput } from './protocol';
import { markAgentProjectSource } from './projectImportControl';
import { deriveOperationOk, deriveOperationStatus } from './renderResult';

export function validateAgentSetBlueprint(input: { blueprint: unknown }) {
  try {
    const parsed = parseSetBlueprint(input.blueprint);
    if (parsed.errors.length > 0 || !parsed.blueprint) {
      return {
        ok: false,
        diagnostics: parsed.errors.map((item) => agentError(item.code, item.message)),
      };
    }
    const compiled = compileSetBlueprint(parsed.blueprint);
    return {
      ok: true,
      objectCount: compiled.project.scene.objects.length,
      diagnostics: compiled.warnings.map((warning) => agentError(warning.code, warning.message)),
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [agentError('blueprint_invalid', error instanceof Error ? error.message : 'SetBlueprint validation failed.')],
    };
  }
}

export async function applyAgentSetBlueprint(
  input: AgentSetBlueprintApplyInput,
): Promise<AgentProjectPackageOpenResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [writeAccessRequiredDiagnostic('applySetBlueprint')],
    };
  }

  const validated = validateAgentSetBlueprint({ blueprint: input.blueprint });
  if (!validated.ok) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: validated.diagnostics,
    };
  }

  const parsed = parseSetBlueprint(input.blueprint);
  if (!parsed.blueprint) {
    return { ok: false, status: 'failed', diagnostics: validated.diagnostics };
  }

  const compiled = compileSetBlueprint(parsed.blueprint);
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    };
  }

  if (input.preserveCurrentAsRecovery) {
    await runDestructive('Before applying SetBlueprint', async () => undefined);
  }

  const verified = await runDestructive(`Applied SetBlueprint: ${compiled.project.name}`, () => {
    useProjectStore.getState().setProject(compiled.project);
    useAppModeStore.getState().setAppMode('studio');
  });

  markAgentProjectSource('blueprint', compiled.project.name);
  const status = deriveOperationStatus({ hasArtifact: false, diagnostics: validated.diagnostics, allowNoArtifact: true });
  return {
    ok: deriveOperationOk(status),
    status,
    projectId: compiled.project.id,
    revisionId: verified?.revision.id,
    projectName: compiled.project.name,
    persistenceConfirmed: Boolean(verified),
    diagnostics: validated.diagnostics,
  };
}

export async function patchAgentProjectSettings(
  patch: import('./protocol').AgentProjectSettingsPatch,
): Promise<{ ok: boolean; revisionId?: string; diagnostics: import('./diagnostics').AgentDiagnostic[] }> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return { ok: false, diagnostics: [writeAccessRequiredDiagnostic('patchProjectSettings')] };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')] };
  }

  const verified = await runDestructive('Patch project settings', () => {
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        settings: {
          ...state.project.settings,
          ...patch,
        },
      },
    }));
  });

  return { ok: true, revisionId: verified?.revision.id, diagnostics: [] };
}
