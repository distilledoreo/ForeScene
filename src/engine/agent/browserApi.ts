/**
 * Browser-facing ForeScene Agent API (`window.foreScene`).
 * Read-only inspection in this milestone; mutations reject without write access.
 */

import type { LocationProject, Shot, Workspace } from '../../domain/types';
import { createExportPlan } from '../exportPlan';
import {
  renderShotCharacterFrame,
  renderShotDepthFrame,
  renderShotFrame as renderShotFrameEngine,
  renderShotProjectedFrame,
} from '../renderers';
import { sampleShotTimeline } from '../shotTimeline';
import { cancelShotStillPreparation as cancelShotStillPreparationAction } from '../shotStillActions';
import {
  computePixelStatsFromDataUrl,
  rejectRenderPixelStats,
  type RenderPixelStats,
} from '../previs/renderPixelStats';
import { buildContactSheetSpec } from '../previs/contactSheet';
import { ensureBackgroundVideoService, queueBackgroundVideosForShot } from '../backgroundVideoService';
import { renderWorkCoordinator } from '../renderWorkCoordinator';
import {
  clearPoseApplicationReports,
  ensurePoseableCharactersForProject,
  getPoseApplicationReports,
} from '../poseableCharacter';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useAppModeStore } from '../../state/useAppModeStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { buildAgentCapabilities } from './capabilities';
import { previewAgentPlan } from './planCompiler';
import { applyAgentPlan, undoLastAgentPlan } from './transaction';
import { runVerifiedProxyReplacement } from './verifiedProxyReplacement';
import { listAgentHistory } from './history';
import {
  cancelAgentPackageExport,
  exportAgentPackage,
  getAgentPackageExportProgress,
} from './packageExportControl';
import {
  cancelAgentShotVideoRender,
  getAgentShotVideoRenderProgress,
  isAgentShotVideoRenderActive,
  renderAgentShotVideo,
} from './videoRenderControl';
import { resetAgentProject } from './projectReset';
import { restoreProjectRevision } from '../projectSafety';
import { getAssetInstanceIds, getAssetShotIds, listMissingProjectAssets } from '../projectAssetRecovery';
import { relinkModelAssetIntoProject } from '../modelImportService';
import { touchProject } from '../../state/slices/touchProject';
import { collectAgentBusyDiagnostics } from './busy';
import { inspectShotVisualPreflight } from './visualPreflight';
import { collectVisualPreflightResults } from './visualValidation';
import { inspectAssetPoseContract } from './assetPoseContract';
import {
  beginShotRepairSession,
  commitBestShotRepairCandidate,
  evaluateShotRepairCandidate,
} from './repairCandidates';
import {
  beginAgentRunSession,
  buildAgentRunProvenance,
  composeAgentValidationEvidence,
  recordAgentValidationEvidence,
} from './runProvenance';
import { recordProvenanceCancellation, recordProvenanceRetry } from './cacheTelemetry';
import { coerceShotTarget } from './targetResolver';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
  agentWarning,
  notImplementedDiagnostic,
} from './diagnostics';
import {
  inspectObjectSnapshot,
  inspectProjectSnapshot,
  inspectShotSnapshot,
  inspectShotTimelineSnapshot,
  listLandmarksSnapshot,
  listObjectsSnapshot,
  listShotsSnapshot,
  resolveExistingObjectTarget,
  resolveExistingShotTarget,
  sampleShotAtTimeSnapshot,
  type AgentInspectionContext,
} from './inspection';
import {
  getViewportReadinessSnapshot,
  subscribeViewportReadiness,
} from './viewportReadiness';
import type {
  AgentEntityTarget,
  AgentExportPlanRequest,
  AgentExportPlanResult,
  AgentModelImportInput,
  AgentModelImportResult,
  AgentMissingAssetSummary,
  AgentObjectInspection,
  AgentObjectQuery,
  AgentPackageExportRequest,
  AgentPackageExportResult,
  AgentPlanApplyResult,
  AgentPlanHistoryEntry,
  AgentPlanPreviewResult,
  AgentProductionRunResult,
  AgentMotionWorkingRevisionResult,
  AgentRefinementCheckpointResult,
  AgentVerifiedProxyReplacementInput,
  AgentVerifiedProxyReplacementResult,
  AgentProjectInspection,
  AgentRenderShotFrameInput,
  AgentRenderShotFrameResult,
  AgentResetProjectRequest,
  AgentShotMaterializationResult,
  AgentShotInspection,
  AgentShotTimeSample,
  AgentShotTimelineInspection,
  AgentShotVideoRenderInput,
  AgentShotVideoRenderResult,
  AgentStillLayoutApprovalResult,
  AgentWaitForViewportReadyInput,
  AgentWaitForViewportReadyResult,
  ForeSceneAgentStatus,
  ForeSceneBrowserApi,
} from './protocol';
import { FORESCENE_AGENT_API_VERSION } from './protocol';
import { writeAccessRequiredDiagnostic } from './diagnostics';
import {
  analyzeCharacterImport,
  analyzeSavedRigCharacter,
  cancelCharacterImport,
  discardCharacterImportAnalysis,
  getCharacterImportProgress,
  importCharacter,
  importSavedRigCharacter,
  isCharacterImportActive,
} from './characterImport';
import {
  ModelImportConsentRequiredError,
  createModelImportPlan,
} from '../modelImport';
import { importModelIntoProject } from '../modelImportService';
import { downloadAgentArtifact } from './artifactRegistry';
import {
  describeAgentCapabilities,
  describeAgentOperation,
  getAgentSchema,
} from './discovery';
import { exportAgentProjectBackup } from './projectBackupControl';
import { buildInlineArtifact, deriveOperationOk, deriveOperationStatus, registerRenderedFrameArtifact } from './renderResult';
import { refreshAgentRevision } from './revisionSync';
import { setAgentShotPanorama } from './shotPanorama';
import {
  inspectAgentProjectionHealth,
  inspectAgentShotEnvironmentContract,
  verifyAgentShotPanorama,
} from './shotEnvironmentControl';
import {
  inspectAgentShotCompositionError,
  setAgentShotCompositionConstraints,
  solveAgentShotToCompositionConstraints,
  verifyAgentShotCompositionConstraints,
} from './compositionConstraintControl';
import {
  approveAgentProductionCanary,
  approveAgentStillLayout,
  createAgentMotionWorkingRevision,
  inspectAgentProductionGates,
  inspectAgentStillLayoutApproval,
  planAgentProductionCanary,
  runAgentProductionCanary,
} from './productionGateControl';
import {
  cancelAgentProductionRun,
  getAgentProductionRun,
  listAgentProductionRuns,
  pauseAgentProductionRun,
  resumeAgentProductionRun,
  runAgentProduction,
  subscribeAgentProductionRun,
} from './productionRunControl';
import { planReviewSamples as planReviewSamplesEngine } from '../previs/reviewSampling';
import { buildProductionReviewArtifacts } from '../previs/productionReviewArtifacts';
import {
  clearAgentRenderCache,
  explainAgentRenderCacheHit,
  explainAgentRenderCacheMiss,
  inspectAgentRenderCache,
  invalidateAgentRenderDependencies,
} from './renderCacheControl';
import { inspectAgentShotDiagnostics } from './shotDiagnostics';
import {
  frameAgentSubjects,
  orientAgentObjectToward,
  placeAgentObjectNearLandmark,
  snapAgentObjectToFloor,
  trackAgentSubjects,
} from './spatialPrimitives';
import {
  captureAgentShotStateAsKeyframe,
  sampleAgentShotState,
  upsertAgentObjectKeyframe,
} from './timelineHelpers';
import {
  openAgentProjectPackage,
  validateAgentProjectPackage,
  cloneAgentProjectRevision,
  getAgentLoadedProjectSource,
} from './projectImportControl';
import {
  importAgentPanoramaReference,
  updateAgentPanoramaReference,
  renderAgentGrayboxPanorama,
  approveAgentPanoramaReference,
  acceptAgentReferenceAlignment,
  removeAgentPanoramaReference,
  setAgentPanoramaCaptureOrigin,
  inspectAgentPanoramaProjection,
} from './panoramaReferenceControl';
import {
  createAgentObjectGroup,
  diagnoseAgentObjectGroup,
  inspectAgentObjectGroup,
  listAgentObjectGroups,
  stageAgentObjectGroup,
  inferImportAssemblyGroups,
} from './objectGroupControl';
import {
  cancelAgentJob,
  getAgentJob,
  resumeAgentJob,
  submitAgentJob,
  subscribeToAgentJobProgress,
  waitForAgentJob,
} from './jobQueue';
import { frameAgentSubjectsBatch, renderAgentShotBatch } from './batchControl';
import { setAgentRenderShotFrameImpl } from './renderCallbackRegistry';
import {
  compareAgentAdjacentShots,
  duplicateAgentShot,
  inspectAgentSequenceContinuity,
  listAgentShotMedia,
  reorderAgentShots,
} from './sequenceReviewControl';
import {
  applyAgentPosePreset,
  copyAgentPoseBetweenShots,
  exportAgentRigPackage,
  inspectAgentCharacterPose,
  mirrorAgentPose,
  resetAgentJointPose,
  setAgentJointRotation,
} from './poseControl';
import {
  cleanupAgentUnreferencedAssets,
  compareAgentProjectRevisions,
  inspectAgentBrowserStorage,
  inspectAgentProjectHealth,
  listAgentProjectRevisions,
  repairAgentProjectIntegrity,
  restoreAgentProjectRevision,
} from './projectHealthControl';
import {
  applyAgentProductionCompile,
  bindAgentManifestAssets,
  inspectAgentProductionStatus,
  previewAgentProductionCompile,
  validateAgentProductionManifest,
} from './productionManifestControl';
import {
  bindAgentProductionEntity,
  defineAgentProductionLocation,
  approveAgentPoseSubstitution,
  inspectAgentEntityCapability,
  inspectAgentProductionConfiguration,
  removeAgentProductionBinding,
  resolveAgentProductionPose,
  validateAgentProductionCapabilities,
  validateAgentProductionConfiguration,
} from './productionConfigurationControl';
import {
  inspectAgentShotPresence,
  repairAgentShotPresence,
  setAgentShotPresenceContract,
  verifyAgentShotPresence,
} from './shotPresenceControl';
import {
  applyAgentSetBlueprint,
  patchAgentProjectSettings,
  validateAgentSetBlueprint,
} from './setBlueprintControl';
import {
  deleteAgentArtifact,
  getAgentArtifactBlob,
  getAgentArtifactHandle,
  getAgentArtifactStatus,
  listAgentArtifacts,
  persistAgentArtifact,
} from './artifactRegistry';
import {
  previewAgentGenerativeWorldRequest,
  renderAgentGenerativeWorldDepthPrior,
  runAgentMockGenerativeWorldBackend,
} from './generativeWorldControl';

function readInspectionContext(): AgentInspectionContext {
  const projectState = useProjectStore.getState();
  const safety = useProjectSafetyStore.getState();
  return {
    project: projectState.project,
    workspace: projectState.workspace,
    selectedObjectIds: projectState.selectedObjectIds,
    selectedShotId: projectState.selectedShotId,
    revisionId: safety.activeRevisionId,
  };
}

/** A clean plate may legitimately be a nearly uniform wall or floor. */
function rejectFrameStats(stats: RenderPixelStats | undefined, allowFlatFrame: boolean) {
  const rejection = rejectRenderPixelStats(stats);
  return allowFlatFrame && rejection?.code === 'frame_zero_variance' ? null : rejection;
}

function isBusy(status: ForeSceneAgentStatus): boolean {
  return (
    status.busy.criticalWrite
    || status.busy.grayboxRender
    || status.busy.packageExport
    || status.busy.videoRender
    || status.busy.characterImport
  );
}

function resolveShotsForExport(
  project: LocationProject,
  shotIds: string[] | undefined,
): { shots: Shot[]; diagnostics: AgentExportPlanResult['diagnostics'] } {
  const diagnostics: AgentExportPlanResult['diagnostics'] = [];
  if (shotIds !== undefined) {
    if (shotIds.length === 0) {
      diagnostics.push(agentError(
        AGENT_DIAGNOSTIC_CODES.invalidArgument,
        'An explicit shotIds selection cannot be empty.',
        { path: 'shotIds' },
      ));
      return { shots: [], diagnostics };
    }
    const seen = new Set<string>();
    const shots: Shot[] = [];
    for (const id of shotIds) {
      if (seen.has(id)) {
        diagnostics.push(agentError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          `Shot id "${id}" is listed more than once.`,
          { path: 'shotIds' },
        ));
        continue;
      }
      seen.add(id);
      const shot = project.shots.find((candidate) => candidate.id === id);
      if (!shot) {
        diagnostics.push(
          agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `No shot with id "${id}".`,
            { path: 'shotIds' },
          ),
        );
        continue;
      }
      shots.push(shot);
    }
    return { shots, diagnostics };
  }
  // Match Export workspace default: plan every shot when no explicit ids are given.
  return { shots: [...project.shots], diagnostics };
}

function requireInspectionAccess(): AgentExportPlanResult['diagnostics'] | null {
  const mode = useAgentControlStore.getState().controlMode;
  if (mode === 'off') {
    return [
      agentError(
        AGENT_DIAGNOSTIC_CODES.agentControlOff,
        'Agent control is off. Set control mode to read-only or read-write.',
      ),
    ];
  }
  return null;
}

function refinementWriteDiagnostics(operation: string): AgentRefinementCheckpointResult['diagnostics'] | null {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return [writeAccessRequiredDiagnostic(operation)];
  }
  const busy = collectAgentBusyDiagnostics();
  return busy.length > 0 ? busy : null;
}

function preparedMediaDiagnostics(
  result: Pick<AgentShotMaterializationResult, 'status' | 'warnings'>,
) {
  if (result.warnings.length === 0) {
    return result.status === 'failed'
      ? [agentError(AGENT_DIAGNOSTIC_CODES.preparedMediaFailed, 'Prepared-media materialization failed.')]
      : [];
  }
  return result.warnings.map((message) => result.status === 'failed'
    ? agentError(AGENT_DIAGNOSTIC_CODES.preparedMediaFailed, message)
    : agentWarning(AGENT_DIAGNOSTIC_CODES.preparedMediaWarning, message));
}

export function getForeSceneAgentStatus(): ForeSceneAgentStatus {
  const projectState = useProjectStore.getState();
  const safety = useProjectSafetyStore.getState();
  const appMode = useAppModeStore.getState().appMode;
  const controlMode = useAgentControlStore.getState().controlMode;
  const project = projectState.project;
  const projectLoaded = Boolean(project?.id);

  return {
    ready: true,
    apiVersion: FORESCENE_AGENT_API_VERSION,
    controlMode,
    writeAccess: controlMode === 'read-write',
    projectLoaded,
    projectId: project?.id,
    projectName: project?.name,
    workspace: projectState.workspace as Workspace | undefined,
    revisionId: safety.activeRevisionId,
    projectUpdatedAt: project?.updatedAt,
    missingAssetCount: project ? listMissingProjectAssets(project).length : 0,
    appMode,
    busy: {
      criticalWrite: safety.criticalWrite,
      grayboxRender: projectState.isRenderingGraybox,
      packageExport: projectState.isExportingPackage,
      videoRender: isAgentShotVideoRenderActive(),
      characterImport: isCharacterImportActive(),
    },
    persistence: {
      ready: typeof safety.flushProject === 'function',
      status: safety.status,
      message: safety.message,
      lastSavedAt: safety.lastSavedAt,
      activeRevisionId: safety.activeRevisionId,
    },
    provenance: buildAgentRunProvenance(),
  };
}

export function createForeSceneBrowserApi(): ForeSceneBrowserApi {
  // Agent-only sessions do not mount the Shots workspace, so bind the same
  // background-preparation lifecycle that the UI capture controller uses.
  ensureBackgroundVideoService(() => useProjectStore.getState().project);
  const api: ForeSceneBrowserApi = {
    apiVersion: FORESCENE_AGENT_API_VERSION,

    getStatus() {
      return getForeSceneAgentStatus();
    },

    beginRunSession(input = {}) {
      beginAgentRunSession(input);
      return getForeSceneAgentStatus();
    },

    recordRunValidation(input) {
      const evidence = composeAgentValidationEvidence({
        source: input.source ?? 'manual',
        revisionId: input.revisionId ?? useProjectSafetyStore.getState().activeRevisionId,
        visualPreflight: input.visualPreflight,
        unmatchedVisualShotIds: input.unmatchedVisualShotIds,
        assetPose: input.assetPose,
        projectHealth: input.projectHealth,
      });
      return recordAgentValidationEvidence(evidence);
    },

    collectVisualPreflightValidation(input = {}) {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      return collectVisualPreflightResults({
        shots: listShotsSnapshot(project),
        requestedShotIds: input.shotIds,
        inspect: (shotId) => inspectShotVisualPreflight({ project, shotId }),
      });
    },

    getCapabilities() {
      return buildAgentCapabilities(useAgentControlStore.getState().controlMode);
    },

    describeCapabilities() {
      return describeAgentCapabilities(useAgentControlStore.getState().controlMode);
    },

    describeOperation(operation: string) {
      return describeAgentOperation(operation);
    },

    getAgentSchema() {
      return getAgentSchema();
    },

    inspectProject(): AgentProjectInspection {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      return inspectProjectSnapshot(readInspectionContext());
    },

    listMissingAssets(): AgentMissingAssetSummary[] {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      return listMissingProjectAssets(project).map((asset) => ({
        assetId: asset.id,
        name: asset.name,
        originalFileName: asset.originalFileName,
        status: asset.resolutionStatus as AgentMissingAssetSummary['status'],
        instanceObjectIds: getAssetInstanceIds(project, asset.id),
        affectedShotIds: getAssetShotIds(project, asset.id),
      }));
    },

    async relinkAsset(input) {
      if (useAgentControlStore.getState().controlMode !== 'read-write') {
        return { ok: false, diagnostics: [writeAccessRequiredDiagnostic('Relink asset')] };
      }
      try {
        const result = await relinkModelAssetIntoProject(input.file, input.assetId, { mode: input.mode });
        return { ok: true, assetId: result.assetId, diagnostics: [] };
      } catch (error) {
        return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, error instanceof Error ? error.message : 'Asset relink failed.')] };
      }
    },

    async removeMissingAsset(assetId) {
      if (useAgentControlStore.getState().controlMode !== 'read-write') {
        return { ok: false, diagnostics: [writeAccessRequiredDiagnostic('Remove missing asset')] };
      }
      const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
      try {
        if (!runDestructive) throw new Error('Project persistence is not ready.');
        await runDestructive('Remove missing asset', () => {
          useProjectStore.setState((state) => {
            const assets = { ...state.project.assets.assets };
            delete assets[assetId];
            return { project: touchProject({ ...state.project, assets: { assets }, scene: { ...state.project.scene, objects: state.project.scene.objects.filter((object) => object.modelAssetId !== assetId) } }) };
          });
        });
        return { ok: true, diagnostics: [] };
      } catch (error) {
        return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, error instanceof Error ? error.message : 'Asset removal failed.')] };
      }
    },

    getProjectDocument(): LocationProject {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      return structuredClone(readInspectionContext().project);
    },

    getShotDocument(target: AgentEntityTarget): Shot {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      const shot = project.shots.find((candidate) => candidate.id === resolved.id);
      if (!shot) throw new AgentApiError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${resolved.id}".`);
      return structuredClone(shot);
    },

    listObjects(query?: AgentObjectQuery) {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      return listObjectsSnapshot(readInspectionContext().project, query);
    },

    inspectObject(target: AgentEntityTarget): AgentObjectInspection {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      const project = readInspectionContext().project;
      const resolved = resolveExistingObjectTarget(project, target);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      const object = project.scene.objects.find((candidate) => candidate.id === resolved.id);
      if (!object) {
        throw new AgentApiError(
          AGENT_DIAGNOSTIC_CODES.targetNotFound,
          `No object with id "${resolved.id}".`,
        );
      }
      return inspectObjectSnapshot(object, project);
    },

    listShots() {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      return listShotsSnapshot(readInspectionContext().project);
    },

    inspectShot(target: AgentEntityTarget): AgentShotInspection {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      const project = readInspectionContext().project;
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      const shot = project.shots.find((candidate) => candidate.id === resolved.id);
      if (!shot) {
        throw new AgentApiError(
          AGENT_DIAGNOSTIC_CODES.targetNotFound,
          `No shot with id "${resolved.id}".`,
        );
      }
      return inspectShotSnapshot(shot);
    },

    async inspectShotPreparedMedia(target: AgentEntityTarget) {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      const project = readInspectionContext().project;
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      const shot = project.shots.find((candidate) => candidate.id === resolved.id);
      if (!shot) {
        throw new AgentApiError(
          AGENT_DIAGNOSTIC_CODES.targetNotFound,
          `No shot with id "${resolved.id}".`,
        );
      }
      const { inspectShotPreparedMedia: inspectPrepared } = await import('./inspection');
      return inspectPrepared(project, shot);
    },

    inspectShotTimeline(target: AgentEntityTarget): AgentShotTimelineInspection {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      const shot = project.shots.find((candidate) => candidate.id === resolved.id);
      if (!shot) throw new AgentApiError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${resolved.id}".`);
      return inspectShotTimelineSnapshot(project, shot);
    },

    sampleShotAtTime(input: {
      shot?: AgentEntityTarget;
      shotId?: string;
      shotNumber?: string;
      timeSeconds: number;
    }): AgentShotTimeSample {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      const target = coerceShotTarget(input);
      if (!target) {
        throw new AgentApiError(
          AGENT_DIAGNOSTIC_CODES.invalidArgument,
          'sampleShotAtTime requires shot, shotId, or shotNumber.',
        );
      }
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      return sampleShotAtTimeSnapshot(project, resolved.id, input.timeSeconds);
    },

    sampleShotState(input: { shotId: string; timeSeconds: number }): AgentShotTimeSample {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      return sampleAgentShotState(input);
    },

    inspectShotDiagnostics(input: {
      shotId?: string;
      shot?: AgentEntityTarget;
      timeSeconds?: number;
      subjectIds?: string[];
    }) {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      const target = coerceShotTarget(input);
      if (!target) {
        throw new AgentApiError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'inspectShotDiagnostics requires shotId or shot.');
      }
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      const shot = project.shots.find((candidate) => candidate.id === resolved.id);
      if (!shot) {
        throw new AgentApiError(
          AGENT_DIAGNOSTIC_CODES.targetNotFound,
          `No shot with id "${resolved.id}".`,
        );
      }
      const diagnostics = inspectAgentShotDiagnostics({
        project,
        shot,
        timeSeconds: input.timeSeconds,
        subjectIds: input.subjectIds,
      });
      diagnostics.revisionId = readInspectionContext().revisionId;
      return diagnostics;
    },

    inspectShotVisualPreflight(input) {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      const target = coerceShotTarget(input);
      if (!target) {
        throw new AgentApiError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'inspectShotVisualPreflight requires shotId or shot.');
      }
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      return inspectShotVisualPreflight({
        project,
        shotId: resolved.id,
        timeSeconds: input.timeSeconds,
        subjectIds: input.subjectIds,
        environmentOnly: input.environmentOnly,
        allowUnresolvedSetDressing: input.allowUnresolvedSetDressing,
      });
    },

    inspectAssetPoseContract(input = {}) {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      const target = coerceShotTarget(input);
      const resolved = target ? resolveExistingShotTarget(project, target) : undefined;
      if (resolved && !resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      return inspectAssetPoseContract(
        project,
        resolved && resolved.ok ? resolved.id : undefined,
        {
          packageManifestPaths: input.packageManifestPaths,
          producedPackageManifest: input.producedPackageManifest,
        },
      );
    },

    beginShotRepairSession(input) {
      const blocked = requireInspectionAccess();
      if (blocked) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId ?? '',
          kept: false,
          currentScore: 0,
          bestScore: 0,
          diagnostics: blocked,
        };
      }
      const project = readInspectionContext().project;
      const target = coerceShotTarget(input);
      if (!target) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: '',
          kept: false,
          currentScore: 0,
          bestScore: 0,
          diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'beginShotRepairSession requires shotId or shot.')],
        };
      }
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId ?? '',
          kept: false,
          currentScore: 0,
          bestScore: 0,
          diagnostics: resolved.diagnostics,
        };
      }
      return beginShotRepairSession({ shotId: resolved.id, label: input.label });
    },

    evaluateShotRepairCandidate(input) {
      const blocked = requireInspectionAccess();
      if (blocked) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId ?? '',
          kept: false,
          currentScore: 0,
          bestScore: 0,
          diagnostics: blocked,
        };
      }
      const project = readInspectionContext().project;
      const target = coerceShotTarget(input);
      if (!target) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: '',
          kept: false,
          currentScore: 0,
          bestScore: 0,
          diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'evaluateShotRepairCandidate requires shotId or shot.')],
        };
      }
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId ?? '',
          kept: false,
          currentScore: 0,
          bestScore: 0,
          diagnostics: resolved.diagnostics,
        };
      }
      return evaluateShotRepairCandidate({
        shotId: resolved.id,
        label: input.label,
        timeSeconds: input.timeSeconds,
        subjectIds: input.subjectIds,
        restoreIfWorse: input.restoreIfWorse,
        accepted: input.accepted,
        keepWhenAccepted: input.keepWhenAccepted,
      });
    },

    commitBestShotRepairCandidate(input) {
      const project = useProjectStore.getState().project;
      const target = coerceShotTarget(input);
      if (!target) {
        return Promise.resolve({
          ok: false,
          status: 'failed' as const,
          shotId: '',
          kept: false,
          currentScore: 0,
          bestScore: 0,
          diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'commitBestShotRepairCandidate requires shotId or shot.')],
        });
      }
      const resolved = resolveExistingShotTarget(project, target);
      if (!resolved.ok) {
        return Promise.resolve({
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId ?? '',
          kept: false,
          currentScore: 0,
          bestScore: 0,
          diagnostics: resolved.diagnostics,
        });
      }
      return commitBestShotRepairCandidate({ shotId: resolved.id });
    },

    listLandmarks() {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      return listLandmarksSnapshot(readInspectionContext().project);
    },

    createExportPlan(input: AgentExportPlanRequest = {}): AgentExportPlanResult {
      const blocked = requireInspectionAccess();
      if (blocked) {
        return { ok: false, diagnostics: blocked };
      }
      const ctx = readInspectionContext();
      const { shots, diagnostics } = resolveShotsForExport(
        ctx.project,
        input.shotIds,
      );
      if (diagnostics.some((item) => item.severity === 'error')) {
        return { ok: false, diagnostics };
      }
      if (shots.length === 0) {
        return {
          ok: false,
          diagnostics: [
            agentError(
              AGENT_DIAGNOSTIC_CODES.invalidArgument,
              'No shots available to plan.',
              { path: 'shotIds' },
            ),
          ],
        };
      }

      const plan = createExportPlan(ctx.project, shots, {
        packageType: input.packageType,
      });
      return {
        ok: true,
        plan,
        summary: plan.summary,
        diagnostics,
      };
    },

    disableWrites(): ForeSceneAgentStatus {
      const current = useAgentControlStore.getState().controlMode;
      // Never escalate — only demote to read-only (or keep off).
      useAgentControlStore.getState().setControlMode(current === 'off' ? 'off' : 'read-only');
      return getForeSceneAgentStatus();
    },

    setShotPanorama(input) {
      return setAgentShotPanorama(input);
    },

    refreshRevision() {
      return refreshAgentRevision().then((result) => ({
        ok: result.revisionId !== undefined,
        status: result.revisionId ? 'completed' as const : 'failed' as const,
        revisionId: result.revisionId,
        fingerprint: result.fingerprint,
        diagnostics: result.diagnostics,
      }));
    },

    downloadArtifact(input) {
      return downloadAgentArtifact(input);
    },

    exportProjectBackup(input = {}) {
      return exportAgentProjectBackup(input);
    },

    snapObjectToFloor(input) {
      return snapAgentObjectToFloor(input);
    },

    placeObjectNearLandmark(input) {
      return placeAgentObjectNearLandmark(input);
    },

    frameSubjects(input) {
      return frameAgentSubjects(input);
    },

    orientObjectToward(input) {
      return orientAgentObjectToward(input);
    },

    trackSubjects(input) {
      return trackAgentSubjects(input);
    },

    captureShotStateAsKeyframe(input) {
      return captureAgentShotStateAsKeyframe(input);
    },

    upsertObjectKeyframe(input) {
      return upsertAgentObjectKeyframe(input);
    },

    async previewPlan(plan: unknown): Promise<AgentPlanPreviewResult> {
      const blocked = requireInspectionAccess();
      if (blocked) {
        return { ok: false, warnings: [], diagnostics: blocked };
      }
      const projectState = useProjectStore.getState();
      // Preview mutates only a structuredClone inside prepareAgentPlan.
      const liveProject = projectState.project;
      const result = previewAgentPlan(plan, {
        project: liveProject,
        workspace: projectState.workspace,
        selectedObjectIds: projectState.selectedObjectIds,
        selectedShotId: projectState.selectedShotId,
        activePanoId: projectState.activePanoId,
        gridSnap: projectState.gridSnap,
      });
      // Prove the live store project was not replaced.
      if (useProjectStore.getState().project !== liveProject) {
        return {
          ok: false,
          warnings: [],
          diagnostics: [
            agentError(
              'preview_isolation',
              'Preview unexpectedly mutated the live project store.',
            ),
          ],
        };
      }
      return result;
    },

    async applyPlan(plan: unknown): Promise<AgentPlanApplyResult> {
      return applyAgentPlan(plan);
    },

    async applyVerifiedProxyReplacement(
      input: AgentVerifiedProxyReplacementInput,
    ): Promise<AgentVerifiedProxyReplacementResult> {
      return runVerifiedProxyReplacement(input);
    },

    async undoLastPlan(): Promise<AgentPlanApplyResult> {
      return undoLastAgentPlan();
    },

    listPlanHistory(): AgentPlanHistoryEntry[] {
      return listAgentHistory();
    },

    async createRefinementCheckpoint(input) {
      const blocked = refinementWriteDiagnostics('createRefinementCheckpoint');
      if (blocked) return { ok: false, diagnostics: blocked };
      const safety = useProjectSafetyStore.getState();
      if (!safety.flushProject) {
        return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready for a refinement checkpoint.')] };
      }
      const revision = await safety.flushProject(`Refinement checkpoint: ${input.reason}`);
      if (!revision) {
        return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Could not create a verified refinement checkpoint.')] };
      }
      return { ok: true, revisionId: revision.revision.id, diagnostics: [] };
    },

    async restoreRefinementCheckpoint(input) {
      const blocked = refinementWriteDiagnostics('restoreRefinementCheckpoint');
      if (blocked) return { ok: false, diagnostics: blocked };
      const live = useProjectStore.getState().project;
      if (live.id !== input.projectId) {
        return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, 'Refinement checkpoint belongs to a different project.')] };
      }
      const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
      if (!runDestructive) {
        return { ok: false, diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready for rollback.')] };
      }
      try {
        const restored = await restoreProjectRevision(input.projectId, input.revisionId);
        const verified = await runDestructive('Restore refinement batch checkpoint', () => {
          if (useProjectStore.getState().project.id !== input.projectId) {
            throw new Error('The loaded project changed before rollback could be committed.');
          }
          useProjectStore.setState((state) => ({
            project: structuredClone(restored.project),
            buildHistoryPast: [],
            buildHistoryFuture: [],
            buildHistoryBatchDepth: 0,
            buildHistoryBatchCaptured: false,
            buildHistoryCoalesceActive: false,
            shotCameraFlying: state.workspace === 'shots',
          }));
        });
        return { ok: true, revisionId: verified?.revision.id ?? restored.revision.id, diagnostics: [] };
      } catch (error) {
        return {
          ok: false,
          diagnostics: [agentError(
            AGENT_DIAGNOSTIC_CODES.invalidArgument,
            error instanceof Error ? error.message : 'Refinement checkpoint rollback failed.',
          )],
        };
      }
    },

    async resetProject(input: AgentResetProjectRequest): Promise<AgentPlanApplyResult & { projectId?: string }> {
      return resetAgentProject(input);
    },

    async exportPackage(input: AgentPackageExportRequest = {}): Promise<AgentPackageExportResult> {
      const blocked = requireInspectionAccess();
      if (blocked) {
        return { ok: false, status: 'failed', diagnostics: blocked };
      }
      return exportAgentPackage(input);
    },

    getPackageExportProgress() {
      return getAgentPackageExportProgress();
    },

    cancelPackageExport(): AgentPackageExportResult {
      return cancelAgentPackageExport();
    },

    async importModel(input: AgentModelImportInput): Promise<AgentModelImportResult> {
      if (useAgentControlStore.getState().controlMode !== 'read-write') {
        return {
          ok: false,
          warnings: [],
          diagnostics: [
            agentError(
              AGENT_DIAGNOSTIC_CODES.writeAccessRequired,
              'Write access is required to import a model.',
            ),
          ],
        };
      }
      const plan = createModelImportPlan([input.file]);
      if (plan.jobs.length !== 1 || plan.issues.some((issue) => issue.tone === 'error')) {
        const diagnostics = plan.issues
          .filter((issue) => issue.tone === 'error')
          .map((issue) => agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, issue.message, { path: 'file' }));
        if (plan.jobs.length !== 1 && diagnostics.length === 0) {
          diagnostics.push(agentError(
            AGENT_DIAGNOSTIC_CODES.invalidArgument,
            'Select one supported model or portable scene bundle to import.',
            { path: 'file' },
          ));
        }
        return {
          ok: false,
          warnings: plan.issues.filter((issue) => issue.tone === 'warning').map((issue) => issue.message),
          diagnostics,
        };
      }
      try {
        const batch = await importModelIntoProject(plan.jobs[0]!, {
          mode: input.mode ?? 'separate',
          allowHeavy: input.consentToken === 'allow-heavy-model-imports' || input.consentToken === 'IMPORT',
          extremeConfirmation: input.extremeConfirmation,
        });
        return {
          ok: true,
          objectRefs: batch.items.map(({ object }) => ({
            kind: 'object', id: object.id, name: object.name,
          })),
          summary: batch.summary,
          importBudget: batch.analysis,
          verifiedRevisionId: batch.verifiedRevisionId,
          reused: batch.reused,
          warnings: batch.warnings,
        };
      } catch (error) {
        if (error instanceof ModelImportConsentRequiredError) {
          return {
            ok: false,
            requiresConsent: true,
            importBudget: error.analysis,
            warnings: error.analysis.warnings,
            diagnostics: [agentError('import_consent_required', error.message)],
          };
        }
        return {
          ok: false,
          warnings: [],
          diagnostics: [agentError('model_import_failed', error instanceof Error ? error.message : 'Model import failed.')],
        };
      }
    },

    analyzeCharacterImport(input) {
      const blocked = requireInspectionAccess();
      if (blocked) return Promise.reject(new AgentApiError(blocked[0]!.code, blocked[0]!.message));
      return analyzeCharacterImport(input);
    },

    importCharacter(input) {
      const controlMode = useAgentControlStore.getState().controlMode;
      if (controlMode !== 'read-write') {
        return Promise.resolve({
          ok: false,
          warnings: [],
          diagnostics: [
            agentError(
              AGENT_DIAGNOSTIC_CODES.writeAccessRequired,
              'Write access is required to import a character.',
            ),
          ],
        });
      }
      return importCharacter(input);
    },

    analyzeSavedRigCharacter(input) {
      const blocked = requireInspectionAccess();
      if (blocked) return Promise.reject(new AgentApiError(blocked[0]!.code, blocked[0]!.message));
      return analyzeSavedRigCharacter(input);
    },

    importSavedRigCharacter(input) {
      const controlMode = useAgentControlStore.getState().controlMode;
      if (controlMode !== 'read-write') {
        return Promise.resolve({
          ok: false,
          warnings: [],
          diagnostics: [
            agentError(
              AGENT_DIAGNOSTIC_CODES.writeAccessRequired,
              'Write access is required to import a saved-rig character.',
            ),
          ],
        });
      }
      return importSavedRigCharacter(input);
    },

    getCharacterImportProgress() {
      return getCharacterImportProgress();
    },

    cancelCharacterImport() {
      return cancelCharacterImport();
    },

    discardCharacterImportAnalysis(analysisId) {
      return discardCharacterImportAnalysis(analysisId);
    },

    openProjectPackage(input) {
      return openAgentProjectPackage(input);
    },

    validateProjectPackage(input) {
      return validateAgentProjectPackage(input);
    },

    cloneProjectRevision(input) {
      return cloneAgentProjectRevision(input);
    },

    getLoadedProjectSource() {
      return getAgentLoadedProjectSource();
    },

    importPanoramaReference(input) {
      return importAgentPanoramaReference(input);
    },

    updatePanoramaReference(input) {
      return updateAgentPanoramaReference(input);
    },

    renderGrayboxPanorama(input) {
      return renderAgentGrayboxPanorama(input);
    },

    approvePanoramaReference(input) {
      return approveAgentPanoramaReference(input);
    },

    acceptReferenceAlignment(input) {
      return acceptAgentReferenceAlignment(input);
    },

    removePanoramaReference(input) {
      return removeAgentPanoramaReference(input);
    },

    setPanoramaCaptureOrigin(input) {
      return setAgentPanoramaCaptureOrigin(input);
    },

    inspectPanoramaProjection(input) {
      return inspectAgentPanoramaProjection(input);
    },

    validateSetBlueprint(input) {
      return Promise.resolve(validateAgentSetBlueprint(input));
    },

    applySetBlueprint(input) {
      return applyAgentSetBlueprint(input);
    },

    patchProjectSettings(input) {
      return patchAgentProjectSettings(input);
    },

    createObjectGroup(input) {
      return createAgentObjectGroup(input);
    },

    inspectObjectGroup(input) {
      return inspectAgentObjectGroup(input.groupId);
    },

    listObjectGroups() {
      const explicit = listAgentObjectGroups();
      if (explicit.length > 0) return explicit;
      return inferImportAssemblyGroups(readInspectionContext().project);
    },

    stageObjectGroup(input) {
      return stageAgentObjectGroup(input);
    },

    diagnoseObjectGroup(input) {
      return diagnoseAgentObjectGroup(input);
    },

    submitJob(input) {
      return Promise.resolve(submitAgentJob(input));
    },

    getJob(jobId) {
      return getAgentJob(jobId);
    },

    cancelJob(jobId) {
      return cancelAgentJob(jobId);
    },

    resumeJob(jobId) {
      return resumeAgentJob(jobId);
    },

    subscribeToJobProgress(jobId, listener) {
      return subscribeToAgentJobProgress(jobId, listener);
    },

    duplicateShot(input) {
      return duplicateAgentShot(input);
    },

    reorderShots(input) {
      return reorderAgentShots(input);
    },

    async captureShotThumbnail(input) {
      const blocked = refinementWriteDiagnostics('captureShotThumbnail');
      if (blocked) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
          width: 0,
          height: 0,
          artifacts: [],
          warnings: [],
          diagnostics: blocked,
        };
      }

      const rendered = await this.renderShotFrame({
        shotId: input.shotId,
        timeSeconds: input.timeSeconds,
        appearance: 'clay',
      });
      const baseResult = {
        ...rendered,
        shotId: input.shotId,
        revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
        primaryStillAssetId: undefined as string | undefined,
        artifacts: [] as AgentShotMaterializationResult['artifacts'],
        warnings: [] as string[],
      };

      if (!rendered.ok || !rendered.pngDataUrl) {
        return {
          ...baseResult,
          ok: false,
          status: 'failed' as const,
          warnings: ['Sampled thumbnail render did not produce attachable PNG data.'],
        };
      }

      const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
      if (!runDestructive) {
        return {
          ...baseResult,
          ok: false,
          status: 'failed' as const,
          diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')],
          warnings: ['Project persistence is not ready.'],
        };
      }

      let attachedAssetId: string | undefined;
      try {
        await runDestructive('Attach shot thumbnail', () => {
          const asset = useProjectStore.getState().attachViewportRenderToShot(input.shotId, {
            name: `shot_${input.shotId}_thumbnail.png`,
            dataUrl: rendered.pngDataUrl!,
            width: rendered.width,
            height: rendered.height,
          });
          attachedAssetId = asset.id;
        });
        return {
          ...baseResult,
          ok: true,
          status: 'ready' as const,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? baseResult.revisionId,
          primaryStillAssetId: attachedAssetId,
          artifacts: attachedAssetId ? [{
            key: `sampled-clay-thumbnail@${input.timeSeconds ?? 0}`,
            status: 'rendered',
            assetId: attachedAssetId,
          }] : [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not attach shot thumbnail.';
        return {
          ...baseResult,
          ok: false,
          status: 'failed' as const,
          diagnostics: [{ code: 'thumbnail_attach_failed', message, severity: 'error' }],
          warnings: [message],
        };
      }
    },

    async captureShotPreparedMedia(input) {
      const blocked = refinementWriteDiagnostics('captureShotPreparedMedia');
      if (blocked) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
          width: 0,
          height: 0,
          artifacts: [],
          warnings: [],
          diagnostics: blocked,
        };
      }

      // Render outside the protected persistence transaction. Each accepted
      // artifact is merged against the latest live project; the verified save
      // barrier happens once after the batch completes.
      const flushProject = useProjectSafetyStore.getState().flushProject;
      if (!flushProject) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
          width: 0,
          height: 0,
          artifacts: [],
          warnings: [],
          diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.busy, 'Project persistence is not ready.')],
        };
      }

      try {
        const { captureShotStillPreparation } = await import('../shotStillActions');
        const project = useProjectStore.getState().project;
        const materialization = await captureShotStillPreparation({
          project,
          shotId: input.shotId,
          mode: 'await-all',
          getLiveProject: () => useProjectStore.getState().project,
          commitLiveProject: (updater) => {
            useProjectStore.setState((current) => ({
              project: updater(current.project),
            }));
            return useProjectStore.getState().project;
          },
        });
        const result = materialization;
        const primaryId = result.primaryStillAssetId;
        await flushProject('Persist materialized shot stills');

        const asset = primaryId
          ? useProjectStore.getState().project.assets.assets[primaryId]
          : undefined;
        const artifacts = result.artifacts.map((item) => ({
          key: item.key,
          status: item.status,
          assetId: item.assetId,
        }));
        const revisionId = useProjectSafetyStore.getState().activeRevisionId ?? '';

        // Primary failure must never report ready — keep previous preview if present.
        if (result.status === 'failed') {
          return {
            ok: false,
            status: 'failed' as const,
            shotId: input.shotId,
            revisionId,
            primaryStillAssetId: primaryId,
            artifacts,
            warnings: result.warnings,
            width: asset?.width ?? 0,
            height: asset?.height ?? 0,
            pngDataUrl: asset?.uri?.startsWith('data:') ? asset.uri : undefined,
            diagnostics: preparedMediaDiagnostics(result),
          };
        }

        void queueBackgroundVideosForShot(input.shotId);

        return {
          ok: true,
          status: result.status,
          shotId: input.shotId,
          revisionId,
          primaryStillAssetId: primaryId,
          artifacts,
          warnings: result.warnings,
          width: asset?.width ?? 0,
          height: asset?.height ?? 0,
          pngDataUrl: asset?.uri?.startsWith('data:') ? asset.uri : undefined,
          diagnostics: preparedMediaDiagnostics(result),
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
          width: 0,
          height: 0,
          artifacts: [],
          warnings: [],
          diagnostics: [agentError(
            AGENT_DIAGNOSTIC_CODES.preparedMediaFailed,
            error instanceof Error ? error.message : 'Could not materialize shot stills.',
          )],
        };
      }
    },

    async regenerateShotStills(input) {
      const blocked = refinementWriteDiagnostics('regenerateShotStills');
      if (blocked) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
          width: 0,
          height: 0,
          artifacts: [],
          warnings: [],
          diagnostics: blocked,
        };
      }
      const { regenerateShotStills } = await import('../shotStillActions');
      const result = await regenerateShotStills({
        project: useProjectStore.getState().project,
        shotId: input.shotId,
        getLiveProject: () => useProjectStore.getState().project,
        commitLiveProject: (updater) => {
          useProjectStore.setState((current) => ({ project: updater(current.project) }));
          return useProjectStore.getState().project;
        },
      });
      void queueBackgroundVideosForShot(input.shotId);
      return {
        ok: result.status !== 'failed',
        status: result.status,
        shotId: input.shotId,
        revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
        primaryStillAssetId: result.primaryStillAssetId,
        artifacts: result.artifacts.map((item) => ({
          key: item.key,
          status: item.status,
          assetId: item.assetId,
        })),
        warnings: result.warnings,
        width: 0,
        height: 0,
        diagnostics: preparedMediaDiagnostics(result),
      };
    },

    async retryFailedShotStills(input) {
      const blocked = refinementWriteDiagnostics('retryFailedShotStills');
      if (blocked) {
        return {
          ok: false,
          status: 'failed' as const,
          shotId: input.shotId,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
          width: 0,
          height: 0,
          artifacts: [],
          warnings: [],
          diagnostics: blocked,
        };
      }
      const { retryFailedShotStills } = await import('../shotStillActions');
      recordProvenanceRetry();
      const result = await retryFailedShotStills({
        project: useProjectStore.getState().project,
        shotId: input.shotId,
        getLiveProject: () => useProjectStore.getState().project,
        commitLiveProject: (updater) => {
          useProjectStore.setState((current) => ({ project: updater(current.project) }));
          return useProjectStore.getState().project;
        },
      });
      void queueBackgroundVideosForShot(input.shotId);
      return {
        ok: result.status !== 'failed',
        status: result.status,
        shotId: input.shotId,
        revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
        primaryStillAssetId: result.primaryStillAssetId,
        artifacts: result.artifacts.map((item) => ({
          key: item.key,
          status: item.status,
          assetId: item.assetId,
        })),
        warnings: result.warnings,
        width: 0,
        height: 0,
        diagnostics: preparedMediaDiagnostics(result),
      };
    },

    cancelShotStillPreparation(input) {
      const result = cancelShotStillPreparationAction(input?.shotId);
      if (result.cancelledShotIds.length > 0) recordProvenanceCancellation();
      return { ok: true, cancelledShotIds: result.cancelledShotIds };
    },

    cancelRenderWork(input) {
      const cancelledCount = input?.shotId
        ? renderWorkCoordinator.cancelByOwner(input.shotId)
        : renderWorkCoordinator.cancelAll();
      if (cancelledCount > 0) recordProvenanceCancellation();
      return { ok: true, cancelledCount };
    },

    listShotMedia(input) {
      return listAgentShotMedia(input);
    },

    compareAdjacentShots(input) {
      return compareAgentAdjacentShots(input);
    },

    inspectSequenceContinuity(input) {
      return inspectAgentSequenceContinuity(input);
    },

    async renderStoryboard(input) {
      const submitted = submitAgentJob({
        type: 'render-shot-batch',
        jobs: input.shotIds.map((shotId) => ({ shotId })),
        concurrency: 1,
        continueOnError: false,
      });
      if (!submitted.ok || !submitted.jobId) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotIds[0] ?? '',
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
          width: 0,
          height: 0,
          diagnostics: submitted.diagnostics,
        };
      }

      const progress = await waitForAgentJob(submitted.jobId);
      const artifactIds = progress.artifactIds ?? [];
      if (progress.status === 'failed' || progress.status === 'cancelled') {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotIds[0] ?? '',
          revisionId: progress.revisionId ?? '',
          width: 0,
          height: 0,
          diagnostics: progress.errors ?? [agentError('render_failed', 'Storyboard render job failed.')],
        };
      }
      if (artifactIds.length !== input.shotIds.length) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotIds[0] ?? '',
          revisionId: progress.revisionId ?? '',
          width: 0,
          height: 0,
          diagnostics: [agentError(
            'storyboard_incomplete',
            `Expected ${input.shotIds.length} shot renders but received ${artifactIds.length}.`,
          )],
        };
      }

      const sheetSubmitted = submitAgentJob({
        type: 'create-contact-sheets',
        jobs: [artifactIds],
      });
      if (!sheetSubmitted.ok || !sheetSubmitted.jobId) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotIds[0] ?? '',
          revisionId: progress.revisionId ?? '',
          width: 0,
          height: 0,
          diagnostics: sheetSubmitted.diagnostics,
        };
      }

      const sheetProgress = await waitForAgentJob(sheetSubmitted.jobId);
      const storyboardArtifactId = sheetProgress.artifactIds?.[0];
      const blob = storyboardArtifactId ? getAgentArtifactBlob(storyboardArtifactId) : undefined;
      if (!blob || !storyboardArtifactId) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotIds[0] ?? '',
          revisionId: sheetProgress.revisionId ?? '',
          width: 0,
          height: 0,
          diagnostics: [agentError('storyboard_compose_failed', 'Storyboard contact sheet was not produced.')],
        };
      }

      const dataUrl = await blobToDataUrlFromBlob(blob);
      const artifact = buildInlineArtifact({ mimeType: 'image/png', dataUrl });
      const handle = getAgentArtifactHandle(storyboardArtifactId);
      const sheetSpec = buildContactSheetSpec({
        title: 'Storyboard',
        shots: artifactIds.map((id, idx) => ({
          shotNumber: String(idx + 1).padStart(3, '0'),
          name: id,
          framePath: id,
          status: 'rendered',
          warningCount: 0,
          fromCanonicalRenderer: true,
        })),
      });
      const rows = Math.ceil(artifactIds.length / sheetSpec.columns);
      const storyboardWidth = sheetSpec.columns * sheetSpec.cellWidth;
      const storyboardHeight = rows * sheetSpec.cellHeight;
      return {
        ok: true,
        status: sheetProgress.status === 'completed_with_warnings' ? 'completed_with_warnings' : 'completed',
        shotId: input.shotIds[0] ?? '',
        revisionId: sheetProgress.revisionId ?? progress.revisionId ?? '',
        width: storyboardWidth,
        height: storyboardHeight,
        artifact,
        handle,
        pngDataUrl: dataUrl,
        diagnostics: sheetProgress.errors ?? [],
      };
    },

    renderAnimaticPreview(input) {
      void input;
      return Promise.resolve({
        ok: false,
        status: 'failed' as const,
        shotId: input.shotIds[0] ?? '',
        revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
        diagnostics: [notImplementedDiagnostic('renderAnimaticPreview')],
      });
    },

    inspectCharacterPose(input) {
      return inspectAgentCharacterPose(input);
    },

    setJointRotation(input) {
      return setAgentJointRotation(input);
    },

    applyPosePreset(input) {
      return applyAgentPosePreset(input);
    },

    mirrorPose(input) {
      return mirrorAgentPose(input);
    },

    resetJointPose(input) {
      return resetAgentJointPose(input);
    },

    copyPoseBetweenShots(input) {
      return copyAgentPoseBetweenShots(input);
    },

    exportRigPackage(input) {
      return exportAgentRigPackage(input);
    },

    listProjectRevisions() {
      return listAgentProjectRevisions();
    },

    inspectProjectHealth() {
      return inspectAgentProjectHealth();
    },

    inspectBrowserStorage() {
      return inspectAgentBrowserStorage();
    },

    restoreProjectRevision(input) {
      return restoreAgentProjectRevision(input);
    },

    compareProjectRevisions(input) {
      return compareAgentProjectRevisions(input);
    },

    cleanupUnreferencedAssets() {
      return cleanupAgentUnreferencedAssets();
    },

    repairProjectIntegrity() {
      return repairAgentProjectIntegrity();
    },

    listArtifacts(input) {
      return listAgentArtifacts(input ?? {});
    },

    persistArtifact(input) {
      return persistAgentArtifact(input.artifactId);
    },

    deleteArtifact(input) {
      return deleteAgentArtifact(input.artifactId);
    },

    getArtifactStatus(input) {
      return getAgentArtifactStatus(input.artifactId);
    },

    validateProductionManifest(input) {
      return validateAgentProductionManifest(input);
    },

    bindManifestAssets(input) {
      return bindAgentManifestAssets(input);
    },

    inspectProductionConfiguration() {
      return inspectAgentProductionConfiguration();
    },

    previewGenerativeWorldRequest(input) {
      return previewAgentGenerativeWorldRequest(input);
    },

    runMockGenerativeWorldBackend(input) {
      return runAgentMockGenerativeWorldBackend(input);
    },

    renderGenerativeWorldDepthPrior(input) {
      return renderAgentGenerativeWorldDepthPrior(input);
    },

    validateProductionConfiguration(input) {
      return validateAgentProductionConfiguration(input);
    },

    bindProductionEntity(input) {
      return bindAgentProductionEntity(input);
    },

    defineProductionLocation(input) {
      return defineAgentProductionLocation(input);
    },

    removeProductionBinding(input) {
      return removeAgentProductionBinding(input);
    },

    inspectEntityCapability(input) {
      return inspectAgentEntityCapability(input);
    },

    validateProductionCapabilities(input) {
      return validateAgentProductionCapabilities(input);
    },

    resolveProductionPose(input) {
      return resolveAgentProductionPose(input);
    },

    approvePoseSubstitution(input) {
      return approveAgentPoseSubstitution(input);
    },

    setShotPresenceContract(input) {
      return setAgentShotPresenceContract(input);
    },

    inspectShotPresence(input) {
      return inspectAgentShotPresence(input);
    },

    verifyShotPresence(input) {
      return verifyAgentShotPresence(input);
    },

    repairShotPresence(input) {
      return repairAgentShotPresence(input);
    },

    inspectShotEnvironmentContract(input) {
      return inspectAgentShotEnvironmentContract(input);
    },

    verifyShotPanorama(input) {
      return verifyAgentShotPanorama(input);
    },

    inspectProjectionHealth(input) {
      return inspectAgentProjectionHealth(input);
    },

    setShotCompositionConstraints(input) {
      return setAgentShotCompositionConstraints(input);
    },

    inspectShotCompositionError(input) {
      return inspectAgentShotCompositionError(input);
    },

    solveShotToCompositionConstraints(input) {
      return solveAgentShotToCompositionConstraints(input);
    },

    verifyShotCompositionConstraints(input) {
      return verifyAgentShotCompositionConstraints(input);
    },

    planProductionCanary(input) {
      return planAgentProductionCanary(input);
    },

    runProductionCanary(input) {
      return runAgentProductionCanary(input);
    },

    approveProductionCanary(input) {
      return approveAgentProductionCanary(input);
    },

    runProduction(input): Promise<AgentProductionRunResult> {
      return runAgentProduction(input);
    },

    getProductionRun(runId) {
      return getAgentProductionRun(runId);
    },

    listProductionRuns() {
      return listAgentProductionRuns();
    },

    pauseProductionRun(runId) {
      return pauseAgentProductionRun(runId);
    },

    resumeProductionRun(runId) {
      return resumeAgentProductionRun(runId);
    },

    cancelProductionRun(runId) {
      return cancelAgentProductionRun(runId);
    },

    subscribeProductionRun(runId, listener) {
      return subscribeAgentProductionRun(runId, listener);
    },

    approveStillLayout(input): Promise<AgentStillLayoutApprovalResult> {
      return approveAgentStillLayout(input);
    },

    createMotionWorkingRevision(input): Promise<AgentMotionWorkingRevisionResult> {
      return createAgentMotionWorkingRevision(input);
    },

    inspectStillLayoutApproval(input) {
      return inspectAgentStillLayoutApproval(input);
    },

    planReviewSamples(input) {
      const shot = useProjectStore.getState().project.shots.find((candidate) => candidate.id === input.shotId);
      if (!shot) throw new Error(`Unknown shot '${input.shotId}'.`);
      return planReviewSamplesEngine({
        shotId: input.shotId,
        shot,
        strategy: input.strategy,
        maxSamples: input.maxSamples,
      });
    },

    planProductionReviewArtifacts(input) {
      return buildProductionReviewArtifacts(input);
    },

    inspectRenderCache(input) {
      return inspectAgentRenderCache(input);
    },

    explainRenderCacheHit(input) {
      return explainAgentRenderCacheHit(input);
    },

    explainRenderCacheMiss(input) {
      return explainAgentRenderCacheMiss(input);
    },

    invalidateRenderDependencies(input) {
      return invalidateAgentRenderDependencies(input);
    },

    clearRenderCache(input) {
      return clearAgentRenderCache(input);
    },

    inspectProductionGates(input) {
      return inspectAgentProductionGates(input);
    },

    previewProductionCompile(input) {
      return previewAgentProductionCompile(input);
    },

    applyProductionCompile(input) {
      return applyAgentProductionCompile(input);
    },

    inspectProductionStatus() {
      return inspectAgentProductionStatus();
    },

    inspectShotsDiagnostics(input) {
      const ctx = readInspectionContext();
      return input.shots.map((entry) => {
        const shot = ctx.project.shots.find((candidate) => candidate.id === entry.shotId);
        if (!shot) {
          return {
            shotId: entry.shotId,
            subjects: [],
            foregroundOcclusionFraction: 0,
            linkedPanoramaResolved: false,
            cameraIntersectsSolidGeometry: false,
            cameraDisplacementMeters: 0,
            subjectDisplacements: [],
            diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.targetNotFound, `No shot with id "${entry.shotId}".`)],
          };
        }
        return inspectAgentShotDiagnostics({
          project: ctx.project,
          shot,
          timeSeconds: entry.timeSeconds,
          subjectIds: entry.subjectIds,
        });
      });
    },

    async frameSubjectsBatch(input) {
      return frameAgentSubjectsBatch(input.shots, input.concurrency ?? 1);
    },

    async renderShotBatch(input) {
      return renderAgentShotBatch(input.jobs, input.concurrency ?? 1);
    },

    renderPassMatrix(input) {
      return Promise.resolve(submitAgentJob({
        type: 'render-pass-matrix',
        shotIds: input.shotIds,
        passes: input.passes,
        concurrency: input.concurrency ?? 1,
        continueOnError: true,
      }));
    },

    createContactSheets(input) {
      return Promise.resolve(submitAgentJob({
        type: 'create-contact-sheets',
        jobs: [input.artifactIds],
      }));
    },

    async waitForIdle(options?: { timeoutMs?: number }): Promise<ForeSceneAgentStatus> {
      const timeoutMs = options?.timeoutMs ?? 30_000;
      const started = Date.now();

      const current = getForeSceneAgentStatus();
      if (!isBusy(current)) return current;

      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (status: ForeSceneAgentStatus) => {
          if (settled) return;
          settled = true;
          unsubProject();
          unsubSafety();
          clearInterval(timer);
          resolve(status);
        };

        const check = () => {
          const status = getForeSceneAgentStatus();
          if (!isBusy(status)) {
            finish(status);
            return;
          }
          if (Date.now() - started >= timeoutMs) {
            if (settled) return;
            settled = true;
            unsubProject();
            unsubSafety();
            clearInterval(timer);
            reject(
              new AgentApiError(
                AGENT_DIAGNOSTIC_CODES.busy,
                `waitForIdle timed out after ${timeoutMs}ms.`,
              ),
            );
          }
        };

        const unsubProject = useProjectStore.subscribe(check);
        const unsubSafety = useProjectSafetyStore.subscribe(check);
        const timer = setInterval(check, 100);
        check();
      });
    },

    async waitForViewportReady(
      options: AgentWaitForViewportReadyInput = {},
    ): Promise<AgentWaitForViewportReadyResult> {
      const blocked = requireInspectionAccess();
      if (blocked) {
        return { ok: false, diagnostics: blocked };
      }

      const timeoutMs = options.timeoutMs ?? 60_000;
      const workspace = options.workspace ?? 'shots';
      const started = Date.now();
      const baselineGeneration = getViewportReadinessSnapshot().sceneRenderGeneration;

      const evaluate = (): AgentWaitForViewportReadyResult | null => {
        const status = getForeSceneAgentStatus();
        const projectState = useProjectStore.getState();
        const safety = useProjectSafetyStore.getState();
        const readiness = getViewportReadinessSnapshot();
        const diagnostics: AgentWaitForViewportReadyResult['diagnostics'] = [];

        if (!projectState.project) {
          diagnostics.push(agentError(
            AGENT_DIAGNOSTIC_CODES.projectNotLoaded,
            'No project is loaded.',
          ));
          return { ok: false, diagnostics };
        }

        if (projectState.workspace !== workspace) {
          return null;
        }

        if (options.shotId && projectState.selectedShotId !== options.shotId) {
          return null;
        }

        const shot = options.shotId
          ? projectState.project.shots.find((item) => item.id === options.shotId)
          : projectState.selectedShotId
            ? projectState.project.shots.find((item) => item.id === projectState.selectedShotId)
            : undefined;

        if (options.shotId && !shot) {
          diagnostics.push(agentError(
            AGENT_DIAGNOSTIC_CODES.targetNotFound,
            `Shot "${options.shotId}" not found.`,
          ));
          return { ok: false, shotId: options.shotId, diagnostics };
        }

        if (isBusy(status) || projectState.isRenderingGraybox || readiness.loading) {
          return null;
        }

        // Prefer reported readiness; fall back to live DOM canvas for workspaces
        // that have not yet emitted a render.
        let canvasWidth = readiness.canvasWidth;
        let canvasHeight = readiness.canvasHeight;
        if (canvasWidth <= 0 || canvasHeight <= 0) {
          const canvas = document.querySelector(
            '[data-testid="scene-viewport"] canvas',
          ) as HTMLCanvasElement | null;
          if (canvas) {
            canvasWidth = canvas.width;
            canvasHeight = canvas.height;
          }
        }

        if (canvasWidth <= 0 || canvasHeight <= 0 || !readiness.canvasInitialized) {
          // DOM-only init is acceptable when the readiness module has not mounted yet
          // but a canvas is present with positive size.
          if (canvasWidth <= 0 || canvasHeight <= 0) return null;
        }

        const renderAfterSelect = readiness.sceneRenderGeneration > baselineGeneration
          || (
            options.shotId
            && readiness.lastRenderShotId === options.shotId
            && readiness.sceneRenderGeneration > 0
          )
          || (!options.shotId && readiness.sceneRenderGeneration > 0);

        if (!renderAfterSelect && workspace === 'shots') {
          return null;
        }

        const revisionId = safety.activeRevisionId ?? '';
        if (
          readiness.projectRevisionId
          && revisionId
          && readiness.projectRevisionId !== revisionId
        ) {
          return null;
        }

        return {
          ok: true,
          workspace: projectState.workspace as Workspace,
          shotId: options.shotId ?? projectState.selectedShotId ?? undefined,
          revisionId,
          canvasWidth,
          canvasHeight,
          sceneRenderGeneration: readiness.sceneRenderGeneration,
        };
      };

      const immediate = evaluate();
      if (immediate?.ok) {
        await waitAnimationFrames(2);
        return evaluate() ?? immediate;
      }
      if (immediate && !immediate.ok && immediate.diagnostics?.length) {
        return immediate;
      }

      return new Promise((resolve) => {
        let settled = false;
        const finish = (result: AgentWaitForViewportReadyResult) => {
          if (settled) return;
          settled = true;
          unsubReady();
          unsubProject();
          unsubSafety();
          clearInterval(timer);
          resolve(result);
        };

        const check = async () => {
          const result = evaluate();
          if (result?.ok) {
            await waitAnimationFrames(2);
            const after = evaluate();
            finish(after?.ok ? after : result);
            return;
          }
          if (result && !result.ok && result.diagnostics?.length) {
            finish(result);
            return;
          }
          if (Date.now() - started >= timeoutMs) {
            finish({
              ok: false,
              workspace: useProjectStore.getState().workspace as Workspace | undefined,
              shotId: options.shotId,
              diagnostics: [
                agentError(
                  AGENT_DIAGNOSTIC_CODES.busy,
                  `waitForViewportReady timed out after ${timeoutMs}ms.`,
                ),
              ],
            });
          }
        };

        const unsubReady = subscribeViewportReadiness(() => {
          void check();
        });
        const unsubProject = useProjectStore.subscribe(() => {
          void check();
        });
        const unsubSafety = useProjectSafetyStore.subscribe(() => {
          void check();
        });
        const timer = setInterval(() => {
          void check();
        }, 100);
        void check();
      });
    },

    async renderShotFrame(
      input: AgentRenderShotFrameInput,
    ): Promise<AgentRenderShotFrameResult> {
      const blocked = requireInspectionAccess();
      if (blocked) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotId,
          revisionId: '',
          width: 0,
          height: 0,
          diagnostics: blocked,
        };
      }

      const projectState = useProjectStore.getState();
      const safety = useProjectSafetyStore.getState();
      const project = projectState.project;
      if (!project) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotId,
          revisionId: '',
          width: 0,
          height: 0,
          diagnostics: [
            agentError(AGENT_DIAGNOSTIC_CODES.projectNotLoaded, 'No project is loaded.'),
          ],
        };
      }

      const shot = project.shots.find((item) => item.id === input.shotId);
      if (!shot) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotId,
          revisionId: safety.activeRevisionId ?? '',
          width: 0,
          height: 0,
          diagnostics: [
            agentError(
              AGENT_DIAGNOSTIC_CODES.targetNotFound,
              `No shot with id "${input.shotId}".`,
            ),
          ],
        };
      }

      const revisionAtStart = safety.activeRevisionId ?? '';
      const width = input.width ?? shot.exportSettings.width;
      const height = input.height ?? shot.exportSettings.height;
      let timeSample: ReturnType<typeof sampleShotTimeline> | undefined;
      try {
        timeSample = input.timeSeconds === undefined
          ? undefined
          : sampleShotTimeline(project, shot.id, input.timeSeconds);
      } catch (error) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotId,
          revisionId: revisionAtStart,
          width,
          height,
          diagnostics: [agentError(AGENT_DIAGNOSTIC_CODES.invalidArgument, error instanceof Error ? error.message : 'Invalid frame time.')],
        };
      }
      const shotForRender: Shot = {
        ...shot,
        ...(timeSample
          ? { camera: timeSample.camera, objectOverrides: timeSample.objectOverrides }
          : {}),
        exportSettings: {
          ...shot.exportSettings,
          width,
          height,
        },
      };

      const appearance = input.appearance ?? 'clay';
      const peopleVariant = input.peopleVariant ?? 'with_people';
      const content = input.content ?? 'full_scene';
      if (content === 'characters_only' && peopleVariant === 'clean_plate') {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotId,
          revisionId: revisionAtStart,
          width,
          height,
          diagnostics: [agentError(
            AGENT_DIAGNOSTIC_CODES.invalidArgument,
            'characters_only cannot be combined with the clean_plate people variant.',
          )],
        };
      }
      if (appearance === 'depth' && content === 'characters_only') {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotId,
          revisionId: revisionAtStart,
          width,
          height,
          diagnostics: [agentError(
            AGENT_DIAGNOSTIC_CODES.invalidArgument,
            'Depth stills support full_scene or clean_plate content; characters_only is a separate transparent pass.',
          )],
        };
      }

      try {
        await ensurePoseableCharactersForProject(project);
      } catch (error) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotId,
          revisionId: revisionAtStart,
          width,
          height,
          diagnostics: [agentError(
            'poseable_character_assets_missing',
            error instanceof Error ? error.message : String(error),
          )],
        };
      }
      clearPoseApplicationReports();

      try {
        let pngDataUrl: string;
        let renderedWidth: number;
        let renderedHeight: number;
        let pixelStats: RenderPixelStats | undefined;
        let source: NonNullable<AgentRenderShotFrameResult['source']>;
        let depth: AgentRenderShotFrameResult['depth'];

        if (content === 'characters_only') {
          const frame = await renderShotCharacterFrame(project, shotForRender, {
            appearance: appearance === 'projected' ? 'projected' : 'clay',
            includeAttachedProps: true,
          });
          pngDataUrl = await blobToDataUrlFromBlob(frame.blob);
          renderedWidth = frame.width;
          renderedHeight = frame.height;
          source = 'canonical_character_renderer';
        } else if (appearance === 'projected') {
          const frame = await renderShotProjectedFrame(project, shotForRender, { peopleVariant });
          pngDataUrl = frame.dataUrl;
          renderedWidth = frame.width;
          renderedHeight = frame.height;
          source = 'canonical_projected_renderer';
        } else if (appearance === 'depth') {
          const frame = await renderShotDepthFrame(project, shotForRender, { peopleVariant });
          pngDataUrl = frame.dataUrl;
          renderedWidth = frame.width;
          renderedHeight = frame.height;
          source = 'canonical_depth_renderer';
          depth = {
            encoding: frame.encoding,
            nearMeters: frame.nearMeters,
            farMeters: frame.farMeters,
            invert: frame.invert,
            grayscalePixelRatio: 0,
          };
        } else {
          // Same internal path as package export inputs/viewport_clay.png.
          const frame = await renderShotFrameEngine(project, shotForRender, { peopleVariant });
          pngDataUrl = frame.dataUrl;
          renderedWidth = frame.width;
          renderedHeight = frame.height;
          pixelStats = frame.pixelStats;
          source = 'canonical_clay_renderer';
        }

        const revisionNow = useProjectSafetyStore.getState().activeRevisionId ?? '';
        if (revisionAtStart && revisionNow && revisionAtStart !== revisionNow) {
          return {
            ok: false,
            status: 'stale_revision',
            shotId: input.shotId,
            revisionId: revisionNow,
            width: renderedWidth,
            height: renderedHeight,
            ...(timeSample ? {
              requestedTimeSeconds: timeSample.requestedTimeSeconds,
              sampledTimeSeconds: timeSample.sampledTimeSeconds,
            } : {}),
            diagnostics: [
              agentError(
                AGENT_DIAGNOSTIC_CODES.staleRevision,
                'Project revision changed during clean frame render.',
              ),
            ],
          };
        }

        const allowFlatFrame = content === 'characters_only' || peopleVariant === 'clean_plate';
        let rejection = rejectFrameStats(pixelStats, allowFlatFrame);
        if ((!pixelStats || rejection) && pngDataUrl) {
          try {
            const fromDataUrl = await computePixelStatsFromDataUrl(pngDataUrl);
            const second = rejectFrameStats(fromDataUrl, allowFlatFrame);
            pixelStats = fromDataUrl;
            rejection = second;
          } catch {
            // Keep original rejection.
          }
        }

        const qualityDiagnostics = rejection
          ? [agentError(rejection.code, rejection.message)]
          : [];
        const poseApplications = getPoseApplicationReports();
        const poseFailures = poseApplications.filter((report) => !report.poseApplied);
        qualityDiagnostics.push(...poseFailures.map((report) => agentError(
          report.diagnostic.code,
          report.diagnostic.message,
        )));

        if (depth) {
          depth.grayscalePixelRatio = await grayscalePixelRatioFromDataUrl(pngDataUrl);
          if (depth.grayscalePixelRatio < 0.995) {
            qualityDiagnostics.push(agentError(
              'depth_not_grayscale',
              `Depth renderer produced non-grayscale pixels (ratio ${depth.grayscalePixelRatio.toFixed(4)}).`,
            ));
          }
        }

        const registered = pngDataUrl
          ? registerRenderedFrameArtifact({
            dataUrl: pngDataUrl,
            fileName: `shot_${input.shotId}.png`,
            revisionId: revisionNow,
            shotId: input.shotId,
          })
          : undefined;
        const status = deriveOperationStatus({
          hasArtifact: Boolean(registered),
          diagnostics: qualityDiagnostics,
        });
        const finalStatus = poseFailures.length > 0 ? 'failed' : status;

        return {
          ok: deriveOperationOk(finalStatus),
          status: finalStatus,
          shotId: input.shotId,
          revisionId: revisionNow,
          width: renderedWidth,
          height: renderedHeight,
          ...(timeSample ? {
            requestedTimeSeconds: timeSample.requestedTimeSeconds,
            sampledTimeSeconds: timeSample.sampledTimeSeconds,
          } : {}),
          artifact: registered?.inline,
          handle: registered?.handle,
          pngDataUrl,
          pixelStats,
          appearance,
          peopleVariant,
          content,
          depth,
          source,
          poseApplications,
          diagnostics: qualityDiagnostics,
        };
      } catch (error) {
        return {
          ok: false,
          status: 'failed',
          shotId: input.shotId,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
          width: 0,
          height: 0,
          diagnostics: [
            agentError(
              'render_failed',
              error instanceof Error ? error.message : String(error),
            ),
          ],
        };
      }
    },

    renderShotVideo(input: AgentShotVideoRenderInput): Promise<AgentShotVideoRenderResult> {
      return renderAgentShotVideo(input);
    },

    getShotVideoRenderProgress() {
      return getAgentShotVideoRenderProgress();
    },

    cancelShotVideoRender() {
      return cancelAgentShotVideoRender();
    },
  };

  // Route every public still-frame entry point through the same coordinator.
  // Batch callers use this late-bound method too, so they cannot bypass a live
  // background video or interactive capture job.
  const renderShotFrameUncoordinated = api.renderShotFrame.bind(api);
  api.renderShotFrame = (input) => {
    const controller = new AbortController();
    return renderWorkCoordinator.schedule(
      'capture-primary-still',
      () => renderShotFrameUncoordinated(input),
      {
        ownerId: input.shotId,
        jobId: `agent-frame:${input.shotId}`,
        signal: controller.signal,
        abort: () => controller.abort(),
      },
    );
  };
  setAgentRenderShotFrameImpl((input) => api.renderShotFrame(input));

  return api;
}

function waitAnimationFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(step);
      } else {
        setTimeout(step, 16);
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(step);
    } else {
      setTimeout(step, 16);
    }
  });
}

function blobToDataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not encode rendered image.'));
    reader.readAsDataURL(blob);
  });
}

async function grayscalePixelRatioFromDataUrl(dataUrl: string): Promise<number> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const next = new Image();
    next.onload = () => resolve(next);
    next.onerror = () => reject(new Error('Could not decode depth PNG.'));
    next.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext('2d');
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('Could not read depth PNG pixels.');
  }
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let sampled = 0;
  let grayscale = 0;
  const stride = 8;
  for (let y = 0; y < canvas.height; y += stride) {
    for (let x = 0; x < canvas.width; x += stride) {
      const index = (y * canvas.width + x) * 4;
      if (pixels[index + 3]! <= 8) continue;
      sampled += 1;
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) <= 1) grayscale += 1;
    }
  }
  return sampled > 0 ? grayscale / sampled : 0;
}

export class AgentApiError extends Error {
  readonly code: string;
  readonly candidates?: string[];

  constructor(code: string, message: string, candidates?: string[]) {
    super(message);
    this.name = 'AgentApiError';
    this.code = code;
    this.candidates = candidates;
  }
}
