import { SceneData, SceneObject, SceneObjectType, Vec3 } from '../domain/types';
import { sceneEnvelope } from './buildSelection';
import { clamp } from './sync';

export interface FlyCameraBounds {
  min: Vec3;
  max: Vec3;
}

export const DEFAULT_FLY_CAMERA_HORIZONTAL_MARGIN_METERS = 10;
const DEFAULT_VERTICAL_MARGIN_METERS = 1.75;
const FALLBACK_HALF_EXTENT: Vec3 = [18, 3.5, 18];
const MIN_EYE_HEIGHT_METERS = 0.45;

const EXCLUDED_BOUND_TYPES = new Set<SceneObjectType>(['sun_marker']);

function isQualifyingObject(object: SceneObject): boolean {
  return object.visible && !EXCLUDED_BOUND_TYPES.has(object.type);
}

/**
 * Revision key for fly bounds. Pose-only edits (humanPose) must not change this key.
 * Bounds depend on object positions, dimensions, scale, visibility, type, and pano origin.
 */
export function sceneFlyBoundsRevisionKey(scene: SceneData): string {
  return JSON.stringify({
    panoOrigin: scene.panoOrigin,
    objects: scene.objects.map((object) => ({
      id: object.id,
      type: object.type,
      visible: object.visible,
      position: object.transform.position,
      scale: object.transform.scale,
      dimensions: object.dimensions,
    })),
  });
}

export function computeSceneFlyBounds(
  scene: SceneData,
  options?: {
    horizontalMarginMeters?: number;
    verticalMarginMeters?: number;
    fallbackHalfExtent?: Vec3;
  },
): FlyCameraBounds {
  const horizontalMarginOption = options?.horizontalMarginMeters;
  const verticalMarginOption = options?.verticalMarginMeters;
  const fallbackHalf = options?.fallbackHalfExtent ?? FALLBACK_HALF_EXTENT;
  const [originX, originY, originZ] = scene.panoOrigin;

  const qualifyingObjects = scene.objects.filter(isQualifyingObject);
  if (qualifyingObjects.length === 0) {
    return {
      min: [
        originX - fallbackHalf[0],
        Math.max(originY - fallbackHalf[1], MIN_EYE_HEIGHT_METERS),
        originZ - fallbackHalf[2],
      ],
      max: [
        originX + fallbackHalf[0],
        originY + fallbackHalf[1],
        originZ + fallbackHalf[2],
      ],
    };
  }

  const envelope = sceneEnvelope(scene, qualifyingObjects);
  const { min, max } = envelope;
  const [minX, minY, minZ] = min.toArray();
  const [maxX, maxY, maxZ] = max.toArray();

  const sceneRadius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
  const horizontalMargin = horizontalMarginOption ?? Math.max(4, sceneRadius * 0.75);
  const verticalMargin = verticalMarginOption ?? Math.max(1, sceneRadius * 0.35);

  return {
    min: [
      minX - horizontalMargin,
      Math.max(minY - verticalMargin, MIN_EYE_HEIGHT_METERS),
      minZ - horizontalMargin,
    ],
    max: [
      maxX + horizontalMargin,
      maxY + verticalMargin,
      maxZ + horizontalMargin,
    ],
  };
}

export function clampFlyCameraPosition(position: Vec3, bounds: FlyCameraBounds): Vec3 {
  return [
    clamp(position[0], bounds.min[0], bounds.max[0]),
    clamp(position[1], bounds.min[1], bounds.max[1]),
    clamp(position[2], bounds.min[2], bounds.max[2]),
  ];
}
