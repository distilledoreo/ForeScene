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
import {
  computePixelStatsFromDataUrl,
  rejectRenderPixelStats,
  type RenderPixelStats,
} from '../previs/renderPixelStats';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useAppModeStore } from '../../state/useAppModeStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { buildAgentCapabilities } from './capabilities';
import { previewAgentPlan } from './planCompiler';
import { applyAgentPlan, undoLastAgentPlan } from './transaction';
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
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
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
  AgentObjectInspection,
  AgentObjectQuery,
  AgentPackageExportRequest,
  AgentPackageExportResult,
  AgentPlanApplyResult,
  AgentPlanHistoryEntry,
  AgentPlanPreviewResult,
  AgentProjectInspection,
  AgentRenderShotFrameInput,
  AgentRenderShotFrameResult,
  AgentResetProjectRequest,
  AgentShotInspection,
  AgentShotTimeSample,
  AgentShotTimelineInspection,
  AgentShotVideoRenderInput,
  AgentShotVideoRenderResult,
  AgentWaitForViewportReadyInput,
  AgentWaitForViewportReadyResult,
  ForeSceneAgentStatus,
  ForeSceneBrowserApi,
} from './protocol';
import { FORESCENE_AGENT_API_VERSION } from './protocol';
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
  if (shotIds && shotIds.length > 0) {
    const shots: Shot[] = [];
    for (const id of shotIds) {
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
  };
}

export function createForeSceneBrowserApi(): ForeSceneBrowserApi {
  const api: ForeSceneBrowserApi = {
    apiVersion: FORESCENE_AGENT_API_VERSION,

    getStatus() {
      return getForeSceneAgentStatus();
    },

    getCapabilities() {
      return buildAgentCapabilities(useAgentControlStore.getState().controlMode);
    },

    inspectProject(): AgentProjectInspection {
      const blocked = requireInspectionAccess();
      if (blocked) {
        throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      }
      return inspectProjectSnapshot(readInspectionContext());
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
      return inspectObjectSnapshot(object);
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

    sampleShotAtTime(input: { shot: AgentEntityTarget; timeSeconds: number }): AgentShotTimeSample {
      const blocked = requireInspectionAccess();
      if (blocked) throw new AgentApiError(blocked[0]!.code, blocked[0]!.message);
      const project = readInspectionContext().project;
      const resolved = resolveExistingShotTarget(project, input.shot);
      if (!resolved.ok) {
        const first = resolved.diagnostics[0]!;
        throw new AgentApiError(first.code, first.message, first.candidates);
      }
      return sampleShotAtTimeSnapshot(project, resolved.id, input.timeSeconds);
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

    async undoLastPlan(): Promise<AgentPlanApplyResult> {
      return undoLastAgentPlan();
    },

    listPlanHistory(): AgentPlanHistoryEntry[] {
      return listAgentHistory();
    },

    async resetProject(input: AgentResetProjectRequest): Promise<AgentPlanApplyResult & { projectId?: string }> {
      return resetAgentProject(input);
    },

    async exportPackage(input: AgentPackageExportRequest = {}): Promise<AgentPackageExportResult> {
      const blocked = requireInspectionAccess();
      if (blocked) {
        return { ok: false, diagnostics: blocked };
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
          pngDataUrl = await blobToDataUrl(frame.blob);
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

        // Prefer WebGL readPixels stats; fall back to decoding the PNG data URL
        // when readback is flaky (preserveDrawingBuffer races, partial buffers).
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
        if (depth) {
          depth.grayscalePixelRatio = await grayscalePixelRatioFromDataUrl(pngDataUrl);
          if (depth.grayscalePixelRatio < 0.995) {
            return {
              ok: false,
              shotId: input.shotId,
              revisionId: revisionNow,
              width: renderedWidth,
              height: renderedHeight,
              pngDataUrl,
              pixelStats,
              depth,
              diagnostics: [agentError(
                'depth_not_grayscale',
                `Depth renderer produced non-grayscale pixels (ratio ${depth.grayscalePixelRatio.toFixed(4)}).`,
              )],
            };
          }
        }
        if (rejection) {
          return {
            ok: false,
            shotId: input.shotId,
            revisionId: revisionNow,
            width: renderedWidth,
            height: renderedHeight,
            pngDataUrl,
            pixelStats,
            depth,
            diagnostics: [
              agentError(rejection.code, rejection.message),
            ],
          };
        }

        return {
          ok: true,
          shotId: input.shotId,
          revisionId: revisionNow,
          width: renderedWidth,
          height: renderedHeight,
          ...(timeSample ? {
            requestedTimeSeconds: timeSample.requestedTimeSeconds,
            sampledTimeSeconds: timeSample.sampledTimeSeconds,
          } : {}),
          pngDataUrl,
          pixelStats,
          appearance,
          peopleVariant,
          content,
          depth,
          source,
        };
      } catch (error) {
        return {
          ok: false,
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

function blobToDataUrl(blob: Blob): Promise<string> {
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
