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
  Shot,
  SceneObjectType,
  StagingRole,
  Transform,
  ShotObjectOverrides,
  Workspace,
  HumanJointId,
  PoseableCharacterOrientation,
  ProductionEntityBinding,
  ProductionLocationDefinition,
  ShotPresenceContract,
  ShotCompositionConstraintSet,
  PoseSubstitutionApproval,
} from '../../domain/types';
import type { ProducedPackageManifestProof } from '../projectPackageInclusion';
import type {
  ExportPackageType,
  ExportPlan,
  ExportPlanSummary,
} from '../exportPlan';
import type { ExportSettingFieldPath } from '../exportConfiguration';
import type { PackageExportPhase } from '../packageExport';
import type { VideoResolutionPresetId } from '../videoPresets';
import type { SceneContentMode } from '../shotSceneState';
import type { PoseApplicationReport } from '../poseableCharacter';
import type { AgentDiagnostic } from './diagnostics';
import type { SavedRigCompatibilityAnalysis } from '../poseableCharacterImport';
import type { ImportBudgetEstimate } from '../modelImportBudget';
import type { ModelImportMode, ModelImportSummary } from '../modelImport';
import type {
  EntityCapabilityProfile,
  ProductionPoseResolution,
} from '../previs/entityCapability';
import type { ProjectionHealthMetrics } from '../previs/shotEnvironment';
import type { CompositionEntityProjection } from '../previs/compositionConstraints';
import type { ReviewSamplePlan } from '../previs/reviewSampling';
import type {
  ProductionReviewArtifactPlanResult,
  ProductionReviewFrameInput,
} from '../previs/productionReviewArtifacts';
import type {
  RenderCacheDecision,
  RenderCacheInspection,
  RenderFingerprint,
} from '../previs/renderCache';
import type {
  ProductionCanaryPlan,
  ProductionCanaryResult,
  ProductionCanaryShotResult,
  ProductionGate,
  ProductionGateState,
} from '../previs/productionGates';
import type { ApprovedLayoutRevision } from '../previs/stillLayoutApproval';
import type {
  GenerativeWorldRequestV1,
  GenerativeWorldResultV1,
  HyWorld2CameraPriorFile,
} from '../generativeWorldBoundary';

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
  | { shotNumber: string }
  | {
      query: {
        name?: string;
        type?: SceneObjectType;
        stagingRole?: StagingRole;
        match?: 'exact' | 'contains';
        shotNumber?: string;
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
  characterImport: boolean;
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
  missingAssetCount?: number;
  /** Stable per-run identity for benchmark and CLI observability. */
  provenance?: AgentRunProvenance;
}

export interface AgentCacheOperationTelemetry {
  operation: string;
  hit: boolean;
  reason: string;
  fingerprint?: string;
  artifactId?: string;
  startedAt?: string;
  durationMs?: number;
}

export interface AgentRunProvenance {
  productName: string;
  productVersion: string;
  schemaVersion?: string;
  agentApiVersion: typeof FORESCENE_AGENT_API_VERSION;
  projectId?: string;
  revisionId?: string;
  projectUpdatedAt?: string;
  /** Git SHA or other source identifier when the host provides one. */
  sourceCommit?: string;
  /** CI/build identifier when the host provides one. */
  buildId?: string;
  cli?: {
    command?: string;
    harness?: string;
    profile?: string;
    runId?: string;
  };
  timings?: {
    provenanceBuiltAt: string;
    operations?: Array<{ name: string; durationMs: number; startedAt?: string }>;
  };
  retries?: number;
  cancelled?: boolean;
  /**
   * Bounded quality-gate snapshot for the revision this run described.
   * Absent until verify / visual-preflight / asset-contract records one.
   * Never populated by automatically re-running expensive renders.
   */
  validation?: AgentRunValidationEvidence;
  artifacts?: Array<{
    artifactId: string;
    fileName?: string;
    byteLength?: number;
    /** Present only after a real content digest is computed. Never derived from the artifact id. */
    sha256?: string;
    hashStatus?: 'computed' | 'unavailable';
    revisionId?: string;
  }>;
  /**
   * Cache inventory and per-operation decisions.
   * `readyEntries` / `invalidatedEntries` are index totals, not operation hits/misses.
   */
  cache?: {
    renderEntries: number;
    readyEntries: number;
    invalidatedEntries: number;
    operations?: AgentCacheOperationTelemetry[];
  };
  jobs?: {
    videoRenderActive: boolean;
    packageExportActive: boolean;
    videoPhase?: string;
    packagePhase?: string;
    videoCompletedFrames?: number;
    videoTotalFrames?: number;
  };
}

export type AgentValidationGateStatus = 'passed' | 'warning' | 'failed' | 'skipped';

export interface AgentVisualPreflightSelection {
  selectedShotIds: string[];
  unmatchedShotIds: string[];
  requestedShotIds: string[];
  emptyProject: boolean;
  explicitSelection: boolean;
  diagnostic?: string;
}

export interface AgentVisualPreflightCollection {
  /** False when an explicit selection is invalid (unknown / unmatched ids). */
  ok: boolean;
  selection: AgentVisualPreflightSelection;
  /**
   * Present when the visual gate should be recorded.
   * Omitted when the caller asked for every shot and the project has none.
   * An empty array means the gate was requested but produced no results.
   */
  visualPreflight?: AgentVisualPreflightResult[];
}

export type AgentValidationRevisionBinding = 'current' | 'stale' | 'unbound';

export interface AgentRunValidationEvidence {
  /** Project revision the snapshot describes. Never invented. */
  revisionId?: string;
  /** Live project revision when the snapshot was recorded. */
  activeRevisionId?: string;
  /**
   * `current` — evidence revision matches the live project revision.
   * `stale` — evidence describes a different revision; not a valid current summary.
   * `unbound` — no revision was available to bind.
   */
  revisionBinding: AgentValidationRevisionBinding;
  /** True only when `revisionBinding` is `current`. */
  current: boolean;
  /** Present when the snapshot is preserved but is not current. */
  historical?: true;
  capturedAt: string;
  source?: 'verify' | 'visual-preflight' | 'asset-contract' | 'manual';
  ok: boolean;
  gates: {
    visualPreflight: AgentValidationGateStatus;
    assetPose: AgentValidationGateStatus;
    projectHealth: AgentValidationGateStatus;
    revisionBound: AgentValidationGateStatus;
  };
  visualPreflight?: {
    shotCount: number;
    passedCount: number;
    failedCount: number;
    warningCount: number;
    failedShotIds: string[];
    warningShotIds: string[];
    unresolvedVisibleObjectIds: string[];
    unresolvedVisibleCount: number;
    /** True when the visual gate was requested but produced no shot results. */
    emptySelection?: true;
    /** Requested shot ids/numbers that did not resolve. */
    unmatchedShotIds?: string[];
    diagnostic?: string;
    scores: Array<{
      shotId: string;
      score: number;
      ok: boolean;
      gateStatus: Exclude<AgentValidationGateStatus, 'skipped'>;
      environmentOnly?: boolean;
      allowUnresolvedSetDressing?: boolean;
      unresolvedVisibleObjectIds?: string[];
    }>;
  };
  assetPose?: {
    objectCount: number;
    missingAssetCount: number;
    includedCount: number;
    omittedCount: number;
    unverifiedCount: number;
  };
  projectHealth?: {
    ok: boolean;
    issueCount: number;
    dangerCount: number;
    codes: string[];
  };
}

export interface ForeSceneAgentCapabilities {
  apiVersion: typeof FORESCENE_AGENT_API_VERSION;
  controlMode: AgentControlMode;
  inspection: boolean;
  mutations: boolean;
  packageExport: boolean;
  characterImport: boolean;
  projectReplacement: boolean;
  missingAssetRecovery: boolean;
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
  missingAssetCount: number;
  missingAssets: AgentMissingAssetSummary[];
}

export interface AgentMissingAssetSummary {
  assetId: string;
  name: string;
  originalFileName?: string;
  status: 'missing' | 'corrupt' | 'unsupported';
  instanceObjectIds: string[];
  affectedShotIds: string[];
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
  assetStatus?: 'available' | 'missing' | 'corrupt' | 'unsupported';
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
  linkedPanoId?: string | null;
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
      /**
       * Solver-backed framing intent: the plan compiler solves the camera for
       * the listed subjects (same solver as the frameSubjects Agent API
       * primitive) and expands this into an equivalent shot.updateCamera
       * command, so preview/diff/apply/undo treat framing as an ordinary
       * camera plan command.
       */
      op: 'shot.frameSubjects';
      shot: AgentEntityTarget;
      subjects: AgentEntityTarget[];
      /** establishing | wide | full_body/full | medium | medium_close_up | close_up | over_the_shoulder | two_shot (default medium). */
      composition?: string;
    }
  | {
      op: 'shot.setPanorama';
      shot: AgentEntityTarget;
      pano: AgentEntityTarget | null;
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
  status?: AgentOperationStatus;
  planId?: string;
  verifiedRevisionId?: string;
  revisionId?: string;
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
  /** Refuse to export if this was not the active revision when export began. */
  expectedRevisionId?: string;
  /** Refuse to export if the verified project content changed after refresh. */
  expectedFingerprint?: string;
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
  status: AgentOperationStatus;
  artifact?: AgentArtifactHandle;
  fileName?: string;
  manifestPaths?: string[];
  shotIds?: string[];
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
  progress?: AgentPackageExportProgressSnapshot;
  warnings?: string[];
  recovery?: {
    ok: boolean;
    rematerialized: number;
    prunedHistoricalResources: number;
    issueCount: number;
  };
  /** Motion-video cache hits/misses and stage timings when available. */
  videoPerformance?: {
    cacheHits: number;
    cacheMisses: number;
    joinedJobs: number;
    bypasses: number;
    setupMs: number;
    renderMs: number;
    encodeMs: number;
    finalizeMs: number;
    totalMs: number;
  };
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

/** One inspectable still pass via the same renderers used by package export. */
export interface AgentRenderShotFrameInput {
  shotId: string;
  timeSeconds?: number;
  appearance?: 'clay' | 'projected' | 'depth';
  peopleVariant?: 'with_people' | 'clean_plate';
  content?: 'full_scene' | 'characters_only';
  width?: number;
  height?: number;
}

export interface AgentRefinementCheckpointResult {
  ok: boolean;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentRenderPixelStats {
  width: number;
  height: number;
  opaquePixelRatio: number;
  luminanceMean: number;
  luminanceVariance: number;
  sampledUniqueColorCount: number;
}

export type AgentOperationStatus =
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'stale_revision'
  | 'cancelled'
  | 'busy';

export interface AgentArtifactInline {
  kind: 'inline';
  mimeType: string;
  dataUrl: string;
  byteLength?: number;
}

export interface AgentArtifactHandle {
  artifactId: string;
  mimeType: string;
  fileName: string;
  byteLength: number;
  revisionId?: string;
  pinned?: boolean;
  pinReason?: AgentArtifactPinReason;
  /** Present only after a real SHA-256 digest is computed. */
  sha256?: string;
  hashStatus?: 'computed' | 'unavailable';
}

export type AgentArtifactPinReason =
  | 'persisted'
  | 'authoritative'
  | 'project-attached'
  | 'in-flight';

export type AgentArtifact = AgentArtifactInline | (AgentArtifactHandle & { kind?: 'handle' });

export type AgentArtifactTransferMode =
  | 'browser-blob'
  | 'chunked-base64'
  | 'uint8array-fallback';

export interface AgentArtifactDownloadResult {
  ok: boolean;
  status: AgentOperationStatus;
  artifact?: AgentArtifactHandle;
  /** Blob-native payload; callers can persist or stream it without base64 expansion. */
  blob?: Blob;
  /** Legacy compatibility only; request explicitly with includeDataUrl. */
  dataUrl?: string;
  /** Browser downloads are always an in-memory Blob; CLI transfer names its own mode. */
  transferMode?: AgentArtifactTransferMode;
  diagnostics: AgentDiagnostic[];
}

export interface AgentShotPanoramaResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId: string;
  linkedPanoId?: string | null;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProjectBackupResult {
  ok: boolean;
  status: AgentOperationStatus;
  artifact?: AgentArtifactHandle;
  fileName?: string;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
  recovery?: {
    ok: boolean;
    rematerialized: number;
    prunedHistoricalResources: number;
    issueCount: number;
  };
}

export interface AgentRevisionRefreshResult {
  ok: boolean;
  status: AgentOperationStatus;
  revisionId?: string;
  fingerprint?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentShotDiagnosticsSubject {
  objectId: string;
  /** Visible projected area as a fraction of the frame (0–1). */
  screenCoverage: number;
  /** Fraction of the subject visible in frame after cropping and occlusion (0–1). */
  visibleFraction: number;
  /** Signed distance from the subject AABB bottom to the identified floor (negative = below floor). */
  groundClearanceMeters: number;
  occlusionRatio?: number;
  behindCamera?: boolean;
  clipped?: boolean;
  humanLandmarks?: Record<string, { x: number; y: number; inFrame: boolean }>;
}

export interface AgentSubjectDisplacement {
  objectId: string;
  displacementMeters: number;
}

export interface AgentShotDiagnostics {
  shotId: string;
  revisionId?: string;
  sampledTimeSeconds?: number;
  subjects: AgentShotDiagnosticsSubject[];
  foregroundOcclusionFraction: number;
  /** True when a linked panorama resolves for the shot (not a render confirmation). */
  linkedPanoramaResolved: boolean;
  linkedPanoId?: string | null;
  /** True when projected panorama pixels are expected to be visible in a projected render. */
  projectedPanoramaVisible?: boolean;
  /** True when the camera position intersects solid geometry. */
  cameraIntersectsSolidGeometry: boolean;
  /** True when the camera is inside the navigable environment envelope, if one can be inferred. */
  cameraInsideEnvironmentBounds?: boolean;
  cameraDisplacementMeters: number;
  subjectDisplacements: AgentSubjectDisplacement[];
  /** Expected subject ids that were missing, hidden, or incomplete. */
  expectedSubjectIds?: string[];
  diagnostics: AgentDiagnostic[];
}

export type AgentVisualPreflightCheckId =
  | 'subject_visibility'
  | 'framing_coverage'
  | 'ground_contact'
  | 'camera_direction'
  | 'cropping'
  | 'motion_continuity'
  | 'action_continuity';

export interface AgentVisualPreflightCheck {
  id: AgentVisualPreflightCheckId;
  status: 'passed' | 'warning' | 'failed';
  message: string;
  measured?: Record<string, number | boolean | string | null>;
}

export interface AgentVisualPreflightSample {
  timeSeconds: number;
  ok: boolean;
  score: number;
  checks: AgentVisualPreflightCheck[];
  failedCheckIds: AgentVisualPreflightCheckId[];
  diagnostics: AgentDiagnostic[];
}

export type AgentVisualPreflightSubjectPolicy =
  | 'environment_only'
  | 'subjects_expected'
  | 'set_dressing_allowed';

export interface AgentVisualPreflightOptions {
  /** Defaults to clay. Projected validates the canonical panorama-backed render. */
  appearance?: 'clay' | 'projected';
  /** Required object IDs, applied to each selected shot. */
  subjectIds?: string[];
  /** Explicit set dressing; remains geometry and can still occlude subjects. */
  environmentObjectIds?: string[];
  /** Explicit environment-only shot; subject/coverage gates become N/A. */
  environmentOnly?: boolean;
  /** Unresolved set dressing remains a warning, never a clean pass. Also accepted on shot.metadata. */
  allowUnresolvedSetDressing?: boolean;
}

export interface AgentVisualPreflightResult {
  appearance?: 'clay' | 'projected';
  environmentObjectIds?: string[];
  /** True only when the ordinary visual gate fully passed (no failures or blocking warnings). */
  ok: boolean;
  /**
   * Aggregated gate outcome. `ok` is true only when this is `passed`.
   * Unresolved visible content on an ordinary shot is `failed` unless the
   * shot opted into non-blocking set dressing, which reports `warning`.
   */
  gateStatus?: Exclude<AgentValidationGateStatus, 'skipped'>;
  shotId: string;
  revisionId?: string;
  sampledTimeSeconds?: number;
  sampleTimesSeconds?: number[];
  samples?: AgentVisualPreflightSample[];
  score: number;
  checks: AgentVisualPreflightCheck[];
  diagnostics: AgentDiagnostic[];
  subjects: AgentShotDiagnosticsSubject[];
  requestedSubjectIds?: string[];
  missingSubjectIds?: string[];
  /**
   * True only for explicit environment-only intent (`environmentOnly` input,
   * `shot.metadata.environmentOnly`, or `shot.metadata.shotKind === 'environment'`).
   * Empty subject inference never makes an ordinary shot environment-only.
   */
  environmentOnly?: boolean;
  subjectPolicy?: AgentVisualPreflightSubjectPolicy;
  candidateSubjectIds?: string[];
  /**
   * Visible non-environment objects that were not identified or scored.
   * Empty for explicit environment-only shots. Ordinary shots report these
   * as unresolved set dressing: failure by default, warning only when
   * `allowUnresolvedSetDressing` is an explicit persisted opt-in.
   */
  unresolvedVisibleObjectIds?: string[];
  /**
   * True only when non-blocking set dressing was explicitly opted into
   * (`allowUnresolvedSetDressing` input or `shot.metadata.allowUnresolvedSetDressing`).
   */
  allowUnresolvedSetDressing?: boolean;
}

export interface AgentShotRepairSnapshot {
  shotId: string;
  capturedAt: string;
  label: string;
  score: number;
  /** Complete shot clone used for rollback of every shot-scoped field. */
  shot?: Shot;
  camera: CameraData;
  objectOverrides?: ShotObjectOverrides;
  cameraKeyframes: import('../../domain/types').CameraKeyframe[];
  linkedPanoId?: string | null;
  panoCrop?: import('../../domain/types').PanoCropSettings;
  landmarkIds?: string[];
  exportSettings?: import('../../domain/types').ShotExportSettings;
  exportOverrides?: ExportSettingsOverride;
  promptOverrides?: import('../../domain/types').PromptOverrides;
  name?: string;
  description?: string;
  productionShotId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRepairCandidateResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId: string;
  revisionId?: string;
  kept: boolean;
  currentScore: number;
  bestScore: number;
  bestLabel?: string;
  diagnostics: AgentDiagnostic[];
}

export type AgentPackageInclusion = true | false | 'not_verified';

export interface AgentAssetPoseContractObject {
  objectId: string;
  name: string;
  type: SceneObjectType;
  modelAssetId?: string;
  assetStatus?: 'available' | 'missing' | 'corrupt' | 'unsupported' | 'none';
  /**
   * `true` only after a produced package manifest lists the planned entry.
   * Available-but-unverified models are `not_verified`, never a false-positive `true`.
   */
  includedInPackage: AgentPackageInclusion;
  /** Planned backup/package path when the inclusion planner can name one. */
  packagePath?: string;
  poseable: boolean;
  requestedPosePreset?: string;
  resolvedPosePreset?: string;
  poseAliased: boolean;
  poseSource: 'base' | 'shot_override' | 'keyframe' | 'none';
}

export interface AgentAssetPoseContract {
  revisionId?: string;
  objects: AgentAssetPoseContractObject[];
  shots: Array<{
    shotId: string;
    shotNumber: string;
    linkedPanoId?: string | null;
    panoramaResolved: boolean;
    stagedObjectIds: string[];
    poseOverrides: Array<{
      objectId: string;
      requestedPosePreset?: string;
      resolvedPosePreset?: string;
    }>;
  }>;
}

export type AgentProjectPackageSource =
  | 'blank'
  | 'import'
  | 'recovery'
  | 'reset'
  | 'blueprint'
  | 'clone'
  | 'unknown';

export interface AgentLoadedProjectSource {
  projectId: string;
  revisionId?: string;
  source: AgentProjectPackageSource;
  sourceLabel?: string;
  loadedAt: string;
}

export interface AgentProjectPackageOpenInput {
  file: File;
  /** When true, snapshot the current project before replacing it. */
  preserveCurrentAsRecovery?: boolean;
}

export interface AgentProjectPackageOpenResult {
  ok: boolean;
  status: AgentOperationStatus;
  projectId?: string;
  revisionId?: string;
  projectName?: string;
  missingAssetCount?: number;
  missingAssets?: AgentMissingAssetSummary[];
  panoCount?: number;
  canonicalPanoId?: string;
  persistenceConfirmed?: boolean;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProjectPackageValidateResult {
  ok: boolean;
  projectName?: string;
  objectCount?: number;
  shotCount?: number;
  panoCount?: number;
  diagnostics: AgentDiagnostic[];
}

export interface AgentCloneProjectRevisionInput {
  revisionId: string;
  /** When true, replace the live project with the cloned revision. */
  loadAsCurrent?: boolean;
}

export interface AgentCloneProjectRevisionResult {
  ok: boolean;
  status: AgentOperationStatus;
  projectId?: string;
  revisionId?: string;
  clonedFromRevisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export type AgentPanoramaImportMode = 'canonical' | 'secondary' | 'replace';

export interface AgentPanoramaReferenceImportInput {
  file: File;
  mode?: AgentPanoramaImportMode;
  name?: string;
}

export interface AgentPanoramaReferenceResult {
  ok: boolean;
  status: AgentOperationStatus;
  panoId?: string;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentPanoramaReferenceUpdateInput {
  panoId: string;
  origin?: [number, number, number];
  rotation?: [number, number, number];
}

export interface AgentGrayboxPanoramaRenderInput {
  origin?: [number, number, number];
  width?: number;
  height?: number;
}

export interface AgentObjectGroupSummary {
  groupId: string;
  name: string;
  objectIds: string[];
  sourceImportId?: string;
  worldBounds?: { min: [number, number, number]; max: [number, number, number] };
}

export interface AgentObjectGroupInput {
  name: string;
  objectIds: string[];
  sourceImportId?: string;
}

export interface AgentObjectGroupResult {
  ok: boolean;
  status: AgentOperationStatus;
  groupId?: string;
  group?: AgentObjectGroupSummary;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentSubjectRef {
  objectId?: string;
  groupId?: string;
}

export type AgentJobType =
  | 'render-shot-batch'
  | 'render-pass-matrix'
  | 'frame-subjects-batch'
  | 'inspect-shots-diagnostics'
  | 'create-contact-sheets'
  | 'custom';

export type AgentJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled'
  | 'paused';

export interface AgentJobProgress {
  jobId: string;
  type: AgentJobType;
  status: AgentJobStatus;
  progress: number;
  completedItems: number;
  totalItems: number;
  currentItem?: string;
  message?: string;
  revisionId?: string;
  errors?: AgentDiagnostic[];
  /** Published result handles only. Late unpublished outputs from an aborted generation are omitted and deleted after drain. */
  artifactIds?: string[];
  /** Epoch ms when the job reached a terminal status (completed, failed, or cancelled). Not set while paused. */
  finishedAt?: number;
}

export interface AgentSubmitJobInput {
  type: AgentJobType;
  revisionId?: string;
  jobs?: unknown[];
  shotIds?: string[];
  passes?: string[];
  concurrency?: number;
  continueOnError?: boolean;
  timeoutMsPerItem?: number;
  retries?: number;
}

export interface AgentSubmitJobResult {
  ok: boolean;
  jobId?: string;
  status?: AgentJobStatus;
  diagnostics: AgentDiagnostic[];
}

export interface AgentDuplicateShotInput {
  shotId: string;
  insertAfter?: boolean;
}

export interface AgentDuplicateShotResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId?: string;
  sourceShotId?: string;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentReorderShotsInput {
  shotIds: string[];
}

export interface AgentShotMediaItem {
  id: string;
  assetId: string;
  kind: 'image' | 'video';
  label: string;
  source: string;
}

export interface AgentSequenceContinuityDelta {
  shotId: string;
  nextShotId?: string;
  cameraDirectionDeltaDegrees?: number;
  lensDeltaMm?: number;
  /** Focal-length field of view change between adjacent shots (degrees). */
  lensFovDeltaDegrees?: number;
  subjectSideReversal?: boolean;
  panoramaChanged?: boolean;
  stagingDelta?: number;
  diagnostics: AgentDiagnostic[];
}

export interface AgentCharacterPoseInspection {
  objectId: string;
  shotId?: string;
  timeSeconds?: number;
  pose?: HumanPose;
  presetId?: string;
  editableJointIds: HumanJointId[];
}

export interface AgentJointRotationInput {
  objectId: string;
  jointId: HumanJointId;
  rotation: [number, number, number];
  shotId?: string;
  timeSeconds?: number;
}

export interface AgentPoseMutationResult {
  ok: boolean;
  status: AgentOperationStatus;
  objectId?: string;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProjectRevisionSummary {
  id: string;
  projectId: string;
  kind: string;
  reason: string;
  createdAt: string;
  isActive: boolean;
  isPreviousKnownGood: boolean;
}

export interface AgentProjectHealthResult {
  ok: boolean;
  projectId: string;
  checkedAt: string;
  issues: Array<{ code: string; severity: string; message: string; repairable?: boolean }>;
  storage?: Record<string, unknown>;
  diagnostics: AgentDiagnostic[];
}

export interface AgentArtifactEvictionInfo {
  evictedArtifactIds: string[];
  pinnedCount: number;
  evictableCount: number;
  retainedOverBudget: boolean;
  reason?: string;
}

export interface AgentArtifactListItem {
  artifactId: string;
  mimeType: string;
  fileName: string;
  byteLength: number;
  revisionId?: string;
  createdAt: number;
  persisted?: boolean;
  pinned?: boolean;
  pinReason?: AgentArtifactPinReason;
  sha256?: string;
  hashStatus?: 'computed' | 'unavailable';
}

export interface AgentArtifactStatusResult {
  ok: boolean;
  artifact?: AgentArtifactHandle;
  persisted?: boolean;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionManifestValidateResult {
  ok: boolean;
  shotCount?: number;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionConfigurationInspection {
  ok: boolean;
  schemaVersion: 1;
  bindings: Record<string, ProductionEntityBinding>;
  locations: Record<string, ProductionLocationDefinition>;
  shotContractCount: number;
  poseSubstitutionCount: number;
  diagnostics: AgentDiagnostic[];
}

export type AgentVerifiedMutationStatus =
  | 'completed'
  | 'rolled_back'
  | 'paused'
  | 'completed_with_warnings'
  | 'failed';

export interface AgentVerifiedProxyReplacementInput {
  proxyObjectId: string;
  replacementObjectId: string;
  requestedShotIds?: string[];
  intendedShotIds?: string[];
  initializeVisibility?: boolean;
  description?: string;
}

export interface AgentVerifiedMutationRollbackResult {
  attempted: boolean;
  ok: boolean;
  checkpointRevisionId?: string;
  restoredFingerprint?: string;
  projectStateRestored: boolean;
  diagnostics: AgentDiagnostic[];
}

export interface AgentVerifiedProxyReplacementResult {
  ok: boolean;
  status: AgentVerifiedMutationStatus;
  checkpointRevisionId?: string;
  preview?: AgentPlanPreviewResult;
  apply: AgentPlanApplyResult;
  verification?: { ok: boolean; errors: string[] };
  rollback?: AgentVerifiedMutationRollbackResult;
  plan?: ForeSceneAgentPlan;
  preparedShots?: Array<{ id: string; shotNumber: string; keyframeIds: string[] }>;
  affectedShots?: Array<{ id: string; shotNumber: string; keyframeIds: string[] }>;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionConfigurationValidationResult {
  ok: boolean;
  checkedEntityIds: string[];
  checkedLocationIds: string[];
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionConfigurationMutationResult {
  ok: boolean;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentEntityCapabilityProfile extends EntityCapabilityProfile {}

export interface AgentProductionCapabilitiesValidationResult {
  ok: boolean;
  profiles: Record<string, AgentEntityCapabilityProfile>;
  checkedEntityIds: string[];
  checkedShotIds: string[];
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionPoseResolution extends ProductionPoseResolution {}

export interface AgentPoseSubstitutionMutationResult extends AgentProductionConfigurationMutationResult {
  resolution?: AgentProductionPoseResolution;
}

export interface AgentShotPresenceSample {
  timeSeconds: number;
  visibleDynamicObjectIds: string[];
  diagnostics: AgentDiagnostic[];
}

export interface AgentShotPresenceInspection {
  ok: boolean;
  shotId: string;
  contractPresent: boolean;
  expectedVisibleObjectIds: string[];
  expectedVisibleGroupIds: string[];
  dynamicObjectIds: string[];
  actualVisibleObjectIds: string[];
  samples: AgentShotPresenceSample[];
  diagnostics: AgentDiagnostic[];
}

export interface AgentShotPresenceMutationResult {
  ok: boolean;
  revisionId?: string;
  inspection?: AgentShotPresenceInspection;
  diagnostics: AgentDiagnostic[];
}

export interface AgentShotEnvironmentInspection {
  ok: boolean;
  shotId: string;
  contractPresent: boolean;
  locationId?: string;
  expectedPanoId?: string;
  actualPanoId?: string;
  requireProjection: boolean;
  minimumProjectionCoverage: number;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProjectionHealthInspection {
  ok: boolean;
  status: AgentOperationStatus;
  shotId: string;
  revisionId: string;
  sampledTimeSeconds?: number;
  metrics?: ProjectionHealthMetrics;
  diagnostics: AgentDiagnostic[];
}

export interface AgentShotCompositionInspection {
  ok: boolean;
  shotId: string;
  contractPresent: boolean;
  totalWeightedError: number;
  entities: Record<string, CompositionEntityProjection>;
  diagnostics: AgentDiagnostic[];
}

export interface AgentShotCompositionMutationResult {
  ok: boolean;
  status?: AgentOperationStatus;
  revisionId?: string;
  changed?: boolean;
  iterations?: number;
  before?: AgentShotCompositionInspection;
  after?: AgentShotCompositionInspection;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionCanaryPlanResult {
  ok: boolean;
  runId?: string;
  plan?: ProductionCanaryPlan;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionCanaryRunResult {
  ok: boolean;
  runId?: string;
  result?: ProductionCanaryResult;
  gateState?: ProductionGateState;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionCanaryApprovalResult {
  ok: boolean;
  runId: string;
  gateState?: ProductionGateState;
  diagnostics: AgentDiagnostic[];
}

export interface AgentStillLayoutApprovalResult {
  ok: boolean;
  status?: AgentOperationStatus;
  runId: string;
  revisionId?: string;
  approvedLayoutRevision?: ApprovedLayoutRevision;
  gateState?: ProductionGateState;
  diagnostics: AgentDiagnostic[];
}

export interface AgentMotionWorkingRevisionResult {
  ok: boolean;
  status?: AgentOperationStatus;
  runId: string;
  sourceRevisionId?: string;
  workingRevisionId?: string;
  workingProjectId?: string;
  approvedLayoutRevision?: ApprovedLayoutRevision;
  gateState?: ProductionGateState;
  diagnostics: AgentDiagnostic[];
}

export type AgentProductionRunStatus = 'queued' | 'running' | 'paused' | 'needs_review' | 'completed' | 'failed' | 'cancelled';

export interface AgentProductionRunState {
  runId: string;
  gateRunId: string;
  status: AgentProductionRunStatus;
  currentGate: ProductionGate;
  manifest: unknown;
  manifestHash?: string;
  projectId?: string;
  sourceProjectFingerprint?: string;
  recoveryRevisionId?: string;
  runGeneration?: number;
  gateState: ProductionGateState;
  completedShotIds: string[];
  artifactIds: string[];
  cacheKeys: Record<string, string>;
  blockingDiagnostics: AgentDiagnostic[];
  overrideApprovals: string[];
  startedAt: string;
  updatedAt: string;
}

export interface AgentProductionRunResult {
  ok: boolean;
  status: AgentProductionRunStatus;
  runId: string;
  state?: AgentProductionRunState;
  diagnostics: AgentDiagnostic[];
}

export interface AgentProductionCompilePreviewResult {
  ok: boolean;
  planCount?: number;
  commandCount?: number;
  diagnostics: AgentDiagnostic[];
}

export interface AgentSetBlueprintApplyInput {
  blueprint: unknown;
  preserveCurrentAsRecovery?: boolean;
}

export interface AgentProjectSettingsPatch {
  defaultShotWidth?: number;
  defaultShotHeight?: number;
  defaultShotFovDegrees?: number;
  defaultCameraLensMm?: number;
  defaultCameraHeightMeters?: number;
  panoGoodMatchMeters?: number;
  panoModerateMatchMeters?: number;
  panoLetterboxExports169?: boolean;
}

export interface AgentSnapObjectToFloorInput {
  shotId?: string;
  shot?: AgentEntityTarget;
  object: AgentEntityTarget;
}

export interface AgentSnapObjectToFloorResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId?: string;
  objectId?: string;
  position?: [number, number, number];
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentPlaceObjectNearLandmarkInput {
  shotId?: string;
  shot?: AgentEntityTarget;
  object: AgentEntityTarget;
  landmark: AgentEntityTarget;
  offset?: [number, number, number];
}

export interface AgentPlaceObjectNearLandmarkResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId?: string;
  objectId?: string;
  landmarkId?: string;
  position?: [number, number, number];
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export type AgentOrientTowardTarget =
  | AgentEntityTarget
  | { position: [number, number, number] }
  | [number, number, number];

export interface AgentOrientObjectTowardInput {
  shotId?: string;
  shot?: AgentEntityTarget;
  object: AgentEntityTarget;
  target: AgentOrientTowardTarget;
}

export interface AgentOrientObjectTowardResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId?: string;
  objectId?: string;
  targetId?: string;
  rotation?: [number, number, number];
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentFrameSubjectsInput {
  shotId: string;
  subjectIds: string[];
  composition?: string;
  shotSize?: string;
  padding?: number;
}

export interface AgentFrameSubjectsResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId?: string;
  camera?: CameraData;
  measuredCoverage?: number;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentTrackSubjectsInput {
  shotId: string;
  subjectIds: string[];
  startTime?: number;
  endTime?: number;
  composition?: string;
  shotSize?: string;
  padding?: number;
}

export interface AgentTrackSubjectsResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId?: string;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
  cameraDisplacementMeters?: number;
  subjectDisplacements?: AgentSubjectDisplacement[];
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentCaptureKeyframeResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId?: string;
  keyframeId?: string;
  timeSeconds?: number;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentUpsertObjectKeyframeInput {
  shotId: string;
  objectId: string;
  timeSeconds: number;
  preserveExplicitState?: boolean;
  transform?: Transform;
  visible?: boolean;
  humanPose?: HumanPose;
  posePreset?: string;
}

export interface AgentUpsertObjectKeyframeResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId?: string;
  objectId?: string;
  keyframeId?: string;
  timeSeconds?: number;
  revisionId?: string;
  diagnostics: AgentDiagnostic[];
}

export interface AgentOperationDescription {
  name: string;
  category: 'inspect' | 'mutation' | 'runtime';
  summary: string;
  writeAccess: boolean;
  input?: Record<string, string>;
  returns: string;
}

export interface AgentSchemaDocument {
  apiVersion: typeof FORESCENE_AGENT_API_VERSION;
  plan: Record<string, unknown>;
  results: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
}

export interface AgentRenderShotFrameResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId: string;
  revisionId: string;
  width: number;
  height: number;
  artifact?: AgentArtifactInline;
  /** Pinned download handle for the same bytes as `artifact` / `pngDataUrl`. */
  handle?: AgentArtifactHandle;
  pngDataUrl?: string;
  pixelStats?: AgentRenderPixelStats;
  requestedTimeSeconds?: number;
  sampledTimeSeconds?: number;
  appearance?: AgentRenderShotFrameInput['appearance'];
  peopleVariant?: AgentRenderShotFrameInput['peopleVariant'];
  content?: AgentRenderShotFrameInput['content'];
  poseApplications?: PoseApplicationReport[];
  depth?: {
    encoding: 'linear-camera-depth';
    nearMeters: number;
    farMeters: number;
    invert: boolean;
    grayscalePixelRatio: number;
  };
  diagnostics: AgentDiagnostic[];
  /** Marks the shared renderer used to produce this exact pass. */
  source?:
    | 'canonical_clay_renderer'
    | 'canonical_projected_renderer'
    | 'canonical_depth_renderer'
    | 'canonical_character_renderer';
}

/** Capture-time still materialization result (agent/API await-all path). */
export interface AgentShotMaterializationArtifact {
  key: string;
  status: 'current' | 'rendered' | 'failed' | 'skipped';
  assetId?: string;
}

export interface AgentShotMaterializationResult {
  ok: boolean;
  shotId: string;
  revisionId: string;
  /** GOAL capture status — never 'ready' when primary failed. */
  status: 'ready' | 'ready-with-warnings' | 'failed';
  primaryStillAssetId?: string;
  artifacts: AgentShotMaterializationArtifact[];
  warnings: string[];
  width: number;
  height: number;
  pngDataUrl?: string;
  diagnostics: AgentDiagnostic[];
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
  status: AgentOperationStatus;
  shotId?: string;
  assetId?: string;
  artifact?: AgentArtifactHandle;
  fileName?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  frameRate?: number;
  mimeType?: string;
  encodeMode?: 'render' | 'quickPreview';
  revisionId?: string;
  cacheStatus?: 'hit' | 'miss' | 'joined' | 'bypass';
  timing?: {
    setupMs: number;
    renderMs: number;
    encodeMs: number;
    finalizeMs: number;
    totalMs: number;
  };
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
  /** Full device-aware estimate used to decide whether an explicit import consent is needed. */
  importBudget: ImportBudgetEstimate;
  consent: AgentCharacterImportConsent;
  warnings: string[];
}

/** Explicit authorization state for a potentially heavy character import. */
export interface AgentCharacterImportConsent {
  required: boolean;
  provided: boolean;
  authorized: boolean;
}

/** Read-only saved-rig preflight enriched with stable source/package fingerprints. */
export interface AgentSavedRigCharacterAnalysis extends SavedRigCompatibilityAnalysis {
  glbFingerprint: string;
  rigPackageFingerprint: string;
  /** SHA-256 over the exact GLB and rig-package fingerprints. */
  importFingerprint: string;
  importBudget?: ImportBudgetEstimate;
  consent: AgentCharacterImportConsent;
}

export interface AgentCharacterImportResult {
  ok: boolean;
  objectId?: string;
  objectRef?: AgentEntityReference;
  sourceAssetId?: string;
  rigAssetId?: string;
  poseable?: boolean;
  importedRigPreserved?: boolean;
  appliedSavedRig?: boolean;
  topologyVerified?: boolean;
  /** SHA-256 of the exact GLB bytes for saved-rig imports. */
  glbFingerprint?: string;
  /** SHA-256 of the exact .fsrig/.panorig bytes for saved-rig imports. */
  rigPackageFingerprint?: string;
  /** Combined GLB + rig-package fingerprint used for duplicate protection. */
  importFingerprint?: string;
  importBudget?: ImportBudgetEstimate;
  consent?: AgentCharacterImportConsent;
  /** True when an exact saved-rig pair was already imported into this project. */
  reused?: boolean;
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

export interface AgentSavedRigCharacterInput {
  sourceFile: File;
  rigPackageFile: File;
  approximateHeightMeters?: number;
}

export interface AgentSavedRigCharacterImportInput extends AgentSavedRigCharacterInput {
  consentToken?: string;
  name: string;
}

/** Generic geometry import, shared with the manual Import 3D scene dialog. */
export interface AgentModelImportInput {
  file: File;
  mode?: ModelImportMode;
  /** Required for heavy imports; the CLI supplies this only with explicit consent. */
  consentToken?: string;
  /** Must be the literal `IMPORT` for extreme imports. */
  extremeConfirmation?: string;
}

export interface AgentModelImportResult {
  ok: boolean;
  objectRefs?: AgentEntityReference[];
  summary?: ModelImportSummary;
  importBudget?: ImportBudgetEstimate;
  requiresConsent?: boolean;
  verifiedRevisionId?: string;
  reused?: boolean;
  warnings: string[];
  diagnostics?: AgentDiagnostic[];
}

export interface AgentGenerativeWorldPreviewResult {
  ok: boolean;
  request?: GenerativeWorldRequestV1;
  hyWorld2CameraPrior?: HyWorld2CameraPriorFile;
  diagnostics: AgentDiagnostic[];
}

export interface AgentGenerativeWorldMockResult {
  ok: boolean;
  request?: GenerativeWorldRequestV1;
  result?: GenerativeWorldResultV1;
  diagnostics: AgentDiagnostic[];
}

export interface AgentGenerativeWorldDepthResult {
  ok: boolean;
  status: AgentOperationStatus;
  shotId: string;
  requestedTimeSeconds?: number;
  sampledTimeSeconds?: number;
  revisionId: string;
  width: number;
  height: number;
  encoding?: 'npy-float32-linear-camera-z';
  invalidDepthValue?: 0;
  nearMeters?: number;
  farMeters?: number;
  artifact?: AgentArtifactHandle;
  diagnostics: AgentDiagnostic[];
}

export interface ForeSceneBrowserApi {
  readonly apiVersion: typeof FORESCENE_AGENT_API_VERSION;

  getStatus(): ForeSceneAgentStatus;
  getCapabilities(): ForeSceneAgentCapabilities;
  describeCapabilities(): {
    apiVersion: typeof FORESCENE_AGENT_API_VERSION;
    controlMode: AgentControlMode;
    capabilities: ForeSceneAgentCapabilities;
    operations: string[];
    commands: {
      inspect: string[];
      mutate: string[];
      deferred: string[];
    };
    renderResultContract: Record<string, unknown>;
    revisionContract: Record<string, unknown>;
  };
  describeOperation(operation: string): AgentOperationDescription | undefined;
  getAgentSchema(): AgentSchemaDocument;

  previewGenerativeWorldRequest(input?: {
    shotIds?: string[];
    desiredRepresentations?: Array<'mesh' | '3dgs'>;
  }): AgentGenerativeWorldPreviewResult;
  runMockGenerativeWorldBackend(input?: {
    shotIds?: string[];
    desiredRepresentations?: Array<'mesh' | '3dgs'>;
  }): AgentGenerativeWorldMockResult;
  renderGenerativeWorldDepthPrior(input: {
    shotId: string;
    timeSeconds?: number;
    width?: number;
    height?: number;
  }): Promise<AgentGenerativeWorldDepthResult>;

  inspectProject(): AgentProjectInspection;
  listMissingAssets(): AgentMissingAssetSummary[];
  relinkAsset(input: { assetId: string; file: File; mode?: 'locate' | 'replace' }): Promise<{ ok: boolean; assetId?: string; diagnostics: AgentDiagnostic[] }>;
  removeMissingAsset(assetId: string): Promise<{ ok: boolean; diagnostics: AgentDiagnostic[] }>;
  /**
   * Read-only structuredClone of the live LocationProject (for offline validation /
   * autonomous previs). Does not expose write handles.
   */
  getProjectDocument(): LocationProject;
  /** Full structuredClone for a single shot, including staging and keyframes. */
  getShotDocument(target: AgentEntityTarget): Shot;
  listObjects(query?: AgentObjectQuery): AgentObjectSummary[];
  inspectObject(target: AgentEntityTarget): AgentObjectInspection;
  listShots(): AgentShotSummary[];
  inspectShot(target: AgentEntityTarget): AgentShotInspection;
  /** Desired vs materialized still readiness for a shot (read-only). */
  inspectShotPreparedMedia(target: AgentEntityTarget): Promise<import('../stillArtifactRuntime').ShotStillRuntimeStatus>;
  inspectShotTimeline(target: AgentEntityTarget): AgentShotTimelineInspection;
  sampleShotAtTime(input: {
    shot?: AgentEntityTarget;
    shotId?: string;
    shotNumber?: string;
    timeSeconds: number;
  }): AgentShotTimeSample;
  sampleShotState(input: { shotId: string; timeSeconds: number }): AgentShotTimeSample;
  inspectShotDiagnostics(input: {
    shotId?: string;
    shot?: AgentEntityTarget;
    timeSeconds?: number;
    subjectIds?: string[];
  }): AgentShotDiagnostics;
  inspectShotVisualPreflight(input: AgentVisualPreflightOptions & {
    shotId?: string;
    shot?: AgentEntityTarget;
    timeSeconds?: number;
  }): AgentVisualPreflightResult;
  /**
   * Select shots, run visual preflight, and report unmatched ids.
   * Does not record provenance. An explicit selection with unknown ids fails
   * and returns `visualPreflight: []`. An empty project with no requested
   * ids omits `visualPreflight` so the visual gate can be skipped.
   */
  collectVisualPreflightValidation(input?: AgentVisualPreflightOptions & {
    shotIds?: string[];
  }): AgentVisualPreflightCollection;
  /**
   * Bind this browser session to a CLI/API invocation. A new `runId` resets
   * retry/cancel/validation telemetry so later status reads cannot inherit
   * another run's counters.
   */
  beginRunSession(input?: {
    command?: string;
    harness?: string;
    profile?: string;
    runId?: string;
    sourceCommit?: string;
    buildId?: string;
  }): ForeSceneAgentStatus;
  /**
   * Attach already-computed quality gates to provenance. Does not render or
   * re-run visual preflight / health / validators.
   */
  recordRunValidation(input: {
    source?: AgentRunValidationEvidence['source'];
    revisionId?: string;
    visualPreflight?: AgentVisualPreflightResult[];
    /** Requested shot ids that did not resolve. Forces a failed visual gate. */
    unmatchedVisualShotIds?: string[];
    assetPose?: AgentAssetPoseContract;
    projectHealth?: AgentProjectHealthResult;
  }): AgentRunValidationEvidence;
  inspectAssetPoseContract(input?: {
    shotId?: string;
    shot?: AgentEntityTarget;
    /** Untrusted path strings. Never prove ZIP inclusion by themselves. */
    packageManifestPaths?: string[];
    /** Proof from `extractProducedPackageManifest` on real ZIP bytes (Blob/ArrayBuffer/Uint8Array). */
    producedPackageManifest?: ProducedPackageManifestProof;
  }): AgentAssetPoseContract;
  beginShotRepairSession(input: { shotId?: string; shot?: AgentEntityTarget; label?: string }): AgentRepairCandidateResult;
  evaluateShotRepairCandidate(input: {
    shotId?: string;
    shot?: AgentEntityTarget;
    label?: string;
    timeSeconds?: number;
    subjectIds?: string[];
    restoreIfWorse?: boolean;
    accepted?: boolean;
    keepWhenAccepted?: boolean;
  }): AgentRepairCandidateResult;
  commitBestShotRepairCandidate(input: { shotId?: string; shot?: AgentEntityTarget }): Promise<AgentRepairCandidateResult>;
  listLandmarks(): AgentLandmarkSummary[];
  createExportPlan(input?: AgentExportPlanRequest): AgentExportPlanResult;

  /**
   * Demote agent write access (`read-write` → `read-only`, or to `off`).
   * Escalation to read-write is UI / CLI-bootstrap only — this never grants writes.
   */
  disableWrites(): ForeSceneAgentStatus;

  setShotPanorama(input: {
    shotId?: string;
    shot?: AgentEntityTarget;
    panoId: string | null;
  }): Promise<AgentShotPanoramaResult>;
  refreshRevision(): Promise<AgentRevisionRefreshResult>;
  downloadArtifact(input: { artifactId: string; download?: boolean; includeDataUrl?: boolean }): Promise<AgentArtifactDownloadResult>;
  exportProjectBackup(input?: { download?: boolean }): Promise<AgentProjectBackupResult>;

  snapObjectToFloor(input: AgentSnapObjectToFloorInput): Promise<AgentSnapObjectToFloorResult>;
  placeObjectNearLandmark(input: AgentPlaceObjectNearLandmarkInput): Promise<AgentPlaceObjectNearLandmarkResult>;
  frameSubjects(input: AgentFrameSubjectsInput): Promise<AgentFrameSubjectsResult>;
  orientObjectToward(input: AgentOrientObjectTowardInput): Promise<AgentOrientObjectTowardResult>;
  trackSubjects(input: AgentTrackSubjectsInput): Promise<AgentTrackSubjectsResult>;
  captureShotStateAsKeyframe(input: { shotId: string; timeSeconds: number }): Promise<AgentCaptureKeyframeResult>;
  upsertObjectKeyframe(input: AgentUpsertObjectKeyframeInput): Promise<AgentUpsertObjectKeyframeResult>;

  previewPlan(plan: unknown): Promise<AgentPlanPreviewResult>;
  applyPlan(plan: unknown, options?: { expectedRevisionId?: string }): Promise<AgentPlanApplyResult>;
  applyVerifiedProxyReplacement(input: AgentVerifiedProxyReplacementInput): Promise<AgentVerifiedProxyReplacementResult>;
  undoLastPlan(): Promise<AgentPlanApplyResult>;
  listPlanHistory(): AgentPlanHistoryEntry[];
  /** Create a verified local recovery point before a resumable refinement batch. */
  createRefinementCheckpoint(input: { reason: string }): Promise<AgentRefinementCheckpointResult>;
  /** Restore only a verified revision of the currently loaded project. */
  restoreRefinementCheckpoint(input: { projectId: string; revisionId: string }): Promise<AgentRefinementCheckpointResult>;
  waitForIdle(options?: { timeoutMs?: number }): Promise<ForeSceneAgentStatus>;

  /**
   * Wait until the Shots (or requested) workspace viewport is visually ready.
   * Prefer stable application state over DOM-text selectors.
   */
  waitForViewportReady(
    options?: AgentWaitForViewportReadyInput,
  ): Promise<AgentWaitForViewportReadyResult>;

  /** Render an inspectable still pass using the same paths as package export (not a UI screenshot). */
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

  importModel(input: AgentModelImportInput): Promise<AgentModelImportResult>;

  analyzeCharacterImport(input: AgentCharacterImportInput): Promise<AgentCharacterImportAnalysis>;
  importCharacter(input: AgentCharacterImportCommitInput): Promise<AgentCharacterImportResult>;
  analyzeSavedRigCharacter(input: AgentSavedRigCharacterInput): Promise<AgentSavedRigCharacterAnalysis>;
  importSavedRigCharacter(input: AgentSavedRigCharacterImportInput): Promise<AgentCharacterImportResult>;
  getCharacterImportProgress(): AgentCharacterImportProgress | null;
  cancelCharacterImport(): { ok: boolean; cancelled: boolean };
  discardCharacterImportAnalysis(analysisId: string): { ok: boolean; discarded: boolean };

  // Project package open/import
  openProjectPackage(input: AgentProjectPackageOpenInput): Promise<AgentProjectPackageOpenResult>;
  validateProjectPackage(input: { file: File }): Promise<AgentProjectPackageValidateResult>;
  cloneProjectRevision(input: AgentCloneProjectRevisionInput): Promise<AgentCloneProjectRevisionResult>;
  getLoadedProjectSource(): AgentLoadedProjectSource;

  // Panorama / reference lifecycle
  importPanoramaReference(input: AgentPanoramaReferenceImportInput): Promise<AgentPanoramaReferenceResult>;
  updatePanoramaReference(input: AgentPanoramaReferenceUpdateInput): Promise<AgentPanoramaReferenceResult>;
  renderGrayboxPanorama(input?: AgentGrayboxPanoramaRenderInput): Promise<AgentPanoramaReferenceResult>;
  approvePanoramaReference(input: { panoId: string }): Promise<AgentPanoramaReferenceResult>;
  acceptReferenceAlignment(input: { panoId: string }): Promise<AgentPanoramaReferenceResult>;
  removePanoramaReference(input: { panoId: string }): Promise<AgentPanoramaReferenceResult>;
  setPanoramaCaptureOrigin(input: { position: [number, number, number] }): Promise<AgentPanoramaReferenceResult>;
  inspectPanoramaProjection(input: { panoId: string; camera?: CameraData }): Promise<AgentPanoramaReferenceResult & { projection?: Record<string, unknown> }>;

  // Set blueprint and project settings
  validateSetBlueprint(input: { blueprint: unknown }): Promise<{ ok: boolean; objectCount?: number; diagnostics: AgentDiagnostic[] }>;
  applySetBlueprint(input: AgentSetBlueprintApplyInput): Promise<AgentProjectPackageOpenResult>;
  patchProjectSettings(input: AgentProjectSettingsPatch): Promise<{ ok: boolean; revisionId?: string; diagnostics: AgentDiagnostic[] }>;

  // Logical object groups
  createObjectGroup(input: AgentObjectGroupInput): Promise<AgentObjectGroupResult>;
  inspectObjectGroup(input: { groupId: string }): AgentObjectGroupSummary | undefined;
  listObjectGroups(): AgentObjectGroupSummary[];
  stageObjectGroup(input: { shotId: string; groupId: string; transform?: Transform; visible?: boolean }): Promise<AgentObjectGroupResult>;
  diagnoseObjectGroup(input: { shotId: string; groupId: string }): AgentShotDiagnostics;

  // Async job API
  submitJob(input: AgentSubmitJobInput): Promise<AgentSubmitJobResult>;
  getJob(jobId: string): AgentJobProgress | undefined;
  cancelJob(jobId: string): AgentSubmitJobResult;
  resumeJob(jobId: string): Promise<AgentSubmitJobResult>;
  subscribeToJobProgress(jobId: string, listener: (progress: AgentJobProgress) => void): () => void;

  // Shot library and sequence review
  duplicateShot(input: AgentDuplicateShotInput): Promise<AgentDuplicateShotResult>;
  reorderShots(input: AgentReorderShotsInput): Promise<{ ok: boolean; revisionId?: string; diagnostics: AgentDiagnostic[] }>;
  captureShotThumbnail(input: { shotId: string; timeSeconds?: number }): Promise<AgentShotMaterializationResult>;
  /** Await the configured prepared-media set; unlike captureShotThumbnail this does not sample a legacy thumbnail frame. */
  captureShotPreparedMedia(input: { shotId: string }): Promise<AgentShotMaterializationResult>;
  /** Regenerate configured stills for a shot (manual refresh). */
  regenerateShotStills(input: { shotId: string }): Promise<AgentShotMaterializationResult>;
  /** Retry failed/missing/stale stills only. */
  retryFailedShotStills(input: { shotId: string }): Promise<AgentShotMaterializationResult>;
  /** Cancel queued/in-flight still preparation for a shot (or all when shotId omitted). */
  cancelShotStillPreparation(input?: { shotId?: string }): { ok: boolean; cancelledShotIds: string[] };
  /** Cancel queued or active coordinator-backed render work, optionally scoped to one shot. */
  cancelRenderWork(input?: { shotId?: string }): { ok: boolean; cancelledCount: number };
  listShotMedia(input: { shotId: string }): AgentShotMediaItem[];
  compareAdjacentShots(input: { shotId: string }): AgentSequenceContinuityDelta;
  inspectSequenceContinuity(input: { shotIds: string[] }): AgentSequenceContinuityDelta[];
  renderStoryboard(input: { shotIds: string[] }): Promise<AgentRenderShotFrameResult>;
  renderAnimaticPreview(input: { shotIds: string[] }): Promise<AgentShotVideoRenderResult>;

  // Semantic character posing
  inspectCharacterPose(input: { objectId: string; shotId?: string; timeSeconds?: number }): AgentCharacterPoseInspection;
  setJointRotation(input: AgentJointRotationInput): Promise<AgentPoseMutationResult>;
  applyPosePreset(input: { objectId: string; presetId: string; shotId?: string; timeSeconds?: number }): Promise<AgentPoseMutationResult>;
  mirrorPose(input: { objectId: string; shotId?: string; timeSeconds?: number }): Promise<AgentPoseMutationResult>;
  resetJointPose(input: { objectId: string; jointId?: HumanJointId; shotId?: string; timeSeconds?: number }): Promise<AgentPoseMutationResult>;
  copyPoseBetweenShots(input: { objectId: string; fromShotId: string; toShotId: string; timeSeconds?: number }): Promise<AgentPoseMutationResult>;
  exportRigPackage(input: { objectId: string }): Promise<AgentArtifactDownloadResult>;

  // Project safety and recovery
  listProjectRevisions(): Promise<AgentProjectRevisionSummary[]>;
  inspectProjectHealth(): Promise<AgentProjectHealthResult>;
  inspectBrowserStorage(): Promise<Record<string, unknown>>;
  restoreProjectRevision(input: { revisionId: string }): Promise<AgentRefinementCheckpointResult>;
  compareProjectRevisions(input: { revisionIdA: string; revisionIdB: string }): Promise<{ ok: boolean; changedFields?: string[]; diagnostics: AgentDiagnostic[] }>;
  cleanupUnreferencedAssets(): Promise<{ ok: boolean; removedCount?: number; diagnostics: AgentDiagnostic[] }>;
  repairProjectIntegrity(): Promise<{ ok: boolean; repairedCount?: number; revisionId?: string; diagnostics: AgentDiagnostic[] }>;

  // Artifact registry extensions
  listArtifacts(input?: { jobId?: string; revisionId?: string; shotId?: string }): AgentArtifactListItem[];
  persistArtifact(input: { artifactId: string }): Promise<AgentArtifactStatusResult>;
  deleteArtifact(input: { artifactId: string }): Promise<{ ok: boolean }>;
  getArtifactStatus(input: { artifactId: string }): AgentArtifactStatusResult;

  // Production manifest compiler
  validateProductionManifest(input: { manifest: unknown }): AgentProductionManifestValidateResult;
  bindManifestAssets(input: {
    manifest: unknown;
    bindings: Record<string, string>;
    groupBindings?: Record<string, string>;
  }): Promise<AgentProductionManifestValidateResult>;
  inspectProductionConfiguration(): AgentProductionConfigurationInspection;
  validateProductionConfiguration(input: { manifest: unknown }): AgentProductionConfigurationValidationResult;
  bindProductionEntity(input: { entityId: string; binding: ProductionEntityBinding }): Promise<AgentProductionConfigurationMutationResult>;
  defineProductionLocation(input: { location: ProductionLocationDefinition }): Promise<AgentProductionConfigurationMutationResult>;
  removeProductionBinding(input: { entityId: string }): Promise<AgentProductionConfigurationMutationResult>;
  inspectEntityCapability(input: { entityId: string }): AgentEntityCapabilityProfile;
  validateProductionCapabilities(input: { manifest?: unknown }): AgentProductionCapabilitiesValidationResult;
  resolveProductionPose(input: { entityId: string; requestedPose: string; shotId?: string }): AgentProductionPoseResolution;
  approvePoseSubstitution(input: { approval: PoseSubstitutionApproval }): Promise<AgentPoseSubstitutionMutationResult>;
  setShotPresenceContract(input: { shotId: string; contract: ShotPresenceContract }): Promise<AgentShotPresenceMutationResult>;
  inspectShotPresence(input: { shotId: string }): AgentShotPresenceInspection;
  verifyShotPresence(input: { shotId: string }): AgentShotPresenceInspection;
  repairShotPresence(input: { shotId: string }): Promise<AgentShotPresenceMutationResult>;
  inspectShotEnvironmentContract(input: { shotId: string }): AgentShotEnvironmentInspection;
  verifyShotPanorama(input: { shotId: string }): AgentShotEnvironmentInspection;
  inspectProjectionHealth(input: { shotId: string; timeSeconds?: number; minimumCoverage?: number; requireProjection?: boolean }): Promise<AgentProjectionHealthInspection>;
  setShotCompositionConstraints(input: { shotId: string; contract: ShotCompositionConstraintSet }): Promise<AgentShotCompositionMutationResult>;
  inspectShotCompositionError(input: { shotId: string }): AgentShotCompositionInspection;
  solveShotToCompositionConstraints(input: { shotId: string; maxIterations?: number }): Promise<AgentShotCompositionMutationResult>;
  verifyShotCompositionConstraints(input: { shotId: string }): AgentShotCompositionInspection;
  planProductionCanary(input: { manifest: unknown; maxShots?: number }): Promise<AgentProductionCanaryPlanResult>;
  runProductionCanary(input: { runId: string }): Promise<AgentProductionCanaryRunResult>;
  approveProductionCanary(input: { runId: string; overrideReason?: string }): AgentProductionCanaryApprovalResult;
  runProduction(input: { manifest: unknown; maxCanaryShots?: number }): Promise<AgentProductionRunResult>;
  getProductionRun(runId: string): AgentProductionRunState | undefined;
  listProductionRuns(): AgentProductionRunState[];
  pauseProductionRun(runId: string): AgentProductionRunResult;
  resumeProductionRun(runId: string): Promise<AgentProductionRunResult>;
  cancelProductionRun(runId: string): AgentProductionRunResult;
  subscribeProductionRun(runId: string, listener: (state: AgentProductionRunState) => void): () => void;
  approveStillLayout(input: { runId: string; approvedShotIds: string[]; reviewArtifactIds?: string[]; reviewRecord?: string }): Promise<AgentStillLayoutApprovalResult>;
  createMotionWorkingRevision(input: { runId: string }): Promise<AgentMotionWorkingRevisionResult>;
  inspectStillLayoutApproval(input: { runId?: string }): { ok: boolean; runId?: string; approvedLayoutRevision?: ApprovedLayoutRevision; gateState?: ProductionGateState; diagnostics: AgentDiagnostic[] };
  planReviewSamples(input: { shotId: string; strategy?: 'event-aware' | 'single'; maxSamples?: number }): ReviewSamplePlan;
  planProductionReviewArtifacts(input: { frames: ProductionReviewFrameInput[]; continuityStripSize?: number }): ProductionReviewArtifactPlanResult;
  inspectRenderCache(input?: { projectId?: string }): RenderCacheInspection;
  explainRenderCacheHit(input: { projectId?: string; fingerprint: RenderFingerprint }): RenderCacheDecision;
  explainRenderCacheMiss(input: { projectId?: string; fingerprint: RenderFingerprint }): RenderCacheDecision;
  invalidateRenderDependencies(input: { projectId?: string; dependencyIds: string[] }): RenderCacheInspection;
  clearRenderCache(input?: { projectId?: string }): RenderCacheInspection;
  inspectProductionGates(input: { runId?: string }): { ok: boolean; runId?: string; gateState?: ProductionGateState; diagnostics: AgentDiagnostic[] };
  previewProductionCompile(input: { manifest: unknown }): AgentProductionCompilePreviewResult;
  applyProductionCompile(input: { manifest: unknown; preserveCurrentAsRecovery?: boolean }): Promise<AgentPlanApplyResult>;
  inspectProductionStatus(): { manifestBound: boolean; shotCount: number; diagnostics: AgentDiagnostic[] };

  // Project-wide batch APIs
  inspectShotsDiagnostics(input: { shots: Array<{ shotId: string; timeSeconds?: number; subjectIds?: string[] }> }): AgentShotDiagnostics[];
  frameSubjectsBatch(input: { shots: Array<AgentFrameSubjectsInput>; concurrency?: number }): Promise<AgentFrameSubjectsResult[]>;
  renderShotBatch(input: { jobs: Array<AgentRenderShotFrameInput>; concurrency?: number }): Promise<AgentRenderShotFrameResult[]>;
  renderPassMatrix(input: { shotIds: string[]; passes: string[]; concurrency?: number }): Promise<AgentSubmitJobResult>;
  createContactSheets(input: { artifactIds: string[]; grouping?: string }): Promise<AgentSubmitJobResult>;
}
