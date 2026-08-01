/**
 * ForeScene Agent API protocol types (version 1).
 * Intentionally constrained read/write surface over existing project capabilities.
 */

import type {
  CameraData,
  CameraKeyframeEasing,
  ExportSettingsOverride,
  HumanPose,
  LocationProject,
  SceneObjectType,
  StagingRole,
  Transform,
  ShotObjectOverrides,
  Workspace,
  HumanJointId,
  PoseableCharacterOrientation,
} from '../../domain/types';
import type {
  ExportPackageType,
  ExportPlan,
  ExportPlanSummary,
} from '../exportPlan';
import type { ExportSettingFieldPath } from '../exportConfiguration';
import type { PackageExportPhase } from '../packageExport';
import type { VideoResolutionPresetId } from '../videoPresets';
import type { SceneContentMode } from '../shotSceneState';
import type { AgentDiagnostic } from './diagnostics';

export const FORESCENE_AGENT_API_VERSION = 1 as const;

export type AgentControlMode = 'off' | 'read-only' | 'read-write';

export type AgentEntityKind = 'object' | 'shot' | 'landmark' | 'keyframe';

export type AgentKeyframeTarget = { id: string } | { ref: string };

export interface AgentTimelineObjectInput {
  object: AgentEntityTarget;
  transform?: Transform;
  visible?: boolean;
  humanPose?: HumanPose;
  posePreset?: string;
}

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
  videoRender: boolean;
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
  timelineInspection: boolean;
  timelineSampling: boolean;
  commands: {
    inspect: string[];
    mutate: string[];
    deferred: string[];
  };
  runtime: {
    focusObjects: boolean;
    focusShot: boolean;
    captureViewport: boolean;
    renderShotFrame?: boolean;
    waitForViewportReady?: boolean;
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

export interface AgentKeyframeInspection {
  id: string;
  label: string;
  timeSeconds: number;
  easing?: CameraKeyframeEasing;
  camera: CameraData;
  objectOverrides: ShotObjectOverrides;
  stagedObjectIds: string[];
}

export interface AgentShotTimelineInspection {
  shotId: string;
  durationSeconds: number;
  renderable: boolean;
  hasManualTiming: boolean;
  keyframes: AgentKeyframeInspection[];
}

export interface AgentShotTimeSample {
  shotId: string;
  requestedTimeSeconds: number;
  sampledTimeSeconds: number;
  durationSeconds: number;
  camera: CameraData;
  objectOverrides: ShotObjectOverrides;
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
        /** Exact production shot number from a previs manifest (preserved verbatim). */
        shotNumber?: string;
        productionShotId?: string;
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
  | {
      op: 'shot.delete';
      shot: AgentEntityTarget;
    }
  | {
      op: 'shot.timeline.replace';
      shot: AgentEntityTarget;
      durationSeconds?: number;
      keyframes: Array<{
        ref?: string;
        label?: string;
        timeSeconds: number;
        camera: Partial<CameraData>;
        easing?: CameraKeyframeEasing;
        objects?: AgentTimelineObjectInput[];
      }>;
    }
  | { op: 'shot.timeline.clear'; shot: AgentEntityTarget }
  | { op: 'shot.timeline.setDuration'; shot: AgentEntityTarget; durationSeconds: number }
  | {
      op: 'shot.keyframe.create';
      shot: AgentEntityTarget;
      ref?: string;
      timeSeconds: number;
      camera: Partial<CameraData>;
      label?: string;
      easing?: CameraKeyframeEasing;
      objects?: AgentTimelineObjectInput[];
      snapshotShotStaging?: boolean;
    }
  | {
      op: 'shot.keyframe.update';
      shot: AgentEntityTarget;
      keyframe: AgentKeyframeTarget;
      timeSeconds?: number;
      label?: string;
      camera?: Partial<CameraData>;
      easing?: CameraKeyframeEasing;
      objects?: AgentTimelineObjectInput[];
    }
  | { op: 'shot.keyframe.delete'; shot: AgentEntityTarget; keyframe: AgentKeyframeTarget }
  | {
      op: 'shot.keyframe.stageObject';
      shot: AgentEntityTarget;
      keyframe: AgentKeyframeTarget;
      object: AgentEntityTarget;
      transform?: Transform;
      visible?: boolean;
      humanPose?: HumanPose;
      posePreset?: string;
    }
  | {
      op: 'shot.keyframe.clearStaging';
      shot: AgentEntityTarget;
      keyframe: AgentKeyframeTarget;
      object?: AgentEntityTarget;
    }
  | {
      op: 'landmark.create';
      ref?: string;
      landmark: {
        name?: string;
        displayName?: string;
        position?: [number, number, number];
        description?: string;
        linkedObjectId?: string;
        visible?: boolean;
        promptCritical?: boolean;
        tags?: string[];
      };
    }
  | {
      op: 'landmark.update';
      landmark: AgentEntityTarget;
      updates: {
        name?: string;
        displayName?: string;
        position?: [number, number, number];
        description?: string;
        linkedObjectId?: string | null;
        visible?: boolean;
        promptCritical?: boolean;
        tags?: string[];
      };
    }
  | { op: 'landmark.delete'; landmark: AgentEntityTarget }
  | {
      op: 'landmark.linkObject';
      landmark: AgentEntityTarget;
      /** Pass null to unlink. */
      object: AgentEntityTarget | null;
    }
  | {
      op: 'export.sceneDefaults.patch';
      patch: ExportSettingsOverride;
    }
  | {
      op: 'export.shotOverrides.patch';
      shot: AgentEntityTarget;
      patch: ExportSettingsOverride;
    }
  | {
      op: 'export.shotOverrides.reset';
      shot: AgentEntityTarget;
      /** Omit to clear every override on the shot. */
      field?: ExportSettingFieldPath;
    }
  | {
      op: 'export.shotOverrides.copy';
      fromShot: AgentEntityTarget;
      toShots: AgentEntityTarget[];
    }
  | {
      op: 'export.shotOverrides.promote';
      shot: AgentEntityTarget;
    }
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
  shotsDeleted: string[];
  landmarksCreated: string[];
  landmarksUpdated: string[];
  landmarksDeleted: string[];
  selectionChanged: boolean;
  workspaceChanged: boolean;
  projectInfoChanged: boolean;
  exportConfigurationChanged: boolean;
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

export interface AgentPackageExportRequest {
  /** Shot ids to package. Defaults to every shot (Export workspace default). */
  shotIds?: string[];
  packageType?: ExportPackageType;
  /**
   * When true (default), download the ZIP and mark shots exported.
   * When false, build only — no download and no shot status / workflow updates.
   */
  download?: boolean;
}

export interface AgentPackageExportProgressSnapshot {
  phase: PackageExportPhase | 'idle' | 'failed' | 'cancelled';
  progress: number;
  currentShot: number;
  totalShots: number;
  shotId?: string;
  shotName?: string;
  message: string;
  indeterminate?: boolean;
  error?: string;
}

export interface AgentPackageExportResult {
  ok: boolean;
  fileName?: string;
  manifestPaths?: string[];
  shotIds?: string[];
  diagnostics: AgentDiagnostic[];
  progress?: AgentPackageExportProgressSnapshot;
}

export interface AgentPlanHistoryEntry {
  planId: string;
  description?: string;
}

export interface ForeSceneRuntimeServices {
  focusObjects?: (ids: string[]) => Promise<void>;
  focusShot?: (shotId: string) => Promise<void>;
  captureViewport?: (options: AgentCaptureOptions) => Promise<AgentCaptureResult>;
}

export interface AgentResetProjectRequest {
  name: string;
  description?: string;
  aspectRatio?: string;
  frameRate?: number;
  expectedProjectId?: string;
  /**
   * Must be the literal `"reset-project"`. The CLI sets this only when
   * `--reset-project` is passed together with `--write`.
   */
  resetAuthorization?: string;
}

/** Clean clay first-frame render via the shared package-export renderer. */
export interface AgentRenderShotFrameInput {
  shotId: string;
  timeSeconds?: number;
  pass?: 'clay';
  width?: number;
  height?: number;
}

export interface AgentRenderPixelStats {
  width: number;
  height: number;
  opaquePixelRatio: number;
  luminanceMean: number;
  luminanceVariance: number;
  sampledUniqueColorCount: number;
}

export interface AgentRenderShotFrameResult {
  ok: boolean;
  shotId: string;
  revisionId: string;
  width: number;
  height: number;
  pngDataUrl?: string;
  pixelStats?: AgentRenderPixelStats;
  requestedTimeSeconds?: number;
  sampledTimeSeconds?: number;
  diagnostics?: AgentDiagnostic[];
  /** Marks frames produced by the canonical clean clay renderer. */
  source?: 'canonical_clay_renderer';
}

export interface AgentShotVideoRenderInput {
  shotId: string;
  mode?: 'render' | 'quickPreview';
  resolutionPreset?: VideoResolutionPresetId;
  appearance?: 'clay' | 'projected' | 'depth';
  contentMode?: SceneContentMode;
  backgroundColor?: string;
  includeCharacterAttachments?: boolean;
  download?: boolean;
  attachToShot?: boolean;
}

export type AgentShotVideoRenderPhase =
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'saving'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface AgentShotVideoProgress {
  phase: AgentShotVideoRenderPhase;
  progress: number;
  completedFrames?: number;
  totalFrames?: number;
  shotId: string;
  message: string;
  error?: string;
}

export interface AgentShotVideoRenderResult {
  ok: boolean;
  shotId?: string;
  assetId?: string;
  fileName?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  frameRate?: number;
  mimeType?: string;
  encodeMode?: 'render' | 'quickPreview';
  diagnostics: AgentDiagnostic[];
  progress?: AgentShotVideoProgress;
}

export interface AgentWaitForViewportReadyInput {
  workspace?: Workspace;
  shotId?: string;
  timeoutMs?: number;
}

export interface AgentWaitForViewportReadyResult {
  ok: boolean;
  workspace?: Workspace;
  shotId?: string;
  revisionId?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  sceneRenderGeneration?: number;
  diagnostics?: AgentDiagnostic[];
}

export type AgentCharacterImportMode = 'auto' | 'preserveExistingRig' | 'autorig';

export interface AgentCharacterImportAnalysis {
  analysisId: string;
  sourceFormat: 'glb' | 'gltf' | 'fbx';
  hasSkeleton: boolean;
  hasSkinning: boolean;
  detectedProfile?: 'mixamo' | 'maya-humanik' | 'generic';
  mappingConfidence?: number;
  requiredMapped: HumanJointId[];
  requiredMissing: HumanJointId[];
  ambiguousMappings: unknown[];
  skinnedMeshCount: number;
  boneCount: number;
  animationClips: Array<{ name: string; durationSeconds: number }>;
  estimatedMemoryBytes: number;
  requiresConsent: boolean;
  warnings: string[];
}

export interface AgentCharacterImportResult {
  ok: boolean;
  objectId?: string;
  objectRef?: AgentEntityReference;
  sourceAssetId?: string;
  rigAssetId?: string;
  poseable?: boolean;
  importedRigPreserved?: boolean;
  verifiedRevisionId?: string;
  warnings: string[];
  diagnostics?: AgentDiagnostic[];
}

export type AgentCharacterImportPhase =
  | 'reading'
  | 'parsing'
  | 'analyzing'
  | 'mapping'
  | 'validating'
  | 'writing'
  | 'registering'
  | 'saving'
  | 'complete';

export interface AgentCharacterImportProgress {
  active: boolean;
  phase?: AgentCharacterImportPhase;
  analysisId?: string;
  message?: string;
}

export interface AgentCharacterImportInput {
  file: File;
  mode?: AgentCharacterImportMode;
  orientation?: PoseableCharacterOrientation;
  approximateHeightMeters?: number;
}

export interface AgentCharacterImportCommitInput {
  analysisId: string;
  mode: Exclude<AgentCharacterImportMode, 'auto'>;
  mappingOverrides?: Partial<Record<HumanJointId, string>>;
  consentToken?: string;
  name?: string;
}

export interface ForeSceneBrowserApi {
  readonly apiVersion: typeof FORESCENE_AGENT_API_VERSION;

  getStatus(): ForeSceneAgentStatus;
  getCapabilities(): ForeSceneAgentCapabilities;

  inspectProject(): AgentProjectInspection;
  /**
   * Read-only structuredClone of the live LocationProject (for offline validation /
   * autonomous previs). Does not expose write handles.
   */
  getProjectDocument(): LocationProject;
  listObjects(query?: AgentObjectQuery): AgentObjectSummary[];
  inspectObject(target: AgentEntityTarget): AgentObjectInspection;
  listShots(): AgentShotSummary[];
  inspectShot(target: AgentEntityTarget): AgentShotInspection;
  inspectShotTimeline(target: AgentEntityTarget): AgentShotTimelineInspection;
  sampleShotAtTime(input: { shot: AgentEntityTarget; timeSeconds: number }): AgentShotTimeSample;
  listLandmarks(): AgentLandmarkSummary[];
  createExportPlan(input?: AgentExportPlanRequest): AgentExportPlanResult;

  /**
   * Demote agent write access (`read-write` → `read-only`, or to `off`).
   * Escalation to read-write is UI / CLI-bootstrap only — this never grants writes.
   */
  disableWrites(): ForeSceneAgentStatus;

  previewPlan(plan: unknown): Promise<AgentPlanPreviewResult>;
  applyPlan(plan: unknown): Promise<AgentPlanApplyResult>;
  undoLastPlan(): Promise<AgentPlanApplyResult>;
  listPlanHistory(): AgentPlanHistoryEntry[];
  waitForIdle(options?: { timeoutMs?: number }): Promise<ForeSceneAgentStatus>;

  /**
   * Wait until the Shots (or requested) workspace viewport is visually ready.
   * Prefer stable application state over DOM-text selectors.
   */
  waitForViewportReady(
    options?: AgentWaitForViewportReadyInput,
  ): Promise<AgentWaitForViewportReadyResult>;

  /**
   * Render a clean clay first frame for a shot using the same path as
   * package `inputs/viewport_clay.png` (not a UI screenshot).
   */
  renderShotFrame(input: AgentRenderShotFrameInput): Promise<AgentRenderShotFrameResult>;
  renderShotVideo(input: AgentShotVideoRenderInput): Promise<AgentShotVideoRenderResult>;
  getShotVideoRenderProgress(): AgentShotVideoProgress | null;
  cancelShotVideoRender(): AgentShotVideoRenderResult;

  /**
   * Replace the live project with a blank graybox shell.
   * Requires read-write mode and explicit `resetAuthorization: "reset-project"`.
   * Creates a recovery snapshot and preserves Agent transaction rollback guarantees.
   */
  resetProject(input: AgentResetProjectRequest): Promise<AgentPlanApplyResult & { projectId?: string }>;

  /** Package selected shots (same engine path as Export workspace). Requires write access. */
  exportPackage(input?: AgentPackageExportRequest): Promise<AgentPackageExportResult>;
  getPackageExportProgress(): AgentPackageExportProgressSnapshot | null;
  cancelPackageExport(): AgentPackageExportResult;

  analyzeCharacterImport(input: AgentCharacterImportInput): Promise<AgentCharacterImportAnalysis>;
  importCharacter(input: AgentCharacterImportCommitInput): Promise<AgentCharacterImportResult>;
  getCharacterImportProgress(): AgentCharacterImportProgress | null;
  cancelCharacterImport(): { ok: boolean; cancelled: boolean };
}
