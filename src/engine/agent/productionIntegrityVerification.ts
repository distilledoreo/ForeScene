/**
 * Shared post-compile integrity verification for production runs.
 */

import type { LocationProject, Shot } from '../../domain/types';
import type { PrevisProductionManifestV1, PrevisShotDefinition } from '../previs/manifest';
import { validateProductionCapabilities } from '../previs/entityCapability';
import { validateShotFrame } from '../previs/frameValidation';
import { verifyShotCompositionConstraints, getShotCompositionContract } from '../previs/compositionConstraints';
import {
  evaluateProjectionHealth,
  inspectShotEnvironment,
  verifyShotPanorama,
} from '../previs/shotEnvironment';
import { getShotPresenceContract, verifyShotPresence } from '../previs/shotPresence';
import { requiresPresenceContract, type ProductionIntegrityMode } from '../previs/productionBindingMode';
import {
  verifyProductionMutationScope,
  type ProductionMutationExpectation,
} from '../previs/productionMutationScope';
import { renderShotProjectedFrameWithHealth } from '../renderers';
import type { ProductionGateDiagnostic } from '../previs/productionGates';

export interface CompiledShotVerificationInput {
  project: LocationProject;
  shot: Shot;
  definition: PrevisShotDefinition;
  manifest?: PrevisProductionManifestV1;
  integrityMode?: ProductionIntegrityMode;
  beforeProject?: LocationProject;
  mutationExpectation?: ProductionMutationExpectation;
  frameExists?: boolean;
  frameByteSize?: number;
  fromCanonicalRenderer?: boolean;
  /** When true, run projected coverage health even if the contract omits requireProjection. */
  forceProjectionHealth?: boolean;
}

export interface CompiledShotVerification {
  presence: { ok: boolean; diagnostics: ProductionGateDiagnostic[] };
  capabilities: { ok: boolean; diagnostics: ProductionGateDiagnostic[] };
  environment: { ok: boolean; diagnostics: ProductionGateDiagnostic[] };
  composition: { ok: boolean; diagnostics: ProductionGateDiagnostic[] };
  renderHealth: { ok: boolean; diagnostics: ProductionGateDiagnostic[] };
  mutationScope: { ok: boolean; diagnostics: ProductionGateDiagnostic[] };
  ok: boolean;
  diagnostics: ProductionGateDiagnostic[];
}

function toGateDiagnostics(
  items: Array<{ code: string; message: string; severity?: 'error' | 'warning' | 'info' }>,
  shotId?: string,
): ProductionGateDiagnostic[] {
  return items
    .filter((item) => item.severity !== 'warning' && item.severity !== 'info')
    .map((item) => ({
      code: item.code,
      message: item.message,
      shotId,
      severity: item.severity ?? 'error',
    }));
}

export async function verifyCompiledShotIntegrity(
  input: CompiledShotVerificationInput,
): Promise<CompiledShotVerification> {
  const {
    project,
    shot,
    definition,
    integrityMode = 'gated_production',
    beforeProject,
    mutationExpectation,
    frameExists = false,
    frameByteSize,
    fromCanonicalRenderer = false,
    forceProjectionHealth = false,
  } = input;
  const shotId = shot.productionShotId ?? definition.id;
  const presenceContract = getShotPresenceContract(project, shot);
  const presenceDiagnostics: ProductionGateDiagnostic[] = [];
  let presenceOk = true;
  if (!presenceContract && requiresPresenceContract(integrityMode)) {
    presenceOk = false;
    presenceDiagnostics.push({
      code: 'presence_contract_missing',
      message: `Shot "${shot.shotNumber}" requires a presence contract for production integrity runs.`,
      shotId,
      severity: 'error',
    });
  } else if (presenceContract) {
    const presence = verifyShotPresence(project, shot, presenceContract);
    presenceOk = presence.ok;
    presenceDiagnostics.push(...presence.diagnostics.map((item) => ({
      code: item.code,
      message: item.message,
      shotId,
      severity: 'error' as const,
    })));
  }

  const capabilityResult = validateProductionCapabilities(project, input.manifest);
  const capabilitiesOk = capabilityResult.ok;
  const capabilityDiagnostics = toGateDiagnostics(capabilityResult.diagnostics, shotId);

  const environmentInspection = inspectShotEnvironment(project, shot);
  const panorama = verifyShotPanorama(project, shot);
  const environmentDiagnostics = toGateDiagnostics([
    ...panorama.diagnostics,
    ...environmentInspection.diagnostics.filter((item) => item.code !== 'environment_contract_missing'),
  ], shotId);
  let environmentOk = environmentDiagnostics.length === 0;

  if (environmentInspection.requireProjection || forceProjectionHealth) {
    try {
      const rendered = await renderShotProjectedFrameWithHealth(project, shot);
      const projectionDiagnostics = evaluateProjectionHealth(rendered.projectionHealth, {
        shotId: shot.id,
        requireProjection: true,
        minimumProjectionCoverage: environmentInspection.minimumProjectionCoverage,
      });
      environmentDiagnostics.push(...toGateDiagnostics(projectionDiagnostics, shotId));
      environmentOk = environmentDiagnostics.length === 0;
    } catch (error) {
      environmentOk = false;
      environmentDiagnostics.push({
        code: 'projection_render_failed',
        message: error instanceof Error ? error.message : 'Projected health render failed.',
        shotId,
        severity: 'error',
      });
    }
  }

  const compositionContract = getShotCompositionContract(project, shot);
  let compositionOk = true;
  const compositionDiagnostics: ProductionGateDiagnostic[] = [];
  if (compositionContract) {
    const composition = verifyShotCompositionConstraints(project, shot, compositionContract);
    compositionOk = composition.ok;
    compositionDiagnostics.push(...composition.diagnostics.map((item) => ({
      code: item.code,
      message: item.message,
      shotId,
      severity: 'error' as const,
    })));
  }

  const shouldValidateFrame = frameExists || frameByteSize !== undefined;
  const frame = shouldValidateFrame
    ? validateShotFrame({
      project,
      shot,
      definition,
      frameExists,
      frameByteSize,
      fromCanonicalRenderer,
    })
    : { status: 'passed' as const, issues: [] };
  const renderHealthOk = frame.status !== 'failed';
  const renderHealthDiagnostics = frame.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    shotId,
    severity: 'error' as const,
  }));

  let mutationScopeOk = true;
  const mutationScopeDiagnostics: ProductionGateDiagnostic[] = [];
  if (beforeProject && mutationExpectation) {
    const scope = verifyProductionMutationScope(beforeProject, project, mutationExpectation);
    mutationScopeOk = scope.ok;
    mutationScopeDiagnostics.push(...scope.errors.map((message) => ({
      code: 'mutation_scope_violation',
      message,
      shotId,
      severity: 'error' as const,
    })));
  }

  const diagnostics = [
    ...presenceDiagnostics,
    ...capabilityDiagnostics,
    ...environmentDiagnostics,
    ...compositionDiagnostics,
    ...renderHealthDiagnostics,
    ...mutationScopeDiagnostics,
  ];
  const ok = presenceOk
    && capabilitiesOk
    && environmentOk
    && compositionOk
    && renderHealthOk
    && mutationScopeOk;

  return {
    presence: { ok: presenceOk, diagnostics: presenceDiagnostics },
    capabilities: { ok: capabilitiesOk, diagnostics: capabilityDiagnostics },
    environment: { ok: environmentOk, diagnostics: environmentDiagnostics },
    composition: { ok: compositionOk, diagnostics: compositionDiagnostics },
    renderHealth: { ok: renderHealthOk, diagnostics: renderHealthDiagnostics },
    mutationScope: { ok: mutationScopeOk, diagnostics: mutationScopeDiagnostics },
    ok,
    diagnostics,
  };
}
