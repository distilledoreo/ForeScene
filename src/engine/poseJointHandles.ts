import * as THREE from 'three';
import type { HumanJointId } from '../domain/types';
import type { PoseableJoint } from './poseableCharacter';

const HANDLE_USERDATA = 'panorefPoseJointHandle';
const HANDLE_RADIUS = 0.07;

/**
 * Direct joint handles for Pose Character mode.
 * Handles are parented to live bones so they track posed skeletons without
 * storing bone refs in persisted pose data.
 */
export function createPoseJointHandleGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'pose-joint-handles';
  group.renderOrder = 20;
  group.frustumCulled = false;
  return group;
}

export function syncPoseJointHandles(params: {
  group: THREE.Group;
  joints: readonly PoseableJoint[];
  selectedJointId?: HumanJointId;
  visible: boolean;
}): void {
  const { group, joints, selectedJointId, visible } = params;
  group.visible = visible;

  const existing = new Map<string, THREE.Mesh>();
  for (const child of [...group.children]) {
    const jointId = child.userData[HANDLE_USERDATA] as string | undefined;
    if (jointId) existing.set(jointId, child as THREE.Mesh);
  }

  if (!visible) {
    for (const mesh of existing.values()) {
      mesh.removeFromParent();
      mesh.visible = false;
      group.add(mesh);
    }
    return;
  }

  const keep = new Set<string>();
  for (const joint of joints) {
    keep.add(joint.id);
    let mesh = existing.get(joint.id);
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
    }

    // Parent to the bone in local space so posed limbs carry their handles.
    if (mesh.parent !== joint.node) {
      joint.node.add(mesh);
    }
    mesh.position.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
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

  for (const [jointId, mesh] of existing) {
    if (keep.has(jointId)) continue;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
}

export function findPoseJointHandleHit(
  raycaster: THREE.Raycaster,
  group: THREE.Group | null | undefined,
  joints: readonly PoseableJoint[] = [],
): HumanJointId | undefined {
  const targets: THREE.Object3D[] = [];
  if (group?.visible) {
    for (const child of group.children) {
      if (child.userData[HANDLE_USERDATA]) targets.push(child);
    }
  }
  for (const joint of joints) {
    for (const child of joint.node.children) {
      if (child.userData[HANDLE_USERDATA]) targets.push(child);
    }
  }
  if (targets.length === 0) return undefined;
  const hits = raycaster.intersectObjects(targets, false);
  const hit = hits[0];
  if (!hit) return undefined;
  return hit.object.userData[HANDLE_USERDATA] as HumanJointId | undefined;
}

export function disposePoseJointHandleGroup(group: THREE.Group): void {
  // Handles may be parented to bones; gather from group and detach leftovers.
  const meshes = new Set<THREE.Mesh>();
  group.traverse((node) => {
    if (node.userData[HANDLE_USERDATA]) meshes.add(node as THREE.Mesh);
  });
  for (const child of [...group.children]) {
    if (child.userData[HANDLE_USERDATA]) meshes.add(child as THREE.Mesh);
  }
  for (const mesh of meshes) {
    mesh.removeFromParent();
    mesh.geometry?.dispose();
    (mesh.material as THREE.Material | undefined)?.dispose();
  }
}
