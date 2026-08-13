/**
 * Stable per-run provenance for Agent status, CLI, and benchmark reports.
 */

import { BRAND } from '../../config/brand';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import {
  FORESCENE_AGENT_API_VERSION,
  type AgentAssetPoseContract,
  type AgentProjectHealthResult,
  type AgentRunProvenance,
  type AgentRunValidationEvidence,
  type AgentValidationGateStatus,
  type AgentValidationRevisionBinding,
  type AgentVisualPreflightResult,
} from './protocol';
import { inspectAgentRenderCache } from './renderCacheControl';
import { getAgentPackageExportProgress } from './packageExportControl';
import { getAgentShotVideoRenderProgress, isAgentShotVideoRenderActive } from './videoRenderControl';
import { listAgentArtifacts } from './artifactRegistry';
import { emptyVisualSelectionDiagnostic } from './visualValidation';
import {
  getCacheOperations,
  getOperationTimings,
  getProvenanceCancelled,
  getProvenanceRetryCount,
  resetProvenanceSessionTelemetry,
} from './cacheTelemetry';

export const FORESCENE_PRODUCT_VERSION = '0.1.0';

export interface AgentRunProvenanceContext {
  command?: string;
  harness?: string;
  profile?: string;
  runId?: string;
  sourceCommit?: string;
  buildId?: string;
}

let provenanceContext: AgentRunProvenanceContext = {};
let validationEvidence: AgentRunValidationEvidence | undefined;

export function setAgentRunProvenanceContext(context: AgentRunProvenanceContext): void {
  provenanceContext = { ...provenanceContext, ...context };
}

/**
 * Start a provenance session for one CLI/API invocation.
 * Changing `runId` resets retry/cancel/validation so another invocation's
 * process-wide leftovers cannot leak into this run.
 */
export function beginAgentRunSession(context: AgentRunProvenanceContext = {}): AgentRunProvenanceContext {
  const nextRunId = context.runId?.trim() || undefined;
  if (nextRunId && nextRunId === provenanceContext.runId) {
    provenanceContext = { ...provenanceContext, ...context, runId: nextRunId };
    return { ...provenanceContext };
  }
  resetProvenanceSessionTelemetry(nextRunId);
  validationEvidence = undefined;
  provenanceContext = { ...context, ...(nextRunId ? { runId: nextRunId } : {}) };
  return { ...provenanceContext };
}

export function resetAgentRunProvenanceContextForTests(): void {
  provenanceContext = {};
  validationEvidence = undefined;
  resetProvenanceSessionTelemetry();
}

export function getAgentValidationEvidence(): AgentRunValidationEvidence | undefined {
  return validationEvidence ? { ...validationEvidence } : undefined;
}

export function recordAgentValidationEvidence(
  evidence: AgentRunValidationEvidence,
): AgentRunValidationEvidence {
  validationEvidence = { ...evidence };
  return { ...validationEvidence };
}

function gateStatus(ok: boolean | undefined, present: boolean): AgentValidationGateStatus {
  if (!present) return 'skipped';
  return ok ? 'passed' : 'failed';
}

function itemVisualGateStatus(
  item: AgentVisualPreflightResult,
): Exclude<AgentValidationGateStatus, 'skipped'> {
  if (item.gateStatus === 'passed' || item.gateStatus === 'warning' || item.gateStatus === 'failed') {
    return item.gateStatus;
  }
  if (item.checks.some((check) => check.status === 'failed') || (item.missingSubjectIds?.length ?? 0) > 0) {
    return 'failed';
  }
  if (
    !item.ok
    || item.checks.some((check) => check.status === 'warning')
    || (item.unresolvedVisibleObjectIds?.length ?? 0) > 0
  ) {
    return 'warning';
  }
  return item.ok ? 'passed' : 'failed';
}

function visualGateFromItems(items: AgentVisualPreflightResult[]): AgentValidationGateStatus {
  if (items.length === 0) return 'failed';
  const statuses = items.map(itemVisualGateStatus);
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'warning')) return 'warning';
  return 'passed';
}

function gateAllowsFullPass(status: AgentValidationGateStatus): boolean {
  return status === 'passed' || status === 'skipped';
}

export function resolveValidationRevisionBinding(input: {
  evidenceRevisionId?: string;
  activeRevisionId?: string;
}): {
  revisionBinding: AgentValidationRevisionBinding;
  revisionId?: string;
  activeRevisionId?: string;
  current: boolean;
  historical?: true;
  revisionBound: AgentValidationGateStatus;
} {
  const evidenceRevisionId = input.evidenceRevisionId?.trim() || undefined;
  const activeRevisionId = input.activeRevisionId?.trim() || undefined;
  if (evidenceRevisionId && activeRevisionId && evidenceRevisionId === activeRevisionId) {
    return {
      revisionBinding: 'current',
      revisionId: evidenceRevisionId,
      activeRevisionId,
      current: true,
      revisionBound: 'passed',
    };
  }
  if (evidenceRevisionId && activeRevisionId && evidenceRevisionId !== activeRevisionId) {
    return {
      revisionBinding: 'stale',
      revisionId: evidenceRevisionId,
      activeRevisionId,
      current: false,
      historical: true,
      revisionBound: 'failed',
    };
  }
  if (!evidenceRevisionId && activeRevisionId) {
    return {
      revisionBinding: 'current',
      revisionId: activeRevisionId,
      activeRevisionId,
      current: true,
      revisionBound: 'passed',
    };
  }
  if (evidenceRevisionId && !activeRevisionId) {
    return {
      revisionBinding: 'unbound',
      revisionId: evidenceRevisionId,
      current: false,
      revisionBound: 'skipped',
    };
  }
  return {
    revisionBinding: 'unbound',
    current: false,
    revisionBound: 'skipped',
  };
}

/**
 * Summarize already-computed verify outputs. Does not inspect the live
 * project, render frames, or re-run validators.
 *
 * A mismatched `revisionId` is preserved as historical/stale evidence and
 * cannot be reported as a valid current revision-bound summary.
 *
 * Visual-gate contract:
 * - `visualPreflight` omitted and no unmatched ids → gate skipped.
 * - `visualPreflight: []` or unmatched requested shot ids → requested-but-empty,
 *   `gates.visualPreflight: "failed"`. Never a vacuous pass.
 */
export function composeAgentValidationEvidence(input: {
  source?: AgentRunValidationEvidence['source'];
  revisionId?: string;
  capturedAt?: string;
  visualPreflight?: AgentVisualPreflightResult[];
  unmatchedVisualShotIds?: string[];
  assetPose?: AgentAssetPoseContract;
  projectHealth?: AgentProjectHealthResult;
}): AgentRunValidationEvidence {
  const unmatchedVisualShotIds = [...new Set(
    (input.unmatchedVisualShotIds ?? []).map((id) => id.trim()).filter(Boolean),
  )];
  const visualRequested = input.visualPreflight !== undefined || unmatchedVisualShotIds.length > 0;
  const preflight = visualRequested ? (input.visualPreflight ?? []) : undefined;
  const unresolvedVisibleObjectIds = preflight
    ? [...new Set(preflight.flatMap((item) => item.unresolvedVisibleObjectIds ?? []))]
    : [];
  const emptyVisualSelection = Boolean(preflight && (preflight.length === 0 || unmatchedVisualShotIds.length > 0));
  const emptyVisualDiagnostic = emptyVisualSelection
    ? emptyVisualSelectionDiagnostic(unmatchedVisualShotIds)
    : undefined;
  const visualSummary = preflight
    ? {
      shotCount: preflight.length,
      passedCount: preflight.filter((item) => itemVisualGateStatus(item) === 'passed').length,
      failedCount: preflight.filter((item) => itemVisualGateStatus(item) === 'failed').length,
      warningCount: preflight.reduce((count, item) => (
        count + item.checks.filter((check) => check.status === 'warning').length
      ), 0),
      failedShotIds: preflight.filter((item) => itemVisualGateStatus(item) === 'failed').map((item) => item.shotId),
      warningShotIds: preflight.filter((item) => itemVisualGateStatus(item) === 'warning').map((item) => item.shotId),
      unresolvedVisibleObjectIds: unresolvedVisibleObjectIds.slice(0, 128),
      unresolvedVisibleCount: unresolvedVisibleObjectIds.length,
      ...(emptyVisualSelection ? { emptySelection: true as const } : {}),
      ...(unmatchedVisualShotIds.length > 0 ? { unmatchedShotIds: unmatchedVisualShotIds } : {}),
      ...(emptyVisualDiagnostic ? { diagnostic: emptyVisualDiagnostic } : {}),
      scores: preflight.slice(0, 64).map((item) => ({
        shotId: item.shotId,
        score: item.score,
        ok: item.ok,
        gateStatus: itemVisualGateStatus(item),
        ...(item.environmentOnly ? { environmentOnly: true } : {}),
        ...(item.allowUnresolvedSetDressing ? { allowUnresolvedSetDressing: true } : {}),
        ...((item.unresolvedVisibleObjectIds?.length ?? 0) > 0
          ? { unresolvedVisibleObjectIds: item.unresolvedVisibleObjectIds }
          : {}),
      })),
    }
    : undefined;

  const assetPose = input.assetPose
    ? {
      objectCount: input.assetPose.objects.length,
      missingAssetCount: input.assetPose.objects.filter((object) => (
        object.assetStatus === 'missing' || object.assetStatus === 'corrupt'
      )).length,
      includedCount: input.assetPose.objects.filter((object) => object.includedInPackage === true).length,
      omittedCount: input.assetPose.objects.filter((object) => object.includedInPackage === false).length,
      unverifiedCount: input.assetPose.objects.filter((object) => object.includedInPackage === 'not_verified').length,
    }
    : undefined;

  const health = input.projectHealth
    ? {
      ok: input.projectHealth.ok,
      issueCount: input.projectHealth.issues.length,
      dangerCount: input.projectHealth.issues.filter((issue) => issue.severity === 'danger').length,
      codes: [...new Set(input.projectHealth.issues.slice(0, 32).map((issue) => issue.code))],
    }
    : undefined;

  const binding = resolveValidationRevisionBinding({
    evidenceRevisionId: input.revisionId ?? input.assetPose?.revisionId,
    activeRevisionId: useProjectSafetyStore.getState().activeRevisionId,
  });

  const gates = {
    visualPreflight: visualSummary
      ? (emptyVisualSelection ? 'failed' : visualGateFromItems(preflight ?? []))
      : 'skipped',
    assetPose: gateStatus(assetPose ? assetPose.missingAssetCount === 0 : undefined, Boolean(assetPose)),
    projectHealth: gateStatus(health?.ok, Boolean(health)),
    revisionBound: binding.revisionBound,
  };

  return {
    revisionId: binding.revisionId,
    ...(binding.activeRevisionId ? { activeRevisionId: binding.activeRevisionId } : {}),
    revisionBinding: binding.revisionBinding,
    current: binding.current,
    ...(binding.historical ? { historical: true as const } : {}),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    source: input.source ?? 'manual',
    ok: gateAllowsFullPass(gates.visualPreflight)
      && gateAllowsFullPass(gates.assetPose)
      && gateAllowsFullPass(gates.projectHealth)
      && gateAllowsFullPass(gates.revisionBound),
    gates,
    ...(visualSummary ? { visualPreflight: visualSummary } : {}),
    ...(assetPose ? { assetPose } : {}),
    ...(health ? { projectHealth: health } : {}),
  };
}

function readWindowCliIdentity(): AgentRunProvenanceContext {
  if (typeof window === 'undefined') return {};
  const value = (window as unknown as { __foreSceneCliIdentity?: AgentRunProvenanceContext }).__foreSceneCliIdentity;
  return value ?? {};
}

function readEnv(name: string): string | undefined {
  const meta = typeof import.meta !== 'undefined'
    ? (import.meta as { env?: Record<string, string | undefined> }).env
    : undefined;
  if (meta?.[name]) return meta[name];
  if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
  return undefined;
}

export function resolveBuildIdentity(): { sourceCommit?: string; buildId?: string } {
  const sourceCommit = provenanceContext.sourceCommit
    || readEnv('FORESCENE_SOURCE_COMMIT')
    || readEnv('VITE_GIT_COMMIT')
    || readEnv('GITHUB_SHA');
  const buildId = provenanceContext.buildId
    || readEnv('FORESCENE_BUILD_ID')
    || readEnv('VITE_BUILD_ID');
  return {
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(buildId ? { buildId } : {}),
  };
}

export function buildAgentRunProvenance(): AgentRunProvenance {
  const project = useProjectStore.getState().project;
  const safety = useProjectSafetyStore.getState();
  const cache = inspectAgentRenderCache({ projectId: project.id });
  const video = getAgentShotVideoRenderProgress();
  const pack = getAgentPackageExportProgress();
  const identity = resolveBuildIdentity();
  const windowCli = readWindowCliIdentity();
  const cli = {
    command: provenanceContext.command ?? windowCli.command,
    harness: provenanceContext.harness ?? windowCli.harness,
    profile: provenanceContext.profile ?? windowCli.profile,
    runId: provenanceContext.runId ?? windowCli.runId,
  };
  const artifacts = listAgentArtifacts().map((artifact) => ({
    artifactId: artifact.artifactId,
    fileName: artifact.fileName,
    byteLength: artifact.byteLength,
    revisionId: artifact.revisionId,
    hashStatus: artifact.hashStatus ?? 'unavailable',
    ...(artifact.hashStatus === 'computed' && artifact.sha256
      ? { sha256: artifact.sha256 }
      : {}),
  }));
  return {
    productName: BRAND.name,
    productVersion: FORESCENE_PRODUCT_VERSION,
    schemaVersion: project.schemaVersion,
    agentApiVersion: FORESCENE_AGENT_API_VERSION,
    projectId: project.id,
    revisionId: safety.activeRevisionId,
    projectUpdatedAt: project.updatedAt,
    ...identity,
    ...(cli.command || cli.harness || cli.profile || cli.runId
      ? {
        cli: {
          ...(cli.command ? { command: cli.command } : {}),
          harness: cli.harness ?? 'forescene-agent',
          ...(cli.profile ? { profile: cli.profile } : {}),
          ...(cli.runId ? { runId: cli.runId } : {}),
        },
      }
      : {}),
    timings: {
      provenanceBuiltAt: new Date().toISOString(),
      operations: getOperationTimings(),
    },
    retries: getProvenanceRetryCount(),
    cancelled: getProvenanceCancelled(),
    ...(validationEvidence ? { validation: { ...validationEvidence } } : {}),
    artifacts,
    cache: {
      renderEntries: cache.totalEntries,
      readyEntries: cache.readyEntries,
      invalidatedEntries: cache.invalidatedEntries,
      operations: getCacheOperations(),
    },
    jobs: {
      videoRenderActive: isAgentShotVideoRenderActive(),
      packageExportActive: useProjectStore.getState().isExportingPackage,
      videoPhase: video?.phase,
      packagePhase: pack?.phase,
      videoCompletedFrames: video?.completedFrames,
      videoTotalFrames: video?.totalFrames,
    },
  };
}
