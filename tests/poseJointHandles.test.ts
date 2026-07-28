import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { HumanJointId } from '../src/domain/types';
import {
  createPoseJointHandleGroup,
  disposePoseJointHandleGroup,
  syncPoseJointHandles,
} from '../src/engine/poseJointHandles';
import type { PoseableJoint } from '../src/engine/poseableCharacter';

function makeJoint(id: HumanJointId): PoseableJoint {
  const node = new THREE.Bone();
  node.name = id;
  return { id, displayName: id, node };
}

describe('pose joint handle lifecycle', () => {
  it('tracks reparented bone handles in an explicit registry for hide/dispose', () => {
    const group = createPoseJointHandleGroup();
    const left = makeJoint('leftUpperArm');
    const right = makeJoint('rightUpperArm');
    const root = new THREE.Group();
    root.add(left.node, right.node);

    syncPoseJointHandles({
      group,
      joints: [left, right],
      selectedJointId: 'leftUpperArm',
      visible: true,
    });

    expect(left.node.children).toHaveLength(1);
    expect(right.node.children).toHaveLength(1);
    expect(group.children).toHaveLength(0);

    syncPoseJointHandles({
      group,
      joints: [left, right],
      visible: false,
    });

    expect(left.node.children).toHaveLength(0);
    expect(right.node.children).toHaveLength(0);
    expect(group.children).toHaveLength(2);
    expect(group.children.every((child) => child.visible === false)).toBe(true);

    syncPoseJointHandles({
      group,
      joints: [left, right],
      visible: true,
    });
    // Re-enter pose mode should reuse the same meshes, not duplicate them.
    expect(left.node.children).toHaveLength(1);
    expect(right.node.children).toHaveLength(1);

    disposePoseJointHandleGroup(group);
    expect(left.node.children).toHaveLength(0);
    expect(right.node.children).toHaveLength(0);
    expect(group.children).toHaveLength(0);
  });
});
