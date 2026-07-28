export type Vec3 = [number, number, number];
export type Euler = [number, number, number];
/** Supported project schema versions (load migrates older → current). */
export type ProjectVersion = '0.1' | '0.2' | '1.0';

export type SceneObjectType =
  | 'floor'
  | 'wall'
  | 'box'
  | 'arch'
  | 'doorway'
  | 'column'
  | 'stairs'
  | 'tree_blob'
  | 'terrain_mass'
  | 'background_card'
  | 'human_dummy'
  | 'sun_marker'
  | 'imported_model';

export type ImportedModelSourceApplication = 'blender' | 'maya' | 'unreal';

export type ImportedModelImportMode = 'separate' | 'combined';

export interface ImportedModelInfo {
  sourceName: string;
  sourceFormat: string;
  sourceKind: 'model' | 'scene';
  sourceApplication?: ImportedModelSourceApplication;
  sourceSceneName?: string;
  vertexCount: number;
  triangleCount: number;
  /** Per-object mesh count: 1 in separate mode, total in combined mode. */
  meshCount: number;
  /** Number of GPU instances aggregated when source node was an InstancedMesh. */
  instanceCount?: number;
  importMode: ImportedModelImportMode;
  /** Shared across all objects produced from one source file import. */
  sourceImportId: string;
  /** Original mesh node name, trimmed, if available. */
  sourceNodeName?: string;
  /** Deterministic path like "Environment[0]/Furniture[3]/Chair[2]". */
  sourceNodePath?: string;
  /** Imported triangles are preserved exactly; only hierarchy/material data is flattened. */
  geometrySimplified: false;
  hierarchyFlattened: true;
  warnings?: string[];
}

export type PanoReferenceType =
  | 'graybox_render'
  | 'ai_global_reference'
  | 'external_reference';

export type ShotStatus =
  | 'planned'
  | 'exported'
  | 'needs_fix'
  | 'approved'
  | 'rejected';

export type Workspace = 'build' | 'reference' | 'shots' | 'export';

export interface Transform {
  position: Vec3;
  rotation: Euler;
  scale: Vec3;
}

export type StagingRole = 'set' | 'prop' | 'person';

export type QuaternionTuple = [number, number, number, number];

/**
 * Stable semantic joints for poseable humanoids.
 * Persisted poses use these IDs — never GLB-specific bone names.
 */
export type HumanJointId =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'leftHand'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'leftLowerLeg'
  | 'leftFoot'
  | 'rightUpperLeg'
  | 'rightLowerLeg'
  | 'rightFoot';

export interface HumanJointPose {
  /** Local rotation relative to the character rest/bind pose. */
  rotation: QuaternionTuple;
  /** Optional hips/root positional adjustment in character-local meters. */
  position?: Vec3;
}

export interface HumanPose {
  version: 1;
  joints: Partial<Record<HumanJointId, HumanJointPose>>;
  presetId?: string;
}

/**
 * Where a poseable character came from.
 * Autorigged imports will use `{ kind: 'autorigged', assetId, rigId }` later.
 */
export type PoseableCharacterSource =
  | {
      kind: 'builtin';
      characterId: 'adult-male' | 'adult-female';
    }
  | {
      kind: 'autorigged';
      assetId: string;
      rigId: string;
    };

/**
 * Marker used by Milestone B marker-assisted autorigging.
 * Stored with the generated rig so regenerate/reset can restore placements.
 */
export interface AutorigMarker {
  id: string;
  jointId: HumanJointId;
  /** Character-local position in meters. */
  position: Vec3;
}

/**
 * Serializable poseable-character rig asset (Milestone B fills skin/mesh fields).
 * The project format anticipates autorigged characters beyond static imported geometry.
 */
export interface PoseableRigAsset {
  version: 1;
  id: string;
  /** Optional mesh asset holding positions/indices (or embedded below). */
  meshAssetId?: string;
  /** Semantic joint hierarchy + soft limits (never GLB bone names). */
  skeletonJoints: HumanJointId[];
  /** Bind matrices keyed by semantic joint id (column-major 16 floats). */
  bindMatrices?: Partial<Record<HumanJointId, number[]>>;
  /** Approximate skinning produced by autorig; omitted for builtin characters. */
  skin?: {
    influencesPerVertex: number;
    /** Flattened vertex → joint index table. */
    indices: number[];
    /** Flattened weights matching `indices`. */
    weights: number[];
  };
  markers?: AutorigMarker[];
  /** Bump when weight/fitting algorithms change so assets can be regenerated. */
  rigGenerationVersion?: number;
  /** Optional original unrigged source mesh for regenerate/reset. */
  sourceMeshAssetId?: string;
}

export interface ShotObjectOverride {
  transform?: Transform;
  visible?: boolean;
  /** Skeletal pose override; only applies to poseable characters. */
  humanPose?: HumanPose;
}

export type ShotObjectOverrides = Record<string, ShotObjectOverride>;

/** Visual surface for graybox objects. Checkerboard tiles are 1m × 1m in world space. */
export type ObjectSurfaceStyle = 'default' | 'solid' | 'checkerboard';

export interface SceneObject {
  id: string;
  name: string;
  type: SceneObjectType;
  transform: Transform;
  dimensions: Vec3;
  category: 'architecture' | 'environment' | 'helper' | 'landmark';
  locked: boolean;
  visible: boolean;
  /** Staging classification for clean-plate people export; any unlocked object may still be staged per shot. */
  stagingRole?: StagingRole;
  /** @deprecated Prefer surfaceStyle + color. Kept for older project files. */
  materialId?: string;
  /** default = category clay; solid / checkerboard for identity and scale. */
  surfaceStyle?: ObjectSurfaceStyle;
  /** Primary hex color (#rrggbb) for solid and checkerboard light squares. */
  color?: string;
  /** Secondary hex for checkerboard dark squares. */
  secondaryColor?: string;
  /** Canonical texture-free mesh asset used by imported graybox geometry. */
  modelAssetId?: string;
  importedModel?: ImportedModelInfo;
  /**
   * Poseable-character identity. Distinct from `transform` (set placement)
   * and `humanPose` (limb articulation).
   */
  poseableCharacter?: PoseableCharacterSource;
  /** Skeletal articulation; only has effect when the object is poseable. */
  humanPose?: HumanPose;
  metadata?: Record<string, unknown>;
}

export interface SceneData {
  worldUp: 'Y';
  objects: SceneObject[];
  panoOrigin: Vec3;
  panoRotation: Euler;
}

export interface PanoReference {
  id: string;
  name: string;
  imageAssetId: string;
  type: PanoReferenceType;
  projection: 'equirectangular';
  origin: Vec3;
  rotation: Euler;
  width: number;
  height: number;
  isCanonical: boolean;
  sourcePanoId?: string;
  notes?: string;
  createdAt: string;
}

export interface Landmark {
  id: string;
  name: string;
  displayName: string;
  position: Vec3;
  linkedObjectId?: string;
  description: string;
  tags: string[];
  promptCritical: boolean;
  visible: boolean;
}

export interface CameraData {
  position: Vec3;
  target: Vec3;
  fovDegrees: number;
  aspectRatio: number;
  near: number;
  far: number;
}

export type CameraKeyframeEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface CameraKeyframe {
  id: string;
  label: string;
  timeSeconds: number;
  camera: CameraData;
  /** Easing applied from this keyframe to the next one. */
  easing?: CameraKeyframeEasing;
  /**
   * Optional staged-object snapshot captured with this keyframe.
   * Used to animate props/people between start and end during camera-move video export.
   */
  objectOverrides?: ShotObjectOverrides;
  /**
   * Content-addressed project asset id for filmstrip / camera-roll stills.
   * Preferred over legacy `previewUri` data URLs (stripped from JSON on save).
   */
  previewAssetId?: string;
  /** Local binary storage key when the preview lives in the project asset store. */
  previewStorageKey?: string;
  /**
   * Runtime-only or legacy still URI (blob URL / ephemeral data URL).
   * Not written into recovery revisions when `previewAssetId` is set.
   */
  previewUri?: string;
}

export interface PanoCropSettings {
  panoId: string;
  yawDegrees: number;
  pitchDegrees: number;
  rollDegrees: number;
  fovDegrees: number;
  aspectRatio: number;
  width: number;
  height: number;
}

export type PeopleExportMode = 'with_people' | 'clean_plate' | 'both';

/** Linear camera-space depth reference for stills, keyframes, and camera-move video. */
export interface ShotDepthSettings {
  enabled: boolean;
  includeViewportStill: boolean;
  includeReferenceFrames: boolean;
  includeCameraMoveVideo: boolean;

  rangeMode: 'auto' | 'manual';
  nearMeters?: number;
  farMeters?: number;

  /** Default: nearest surfaces are white. */
  invert?: boolean;
}

export interface ShotExportSettings {
  width: number;
  height: number;
  /** Whether shot renders include staged people, a clean plate, or both. */
  peopleExportMode?: PeopleExportMode;
  includeViewport: boolean;
  /** Optional projected-style still matching the clay viewport camera. */
  includeProjectedViewport?: boolean;
  /** Optional projected clay-style keyframe stills along the camera move. */
  includeProjectedCameraMoveReferenceFrames?: boolean;
  /** Optional projected-style camera-move MP4 alongside clay motion. */
  includeProjectedCameraMoveVideo?: boolean;
  includeAiResultFrame: boolean;
  includePanoCrop: boolean;
  includeFullPano: boolean;
  includeGrayboxPano: boolean;
  includeCameraMoveVideo: boolean;
  includeCameraMoveReferenceFrames: boolean;
  includeMetadata: boolean;
  includePrompt: boolean;
  /** Nested depth-reference export + preview settings. */
  depth?: ShotDepthSettings;
}

/** Multi-origin selection after per-projector occlusion and quality scoring. */
export type ProjectorBlendMode =
  | 'primary_only'
  | 'secondary_only'
  | 'primary_dominant'
  | 'secondary_dominant';

/** Project-level projector configuration (no GPU resources). */
export interface ProjectedStyleSettings {
  /** Primary pano reference id; omit to auto-pick canonical styled pano. */
  panoId?: string;
  /** Optional second pano reference id for dual-origin projection. */
  secondaryPanoId?: string;
  /** Dominance mode when two projectors are active. */
  blendMode?: ProjectorBlendMode;

  opacity: number;
  exposure: number;
  lightingContribution: number;
  fallbackMode: 'clay' | 'neutral';

  /** Use live geometry-derived visibility maps when available. */
  occlusionEnabled?: boolean;

  /** Extra radial tolerance preventing self-shadow acne. */
  occlusionBiasMeters?: number;

  /** Angular filtering radius, in approximate cubemap texels. */
  occlusionSoftness?: number;

  /**
   * Occlusion cubemap filtering for projected materials.
   * `soft` = five samples (viewport quality); `fast` = one center sample (export).
   */
  occlusionFilterMode?: 'soft' | 'fast';

  /** Optional diagnostic appearance. */
  occlusionDebugMode?: 'off' | 'coverage';
}

export interface PromptOverrides {
  imagePrompt?: string;
  videoPrompt?: string;
  negativePrompt?: string;
  notes?: string;
}

export interface ShotAssetRefs {
  /** Clay still with people (primary camera-roll capture). */
  viewportRenderAssetId?: string;
  /** Clay still with people hidden (clean plate). */
  viewportCleanPlateAssetId?: string;
  /** Projected still with people. */
  viewportProjectedAssetId?: string;
  /** Projected still with people hidden (clean plate). */
  viewportProjectedCleanPlateAssetId?: string;
  panoCropAssetId?: string;
  finalBaseFrameAssetId?: string;
  aiResultFrameAssetId?: string;
  cameraMoveVideoAssetId?: string;
}

export interface Shot {
  id: string;
  shotNumber: string;
  /** Optional production identifier such as 42A, SC_120, or B017. */
  productionShotId?: string;
  name: string;
  description: string;
  camera: CameraData;
  cameraKeyframes: CameraKeyframe[];
  /** Sparse transform/visibility differences from the global Build scene. */
  objectOverrides?: ShotObjectOverrides;
  linkedPanoId?: string;
  panoCrop?: PanoCropSettings;
  landmarkIds: string[];
  exportSettings: ShotExportSettings;
  promptOverrides: PromptOverrides;
  status: ShotStatus;
  assets: ShotAssetRefs;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAsset {
  id: string;
  type: 'image' | 'video' | 'model' | 'json' | 'text' | 'other' | 'poseable_rig';
  name: string;
  /** Runtime URL (data:, blob:, or a portable panoref-asset: reference). */
  uri: string;
  /** IndexedDB key for local-first image/video payloads; portable packages include this binary separately. */
  storageKey?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  createdAt: string;
  /**
   * For `poseable_rig` assets, prefer embedding {@link PoseableRigAsset} here
   * (or as JSON behind `uri`) so autorig results round-trip with the project.
   */
  metadata?: Record<string, unknown> & {
    poseableRig?: PoseableRigAsset;
  };
}

export interface AssetRegistry {
  assets: Record<string, ProjectAsset>;
}

export interface ProjectWorkflow {
  grayboxApprovedForReferenceAt?: string;
  referenceAlignmentAcceptedForPanoId?: string;
  shotFramingAcceptedAtByShotId: Record<string, string>;
  aiBriefSentAtByShotId: Record<string, string>;
  finalPackageExportedAtByShotId: Record<string, string>;
}

export interface ProjectSettings {
  defaultShotWidth: number;
  defaultShotHeight: number;
  defaultShotFovDegrees: number;
  defaultCameraLensMm?: number;
  defaultCameraHeightMeters?: number;
  panoGoodMatchMeters: number;
  panoModerateMatchMeters: number;
  panoLetterboxExports169: boolean;
  /** Optional projected-style appearance configuration. */
  projectedStyle?: ProjectedStyleSettings;
}

export interface LocationProject {
  schemaVersion: ProjectVersion;
  /**
   * Semver product release that last wrote this project (distinct from schemaVersion).
   * Present on schema ≥1.0; optional on older files after migration.
   */
  productVersion?: string;
  id: string;
  name: string;
  description: string;
  units: 'meters';
  createdAt: string;
  updatedAt: string;
  scene: SceneData;
  panoRefs: PanoReference[];
  landmarks: Landmark[];
  shots: Shot[];
  assets: AssetRegistry;
  settings: ProjectSettings;
  workflow: ProjectWorkflow;
}

export interface PanoViewState {
  yawDegrees: number;
  pitchDegrees: number;
  fovDegrees: number;
}

export interface WarningItem {
  id: string;
  severity: 'info' | 'warning' | 'danger';
  message: string;
}
