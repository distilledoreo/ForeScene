/**
 * Top-level production compiler — orchestrates location/cast/prop/shot phases.
 */

import type { ForeSceneAgentPlan } from '../agent/protocol';
import type { LocationProject } from '../../domain/types';
import type { PrevisProductionManifestV1 } from './manifest';
import type { PrevisDiagnostic } from './manifestDiagnostics';
import { previsError, previsWarning } from './manifestDiagnostics';
import {
  compileCastPhase,
  compileLocationsPhase,
  compilePropsPhase,
  createEmptyCompiledContext,
  type CompiledProductionContext,
  type CompilePhaseResult,
} from './locationCompiler';
import { compileShotList, type CompiledShotBatch } from './shotCompiler';
import { validateManifestShotNumbers } from './shotValidator';
import {
  validateProductionCapabilities,
  type ProductionCapabilityValidationResult,
} from './entityCapability';

export interface ProductionCompileResult {
  ok: boolean;
  context: CompiledProductionContext;
  locations: CompilePhaseResult;
  cast: CompilePhaseResult;
  props: CompilePhaseResult;
  shotBatches: CompiledShotBatch[];
  diagnostics: PrevisDiagnostic[];
  capabilities?: ProductionCapabilityValidationResult;
}

export interface ProductionCompileOptions {
  existingContext?: CompiledProductionContext;
  skipShotNumbers?: Set<string>;
  existingShotIds?: Record<string, string>;
  batchSize?: number;
  /** Manifest entity id → existing scene object id — skips create commands for bound entities. */
  assetBindings?: Record<string, string>;
  /** Prepared project used to compile project-wide closed-world visibility. */
  presenceProject?: LocationProject;
}

export function compileProduction(
  manifest: PrevisProductionManifestV1,
  options: ProductionCompileOptions = {},
): ProductionCompileResult {
  const diagnostics: PrevisDiagnostic[] = [
    ...validateManifestShotNumbers(manifest),
  ];

  const capabilities = options.presenceProject?.workflow.production
    ? validateProductionCapabilities(options.presenceProject, manifest)
    : undefined;
  if (capabilities) {
    diagnostics.push(...capabilities.diagnostics.map((item) => {
      const extras = {
        ...(item.entityId ? { entityId: item.entityId } : {}),
        ...(item.shotId ? { path: `shots[id=${item.shotId}]` } : {}),
      };
      return item.severity === 'warning'
        ? previsWarning(item.code, item.message, extras)
        : previsError(item.code, item.message, extras);
    }));
  }

  let context = options.existingContext ?? createEmptyCompiledContext();
  const phaseOptions = { assetBindings: options.assetBindings };

  const locations = compileLocationsPhase(manifest, context, phaseOptions);
  diagnostics.push(...locations.diagnostics);
  context = locations.context;

  const cast = compileCastPhase(manifest, context, phaseOptions);
  diagnostics.push(...cast.diagnostics);
  context = cast.context;

  const props = compilePropsPhase(manifest, context, phaseOptions);
  diagnostics.push(...props.diagnostics);
  context = props.context;

  const shotBatches = compileShotList(manifest, context, {
    skipShotNumbers: options.skipShotNumbers,
    existingShotIds: options.existingShotIds,
    batchSize: options.batchSize,
    presenceProject: options.presenceProject,
  });
  for (const batch of shotBatches) {
    diagnostics.push(...batch.diagnostics);
  }

  const ok = diagnostics.every((item) => item.severity !== 'error');
  return {
    ok,
    context,
    locations,
    cast,
    props,
    shotBatches,
    diagnostics,
    ...(capabilities ? { capabilities } : {}),
  };
}

export function plansForSceneSetup(result: ProductionCompileResult): ForeSceneAgentPlan[] {
  const plans: ForeSceneAgentPlan[] = [];
  if (result.locations.plan.commands.length > 0) plans.push(result.locations.plan);
  if (result.cast.plan.commands.length > 0) plans.push(result.cast.plan);
  if (result.props.plan.commands.length > 0) plans.push(result.props.plan);
  return plans;
}

/** Scene setup plus every compiled shot batch — use for full manifest apply/preview. */
export function plansForProductionCompile(result: ProductionCompileResult): ForeSceneAgentPlan[] {
  return [
    ...plansForSceneSetup(result),
    ...result.shotBatches.map((batch) => batch.plan),
  ].filter((plan) => plan.commands.length > 0);
}
