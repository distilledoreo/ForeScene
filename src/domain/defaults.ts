import {
  CameraData,
  CameraKeyframe,
  Landmark,
  LocationProject,
  PanoCropSettings,
  PanoReference,
  ProjectAsset,
  SceneObject,
  SceneObjectType,
  ProjectedStyleSettings,
  ProjectSettings,
  ProjectWorkflow,
  Shot,
  ShotExportSettings,
  ShotObjectOverrides,
  Transform,
  Vec3,
} from './types';
import { createId } from '../utils/ids';
import { DEFAULT_SHOT_NEAR_CLIP_METERS } from '../engine/cameraClipping';
import { focalLengthToVerticalFov } from '../engine/focalLength';

const nowIso = () => new Date().toISOString();

const primitiveDefaults: Record<SceneObjectType, { dimensions: Vec3; category: SceneObject['category'] }> = {
  floor: { dimensions: [12, 0.08, 12], category: 'architecture' },
  wall: { dimensions: [6, 3, 0.18], category: 'architecture' },
  box: { dimensions: [1.4, 1.4, 1.4], category: 'architecture' },
  arch: { dimensions: [3, 3.4, 0.35], category: 'architecture' },
  doorway: { dimensions: [2, 2.8, 0.25], category: 'architecture' },
  column: { dimensions: [0.6, 3, 0.6], category: 'architecture' },
  stairs: { dimensions: [2.8, 1.2, 2.4], category: 'architecture' },
  tree_blob: { dimensions: [1.8, 3.2, 1.8], category: 'environment' },
  terrain_mass: { dimensions: [3.5, 0.8, 2.4], category: 'environment' },
  background_card: { dimensions: [8, 4, 0.08], category: 'environment' },
  human_dummy: { dimensions: [0.55, 1.75, 0.55], category: 'helper' },
  sun_marker: { dimensions: [0.8, 0.8, 0.8], category: 'helper' },
  imported_model: { dimensions: [1, 1, 1], category: 'architecture' },
};

export const DEFAULT_CAMERA_LENS_MM = 35;
export const DEFAULT_CAMERA_ASPECT_RATIO = 16 / 9;
export const DEFAULT_CAMERA_FOV_DEGREES = focalLengthToVerticalFov(
  DEFAULT_CAMERA_LENS_MM,
  DEFAULT_CAMERA_ASPECT_RATIO,
);
export const DEFAULT_CAMERA_HEIGHT_METERS = 1.65;
/** 4K equirectangular (2:1) — graybox / canonical 360 panoramas. */
export const DEFAULT_GRAYBOX_PANO_WIDTH = 4096;
export const DEFAULT_GRAYBOX_PANO_HEIGHT = 2048;
/** 4K UHD 16:9 — shot stills, camera-move video, letterboxed pano exports. */
export const DEFAULT_SHOT_WIDTH = 3840;
export const DEFAULT_SHOT_HEIGHT = 2160;

export const defaultProjectedStyleSettings: ProjectedStyleSettings = {
  panoId: undefined,
  secondaryPanoId: undefined,
  blendMode: 'primary_only',
  opacity: 1,
  exposure: 1,
  lightingContribution: 0,
  fallbackMode: 'clay',
  occlusionEnabled: true,
  occlusionBiasMeters: 0.04,
  occlusionSoftness: 1,
  occlusionFilterMode: 'soft',
  occlusionDebugMode: 'off',
};

export const defaultProjectSettings = {
  defaultShotWidth: DEFAULT_SHOT_WIDTH,
  defaultShotHeight: DEFAULT_SHOT_HEIGHT,
  defaultShotFovDegrees: DEFAULT_CAMERA_FOV_DEGREES,
  defaultCameraLensMm: DEFAULT_CAMERA_LENS_MM,
  defaultCameraHeightMeters: DEFAULT_CAMERA_HEIGHT_METERS,
  panoGoodMatchMeters: 1.5,
  panoModerateMatchMeters: 4,
  panoLetterboxExports169: true,
  projectedStyle: { ...defaultProjectedStyleSettings },
} satisfies ProjectSettings;

export const defaultProjectWorkflow: ProjectWorkflow = {
  shotFramingAcceptedAtByShotId: {},
  aiBriefSentAtByShotId: {},
  finalPackageExportedAtByShotId: {},
};

export function normalizeProjectWorkflow(workflow?: Partial<ProjectWorkflow>): ProjectWorkflow {
  return {
    grayboxApprovedForReferenceAt: workflow?.grayboxApprovedForReferenceAt,
    referenceAlignmentAcceptedForPanoId: workflow?.referenceAlignmentAcceptedForPanoId,
    shotFramingAcceptedAtByShotId: { ...workflow?.shotFramingAcceptedAtByShotId },
    aiBriefSentAtByShotId: { ...workflow?.aiBriefSentAtByShotId },
    finalPackageExportedAtByShotId: { ...workflow?.finalPackageExportedAtByShotId },
  };
}

export function normalizeProjectedStyleSettings(
  settings?: Partial<ProjectedStyleSettings> | null,
): ProjectedStyleSettings {
  const opacity = Number(settings?.opacity);
  const exposure = Number(settings?.exposure);
  const lightingContribution = Number(settings?.lightingContribution);
  const blendModes = new Set(['primary_only', 'secondary_only', 'primary_dominant', 'secondary_dominant']);
  const blendMode = settings?.blendMode && blendModes.has(settings.blendMode)
    ? settings.blendMode
    : defaultProjectedStyleSettings.blendMode;
  const occlusionBiasMeters = Number(settings?.occlusionBiasMeters);
  const occlusionSoftness = Number(settings?.occlusionSoftness);
  const occlusionEnabled = typeof settings?.occlusionEnabled === 'boolean'
    ? settings.occlusionEnabled
    : true;
  const panoId = typeof settings?.panoId === 'string' && settings.panoId.length > 0
    ? settings.panoId
    : undefined;
  let secondaryPanoId = typeof settings?.secondaryPanoId === 'string' && settings.secondaryPanoId.length > 0
      ? settings.secondaryPanoId
      : undefined;
  if (secondaryPanoId && panoId && secondaryPanoId === panoId) secondaryPanoId = undefined;
  return {
    panoId,
    secondaryPanoId,
    blendMode,
    opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : defaultProjectedStyleSettings.opacity,
    exposure: Number.isFinite(exposure) ? Math.min(4, Math.max(0.25, exposure)) : defaultProjectedStyleSettings.exposure,
    lightingContribution: Number.isFinite(lightingContribution)
      ? Math.min(1, Math.max(0, lightingContribution))
      : defaultProjectedStyleSettings.lightingContribution,
    fallbackMode: settings?.fallbackMode === 'neutral' ? 'neutral' : 'clay',
    occlusionEnabled,
    occlusionBiasMeters: Number.isFinite(occlusionBiasMeters)
      ? Math.min(0.5, Math.max(0, occlusionBiasMeters))
      : defaultProjectedStyleSettings.occlusionBiasMeters,
    occlusionSoftness: Number.isFinite(occlusionSoftness)
      ? Math.min(2, Math.max(0, occlusionSoftness))
      : defaultProjectedStyleSettings.occlusionSoftness,
    occlusionFilterMode: settings?.occlusionFilterMode === 'fast' ? 'fast' : 'soft',
    occlusionDebugMode: settings?.occlusionDebugMode === 'coverage' ? 'coverage' : 'off',
  };
}

export function normalizeProjectSettings(settings?: Partial<ProjectSettings>): ProjectSettings {
  return {
    ...defaultProjectSettings,
    ...settings,
    panoLetterboxExports169: settings?.panoLetterboxExports169 ?? defaultProjectSettings.panoLetterboxExports169,
    projectedStyle: normalizeProjectedStyleSettings(
      settings?.projectedStyle ?? defaultProjectSettings.projectedStyle,
    ),
  };
}

export const defaultShotExportSettings: ShotExportSettings = {
  width: DEFAULT_SHOT_WIDTH,
  height: DEFAULT_SHOT_HEIGHT,
  peopleExportMode: 'with_people',
  includeViewport: true,
  /** Include projected stills alongside clay when a styled pano is available. */
  includeProjectedViewport: true,
  includeProjectedCameraMoveReferenceFrames: true,
  includeProjectedCameraMoveVideo: true,
  includeAiResultFrame: true,
  includePanoCrop: true,
  includeFullPano: true,
  includeGrayboxPano: true,
  includeCameraMoveVideo: true,
  includeCameraMoveReferenceFrames: true,
  includeMetadata: true,
  includePrompt: true,
};

export function createTransform(position: Vec3 = [0, 0, 0]): Transform {
  return {
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

export function createSceneObject(type: SceneObjectType, index = 1, position?: Vec3): SceneObject {
  const defaults = primitiveDefaults[type];
  const object: SceneObject = {
    id: createId('obj'),
    name: `${objectDisplayName(type)} ${index}`,
    type,
    transform: createTransform(position ?? defaultPositionForType(type, index)),
    dimensions: defaults.dimensions,
    category: defaults.category,
    locked: false,
    visible: true,
    stagingRole: type === 'human_dummy' ? 'person' : 'set',
  };

  if (type === 'wall') object.transform.position = [0, 1.5, 5];
  if (type === 'background_card') object.transform.position = [0, 2, 6.5];
  if (type === 'sun_marker') object.transform.position = [3.5, 5, -2.5];
  if (type === 'human_dummy') object.transform.position = [-1.25, 0.875, 0.9];
  return object;
}

export function objectDisplayName(type: SceneObjectType): string {
  return type
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function defaultPositionForType(type: SceneObjectType, index: number): Vec3 {
  if (type === 'floor') return [0, 0, 0];
  const column = (index % 5) - 2;
  const row = Math.floor(index / 5);
  return [column * 1.6, 0.7, row * 1.4 - 1.4];
}

export function createLandmark(index: number, position: Vec3 = [0, 1.2, 0]): Landmark {
  return {
    id: createId('landmark'),
    name: `landmark_${index}`,
    displayName: `Landmark ${index}`,
    position,
    description: '',
    tags: [],
    promptCritical: true,
    visible: true,
  };
}

export function createCameraData(position: Vec3, target: Vec3, fovDegrees = 55): CameraData {
  return {
    position,
    target,
    fovDegrees,
    aspectRatio: 16 / 9,
    near: DEFAULT_SHOT_NEAR_CLIP_METERS,
    far: 100,
  };
}

export function createOriginShot(
  project: Pick<LocationProject, 'scene' | 'settings'>,
  index = 1,
): Shot {
  const origin = project.scene.panoOrigin;
  const camera = createCameraData(
    [...origin],
    [origin[0], origin[1], origin[2] + 10],
    project.settings.defaultShotFovDegrees,
  );
  camera.aspectRatio = DEFAULT_CAMERA_ASPECT_RATIO;
  const shot = createShot({ index, camera });
  shot.name = `Camera ${String(index).padStart(3, '0')}`;
  return shot;
}

export function createShot(params: {
  index: number;
  camera: CameraData;
  linkedPanoId?: string;
  panoCrop?: PanoCropSettings;
}): Shot {
  const shotNumber = String(params.index).padStart(3, '0');
  const now = nowIso();
  return {
    id: createId('shot'),
    shotNumber,
    name: `Shot ${shotNumber}`,
    description: '',
    camera: params.camera,
    cameraKeyframes: [],
    objectOverrides: {},
    linkedPanoId: params.linkedPanoId,
    panoCrop: params.panoCrop,
    landmarkIds: [],
    exportSettings: { ...defaultShotExportSettings },
    promptOverrides: {},
    status: 'planned',
    assets: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function createPanoAsset(params: {
  name: string;
  uri: string;
  width: number;
  height: number;
  metadata?: Record<string, unknown>;
}): ProjectAsset {
  return {
    id: createId('asset'),
    type: 'image',
    name: params.name,
    uri: params.uri,
    mimeType: 'image/png',
    width: params.width,
    height: params.height,
    createdAt: nowIso(),
    metadata: params.metadata,
  };
}

export function createVideoAsset(params: {
  name: string;
  uri: string;
  mimeType: string;
  width: number;
  height: number;
  metadata?: Record<string, unknown>;
}): ProjectAsset {
  return {
    id: createId('asset'),
    type: 'video',
    name: params.name,
    uri: params.uri,
    mimeType: params.mimeType,
    width: params.width,
    height: params.height,
    createdAt: nowIso(),
    metadata: params.metadata,
  };
}

export function createCameraKeyframe(params: {
  label: string;
  timeSeconds: number;
  camera: CameraData;
  easing?: CameraKeyframe['easing'];
  objectOverrides?: ShotObjectOverrides;
}): CameraKeyframe {
  return {
    id: createId('keyframe'),
    label: params.label,
    timeSeconds: params.timeSeconds,
    camera: cloneCamera(params.camera),
    ...(params.easing ? { easing: params.easing } : {}),
    // Preserve explicit snapshots, including empty ones ("use build poses").
    ...(params.objectOverrides !== undefined
      ? { objectOverrides: structuredClone(params.objectOverrides) }
      : {}),
  };
}

export function createPanoReference(params: {
  name: string;
  assetId: string;
  type: PanoReference['type'];
  origin: Vec3;
  rotation?: Vec3;
  width: number;
  height: number;
  isCanonical?: boolean;
  sourcePanoId?: string;
  notes?: string;
}): PanoReference {
  return {
    id: createId('pano'),
    name: params.name,
    imageAssetId: params.assetId,
    type: params.type,
    projection: 'equirectangular',
    // Freeze pose copies so later scene.panoOrigin moves never rewrite this pano.
    origin: [...params.origin] as Vec3,
    rotation: [...(params.rotation ?? [0, 0, 0])] as Vec3,
    width: params.width,
    height: params.height,
    isCanonical: params.isCanonical ?? false,
    sourcePanoId: params.sourcePanoId,
    notes: params.notes,
    createdAt: nowIso(),
  };
}

function cloneCamera(camera: CameraData): CameraData {
  return {
    position: [...camera.position],
    target: [...camera.target],
    fovDegrees: camera.fovDegrees,
    aspectRatio: camera.aspectRatio,
    near: camera.near,
    far: camera.far,
  };
}

export function createDefaultProject(): LocationProject {
  const now = nowIso();
  const starterObjects = [
    createSceneObject('floor', 1),
    createSceneObject('wall', 1),
    createSceneObject('arch', 1, [0, 1.7, 4.95]),
    createSceneObject('column', 1, [-3.4, 1.5, 3.8]),
    createSceneObject('column', 2, [3.4, 1.5, 3.8]),
    createSceneObject('wall', 2),
    createSceneObject('wall', 3),
    createSceneObject('human_dummy', 1),
    createSceneObject('sun_marker', 1),
  ];

  starterObjects[0].name = 'Ground Slab';
  starterObjects[0].locked = true;
  starterObjects[1].name = 'Main Temple Wall';
  starterObjects[1].dimensions = [5.4, 2.8, 0.2];
  starterObjects[2].name = 'Main Temple Gate';
  starterObjects[2].dimensions = [3.2, 3.2, 0.38];
  starterObjects[5].name = 'Left Courtyard Wall';
  starterObjects[5].dimensions = [3.2, 2.3, 0.18];
  starterObjects[5].transform.position = [-5.4, 1.15, 2.4];
  starterObjects[5].transform.rotation = [0, 36, 0];
  starterObjects[6].name = 'Right Courtyard Wall';
  starterObjects[6].dimensions = [3.2, 2.3, 0.18];
  starterObjects[6].transform.position = [5.4, 1.15, 2.4];
  starterObjects[6].transform.rotation = [0, -36, 0];
  starterObjects[7].name = 'Man Facing Camera';
  starterObjects[7].transform.position = [-1.2, 0.875, 0.85];

  const settings = { ...defaultProjectSettings };
  const scene = {
    worldUp: 'Y' as const,
    objects: starterObjects,
    panoOrigin: [0, DEFAULT_CAMERA_HEIGHT_METERS, 0] as Vec3,
    panoRotation: [0, 0, 0] as Vec3,
  };

  return {
    schemaVersion: '1.0',
    productVersion: '0.1.0',
    id: createId('project'),
    name: 'Untitled Location',
    description: '',
    units: 'meters',
    createdAt: now,
    updatedAt: now,
    scene,
    panoRefs: [],
    landmarks: [
      {
        ...createLandmark(1, [0, 1.8, 4.95]),
        name: 'main_temple_gate',
        displayName: 'Main Temple Gate',
        description: 'Central architectural anchor visible straight ahead in the wide shot.',
      },
      {
        ...createLandmark(2, [-1.2, 1.1, 0.85]),
        name: 'man_facing_camera',
        displayName: 'Man Facing Camera',
        description: 'Foreground human scale figure that should face the camera.',
      },
    ],
    shots: [createOriginShot({ scene, settings })],
    assets: { assets: {} },
    settings,
    workflow: { ...defaultProjectWorkflow },
  };
}
