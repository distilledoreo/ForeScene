/**
 * Verified agent mutations.
 *
 * Agent plans are atomic at the Zustand/persistence boundary, but an atomic
 * write can still produce the wrong semantic result. This module adds a
 * recovery checkpoint and a postcondition phase around an existing plan.
 */

import type { LocationProject, Shot, Workspace } from '../../domain/types';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { restoreAgentProjectRevision } from './projectHealthControl';
import { agentError, writeAccessRequiredDiagnostic, type AgentDiagnostic } from './diagnostics';
import { applyAgentPlan } from './transaction';
import { previewAgentPlan } from './planCompiler';
import { projectFingerprint } from './planDiff';
import type {
  AgentPlanApplyResult,
  AgentPlanPreviewResult,
  ForeSceneAgentPlan,
} from './protocol';

export type VerifiedMutationFailurePolicy = 'rollback' | 'pause' | 'keep_and_warn';

export interface VerifiedMutationRequest<TVerification> {
  description: string;
  plan: ForeSceneAgentPlan;
  verify: (input: {
    before: LocationProject;
    after: LocationProject;
    applied: AgentPlanApplyResult;
  }) => Promise<TVerification>;
  isVerificationSuccessful: (result: TVerification) => boolean;
  failurePolicy: VerifiedMutationFailurePolicy;
}

export interface VerifiedMutationRollbackResult {
  attempted: boolean;
  ok: boolean;
  checkpointRevisionId?: string;
  restoredFingerprint?: string;
  projectStateRestored: boolean;
  diagnostics: AgentDiagnostic[];
}

export interface VerifiedMutationResult<TVerification> {
  ok: boolean;
  status: 'completed' | 'rolled_back' | 'paused' | 'completed_with_warnings' | 'failed';
  checkpointRevisionId?: string;
  preview?: AgentPlanPreviewResult;
  apply: AgentPlanApplyResult;
  verification?: TVerification;
  rollback?: VerifiedMutationRollbackResult;
  diagnostics: AgentDiagnostic[];
}

export interface MutationScopeVerificationOptions {
  allowedShotIds?: readonly string[];
  allowedObjectIds?: readonly string[];
  requireCamerasUnchanged?: boolean;
  requireTimelinesUnchanged?: boolean;
}

export interface MutationScopeVerificationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Compare the project-wide invariants that a verified mutation must preserve.
 * Callers can add operation-specific checks (for example replacement staging)
 * through VerifiedMutationRequest.verify.
 */
export function verifyProjectMutationScope(
  before: LocationProject,
  after: LocationProject,
  options: MutationScopeVerificationOptions = {},
): MutationScopeVerificationResult {
  const errors: string[] = [];
  const allowedShots = new Set(options.allowedShotIds ?? []);
  const allowedObjects = new Set(options.allowedObjectIds ?? []);

  if (before.id !== after.id) errors.push('Project id changed during the verified mutation.');
  if (!sameIds(before.shots, after.shots)) errors.push('Shot ids changed during the verified mutation.');
  if (!sameIds(before.scene.objects, after.scene.objects)) errors.push('Scene object ids changed during the verified mutation.');
  if (!sameIds(before.panoRefs, after.panoRefs)) errors.push('Panorama ids changed during the verified mutation.');

  const beforeObjects = new Map(before.scene.objects.map((object) => [object.id, object]));
  for (const afterObject of after.scene.objects) {
    const beforeObject = beforeObjects.get(afterObject.id);
    if (!beforeObject || allowedObjects.has(afterObject.id)) continue;
    if (!sameJson(beforeObject, afterObject)) {
      errors.push(`Unrelated object ${afterObject.id} changed during the verified mutation.`);
    }
  }

  const beforeShots = new Map(before.shots.map((shot) => [shot.id, shot]));
  for (const afterShot of after.shots) {
    const beforeShot = beforeShots.get(afterShot.id);
    if (!beforeShot) continue;
    if (options.requireCamerasUnchanged !== false && !sameJson(beforeShot.camera, afterShot.camera)) {
      errors.push(`Camera changed for shot ${afterShot.shotNumber}.`);
    }
    if (options.requireTimelinesUnchanged !== false && !sameJson(
      timelineIdentity(beforeShot),
      timelineIdentity(afterShot),
    )) {
      errors.push(`Timeline changed for shot ${afterShot.shotNumber}.`);
    }
    if (allowedShots.has(afterShot.id)) continue;
    if (!sameJson(beforeShot, afterShot)) {
      errors.push(`Unrelated shot ${afterShot.shotNumber} changed during the verified mutation.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Capture a deterministic identity used to prove rollback restored shot state. */
export function projectStateFingerprint(project: LocationProject): string {
  return JSON.stringify(project);
}

function livePlanSource() {
  const state = useProjectStore.getState();
  return {
    project: state.project,
    workspace: state.workspace as Workspace,
    selectedObjectIds: state.selectedObjectIds,
    selectedShotId: state.selectedShotId,
    activePanoId: state.activePanoId,
    gridSnap: state.gridSnap,
  };
}

function failedApply(diagnostics: AgentDiagnostic[]): AgentPlanApplyResult {
  return { ok: false, diagnostics };
}

function checkpointFailure(description: string, diagnostics: AgentDiagnostic[]): VerifiedMutationResult<never> {
  return {
    ok: false,
    status: 'failed',
    apply: failedApply(diagnostics),
    diagnostics: [
      agentError('verified_checkpoint_failed', `Could not create a recovery checkpoint for ${description}.`),
      ...diagnostics,
    ],
  };
}

/**
 * Preview, apply, verify, and—when requested—restore a verified checkpoint.
 * The callback runs against cloned project documents and never receives a
 * mutable Zustand reference.
 */
export async function runVerifiedAgentMutation<TVerification>(
  request: VerifiedMutationRequest<TVerification>,
): Promise<VerifiedMutationResult<TVerification>> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    const diagnostics = [writeAccessRequiredDiagnostic(`verified mutation: ${request.description}`)];
    return { ok: false, status: 'failed', apply: failedApply(diagnostics), diagnostics };
  }

  const safety = useProjectSafetyStore.getState();
  if (!safety.flushProject) {
    return checkpointFailure(request.description, [
      agentError('persistence_not_ready', 'Project persistence is not ready for a verified mutation.'),
    ]);
  }

  const before = structuredClone(useProjectStore.getState().project);
  const beforeFingerprint = projectFingerprint(before);
  const beforeStateFingerprint = projectStateFingerprint(before);
  const checkpoint = await safety.flushProject(`Verified mutation checkpoint: ${request.description}`);
  if (!checkpoint) {
    return checkpointFailure(request.description, [
      agentError('persistence_not_ready', 'No verified recovery revision was created.'),
    ]);
  }

  if (projectFingerprint(useProjectStore.getState().project) !== beforeFingerprint) {
    return checkpointFailure(request.description, [
      agentError('stale_revision', 'The project changed while the verified checkpoint was being created; re-preview the mutation.'),
    ]);
  }

  const preview = previewAgentPlan(request.plan, livePlanSource());
  if (!preview.ok) {
    return {
      ok: false,
      status: 'failed',
      checkpointRevisionId: checkpoint.revision.id,
      preview,
      apply: failedApply(preview.diagnostics),
      diagnostics: preview.diagnostics,
    };
  }

  const applied = await applyAgentPlan(request.plan);
  if (!applied.ok) {
    const current = useProjectStore.getState().project;
    if (projectFingerprint(current) !== beforeFingerprint) {
      const rollback = await restoreCheckpoint(checkpoint.revision.id, beforeFingerprint, beforeStateFingerprint);
      return {
        ok: false,
        status: rollback.ok ? 'rolled_back' : 'failed',
        checkpointRevisionId: checkpoint.revision.id,
        preview,
        apply: applied,
        rollback,
        diagnostics: [...applied.diagnostics, ...rollback.diagnostics],
      };
    }
    return {
      ok: false,
      status: 'failed',
      checkpointRevisionId: checkpoint.revision.id,
      preview,
      apply: applied,
      diagnostics: applied.diagnostics,
    };
  }

  const after = structuredClone(useProjectStore.getState().project);
  let verification: TVerification | undefined;
  try {
    verification = await request.verify({ before: structuredClone(before), after, applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verified mutation postcondition threw an unknown error.';
    return handleVerificationFailure({
      request,
      before,
      after,
      beforeFingerprint,
      beforeStateFingerprint,
      checkpointRevisionId: checkpoint.revision.id,
      preview,
      applied,
      verification: undefined,
      diagnostics: [agentError('postcondition_failed', message)],
    });
  }

  if (request.isVerificationSuccessful(verification)) {
    return {
      ok: true,
      status: 'completed',
      checkpointRevisionId: checkpoint.revision.id,
      preview,
      apply: applied,
      verification,
      diagnostics: applied.diagnostics,
    };
  }

  return handleVerificationFailure({
    request,
    before,
    after,
    beforeFingerprint,
    beforeStateFingerprint,
    checkpointRevisionId: checkpoint.revision.id,
    preview,
    applied,
    verification,
    diagnostics: [agentError('postcondition_failed', `Verified mutation failed its postcondition: ${request.description}.`)],
  });
}

async function handleVerificationFailure<TVerification>(input: {
  request: VerifiedMutationRequest<TVerification>;
  before: LocationProject;
  after: LocationProject;
  beforeFingerprint: string;
  beforeStateFingerprint: string;
  checkpointRevisionId: string;
  preview: AgentPlanPreviewResult;
  applied: AgentPlanApplyResult;
  verification: TVerification | undefined;
  diagnostics: AgentDiagnostic[];
}): Promise<VerifiedMutationResult<TVerification>> {
  if (input.request.failurePolicy === 'keep_and_warn') {
    const diagnostics = input.diagnostics.map((diagnostic) => ({ ...diagnostic, severity: 'warning' as const }));
    return {
      ok: true,
      status: 'completed_with_warnings',
      checkpointRevisionId: input.checkpointRevisionId,
      preview: input.preview,
      apply: input.applied,
      verification: input.verification,
      diagnostics,
    };
  }
  if (input.request.failurePolicy === 'pause') {
    return {
      ok: false,
      status: 'paused',
      checkpointRevisionId: input.checkpointRevisionId,
      preview: input.preview,
      apply: input.applied,
      verification: input.verification,
      diagnostics: input.diagnostics,
    };
  }

  const rollback = await restoreCheckpoint(
    input.checkpointRevisionId,
    input.beforeFingerprint,
    input.beforeStateFingerprint,
  );
  return {
    ok: false,
    status: rollback.ok ? 'rolled_back' : 'failed',
    checkpointRevisionId: input.checkpointRevisionId,
    preview: input.preview,
    apply: input.applied,
    verification: input.verification,
    rollback,
    diagnostics: [...input.diagnostics, ...rollback.diagnostics],
  };
}

async function restoreCheckpoint(
  revisionId: string,
  expectedFingerprint: string,
  expectedStateFingerprint: string,
): Promise<VerifiedMutationRollbackResult> {
  const restored = await restoreAgentProjectRevision({ revisionId });
  if (!restored.ok) {
    return {
      attempted: true,
      ok: false,
      checkpointRevisionId: revisionId,
      projectStateRestored: false,
      diagnostics: [
        agentError('rollback_failed', 'Automatic rollback could not restore the verified checkpoint.'),
        ...restored.diagnostics,
      ],
    };
  }
  const current = useProjectStore.getState().project;
  const restoredFingerprint = projectFingerprint(current);
  const projectStateRestored = restoredFingerprint === expectedFingerprint
    && projectStateFingerprint(current) === expectedStateFingerprint;
  if (!projectStateRestored) {
    return {
      attempted: true,
      ok: false,
      checkpointRevisionId: revisionId,
      restoredFingerprint,
      projectStateRestored: false,
      diagnostics: [agentError('rollback_verification_failed', 'Automatic rollback completed, but the restored project does not match the verified starting state.')],
    };
  }
  return {
    attempted: true,
    ok: true,
    checkpointRevisionId: revisionId,
    restoredFingerprint,
    projectStateRestored: true,
    diagnostics: [],
  };
}

function sameIds<T extends { id: string }>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value.id === right[index]?.id);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function timelineIdentity(shot: Shot): unknown {
  return shot.cameraKeyframes.map((keyframe) => ({
    id: keyframe.id,
    label: keyframe.label,
    timeSeconds: keyframe.timeSeconds,
    easing: keyframe.easing,
    camera: keyframe.camera,
  }));
}
