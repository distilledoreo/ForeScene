/**
 * Agent API production manifest compiler endpoints.
 */

import type { Workspace } from '../../domain/types';
import { parsePrevisProductionManifest } from '../previs/manifestValidation';
import { compileProduction, plansForProductionCompile } from '../previs/productionCompiler';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { touchProject } from '../../state/slices/touchProject';
import { agentError, agentWarning, writeAccessRequiredDiagnostic } from './diagnostics';
import type {
  AgentProductionCompilePreviewResult,
  AgentProductionManifestValidateResult,
} from './protocol';
import { prepareAgentPlan, type PreparedAgentPlan } from './planCompiler';
import { projectFingerprint } from './planDiff';
import { commitPreparedPlanToStore } from './transaction';

function readLiveSource() {
  const projectState = useProjectStore.getState();
  return {
    project: projectState.project,
    workspace: projectState.workspace as Workspace,
    selectedObjectIds: projectState.selectedObjectIds,
    selectedShotId: projectState.selectedShotId,
    activePanoId: projectState.activePanoId,
    gridSnap: projectState.gridSnap,
  };
}

function readPersistedManifestBindings(): Record<string, string> {
  const project = useProjectStore.getState().project;
  return { ...(project.workflow.productionManifestAssetBindings ?? {}) };
}

function mapPrevisDiagnostics(items: Array<{ code: string; message: string; severity: string }>) {
  return items.map((item) => (
    item.severity === 'warning' || item.severity === 'info'
      ? agentWarning(item.code, item.message)
      : agentError(item.code, item.message)
  ));
}

function mergeAgentPlans(plans: import('./protocol').ForeSceneAgentPlan[]): import('./protocol').ForeSceneAgentPlan {
  if (plans.length === 0) {
    return {
      version: 1,
      planId: 'production-compile-empty',
      description: 'Production compile (no commands)',
      commands: [],
    };
  }
  return {
    version: 1,
    planId: `production-compile-${plans[0]!.planId}`.slice(0, 80),
    description: plans.map((plan) => plan.description).filter(Boolean).join(' · '),
    commands: plans.flatMap((plan) => plan.commands),
  };
}

function chainPreparePlans(
  plans: unknown[],
  source: ReturnType<typeof readLiveSource>,
): { ok: true; lastPrepared: PreparedAgentPlan; commandCount: number } | { ok: false; diagnostics: import('./diagnostics').AgentDiagnostic[] } {
  let chainSource = source;
  let lastPrepared: PreparedAgentPlan | undefined;
  let commandCount = 0;

  for (const plan of plans) {
    const prepared = prepareAgentPlan(plan, chainSource);
    if (!prepared.ok) {
      return { ok: false, diagnostics: prepared.diagnostics };
    }
    lastPrepared = prepared.prepared;
    commandCount += prepared.prepared.summary.commandCount;
    chainSource = {
      ...chainSource,
      project: prepared.prepared.nextProject,
      workspace: prepared.prepared.nextSelection.workspace,
      selectedObjectIds: prepared.prepared.nextSelection.selectedObjectIds,
      selectedShotId: prepared.prepared.nextSelection.selectedShotId,
      activePanoId: prepared.prepared.nextActivePanoId ?? chainSource.activePanoId,
    };
  }

  if (!lastPrepared) {
    return { ok: false, diagnostics: [agentError('compile_empty', 'Production compile produced no plans.')] };
  }

  return { ok: true, lastPrepared, commandCount };
}

export function resetAgentProductionManifestBindingsForTests(): void {
  useProjectStore.setState((state) => ({
    project: touchProject({
      ...state.project,
      workflow: {
        ...state.project.workflow,
        productionManifestAssetBindings: undefined,
      },
    }),
  }));
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

export async function bindAgentManifestAssets(input: {
  manifest: unknown;
  bindings: Record<string, string>;
}): Promise<AgentProductionManifestValidateResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return {
      ok: false,
      diagnostics: [writeAccessRequiredDiagnostic('bindManifestAssets')],
    };
  }

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

  const project = useProjectStore.getState().project;
  const missingObjects = Object.values(input.bindings).filter((objectId) => (
    !project.scene.objects.some((object) => object.id === objectId)
  ));
  if (missingObjects.length > 0) {
    return {
      ok: false,
      diagnostics: [agentError('object_not_found', 'Bound scene objects not found: ' + missingObjects.join(', ') + '.')],
    };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return {
      ok: false,
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    };
  }

  await runDestructive('Bind manifest assets', () => {
    useProjectStore.setState((state) => ({
      project: touchProject({
        ...state.project,
        workflow: {
          ...state.project.workflow,
          productionManifestAssetBindings: { ...input.bindings },
        },
      }),
    }));
  });

  const locationBindingIds = Object.keys(input.bindings).filter((id) => (
    parsed.manifest!.locations.some((location) => location.id === id)
  ));
  const bindingWarnings = locationBindingIds.length > 0
    ? [agentWarning(
      'location_binding_limited',
      'Simple locationId→objectId binding records only the object reference and zone origin. '
        + 'Anchors, blocker geometry, and template geography are not populated — shots may lack '
        + 'location-specific solver context until rich location bindings are supported.',
    )]
    : [];

  return {
    ok: true,
    shotCount: parsed.manifest.shots.length,
    diagnostics: [
      ...bindingWarnings,
      ...mapPrevisDiagnostics(parsed.warnings.filter((item) => item.severity === 'warning')),
    ],
  };
}

export function getAgentManifestBindings(): Record<string, string> {
  return readPersistedManifestBindings();
}

export function previewAgentProductionCompile(input: { manifest: unknown }): AgentProductionCompilePreviewResult {
  const parsed = parsePrevisProductionManifest(input.manifest);
  if (parsed.errors.length > 0 || !parsed.manifest) {
    return {
      ok: false,
      diagnostics: mapPrevisDiagnostics(parsed.errors),
    };
  }

  const assetBindings = readPersistedManifestBindings();
  const result = compileProduction(parsed.manifest, {
    assetBindings,
    presenceProject: useProjectStore.getState().project,
  });
  const setupPlans = plansForProductionCompile(result);
  const mergedPlan = mergeAgentPlans(setupPlans);
  const chained = chainPreparePlans([mergedPlan], readLiveSource());
  if (!chained.ok) {
    return { ok: false, diagnostics: chained.diagnostics };
  }

  return {
    ok: result.ok,
    planCount: setupPlans.length,
    commandCount: chained.commandCount,
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
      diagnostics: [writeAccessRequiredDiagnostic('applyProductionCompile')],
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

  const assetBindings = readPersistedManifestBindings();
  const result = compileProduction(parsed.manifest, {
    assetBindings,
    presenceProject: useProjectStore.getState().project,
  });
  const setupPlans = plansForProductionCompile(result);
  const mergedPlan = mergeAgentPlans(setupPlans);
  const chained = chainPreparePlans([mergedPlan], readLiveSource());
  if (!chained.ok) {
    return { ok: false, diagnostics: chained.diagnostics };
  }

  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return { ok: false, diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')] };
  }

  const baseFingerprint = projectFingerprint(readLiveSource().project);

  try {
    if (input.preserveCurrentAsRecovery) {
      await runDestructive('Recovery snapshot before production compile', async () => {
        // Snapshot only — compile commit follows.
      });
    }

    const verified = await runDestructive('Apply production compile', () => {
      const live = useProjectStore.getState().project;
      if (projectFingerprint(live) !== baseFingerprint) {
        throw new Error('Project changed before production compile could be committed.');
      }
      commitPreparedPlanToStore(chained.lastPrepared);
    });

    return {
      ok: true,
      revisionId: verified?.revision.id,
      diagnostics: mapPrevisDiagnostics(result.diagnostics.filter((item) => item.severity === 'warning')),
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [agentError(
        'compile_apply_failed',
        error instanceof Error ? error.message : 'Production compile apply failed.',
      )],
    };
  }
}

export function inspectAgentProductionStatus() {
  const project = useProjectStore.getState().project;
  const bindings = readPersistedManifestBindings();
  return {
    manifestBound: Object.keys(bindings).length > 0,
    shotCount: project.shots.length,
    bindingCount: Object.keys(bindings).length,
    diagnostics: [],
  };
}
