export type Vec3 = [number, number, number];
export type Euler = [number, number, number];
export type ProjectVersion = '0.1';

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

export interface ShotObjectOverride {
  transform?: Transform;
  visible?: boolean;
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
   * Lightweight still (data URL or asset URI) for filmstrip / camera-roll animation.
   * Not used for export; regenerated cheaply when missing.
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
  type: 'image' | 'video' | 'model' | 'json' | 'text' | 'other';
  name: string;
  /** Runtime URL (data:, blob:, or a portable panoref-asset: reference). */
  uri: string;
  /** IndexedDB key for local-first image/video payloads; portable packages include this binary separately. */
  storageKey?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
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
