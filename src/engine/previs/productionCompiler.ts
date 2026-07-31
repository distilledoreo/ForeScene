/**
 * Top-level production compiler — orchestrates location/cast/prop/shot phases.
 */

import type { ForeSceneAgentPlan } from '../agent/protocol';
import type { PrevisProductionManifestV1 } from './manifest';
import type { PrevisDiagnostic } from './manifestDiagnostics';
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

export interface ProductionCompileResult {
  ok: boolean;
  context: CompiledProductionContext;
  locations: CompilePhaseResult;
  cast: CompilePhaseResult;
  props: CompilePhaseResult;
  shotBatches: CompiledShotBatch[];
  diagnostics: PrevisDiagnostic[];
}

export function compileProduction(
  manifest: PrevisProductionManifestV1,
  options: {
    existingContext?: CompiledProductionContext;
    skipShotNumbers?: Set<string>;
    existingShotIds?: Record<string, string>;
    batchSize?: number;
  } = {},
): ProductionCompileResult {
  const diagnostics: PrevisDiagnostic[] = [
    ...validateManifestShotNumbers(manifest),
  ];

  let context = options.existingContext ?? createEmptyCompiledContext();

  const locations = compileLocationsPhase(manifest, context);
  diagnostics.push(...locations.diagnostics);
  context = locations.context;

  const cast = compileCastPhase(manifest, context);
  diagnostics.push(...cast.diagnostics);
  context = cast.context;

  const props = compilePropsPhase(manifest, context);
  diagnostics.push(...props.diagnostics);
  context = props.context;

  const shotBatches = compileShotList(manifest, context, {
    skipShotNumbers: options.skipShotNumbers,
    existingShotIds: options.existingShotIds,
    batchSize: options.batchSize,
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
  };
}

export function plansForSceneSetup(result: ProductionCompileResult): ForeSceneAgentPlan[] {
  const plans: ForeSceneAgentPlan[] = [];
  if (result.locations.plan.commands.length > 0) plans.push(result.locations.plan);
  if (result.cast.plan.commands.length > 0) plans.push(result.cast.plan);
  if (result.props.plan.commands.length > 0) plans.push(result.props.plan);
  return plans;
}
