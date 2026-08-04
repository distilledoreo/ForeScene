/** Browser/Agent adapter for the verified proxy-replacement transaction. */

import { useProjectStore } from '../../state/useProjectStore';
import { agentError } from './diagnostics';
import {
  createProxyReplacementPlan,
  verifyProxyReplacement,
  type ProxyReplacementAffectedShot,
  type ProxyReplacementVerificationResult,
} from './proxyReplacement';
import {
  runVerifiedAgentMutation,
  type VerifiedMutationResult,
} from './verifiedMutation';
import type { AgentPlanApplyResult, ForeSceneAgentPlan } from './protocol';

export interface VerifiedProxyReplacementInput {
  proxyObjectId: string;
  replacementObjectId: string;
  requestedShotIds?: readonly string[];
  intendedShotIds?: readonly string[];
  initializeVisibility?: boolean;
  description?: string;
}

export type VerifiedProxyReplacementResult = VerifiedMutationResult<ProxyReplacementVerificationResult> & {
  plan?: ForeSceneAgentPlan;
  preparedShots?: ProxyReplacementAffectedShot[];
  affectedShots?: ProxyReplacementAffectedShot[];
};

/**
 * Build the replacement plan from the current project and run it through the
 * generic checkpoint/apply/postcondition/rollback transaction.
 */
export async function runVerifiedProxyReplacement(
  input: VerifiedProxyReplacementInput,
): Promise<VerifiedProxyReplacementResult> {
  const project = structuredClone(useProjectStore.getState().project);
  const planned = createProxyReplacementPlan({
    project,
    shotDocuments: project.shots,
    proxyObjectId: input.proxyObjectId,
    replacementObjectId: input.replacementObjectId,
    requestedShotIds: input.requestedShotIds,
    intendedShotIds: input.intendedShotIds,
    initializeVisibility: input.initializeVisibility,
  });
  if (!planned.ok) {
    const diagnostics = [agentError('verified_mutation_plan_failed', planned.errors.join(' '))];
    const apply: AgentPlanApplyResult = { ok: false, diagnostics };
    return { ok: false, status: 'failed', apply, diagnostics };
  }

  const result = await runVerifiedAgentMutation({
    description: input.description ?? `Replace proxy ${input.proxyObjectId} with ${input.replacementObjectId}`,
    plan: planned.plan,
    failurePolicy: 'rollback',
    verify: async ({ before, after }) => verifyProxyReplacement({
      beforeProject: before,
      afterProject: after,
      proxyObjectId: input.proxyObjectId,
      replacementObjectId: input.replacementObjectId,
      preparedShots: planned.preparedShots,
      affectedShots: planned.affectedShots,
    }),
    isVerificationSuccessful: (verification) => verification.ok,
  });
  return {
    ...result,
    plan: planned.plan,
    preparedShots: planned.preparedShots,
    affectedShots: planned.affectedShots,
  };
}
