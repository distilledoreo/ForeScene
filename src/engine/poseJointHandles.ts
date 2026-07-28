import * as THREE from 'three';
import type { HumanJointId } from '../domain/types';
import type { PoseableJoint } from './poseableCharacter';

const HANDLE_USERDATA = 'panorefPoseJointHandle';

/**
 * Direct joint handles for Pose Character mode.
 * Clickable spheres track live bone world positions without storing bone refs in pose data.
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
  if (!visible) {
    for (const child of group.children) child.visible = false;
    return;
  }

  const existing = new Map<string, THREE.Mesh>();
  for (const child of group.children) {
    const jointId = child.userData[HANDLE_USERDATA] as string | undefined;
    if (jointId) existing.set(jointId, child as THREE.Mesh);
  }

  const keep = new Set<string>();
  const world = new THREE.Vector3();
  for (const joint of joints) {
    keep.add(joint.id);
    let mesh = existing.get(joint.id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 14, 14),
        new THREE.MeshBasicMaterial({
          color: 0x3b82f6,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      mesh.userData[HANDLE_USERDATA] = joint.id;
      mesh.renderOrder = 21;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    joint.node.updateWorldMatrix(true, false);
    joint.node.getWorldPosition(world);
    mesh.position.copy(world);
    mesh.visible = true;
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.color.setHex(joint.id === selectedJointId ? 0xf59e0b : 0x38bdf8);
    material.opacity = joint.id === selectedJointId ? 1 : 0.9;
  }

  for (const [jointId, mesh] of existing) {
    if (keep.has(jointId)) continue;
    group.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
}

export function findPoseJointHandleHit(
  raycaster: THREE.Raycaster,
  group: THREE.Group | null | undefined,
): HumanJointId | undefined {
  if (!group || !group.visible) return undefined;
  const hits = raycaster.intersectObjects(group.children, false);
  const hit = hits[0];
  if (!hit) return undefined;
  const jointId = hit.object.userData[HANDLE_USERDATA] as HumanJointId | undefined;
  return jointId;
}

export function disposePoseJointHandleGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    (mesh.material as THREE.Material | undefined)?.dispose();
  }
}
