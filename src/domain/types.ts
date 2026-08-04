export type Vec3 = [number, number, number];
export type Euler = [number, number, number];
export type Vec2 = [number, number];

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

/** Normalized screen-space rectangle: all values are expressed in [0, 1]. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Supported project schema versions (load migrates older → current). */
export type ProjectVersion = '0.1' | '0.2' | '1.0' | '1.1' | '1.2';

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
  | 'upperSpine'
  | 'neck'
  | 'head'
  | 'leftClavicle'
  | 'leftUpperArm'
  | 'leftUpperArmTwist'
  | 'leftLowerArm'
  | 'leftLowerArmTwist'
  | 'leftHand'
  | 'leftHandEnd'
  | 'rightClavicle'
  | 'rightUpperArm'
  | 'rightUpperArmTwist'
  | 'rightLowerArm'
  | 'rightLowerArmTwist'
  | 'rightHand'
  | 'rightHandEnd'
  | 'leftUpperLeg'
  | 'leftUpperLegTwist'
  | 'leftLowerLeg'
  | 'leftLowerLegTwist'
  | 'leftFoot'
  | 'leftToeBase'
  | 'rightUpperLeg'
  | 'rightUpperLegTwist'
  | 'rightLowerLeg'
  | 'rightLowerLegTwist'
  | 'rightFoot'
  | 'rightToeBase';

export type ProductionObjectClass =
  | 'static_environment'
  | 'dynamic_subject'
  | 'dynamic_prop'
  | 'conditional_set_piece'
  | 'helper'
  | 'unclassified';

export type ProductionEntityBinding =
  | {
      kind: 'object';
      objectId: string;
    }
  | {
      kind: 'group';
      groupId: string;
    }
  | {
      kind: 'location';
      locationId: string;
    }
  | {
      kind: 'panorama';
      panoId: string;
    };

export interface ProductionLocationAnchor {
  position: Vec3;
  rotation?: Vec3;
  tags?: string[];
}

export interface ProductionLocationZone {
  id: string;
  bounds: Bounds3;
  tags?: string[];
}

export interface ProductionLocationDefinition {
  id: string;
  objectIds: string[];
  objectGroupIds: string[];
  anchors: Record<string, ProductionLocationAnchor>;
  blockerObjectIds: string[];
  cameraZones?: ProductionLocationZone[];
  subjectZones?: ProductionLocationZone[];
  panoIds?: string[];
  defaultPanoId?: string;
  cameraRecipeIds?: string[];
}

export interface ShotPresenceContract {
  expectedVisibleObjectIds: string[];
  expectedVisibleGroupIds: string[];
  /** Defaults to false when omitted by a caller. */
  allowUnspecifiedDynamicObjects: boolean;
}

export interface ShotEnvironmentContract {
  locationId: string;
  expectedPanoId?: string;
  requireProjection?: boolean;
  minimumProjectionCoverage?: number;
}

export interface CompositionConstraintWeights {
  subjectPosition?: number;
  subjectScale?: number;
  headPoint?: number;
  facePoint?: number;
  propPosition?: number;
  horizon?: number;
  floorLine?: number;
  crop?: number;
  occlusion?: number;
  cameraCollision?: number;
}

export interface ShotCompositionSubjectConstraint {
  entityId: string;
  expectedBounds?: NormalizedRect;
  headPoint?: Vec2;
  facePoint?: Vec2;
  screenRegion?: 'left' | 'center' | 'right';
  expectedCoverage?: [number, number];
  expectedVisibility?: number;
}

export interface ShotCompositionPropConstraint {
  entityId: string;
  expectedBounds?: NormalizedRect;
  expectedScreenPoint?: Vec2;
}

export interface ShotCompositionOcclusionIntent {
  foregroundEntityId: string;
  backgroundEntityId: string;
  targetFraction?: [number, number];
}

export interface ShotCompositionConstraintSet {
  referenceImageAssetId?: string;
  subjects: ShotCompositionSubjectConstraint[];
  props?: ShotCompositionPropConstraint[];
  horizonY?: number;
  floorLineY?: number;
  cropTolerance?: number;
  occlusionIntent?: ShotCompositionOcclusionIntent[];
  weights?: CompositionConstraintWeights;
}

export interface EntityCapabilityRequirement {
  entityId: string;
  requires: {
    renderable?: boolean;
    rigidAssembly?: boolean;
    poseable?: boolean;
    deforming?: boolean;
    timelinePoseable?: boolean;
    joints?: HumanJointId[];
  };
}

export type PoseResolutionRelationship =
  | 'exact'
  | 'approved_substitute'
  | 'approximate'
  | 'contradictory';

export interface PoseResolution {
  requestedPose: string;
  resolvedPose?: string;
  relationship: PoseResolutionRelationship;
  requiresReview: boolean;
  reason?: string;
}

export interface PoseSubstitutionApproval {
  entityId: string;
  requestedPose: string;
  resolvedPose?: string;
  relationship: PoseResolutionRelationship;
  requiresReview: boolean;
  shotIds?: string[];
  reason?: string;
  approvedAt?: string;
  approvedBy?: string;
}

export interface ShotProductionContract {
  presence?: ShotPresenceContract;
  environment?: ShotEnvironmentContract;
  composition?: ShotCompositionConstraintSet;
  capabilityRequirements?: EntityCapabilityRequirement[];
}

export interface ProductionConfiguration {
  schemaVersion: 1;
  bindings: Record<string, ProductionEntityBinding>;
  locations: Record<string, ProductionLocationDefinition>;
  shotContracts: Record<string, ShotProductionContract>;
  poseSubstitutions?: PoseSubstitutionApproval[];
}

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
    }
  | {
      kind: 'importedRig';
      assetId: string;
      rigId: string;
    };

export type ImportedRigSourceFormat = 'glb' | 'gltf' | 'fbx';
export type ImportedHumanoidRigProfile = 'mixamo' | 'maya-humanik' | 'generic';

/**
 * A compact binding from ForeScene semantic joints to an existing source rig.
 * Meshes, skeletons, skin weights, and inverse bind matrices stay in the
 * original binary model asset; only stable mapping metadata is persisted.
 */
export interface ImportedHumanoidRigBinding {
  version: 1;
  id: string;
  sourceAssetId: string;
  sourceFormat: ImportedRigSourceFormat;
  profile: ImportedHumanoidRigProfile;
  boneMap: Partial<Record<HumanJointId, string>>;
  canonicalPoseBases: Partial<Record<HumanJointId, QuaternionTuple>>;
  skeletonHash: string;
  restPoseHash: string;
  rootBonePath?: string;
  hipsBonePath: string;
  orientation: PoseableCharacterOrientation;
  approximateHeightMeters: number;
  requiredJointCoverage: number;
  optionalJointCoverage: number;
  sourceAnimationClips?: Array<{ name: string; durationSeconds: number }>;
  warnings?: string[];
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

/** Axis choices for aligning an imported poseable character to ForeScene space. */
export type PoseableAxisHint = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export interface PoseableCharacterOrientation {
  /** Axis of the source mesh that should face the camera / +Z after import. */
  frontAxis: PoseableAxisHint;
  /** Axis of the source mesh that should point world-up (+Y). */
  upAxis: PoseableAxisHint;
  /** World Y of the soles / ground contact after rest placement, in meters. */
  groundLevelMeters: number;
}

export interface PoseableRestTransform {
  position: Vec3;
  rotation: Euler;
  scale: Vec3;
}

export interface PoseableRigGenerationSettings {
  /** Approximate character height in meters (head-to-ground). */
  approximateHeightMeters: number;
  /** Author-declared rest pose hint for later marker suggestions. */
  poseHint?: 'a-pose' | 't-pose';
  /** Soft validation notes recorded at import time. */
  notes?: string[];
}

/**
 * Compact reference to a binary six-region body-part map (one Uint8 per vertex).
 * Labels themselves live in a model binary asset — never in project JSON.
 */
export interface PoseableRegionMapReference {
  version: 1;
  regionAssetId: string;
  vertexCount: number;
  topologyHash: string;
  sourceAssetId: string;
}

/**
 * Serializable poseable-character rig asset.
 * 2A establishes the lifecycle shell; 2B/2C fill markers, bind matrices, and skin.
 * Large vertex/skin arrays stay in binary assets — not ordinary project JSON.
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
  /** Canonical anatomical rest frames used to retarget semantic pose deltas. */
  canonicalPoseBases?: Partial<Record<HumanJointId, number[]>>;
  /**
   * Approximate skinning produced by autorig.
   * Production projects store only compact metadata + `skinAssetId` (binary asset).
   * Inline `indices`/`weights` are legacy / tiny test fixtures and are stripped on
   * serialize when `skinAssetId` is present.
   */
  skin?: {
    influencesPerVertex: number;
    /**
     * @deprecated Prefer `skinAssetId`. Tiny fixtures only; never persist large arrays.
     * Flattened vertex → joint index table.
     */
    indices?: number[];
    /**
     * @deprecated Prefer `skinAssetId`. Tiny fixtures only.
     * Flattened weights matching `indices`.
     */
    weights?: number[];
    /** Binary payload asset id for indices+weights (required for production skins). */
    skinAssetId?: string;
  };
  /**
   * Six-region body-part map used by guided labeling / Binder V2.
   * Binary labels are referenced by `regionAssetId` — not embedded here.
   */
  regionMap?: PoseableRegionMapReference;
  markers?: AutorigMarker[];
  /** Bump when weight/fitting algorithms change so assets can be regenerated. */
  rigGenerationVersion?: number;
  /**
   * Independent binder algorithm version (region-constrained weights).
   * Distinct from {@link rigGenerationVersion} so marker/skeleton changes and
   * weight-solver changes can invalidate separately.
   */
  binderVersion?: number;
  /** Legacy baked weights/binds must be regenerated before this rig is usable. */
  requiresRerigging?: boolean;
  /**
   * Unmodified original import (GLB/glTF bytes) so autorigging can be retried
   * without re-picking the file.
   */
  originalSourceAssetId?: string;
  /** Optional derived mesh used for display/skinning (may equal original for 2A). */
  sourceMeshAssetId?: string;
  /** How the author oriented the character relative to ForeScene axes. */
  orientation?: PoseableCharacterOrientation;
  /** Rest placement applied when the character is first created in the scene. */
  restTransform?: PoseableRestTransform;
  /** Wizard / generation inputs used to produce this rig. */
  generationSettings?: PoseableRigGenerationSettings;
  /** Optional correction metadata from later marker/weight passes. */
  correctionMetadata?: Record<string, unknown>;
  /** Preserved source-rig mapping; absent means this is a generated autorig. */
  importedRigBinding?: ImportedHumanoidRigBinding;
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
  /** Optional stable parent node for preserving hierarchy across asset recovery. */
  parentId?: string;
  importedModel?: ImportedModelInfo;
  /** Explicit production classification; omitted values are derived by the compiler. */
  productionClass?: ProductionObjectClass;
  /**
   * Poseable-character identity. Distinct from `transform` (set placement)
   * and `humanPose` (limb articulation).
   */
  poseableCharacter?: PoseableCharacterSource;
  /** Skeletal articulation; only has effect when the object is poseable. */
  humanPose?: HumanPose;
  metadata?: Record<string, unknown>;
}

/** Logical assembly of scene objects for spatial operations and diagnostics. */
export interface ObjectGroup {
  id: string;
  name: string;
  objectIds: string[];
  /** Optional link to a model import batch (`ImportedModelInfo.sourceImportId`). */
  sourceImportId?: string;
}

export interface SceneData {
  worldUp: 'Y';
  objects: SceneObject[];
  panoOrigin: Vec3;
  panoRotation: Euler;
  /** Agent-managed logical assemblies; persisted with the project. */
  objectGroups?: Record<string, ObjectGroup>;
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

/** Motion deliverable for the optional characters-only export pass. */
export type CharacterMotionExportFormat =
  | 'green_mp4'
  | 'transparent_png_sequence'
  | 'both';

/** Isolated character-compositing deliverables (separate from People output). */
export interface CharacterPassExportSettings {
  enabled: boolean;
  includeStill: boolean;
  includeMotion: boolean;
  motionFormat: CharacterMotionExportFormat;
  /** Six-digit hex background for green-screen MP4 (e.g. `#00FF00`). */
  backgroundColor: string;
  /** Include props whose metadata.characterOwnerId references a person. */
  includeAttachedProps: boolean;
}

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
  /** Optional characters-only compositing pass (stills / green MP4 / PNG sequence). */
  characterPass?: CharacterPassExportSettings;
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

/** Built-in export profiles that populate scene defaults (extensible for providers later). */
export type ExportProfileId =
  | 'ai-generation'
  | 'full-production'
  | 'character-compositing'
  | 'custom';

/** Package folder layout written by the exporter. */
export type ExportPackageFormat = 'forescene-v2' | 'legacy-v1';

/** Current version of the project-level export configuration document. */
export const EXPORT_CONFIGURATION_SCHEMA_VERSION = 2 as const;
export type ExportConfigurationSchemaVersion = typeof EXPORT_CONFIGURATION_SCHEMA_VERSION;

/**
 * Sparse per-shot differences from scene export defaults.
 * Only explicitly customized leaf values are stored; absent keys inherit.
 * Explicit `false` / `0` values are preserved.
 */
export type CharacterPassExportSettingsOverride = {
  [K in keyof CharacterPassExportSettings]?: CharacterPassExportSettings[K];
};

export type ShotDepthSettingsOverride = {
  [K in keyof ShotDepthSettings]?: ShotDepthSettings[K];
};

export interface ExportSettingsOverride {
  width?: number;
  height?: number;
  peopleExportMode?: PeopleExportMode;
  characterPass?: CharacterPassExportSettingsOverride;
  includeViewport?: boolean;
  includeProjectedViewport?: boolean;
  includeProjectedCameraMoveReferenceFrames?: boolean;
  includeProjectedCameraMoveVideo?: boolean;
  includeAiResultFrame?: boolean;
  includePanoCrop?: boolean;
  includeFullPano?: boolean;
  includeGrayboxPano?: boolean;
  includeCameraMoveVideo?: boolean;
  includeCameraMoveReferenceFrames?: boolean;
  includeMetadata?: boolean;
  includePrompt?: boolean;
  depth?: ShotDepthSettingsOverride;
}

/**
 * Project-level export configuration: scene defaults inherited by every shot,
 * plus package/profile metadata. Shot-specific differences live in `Shot.exportOverrides`.
 */
export interface ProjectExportConfiguration {
  schemaVersion: ExportConfigurationSchemaVersion;
  activeProfileId: ExportProfileId;
  defaults: ShotExportSettings;
  packageFormat: ExportPackageFormat;
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
  /**
   * Fully resolved export settings for this shot (scene defaults + overrides).
   * Always rematerialized from `exportOverrides` against project export defaults
   * so existing exporters can keep reading `shot.exportSettings` directly.
   */
  exportSettings: ShotExportSettings;
  /**
   * Sparse leaf overrides relative to `project.exportConfiguration.defaults`.
   * Absent keys inherit; only explicit customizations are stored.
   */
  exportOverrides?: ExportSettingsOverride;
  promptOverrides: PromptOverrides;
  status: ShotStatus;
  assets: ShotAssetRefs;
  /**
   * Optional shot metadata (e.g. system scaffold tags for blank-project detection).
   * Not required for export; preserved across backup/import when present.
   */
  metadata?: Record<string, unknown>;
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
  /** Stable source identity retained even when the local binary is unavailable. */
  originalFileName?: string;
  /** Optional browser File System Access handle key; never required to open a project. */
  fileHandleKey?: string;
  contentHash?: string;
  byteSize?: number;
  resolutionStatus?: 'available' | 'missing' | 'corrupt' | 'unsupported';
  bounds?: { min: Vec3; max: Vec3 };
  dimensions?: Vec3;
  meshCount?: number;
  animationNames?: string[];
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
  /** Formal production contracts and prepared entity/location bindings. */
  production?: ProductionConfiguration;
  /**
   * @deprecated Read/write through `production.bindings` for new work. Kept as
   * a compatibility bridge for older Agent API callers and old project files.
   */
  productionManifestAssetBindings?: Record<string, string>;
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
  /**
   * Scene-level export defaults + package/profile metadata.
   * Present after load/normalize; older projects migrate into this shape.
   */
  exportConfiguration?: ProjectExportConfiguration;
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
