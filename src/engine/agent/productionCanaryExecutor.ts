/**
 * Browser-owned canary executor — compiles, verifies, and renders canary shots.
 */

import type { LocationProject } from '../../domain/types';
import type { PrevisProductionManifestV1 } from '../previs/manifest';
import { useProjectStore } from '../../state/useProjectStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { applyAgentProductionCompile } from './productionManifestControl';
import { getAgentRenderShotFrameImpl } from './renderCallbackRegistry';
import { registerAgentArtifact } from './artifactRegistry';
import { projectFingerprint } from './planDiff';
import { verifyCompiledShotIntegrity } from './productionIntegrityVerification';
import {
  CANARY_OUTPUTS,
  runProductionCanary,
  type CanaryOutput,
  type ProductionCanaryPlan,
  type ProductionCanaryResult,
  type ProductionCanaryShotResult,
  type ProductionGateDiagnostic,
} from '../previs/productionGates';
import { RAPID_REVIEW_PROFILE } from '../previs/renderProfiles';
import type { AgentRenderShotFrameResult } from './protocol';

function canaryOutputRenderParams(output: CanaryOutput): {
  appearance: 'clay' | 'projected';
  peopleVariant: 'with_people' | 'clean_plate';
  content: 'full_scene' | 'characters_only';
} {
  switch (output) {
    case 'characters_only':
      return { appearance: 'clay', peopleVariant: 'with_people', content: 'characters_only' };
    case 'clay_clean_plate':
      return { appearance: 'clay', peopleVariant: 'clean_plate', content: 'full_scene' };
    case 'projected_dynamic_subjects':
      return { appearance: 'projected', peopleVariant: 'with_people', content: 'full_scene' };
    default:
      return { appearance: 'clay', peopleVariant: 'with_people', content: 'full_scene' };
  }
}

function findCompiledShot(
  project: LocationProject,
  definition: { id: string; shotNumber: string },
) {
  return project.shots.find((shot) => shot.productionShotId === definition.id)
    ?? project.shots.find((shot) => shot.shotNumber === definition.shotNumber);
}

async function persistInlineArtifact(
  result: AgentRenderShotFrameResult,
  runId: string,
  shotId: string,
): Promise<string | undefined> {
  if (!result.artifact || result.artifact.kind !== 'inline' || !result.artifact.dataUrl) return undefined;
  const blob = await fetch(result.artifact.dataUrl).then((response) => response.blob());
  const handle = registerAgentArtifact({
    blob,
    mimeType: result.artifact.mimeType,
    fileName: `canary-${runId}-${shotId}.png`,
    revisionId: result.revisionId,
    shotId,
  });
  return handle.artifactId;
}

export interface ExecuteProductionCanaryInput {
  runId: string;
  plan: ProductionCanaryPlan;
  manifest: PrevisProductionManifestV1;
  assertActive?: () => void;
}

export interface ExecuteProductionCanaryResult {
  ok: boolean;
  result: ProductionCanaryResult;
  authorDiagnostics: ProductionGateDiagnostic[];
  verifyDiagnostics: ProductionGateDiagnostic[];
  renderDiagnostics: ProductionGateDiagnostic[];
  recoveryRevisionId?: string;
}

export async function executeProductionCanary(
  input: ExecuteProductionCanaryInput,
): Promise<ExecuteProductionCanaryResult> {
  const beforeProject = structuredClone(useProjectStore.getState().project);
  const beforeFingerprint = projectFingerprint(beforeProject);
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  let recoveryRevisionId: string | undefined;
  if (runDestructive) {
    const recovery = await runDestructive('Recovery snapshot before canary authoring', async () => {
      // Snapshot only.
    });
    recoveryRevisionId = recovery?.revision.id;
  }
  input.assertActive?.();

  const compiled = await applyAgentProductionCompile({
    manifest: input.manifest,
    preserveCurrentAsRecovery: false,
    onlyShotIds: input.plan.shotIds,
  });
  if (!compiled.ok) {
    const diagnostics = compiled.diagnostics.map((item) => ({
      code: item.code,
      message: item.message,
      severity: 'error' as const,
    }));
    const result = runProductionCanary(input.plan, []);
    return {
      ok: false,
      result: { ...result, ok: false, diagnostics: [...result.diagnostics, ...diagnostics] },
      authorDiagnostics: diagnostics,
      verifyDiagnostics: diagnostics,
      renderDiagnostics: diagnostics,
      recoveryRevisionId,
    };
  }
  input.assertActive?.();

  const afterProject = useProjectStore.getState().project;
  const render = getAgentRenderShotFrameImpl();
  const shotResults: ProductionCanaryShotResult[] = [];
  const authorDiagnostics: ProductionGateDiagnostic[] = [];
  const verifyDiagnostics: ProductionGateDiagnostic[] = [];
  const renderDiagnostics: ProductionGateDiagnostic[] = [];

  for (const shotId of input.plan.shotIds) {
    input.assertActive?.();
    const definition = input.manifest.shots.find((shot) => shot.id === shotId);
    if (!definition) {
      const diagnostic = { code: 'canary_shot_missing', message: `Canary shot "${shotId}" is missing from the manifest.`, shotId };
      verifyDiagnostics.push(diagnostic);
      continue;
    }
    const shot = findCompiledShot(afterProject, definition);
    if (!shot) {
      const diagnostic = { code: 'compiled_shot_missing', message: `Compiled shot "${definition.shotNumber}" is missing.`, shotId };
      authorDiagnostics.push(diagnostic);
      continue;
    }

    const verification = verifyCompiledShotIntegrity({
      project: afterProject,
      shot,
      definition,
      manifest: input.manifest,
      integrityMode: 'gated_production',
      beforeProject,
      allowedShotIds: afterProject.shots.map((item) => item.id),
      allowStructuralChanges: true,
    });
    verifyDiagnostics.push(...verification.diagnostics);

    const outputs = [];
    for (const output of input.plan.outputs.filter((item) => (
      item !== 'projected_dynamic_subjects' || verification.environment.ok
    ))) {
      input.assertActive?.();
      const params = canaryOutputRenderParams(output);
      let outputOk = false;
      let artifactId: string | undefined;
      const outputDiagnostics: ProductionGateDiagnostic[] = [];
      try {
        const rendered = await render({
          shotId: shot.id,
          appearance: params.appearance,
          peopleVariant: params.peopleVariant,
          content: params.content,
          timeSeconds: 0,
          width: RAPID_REVIEW_PROFILE.width,
          height: RAPID_REVIEW_PROFILE.height,
        });
        if (!rendered.ok) {
          outputDiagnostics.push(...rendered.diagnostics.map((item) => ({
            code: item.code,
            message: item.message,
            shotId,
            severity: 'error' as const,
          })));
        } else {
          artifactId = await persistInlineArtifact(rendered, input.runId, shot.id);
          const frameBytes = rendered.artifact?.kind === 'inline' && rendered.artifact.dataUrl
            ? (await fetch(rendered.artifact.dataUrl).then((response) => response.blob())).size
            : undefined;
          const frameVerification = verifyCompiledShotIntegrity({
            project: afterProject,
            shot,
            definition,
            manifest: input.manifest,
            integrityMode: 'gated_production',
            beforeProject,
            allowedShotIds: afterProject.shots.map((item) => item.id),
            allowStructuralChanges: true,
            frameExists: Boolean(artifactId || rendered.artifact),
            frameByteSize: frameBytes,
            fromCanonicalRenderer: true,
          });
          outputOk = frameVerification.renderHealth.ok && rendered.ok;
          if (!outputOk) {
            outputDiagnostics.push(...frameVerification.renderHealth.diagnostics);
          }
        }
      } catch (error) {
        outputDiagnostics.push({
          code: 'canary_render_failed',
          message: error instanceof Error ? error.message : 'Canary render failed.',
          shotId,
          severity: 'error',
        });
      }
      renderDiagnostics.push(...outputDiagnostics);
      outputs.push({ output, ok: outputOk, artifactId, diagnostics: outputDiagnostics });
    }

    shotResults.push({
      shotId,
      presenceOk: verification.presence.ok,
      capabilitiesOk: verification.capabilities.ok,
      panoramaOk: verification.environment.ok,
      compositionOk: verification.composition.ok,
      unrelatedStateChanged: !verification.mutationScope.ok,
      outputs,
      diagnostics: verification.diagnostics,
    });
  }

  const result = runProductionCanary(input.plan, shotResults);
  return {
    ok: result.ok,
    result,
    authorDiagnostics,
    verifyDiagnostics,
    renderDiagnostics,
    recoveryRevisionId,
  };
}

export { CANARY_OUTPUTS, canaryOutputRenderParams };
