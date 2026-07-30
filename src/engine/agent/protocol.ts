/**
 * ForeScene Agent API protocol types (version 1).
 * Intentionally constrained read/write surface over existing project capabilities.
 */

import type {
  CameraData,
  HumanPose,
  SceneObjectType,
  StagingRole,
  Transform,
  Workspace,
} from '../../domain/types';
import type {
  ExportPackageType,
  ExportPlan,
  ExportPlanSummary,
} from '../exportPlan';
import type { AgentDiagnostic } from './diagnostics';

export const FORESCENE_AGENT_API_VERSION = 1 as const;

export type AgentControlMode = 'off' | 'read-only' | 'read-write';

export type AgentEntityKind = 'object' | 'shot' | 'landmark';

/** Stable target for existing entities or plan-local refs (mutations use refs). */
export type AgentEntityTarget =
  | { id: string }
  | { ref: string }
  | {
      query: {
        name?: string;
        type?: SceneObjectType;
        stagingRole?: StagingRole;
        match?: 'exact' | 'contains';
      };
    };

export interface AgentEntityReference {
  kind: AgentEntityKind;
  id: string;
  ref?: string;
  name: string;
}

export interface ForeSceneAgentBusyState {
  criticalWrite: boolean;
  grayboxRender: boolean;
  packageExport: boolean;
}

export interface ForeSceneAgentPersistenceStatus {
  ready: boolean;
  status: string;
  message?: string;
  lastSavedAt?: string;
  activeRevisionId?: string;
}

export interface ForeSceneAgentStatus {
  ready: boolean;
  apiVersion: typeof FORESCENE_AGENT_API_VERSION;
  controlMode: AgentControlMode;
  writeAccess: boolean;
  projectLoaded: boolean;
  projectId?: string;
  projectName?: string;
  workspace?: Workspace;
  /** Active verified revision id when persistence has one. */
  revisionId?: string;
  /** Project document `updatedAt` — useful for change detection. */
  projectUpdatedAt?: string;
  appMode?: 'studio' | 'panoViewer' | null;
  busy: ForeSceneAgentBusyState;
  persistence: ForeSceneAgentPersistenceStatus;
}

export interface ForeSceneAgentCapabilities {
  apiVersion: typeof FORESCENE_AGENT_API_VERSION;
  controlMode: AgentControlMode;
  inspection: boolean;
  mutations: boolean;
  packageExport: boolean;
  projectReplacement: boolean;
  commands: {
    inspect: string[];
    mutate: string[];
    deferred: string[];
  };
  runtime: {
    focusObjects: boolean;
    focusShot: boolean;
    captureViewport: boolean;
  };
}

export interface AgentProjectInspection {
  id: string;
  name: string;
  description: string;
  units: 'meters';
  schemaVersion: string;
  updatedAt: string;
  objectCount: number;
  shotCount: number;
  landmarkCount: number;
  panoCount: number;
  workspace: Workspace;
  selectedObjectIds: string[];
  selectedShotId?: string;
  revisionId?: string;
}

export interface AgentObjectQuery {
  name?: string;
  type?: SceneObjectType;
  stagingRole?: StagingRole;
  match?: 'exact' | 'contains';
  visible?: boolean;
  locked?: boolean;
}

export interface AgentObjectSummary {
  id: string;
  name: string;
  type: SceneObjectType;
  stagingRole?: StagingRole;
  visible: boolean;
  locked: boolean;
  position: [number, number, number];
  hasHumanPose: boolean;
  isPoseable: boolean;
}

export interface AgentObjectInspection extends AgentObjectSummary {
  transform: Transform;
  dimensions: [number, number, number];
  category: string;
  color?: string;
  modelAssetId?: string;
}

export interface AgentShotSummary {
  id: string;
  shotNumber: string;
  name: string;
  description: string;
  status: string;
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  fovDegrees: number;
  overrideObjectCount: number;
  keyframeCount: number;
  linkedPanoId?: string;
}

export interface AgentShotInspection extends AgentShotSummary {
  camera: CameraData;
  landmarkIds: string[];
  stagedObjectIds: string[];
}

export interface AgentLandmarkSummary {
  id: string;
  name: string;
  displayName: string;
  position: [number, number, number];
  linkedObjectId?: string;
  visible: boolean;
}

export interface AgentExportPlanRequest {
  /** Shot ids to plan. Defaults to the current selection, or all shots when none selected. */
  shotIds?: string[];
  packageType?: ExportPackageType;
}

export interface AgentExportPlanResult {
  ok: boolean;
  plan?: ExportPlan;
  summary?: ExportPlanSummary;
  diagnostics: AgentDiagnostic[];
}

/** Plan envelope — validated by `parseForeSceneAgentPlan`. */
export interface ForeSceneAgentPlan {
  version: 1;
  planId?: string;
  description?: string;
  /** Reserved numeric revision token (prefer expectedFingerprint). */
  expectedRevision?: number;
  /** Reject prepare/apply when the live project fingerprint no longer matches. */
  expectedFingerprint?: string;
  commands: ForeSceneAgentCommand[];
}

export type ForeSceneAgentCommand =
  | { op: 'project.updateInfo'; name?: string; description?: string }
  | {
      op: 'object.create';
      ref?: string;
      object: {
        type: SceneObjectType;
        name?: string;
        position?: [number, number, number];
        rotation?: [number, number, number];
        scale?: [number, number, number];
        dimensions?: [number, number, number];
        stagingRole?: StagingRole;
      };
    }
  | {
      op: 'object.update';
      object: AgentEntityTarget;
      updates: Record<string, unknown>;
    }
  | { op: 'object.delete'; object: AgentEntityTarget }
  | { op: 'object.duplicate'; object: AgentEntityTarget; ref?: string }
  | {
      op: 'shot.create';
      ref?: string;
      shot: {
        name?: string;
        description?: string;
        camera?: Partial<CameraData>;
      };
    }
  | {
      op: 'shot.rename';
      shot: AgentEntityTarget;
      name: string;
    }
  | {
      op: 'shot.updateDescription';
      shot: AgentEntityTarget;
      description: string;
    }
  | {
      op: 'shot.updateCamera';
      shot: AgentEntityTarget;
      camera: Partial<CameraData>;
    }
  | {
      op: 'shot.select';
      shot: AgentEntityTarget;
    }
  | {
      op: 'shot.copyStagingToNext';
      shot: AgentEntityTarget;
    }
  | {
      op: 'shot.stageObject';
      shot: AgentEntityTarget;
      object: AgentEntityTarget;
      transform?: Transform;
      visible?: boolean;
      humanPose?: HumanPose;
      posePreset?: string;
    }
  | {
      op: 'shot.clearStaging';
      shot: AgentEntityTarget;
      object?: AgentEntityTarget;
      clearPoseOnly?: boolean;
    }
  | { op: 'landmark.create'; ref?: string; landmark: Record<string, unknown> }
  | { op: 'workspace.open'; workspace: Workspace }
  | { op: 'selection.set'; objectIds?: string[]; shotId?: string | null };

export interface AgentPlanPreviewResult {
  ok: boolean;
  planId?: string;
  summary?: AgentPlanSummary;
  diff?: AgentPlanDiff;
  fingerprint?: string;
  baseProjectUpdatedAt?: string;
  warnings: AgentDiagnostic[];
  diagnostics: AgentDiagnostic[];
}

export interface AgentPlanDiff {
  objectsCreated: string[];
  objectsUpdated: string[];
  objectsDeleted: string[];
  shotsCreated: string[];
  shotsUpdated: string[];
  selectionChanged: boolean;
  workspaceChanged: boolean;
  projectInfoChanged: boolean;
}

export interface AgentPlanApplyResult {
  ok: boolean;
  planId?: string;
  verifiedRevisionId?: string;
  summary?: AgentPlanSummary;
  diagnostics: AgentDiagnostic[];
}

export interface AgentPlanSummary {
  commandCount: number;
  affectedObjectIds: string[];
  affectedShotIds: string[];
  affectedLandmarkIds: string[];
  createdRefs: Record<string, AgentEntityReference>;
  description?: string;
}

export interface AgentCaptureOptions {
  workspace?: Workspace;
  clean?: boolean;
}

export interface AgentCaptureResult {
  ok: boolean;
  mimeType?: string;
  dataUrl?: string;
  diagnostics: AgentDiagnostic[];
}

export interface ForeSceneRuntimeServices {
  focusObjects?: (ids: string[]) => Promise<void>;
  focusShot?: (shotId: string) => Promise<void>;
  captureViewport?: (options: AgentCaptureOptions) => Promise<AgentCaptureResult>;
}

export interface ForeSceneBrowserApi {
  readonly apiVersion: typeof FORESCENE_AGENT_API_VERSION;

  getStatus(): ForeSceneAgentStatus;
  getCapabilities(): ForeSceneAgentCapabilities;

  inspectProject(): AgentProjectInspection;
  listObjects(query?: AgentObjectQuery): AgentObjectSummary[];
  inspectObject(target: AgentEntityTarget): AgentObjectInspection;
  listShots(): AgentShotSummary[];
  inspectShot(target: AgentEntityTarget): AgentShotInspection;
  listLandmarks(): AgentLandmarkSummary[];
  createExportPlan(input?: AgentExportPlanRequest): AgentExportPlanResult;

  /** Enable or disable agent write access for this browser session. */
  setControlMode(mode: AgentControlMode): ForeSceneAgentStatus;

  previewPlan(plan: unknown): Promise<AgentPlanPreviewResult>;
  applyPlan(plan: unknown): Promise<AgentPlanApplyResult>;
  undoLastPlan(): Promise<AgentPlanApplyResult>;
  waitForIdle(options?: { timeoutMs?: number }): Promise<ForeSceneAgentStatus>;
}
