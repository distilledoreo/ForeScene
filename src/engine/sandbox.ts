import * as THREE from 'three';
import type { Vec3 } from '../domain/types';
import { snapBuildPoint } from './sandboxCore';
export {
  BUILD_GRID_SIZE,
  STAMP_FLOOR_TILE_DIMENSIONS,
  createPlacedSceneObject,
  duplicateSceneObject,
  getGroundPlacementPosition,
  snapBuildPoint,
} from './sandboxCore';

const UP_FACING_THRESHOLD = 0.35;

export function resolveStampPoint(
  raycaster: THREE.Raycaster,
  options: {
    snapToGrid: boolean;
    scene?: THREE.Scene | null;
  },
): Vec3 | undefined {
  if (options.scene) {
    const hits = raycaster.intersectObjects(options.scene.children, true);
    for (const hit of hits) {
      if (!isStampSurfaceHit(hit)) continue;
      const snapped = snapBuildPoint([hit.point.x, 0, hit.point.z], options.snapToGrid);
      return [snapped[0], 0, snapped[2]];
    }
  }

  const planeHit = new THREE.Vector3();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  if (!raycaster.ray.intersectPlane(plane, planeHit)) return undefined;

  const snapped = snapBuildPoint(planeHit.toArray() as Vec3, options.snapToGrid);
  return [snapped[0], 0, snapped[2]];
}

function isStampSurfaceHit(hit: THREE.Intersection): boolean {
  if (hit.object.userData.previewObject) return false;

  let current: THREE.Object3D | null = hit.object;
  while (current) {
    if (current.userData.panoOrigin === true) return false;
    current = current.parent;
  }

  if (hit.object instanceof THREE.Line || hit.object instanceof THREE.LineSegments) return false;
  if (typeof hit.object.name === 'string' && hit.object.name.startsWith('Frustum ')) return false;
  if (!hit.face) return false;

  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  return normal.y >= UP_FACING_THRESHOLD;
}
