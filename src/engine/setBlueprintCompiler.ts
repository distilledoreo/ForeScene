import {
  Box3Like,
  BlueprintDiagnostic,
  SetBlueprint,
  SetBlueprintLandmark,
  SetBlueprintObject,
  SetBlueprintObjectType,
} from '../domain/setBlueprint';
import {
  createDefaultProject,
  createLandmark,
  createOriginShot,
  createSceneObject,
  DEFAULT_CAMERA_HEIGHT_METERS,
  defaultProjectSettings,
  defaultProjectWorkflow,
  defaultProjectedStyleSettings,
} from '../domain/defaults';
import type {
  Euler,
  Landmark,
  LocationProject,
  ProjectSettings,
  SceneObject,
  StagingRole,
  Vec3,
} from '../domain/types';

export interface CompileSetBlueprintOptions {
  /**
   * Optional preference-like settings carried from the previous project.
   * Never carries projectedStyle panorama IDs from a prior project.
   */
  preferenceSettings?: Partial<Pick<
    ProjectSettings,
    | 'defaultShotWidth'
    | 'defaultShotHeight'
    | 'defaultShotFovDegrees'
    | 'defaultCameraLensMm'
    | 'defaultCameraHeightMeters'
    | 'panoGoodMatchMeters'
    | 'panoModerateMatchMeters'
    | 'panoLetterboxExports169'
  >>;
}

export interface CompiledSetBlueprint {
  project: LocationProject;
  objectIdByBlueprintKey: Record<string, string>;
  warnings: BlueprintDiagnostic[];
  bounds: Box3Like;
}

const UPRIGHT_TYPES = new Set<SetBlueprintObjectType>([
  'wall',
  'arch',
  'doorway',
  'column',
  'stairs',
  'background_card',
  'human_dummy',
  'tree_blob',
]);

/**
 * Deterministic SetBlueprint → LocationProject compiler.
 * Same blueprint yields geometrically equivalent projects aside from IDs and timestamps.
 */
export function compileSetBlueprint(
  blueprint: SetBlueprint,
  options: CompileSetBlueprintOptions = {},
): CompiledSetBlueprint {
  const warnings: BlueprintDiagnostic[] = [];
  const base = createDefaultProject();

  const settings: ProjectSettings = {
    ...defaultProjectSettings,
    ...pickPreferenceSettings(options.preferenceSettings),
    // Never inherit panorama-bound projected style from a prior project.
    projectedStyle: { ...defaultProjectedStyleSettings },
  };

  const objectIdByBlueprintKey: Record<string, string> = {};
  const typeCounts = new Map<SetBlueprintObjectType, number>();
  const objects: SceneObject[] = blueprint.objects.map((entry) => {
    const count = (typeCounts.get(entry.type) ?? 0) + 1;
    typeCounts.set(entry.type, count);
    const object = compileObject(entry, count, warnings);
    objectIdByBlueprintKey[entry.key] = object.id;
    return object;
  });

  const panoOrigin: Vec3 = blueprint.panoOrigin
    ? [...blueprint.panoOrigin] as Vec3
    : [0, settings.defaultCameraHeightMeters ?? DEFAULT_CAMERA_HEIGHT_METERS, 0];
  const panoRotation: Euler = blueprint.panoRotation
    ? [...blueprint.panoRotation] as Euler
    : [0, 0, 0];

  const scene = {
    worldUp: 'Y' as const,
    objects,
    panoOrigin,
    panoRotation,
  };

  const landmarks = (blueprint.landmarks ?? []).map((entry, index) => (
    compileLandmark(entry, index + 1, objectIdByBlueprintKey, objects, warnings)
  ));

  const project: LocationProject = {
    ...base,
    name: blueprint.name,
    description: blueprint.description ?? '',
    units: 'meters',
    scene,
    panoRefs: [],
    landmarks,
    shots: [createOriginShot({ scene, settings })],
    assets: { assets: {} },
    settings,
    workflow: { ...defaultProjectWorkflow },
  };

  return {
    project,
    objectIdByBlueprintKey,
    warnings,
    bounds: computeBlueprintBounds(objects),
  };
}

function compileObject(
  entry: SetBlueprintObject,
  index: number,
  warnings: BlueprintDiagnostic[],
): SceneObject {
  const object = createSceneObject(entry.type, index);
  object.name = entry.name;
  object.dimensions = [...entry.dimensions] as Vec3;
  object.transform.rotation = entry.rotation
    ? [...entry.rotation] as Euler
    : [0, 0, 0];
  object.transform.scale = entry.scale
    ? [...entry.scale] as Vec3
    : [1, 1, 1];
  object.transform.position = resolveObjectPosition(entry);
  object.stagingRole = resolveStagingRole(entry);
  applySurface(object, entry);

  if (entry.type === 'floor' && entry.position[1] !== 0) {
    warnings.push({
      code: 'floor_y_normalized',
      message: `Floor "${entry.key}" Y was adjusted so its top surface sits at Y=0.`,
      path: `objects[key=${entry.key}].position`,
      key: entry.key,
    });
  }

  return object;
}

/**
 * Geometry conventions handled by the compiler (not the AI):
 * - Floors: top surface at Y=0.
 * - Upright architecture / people: bottom sits on the floor (Y = height/2 * scaleY).
 * - Other types: use the provided position as the object center.
 */
function resolveObjectPosition(entry: SetBlueprintObject): Vec3 {
  const [x, y, z] = entry.position;
  const height = entry.dimensions[1];
  const scaleY = entry.scale?.[1] ?? 1;
  const scaledHeight = height * scaleY;

  if (entry.type === 'floor') {
    return [x, -scaledHeight / 2, z];
  }
  if (UPRIGHT_TYPES.has(entry.type)) {
    return [x, scaledHeight / 2, z];
  }
  return [x, y, z];
}

function resolveStagingRole(entry: SetBlueprintObject): StagingRole {
  if (entry.stagingRole) return entry.stagingRole;
  if (entry.type === 'human_dummy') return 'person';
  return 'set';
}

function applySurface(object: SceneObject, entry: SetBlueprintObject): void {
  if (!entry.surface) return;
  object.surfaceStyle = entry.surface.style;
  if (entry.surface.color) object.color = entry.surface.color;
  if (entry.surface.secondaryColor) object.secondaryColor = entry.surface.secondaryColor;
}

function compileLandmark(
  entry: SetBlueprintLandmark,
  index: number,
  objectIdByBlueprintKey: Record<string, string>,
  objects: SceneObject[],
  warnings: BlueprintDiagnostic[],
): Landmark {
  const landmark = createLandmark(index);
  landmark.name = entry.key;
  landmark.displayName = entry.displayName;
  landmark.description = entry.description ?? '';
  landmark.tags = entry.tags ? [...entry.tags] : [];
  landmark.promptCritical = entry.promptCritical ?? true;

  if (entry.linkedObjectKey) {
    const objectId = objectIdByBlueprintKey[entry.linkedObjectKey];
    if (objectId) {
      landmark.linkedObjectId = objectId;
    } else {
      warnings.push({
        code: 'landmark_link_missing',
        message: `Landmark "${entry.key}" linkedObjectKey "${entry.linkedObjectKey}" did not resolve.`,
        path: `landmarks[key=${entry.key}].linkedObjectKey`,
        key: entry.key,
      });
    }
  }

  if (entry.position) {
    landmark.position = [...entry.position] as Vec3;
  } else if (entry.linkedObjectKey && landmark.linkedObjectId) {
    const linked = objects.find((object) => object.id === landmark.linkedObjectId);
    if (linked) {
      landmark.position = [...linked.transform.position] as Vec3;
    }
  }

  return landmark;
}

function pickPreferenceSettings(
  preferences?: CompileSetBlueprintOptions['preferenceSettings'],
): Partial<ProjectSettings> {
  if (!preferences) return {};
  const next: Partial<ProjectSettings> = {};
  if (preferences.defaultShotWidth !== undefined) next.defaultShotWidth = preferences.defaultShotWidth;
  if (preferences.defaultShotHeight !== undefined) next.defaultShotHeight = preferences.defaultShotHeight;
  if (preferences.defaultShotFovDegrees !== undefined) {
    next.defaultShotFovDegrees = preferences.defaultShotFovDegrees;
  }
  if (preferences.defaultCameraLensMm !== undefined) next.defaultCameraLensMm = preferences.defaultCameraLensMm;
  if (preferences.defaultCameraHeightMeters !== undefined) {
    next.defaultCameraHeightMeters = preferences.defaultCameraHeightMeters;
  }
  if (preferences.panoGoodMatchMeters !== undefined) next.panoGoodMatchMeters = preferences.panoGoodMatchMeters;
  if (preferences.panoModerateMatchMeters !== undefined) {
    next.panoModerateMatchMeters = preferences.panoModerateMatchMeters;
  }
  if (preferences.panoLetterboxExports169 !== undefined) {
    next.panoLetterboxExports169 = preferences.panoLetterboxExports169;
  }
  return next;
}

function computeBlueprintBounds(objects: SceneObject[]): Box3Like {
  if (objects.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const object of objects) {
    const [px, py, pz] = object.transform.position;
    const [sx, sy, sz] = object.transform.scale;
    const [dx, dy, dz] = object.dimensions;
    const hx = (dx * sx) / 2;
    const hy = (dy * sy) / 2;
    const hz = (dz * sz) / 2;
    minX = Math.min(minX, px - hx);
    minY = Math.min(minY, py - hy);
    minZ = Math.min(minZ, pz - hz);
    maxX = Math.max(maxX, px + hx);
    maxY = Math.max(maxY, py + hy);
    maxZ = Math.max(maxZ, pz + hz);
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}
