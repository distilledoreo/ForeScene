import {
  Box3Like,
  BlueprintDiagnostic,
  SET_BLUEPRINT_LEGACY_SCHEMA_VERSION,
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
import {
  resolveSceneRelationships,
  resolvedObjectWorldAabbs,
  type SceneRelationshipResolution,
  type SceneSpatialRelationship,
} from './sceneRelationships';
import { validateSpatialAuthoring } from './agent/spatialAuthoring';

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
  spatialErrors: BlueprintDiagnostic[];
  spatialNotes: BlueprintDiagnostic[];
  bounds: Box3Like;
  spatialRelationships: SceneSpatialRelationship[];
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
  const spatialErrors: BlueprintDiagnostic[] = [];
  const spatialNotes: BlueprintDiagnostic[] = [];
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
    const object = compileObject(entry, count, blueprint.schemaVersion);
    objectIdByBlueprintKey[entry.key] = object.id;
    return object;
  });

  blueprint.objects.forEach((entry, index) => {
    if (entry.type !== 'doorway' || !entry.hostWallKey) return;
    const hostId = objectIdByBlueprintKey[entry.hostWallKey];
    const host = objects.find((candidate) => candidate.id === hostId);
    if (!host || host.type !== 'wall') {
      warnings.push({
        code: 'host_wall_missing',
        message: `Doorway "${entry.key}" names a host wall that was not compiled.`,
        path: `objects[${index}].hostWallKey`,
        key: entry.key,
      });
      return;
    }
    const object = objects[index];
    object.metadata = {
      ...object.metadata,
      architecture: { kind: 'opening', openingKind: 'door', hostWallId: host.id },
    };
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
  const relationshipResolution = resolveSceneRelationships(project);
  appendRelationshipWarnings(blueprint, relationshipResolution, objectIdByBlueprintKey, warnings);
  appendSpatialValidationDiagnostics(
    project, blueprint, objectIdByBlueprintKey, warnings, spatialErrors, spatialNotes,
  );

  return {
    project,
    objectIdByBlueprintKey,
    warnings,
    spatialErrors,
    spatialNotes,
    bounds: computeBlueprintBounds(objects, relationshipResolution),
    spatialRelationships: relationshipResolution.relationships,
  };
}

function appendSpatialValidationDiagnostics(
  project: LocationProject,
  blueprint: SetBlueprint,
  objectIdByBlueprintKey: Record<string, string>,
  warnings: BlueprintDiagnostic[],
  errors: BlueprintDiagnostic[],
  notes: BlueprintDiagnostic[],
): void {
  const entryById = new Map(blueprint.objects.map((entry, index) => [
    objectIdByBlueprintKey[entry.key], { entry, index },
  ]));
  for (const issue of validateSpatialAuthoring(project).issues) {
    // The relationship warnings above carry a more precise blueprint field path.
    if (issue.code === 'ambiguous_opening_host' || issue.code === 'unhosted_opening') continue;
    const source = issue.objectIds.map((id) => entryById.get(id)).find(Boolean);
    const diagnostic: BlueprintDiagnostic = {
      code: issue.code,
      message: issue.message,
      ...(source ? { path: `objects[${source.index}]`, key: source.entry.key } : {}),
    };
    if (issue.severity === 'error') errors.push(diagnostic);
    else if (issue.severity === 'warning') warnings.push(diagnostic);
    else notes.push(diagnostic);
  }
}

function compileObject(
  entry: SetBlueprintObject,
  index: number,
  schemaVersion: SetBlueprint['schemaVersion'],
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
  object.transform.position = resolveObjectPosition(entry, schemaVersion);
  object.stagingRole = resolveStagingRole(entry);
  applySurface(object, entry);
  if (entry.type === 'doorway') {
    object.metadata = { ...object.metadata, architecture: { kind: 'opening', openingKind: 'door' } };
  } else if (entry.type === 'stairs' && entry.clearanceAboveMeters !== undefined) {
    object.metadata = {
      ...object.metadata,
      architecture: { kind: 'level_member', clearanceAboveMeters: entry.clearanceAboveMeters },
    };
  }

  return object;
}

/**
 * v2 uses the same uniform object-center coordinates as scene.createCentered.
 * v1 retains its legacy primitive-specific placement semantics.
 */
function resolveObjectPosition(
  entry: SetBlueprintObject,
  schemaVersion: SetBlueprint['schemaVersion'],
): Vec3 {
  const [x, y, z] = entry.position;
  if (schemaVersion !== SET_BLUEPRINT_LEGACY_SCHEMA_VERSION) return [x, y, z];
  const height = entry.dimensions[1];
  const scaleY = entry.scale?.[1] ?? 1;
  const scaledHeight = height * scaleY;

  if (entry.type === 'floor') {
    return [x, y - scaledHeight / 2, z];
  }
  if (UPRIGHT_TYPES.has(entry.type)) {
    return [x, y + scaledHeight / 2, z];
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

function appendRelationshipWarnings(
  blueprint: SetBlueprint,
  resolution: SceneRelationshipResolution,
  objectIdByBlueprintKey: Record<string, string>,
  warnings: BlueprintDiagnostic[],
): void {
  const entryById = new Map(blueprint.objects.map((entry, index) => [
    objectIdByBlueprintKey[entry.key], { entry, index },
  ]));
  for (const relationship of resolution.relationships) {
    if (relationship.status === 'resolved') continue;
    const source = entryById.get(relationship.sourceId);
    if (!source) continue;
    const { entry, index } = source;
    if (relationship.kind === 'portal_host') {
      const ambiguous = relationship.status === 'ambiguous';
      warnings.push({
        code: ambiguous ? 'doorway_host_ambiguous' : 'doorway_unhosted',
        message: ambiguous
          ? `Doorway "${entry.key}" overlaps multiple compatible walls; set hostWallKey to choose one.`
          : `Doorway "${entry.key}" does not overlap ${entry.hostWallKey ? 'its chosen wall' : 'a compatible wall'}, so it will not cut an opening.`,
        path: `objects[${index}]${entry.hostWallKey ? '.hostWallKey' : '.position'}`,
        key: entry.key,
      });
    } else if (relationship.kind === 'stair_clearance') {
      warnings.push({
        code: 'stair_clearance_unhosted',
        message: `Stairs "${entry.key}" have no upper floor or slab in their clearance volume to cut.`,
        path: `objects[${index}].position`,
        key: entry.key,
      });
    }
  }
}

function computeBlueprintBounds(
  objects: SceneObject[],
  resolution: SceneRelationshipResolution,
): Box3Like {
  const boxes = objects.flatMap((object) => resolvedObjectWorldAabbs(object, resolution));
  if (boxes.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const box of boxes) {
    minX = Math.min(minX, box.min[0]);
    minY = Math.min(minY, box.min[1]);
    minZ = Math.min(minZ, box.min[2]);
    maxX = Math.max(maxX, box.max[0]);
    maxY = Math.max(maxY, box.max[1]);
    maxZ = Math.max(maxZ, box.max[2]);
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}
