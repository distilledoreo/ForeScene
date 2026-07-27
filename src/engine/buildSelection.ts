import * as THREE from 'three';
import type { SceneData, SceneObject } from '../domain/types';
export {
  type SelectionMode,
  normalizeSelectedIds,
  rotateSelectedObjects,
  scaleSelectedObjects,
  selectionPivot,
  toggleSelectedId,
  translateSelectedObjects,
} from './buildSelectionMath';

export function selectionBounds(objects: SceneObject[]): THREE.Box3 {
  const box = new THREE.Box3();
  if (objects.length === 0) return box;
  objects.forEach((object) => {
    const half = new THREE.Vector3(...object.dimensions).multiplyScalar(0.5);
    const localBox = new THREE.Box3(half.clone().multiplyScalar(-1), half);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...object.transform.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(object.transform.rotation[0]),
        THREE.MathUtils.degToRad(object.transform.rotation[1]),
        THREE.MathUtils.degToRad(object.transform.rotation[2]),
        'XYZ',
      )),
      new THREE.Vector3(...object.transform.scale),
    );
    box.union(localBox.applyMatrix4(matrix));
  });
  return box;
}

export function sceneEnvelope(scene: SceneData, objects = scene.objects.filter((object) => object.visible && object.type !== 'sun_marker')): THREE.Box3 {
  const box = selectionBounds(objects);
  box.expandByPoint(new THREE.Vector3(...scene.panoOrigin));
  return box;
}
