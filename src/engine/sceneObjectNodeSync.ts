import * as THREE from 'three';
import type { AssetRegistry, HumanPose, SceneObject, Transform } from '../domain/types';
import { humanPosesEqual } from './humanPose';
import { transformsEqual } from './shotSceneState';
import { applySceneObjectTransform, sceneObjectUsesProceduralScale } from './sceneObjects';
import { applyHumanPoseToObject3D } from './poseableCharacter';

export interface ObjectSyncSnapshot {
  name: string;
  transform: Transform;
  visible: boolean;
  humanPose: HumanPose | undefined;
}

export function snapshotSceneObject(object: SceneObject): ObjectSyncSnapshot {
  return {
    name: object.name,
    transform: object.transform,
    visible: object.visible,
    humanPose: object.humanPose,
  };
}

export function objectSyncSnapshotsEqual(
  a: ObjectSyncSnapshot | undefined,
  b: ObjectSyncSnapshot,
): boolean {
  if (!a) return false;
  return a.name === b.name
    && a.visible === b.visible
    && transformsEqual(a.transform, b.transform)
    && humanPosesEqual(a.humanPose, b.humanPose);
}

/**
 * Apply transform/pose updates only for objects whose snapshot changed.
 * Uses a persistent node map (no full scene traverse).
 */
export function diffAndApplySceneObjectUpdates(params: {
  nodes: Map<string, THREE.Object3D>;
  objects: readonly SceneObject[];
  previous: Map<string, ObjectSyncSnapshot>;
  assets?: AssetRegistry;
}): {
  appliedIds: string[];
  skippedIds: string[];
  nextPrevious: Map<string, ObjectSyncSnapshot>;
} {
  const appliedIds: string[] = [];
  const skippedIds: string[] = [];
  const nextPrevious = new Map<string, ObjectSyncSnapshot>();
  const liveIds = new Set<string>();

  for (const object of params.objects) {
    liveIds.add(object.id);
    const snapshot = snapshotSceneObject(object);
    nextPrevious.set(object.id, snapshot);
    const node = params.nodes.get(object.id);
    if (!node) {
      skippedIds.push(object.id);
      continue;
    }
    const prev = params.previous.get(object.id);
    if (objectSyncSnapshotsEqual(prev, snapshot)) {
      skippedIds.push(object.id);
      continue;
    }

    const transformChanged = !prev || !transformsEqual(prev.transform, snapshot.transform)
      || prev.visible !== snapshot.visible
      || prev.name !== snapshot.name;
    const poseChanged = !prev || !humanPosesEqual(prev.humanPose, snapshot.humanPose);

    if (transformChanged) {
      node.name = object.name;
      applySceneObjectTransform(node, object.transform, {
        applyScale: !sceneObjectUsesProceduralScale(object.type),
        visible: object.visible,
      });
    }
    if (poseChanged || transformChanged) {
      // Pose may need re-bind after structural scale changes; cheap when pose equal after first apply.
      applyHumanPoseToObject3D(node, object, params.assets);
    }
    appliedIds.push(object.id);
  }

  // Drop snapshots for removed objects.
  for (const id of params.previous.keys()) {
    if (!liveIds.has(id)) {
      // left out of nextPrevious intentionally
    }
  }

  return { appliedIds, skippedIds, nextPrevious };
}

/**
 * Build a persistent scene-object node registry from a Three.js scene once.
 * Prefer this over re-traversing on every pose/transform edit.
 */
export function buildSceneObjectNodeMap(scene: THREE.Object3D): Map<string, THREE.Object3D> {
  const map = new Map<string, THREE.Object3D>();
  scene.traverse((node) => {
    const objectId = node.userData.sceneObjectId as string | undefined;
    if (objectId) map.set(objectId, node);
  });
  return map;
}
