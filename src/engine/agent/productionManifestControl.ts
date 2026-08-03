/**
 * Agent API production manifest compiler endpoints.
 */

import { parsePrevisProductionManifest } from '../previs/manifestValidation';
import { compileProduction, plansForSceneSetup } from '../previs/productionCompiler';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectStore } from '../../state/useProjectStore';
import { agentError } from './diagnostics';
import type {
  AgentProductionCompilePreviewResult,
  AgentProductionManifestValidateResult,
} from './protocol';
import { previewAgentPlan } from './planCompiler';
import { applyAgentPlan } from './transaction';

function mapPrevisDiagnostics(items: Array<{ code: string; message: string; severity: string }>) {
  return items.map((item) => agentError(item.code, item.message));
}

export function validateAgentProductionManifest(input: { manifest: unknown }): AgentProductionManifestValidateResult {
  const parsed = parsePrevisProductionManifest(input.manifest);
  if (parsed.errors.length > 0 || !parsed.manifest) {
    return {
      ok: false,
      diagnostics: mapPrevisDiagnostics(parsed.errors),
    };
  }
  return {
    ok: true,
    shotCount: parsed.manifest.shots.length,
    diagnostics: mapPrevisDiagnostics(parsed.warnings.filter((item) => item.severity === 'error')),
  };
}

export function bindAgentManifestAssets(input: {
  manifest: unknown;
  bindings: Record<string, string>;
}): AgentProductionManifestValidateResult {
  const parsed = parsePrevisProductionManifest(input.manifest);
  if (parsed.errors.length > 0 || !parsed.manifest) {
    return {
      ok: false,
      diagnostics: mapPrevisDiagnostics(parsed.errors),
    };
  }

  const manifestIds = new Set([
    ...parsed.manifest.cast.map((entry) => entry.id),
    ...(parsed.manifest.props ?? []).map((entry) => entry.id),
    ...parsed.manifest.locations.map((entry) => entry.id),
  ]);
  const missingBindings = Object.keys(input.bindings).filter((key) => !manifestIds.has(key));
  if (missingBindings.length > 0) {
    return {
      ok: false,
      diagnostics: [agentError('binding_not_found', 'Manifest entities not found: ' + missingBindings.join(', ') + '.')],
    };
  }

  return {
    ok: true,
    shotCount: parsed.manifest.shots.length,
    diagnostics: [],
  };
}

export function previewAgentProductionCompile(input: { manifest: unknown }): AgentProductionCompilePreviewResult {
  const parsed = parsePrevisProductionManifest(input.manifest);
  if (parsed.errors.length > 0 || !parsed.manifest) {
    return {
      ok: false,
      diagnostics: mapPrevisDiagnostics(parsed.errors),
    };
  }

  const result = compileProduction(parsed.manifest);
  const plans = plansForSceneSetup(result);
  const projectState = useProjectStore.getState();
  const source = {
    project: projectState.project,
    workspace: projectState.workspace,
    selectedObjectIds: projectState.selectedObjectIds,
    selectedShotId: projectState.selectedShotId,
    activePanoId: projectState.activePanoId,
    gridSnap: projectState.gridSnap,
  };
  let commandCount = 0;
  for (const plan of plans) {
    const preview = previewAgentPlan(plan, source);
    commandCount += preview.summary?.commandCount ?? 0;
  }

  return {
    ok: result.ok,
    planCount: plans.length,
    commandCount,
    diagnostics: mapPrevisDiagnostics(result.diagnostics.filter((item) => item.severity === 'error')),
  };
}

export async function applyAgentProductionCompile(input: {
  manifest: unknown;
  preserveCurrentAsRecovery?: boolean;
}) {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      diagnostics: [agentError('write_access_required', 'Write access is required for applyProductionCompile.')],
    };
  }

  const preview = previewAgentProductionCompile({ manifest: input.manifest });
  if (!preview.ok) {
    return { ok: false, diagnostics: preview.diagnostics };
  }

  const parsed = parsePrevisProductionManifest(input.manifest);
  if (!parsed.manifest) {
    return { ok: false, diagnostics: preview.diagnostics };
  }

  const result = compileProduction(parsed.manifest);
  const plans = plansForSceneSetup(result);
  for (const plan of plans) {
    const apply = await applyAgentPlan(plan);
    if (!apply.ok) return apply;
  }

  return {
    ok: true,
    diagnostics: mapPrevisDiagnostics(result.diagnostics.filter((item) => item.severity === 'warning')),
  };
}

export function inspectAgentProductionStatus() {
  const project = useProjectStore.getState().project;
  return {
    manifestBound: false,
    shotCount: project.shots.length,
    diagnostics: [],
  };
}
