/**
 * Browser-facing ForeScene Agent API (`window.foreScene`).
 * Read-only inspection in this milestone; mutations reject without write access.
 */

import type { LocationProject, Shot, Workspace } from '../../domain/types';
import { createExportPlan } from '../exportPlan';
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
import { resetAgentProject } from './projectReset';
import {
  AGENT_DIAGNOSTIC_CODES,
  agentError,
} from './diagnostics';
import {
  inspectObjectSnapshot,
  inspectProjectSnapshot,
  inspectShotSnapshot,
  listLandmarksSnapshot,
  listObjectsSnapshot,
  listShotsSnapshot,
  resolveExistingObjectTarget,
  resolveExistingShotTarget,
  type AgentInspectionContext,
} from './inspection';
import type {
  AgentEntityTarget,
  AgentExportPlanRequest,
  AgentExportPlanResult,
  AgentObjectInspection,
  AgentObjectQuery,
  AgentPackageExportRequest,
  AgentPackageExportResult,
  AgentPlanApplyResult,
  AgentPlanHistoryEntry,
  AgentPlanPreviewResult,
  AgentProjectInspection,
  AgentResetProjectRequest,
  AgentShotInspection,
  ForeSceneAgentStatus,
  ForeSceneBrowserApi,
} from './protocol';
import { FORESCENE_AGENT_API_VERSION } from './protocol';

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

function isBusy(status: ForeSceneAgentStatus): boolean {
  return (
    status.busy.criticalWrite
    || status.busy.grayboxRender
    || status.busy.packageExport
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
  };

  return api;
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
