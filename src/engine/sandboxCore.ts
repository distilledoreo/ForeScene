import { createSceneObject, objectDisplayName } from '../domain/defaults';
import type { SceneObject, SceneObjectType, Vec3 } from '../domain/types';
import { createId } from '../utils/ids';

/** Math-only Build helpers used by the app store before the 3D viewport loads. */
export const BUILD_GRID_SIZE = 0.5;
export const STAMP_FLOOR_TILE_DIMENSIONS: Vec3 = [4, 0.08, 4];

export function snapBuildPoint(point: Vec3, enabled: boolean, gridSize = BUILD_GRID_SIZE): Vec3 {
  if (!enabled) return [...point] as Vec3;
  return [
    roundToGrid(point[0], gridSize),
    point[1],
    roundToGrid(point[2], gridSize),
  ];
}

export function createPlacedSceneObject(params: {
  type: SceneObjectType;
  index: number;
  point: Vec3;
  snapToGrid: boolean;
}): SceneObject {
  const object = createSceneObject(params.type, params.index);
  const placed: SceneObject = params.type === 'floor'
    ? { ...object, dimensions: STAMP_FLOOR_TILE_DIMENSIONS }
    : object;

  return {
    ...placed,
    transform: {
      ...placed.transform,
      position: getGroundPlacementPosition(placed, params.point, params.snapToGrid),
    },
  };
}

export function getGroundPlacementPosition(
  object: SceneObject,
  point: Vec3,
  snapToGrid: boolean,
): Vec3 {
  const snapped = snapBuildPoint(point, snapToGrid);
  const groundY = object.dimensions[1] / 2;
  return [snapped[0], groundY, snapped[2]];
}

export function duplicateSceneObject(
  object: SceneObject,
  index: number,
  snapToGrid: boolean,
): SceneObject {
  const position = snapBuildPoint([
    object.transform.position[0] + 0.75,
    object.transform.position[1],
    object.transform.position[2] + 0.75,
  ], snapToGrid);

  return {
    ...object,
    id: createId('obj'),
    name: `${objectDisplayName(object.type)} ${index}`,
    transform: {
      ...object.transform,
      position,
      rotation: [...object.transform.rotation] as Vec3,
      scale: [...object.transform.scale] as Vec3,
    },
    dimensions: [...object.dimensions] as Vec3,
    locked: false,
    visible: true,
    metadata: object.metadata ? { ...object.metadata } : undefined,
  };
}

function roundToGrid(value: number, gridSize: number) {
  if (!Number.isFinite(value) || gridSize <= 0) return value;
  return Number((Math.round(value / gridSize) * gridSize).toFixed(3));
}
