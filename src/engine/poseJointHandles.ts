import * as THREE from 'three';
import type { HumanJointId } from '../domain/types';
import type { PoseableJoint } from './poseableCharacter';

const HANDLE_USERDATA = 'panorefPoseJointHandle';
const HANDLES_BY_JOINT_KEY = 'handlesByJoint';
const HANDLE_RADIUS = 0.07;

type HandleRegistry = Map<HumanJointId, THREE.Mesh>;

/**
 * Direct joint handles for Pose Character mode.
 * Handles are parented to live bones so they track posed skeletons without
 * storing bone refs in persisted pose data.
 *
 * Lifecycle uses an explicit registry on the overlay group because active
 * handles are reparented off `group.children` onto bones.
 */
export function createPoseJointHandleGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'pose-joint-handles';
  group.renderOrder = 20;
  group.frustumCulled = false;
  group.userData[HANDLES_BY_JOINT_KEY] = new Map<HumanJointId, THREE.Mesh>();
  return group;
}

function getHandleRegistry(group: THREE.Group): HandleRegistry {
  let registry = group.userData[HANDLES_BY_JOINT_KEY] as HandleRegistry | undefined;
  if (!registry) {
    registry = new Map<HumanJointId, THREE.Mesh>();
    group.userData[HANDLES_BY_JOINT_KEY] = registry;
  }
  return registry;
}

export function syncPoseJointHandles(params: {
  group: THREE.Group;
  joints: readonly PoseableJoint[];
  selectedJointId?: HumanJointId;
  visible: boolean;
}): void {
  const { group, joints, selectedJointId, visible } = params;
  group.visible = visible;
  const registry = getHandleRegistry(group);

  if (!visible) {
    for (const mesh of registry.values()) {
      mesh.visible = false;
      if (mesh.parent !== group) {
        mesh.removeFromParent();
        group.add(mesh);
      }
    }
    return;
  }

  const keep = new Set<HumanJointId>();
  for (const joint of joints) {
    keep.add(joint.id);
    let mesh = registry.get(joint.id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(HANDLE_RADIUS, 14, 14),
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      mesh.userData[HANDLE_USERDATA] = joint.id;
      mesh.renderOrder = 21;
      mesh.frustumCulled = false;
      registry.set(joint.id, mesh);
    }

    // Parent to the bone in local space so posed limbs carry their handles.
    if (mesh.parent !== joint.node) {
      joint.node.add(mesh);
    }
    mesh.position.set(0, 0, 0);
    mesh.visible = true;

    // Counter-scale so handles stay readable if the character root is scaled.
    const worldScale = new THREE.Vector3();
    joint.node.getWorldScale(worldScale);
    const sx = Math.max(worldScale.x, 1e-4);
    const sy = Math.max(worldScale.y, 1e-4);
    const sz = Math.max(worldScale.z, 1e-4);
    mesh.scale.set(1 / sx, 1 / sy, 1 / sz);

    const material = mesh.material as THREE.MeshBasicMaterial;
    material.color.setHex(joint.id === selectedJointId ? 0xf59e0b : 0x38bdf8);
    material.opacity = joint.id === selectedJointId ? 1 : 0.92;
  }

  for (const [jointId, mesh] of [...registry.entries()]) {
    if (keep.has(jointId)) continue;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    registry.delete(jointId);
  }
}

export function findPoseJointHandleHit(
  raycaster: THREE.Raycaster,
  group: THREE.Group | null | undefined,
  joints: readonly PoseableJoint[] = [],
): HumanJointId | undefined {
  const targets: THREE.Object3D[] = [];
  if (group) {
    for (const mesh of getHandleRegistry(group).values()) {
      if (mesh.visible) targets.push(mesh);
    }
  }
  // Fallback for callers that only have live joints.
  for (const joint of joints) {
    for (const child of joint.node.children) {
      if (child.userData[HANDLE_USERDATA] && !targets.includes(child)) {
        targets.push(child);
      }
    }
  }
  if (targets.length === 0) return undefined;
  const hits = raycaster.intersectObjects(targets, false);
  const hit = hits[0];
  if (!hit) return undefined;
  return hit.object.userData[HANDLE_USERDATA] as HumanJointId | undefined;
}

export function disposePoseJointHandleGroup(group: THREE.Group): void {
  const registry = getHandleRegistry(group);
  for (const mesh of registry.values()) {
    mesh.removeFromParent();
    mesh.geometry?.dispose();
    (mesh.material as THREE.Material | undefined)?.dispose();
  }
  registry.clear();
  for (const child of [...group.children]) {
    if (!child.userData[HANDLE_USERDATA]) continue;
    group.remove(child);
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    (mesh.material as THREE.Material | undefined)?.dispose();
  }
}
