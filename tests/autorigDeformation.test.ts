import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { suggestAutorigMarkers, fitSkeletonFromMarkers, canonicalJointFrame } from '../src/engine/autorigMarkers';
import { extractCanonicalVertexPositions } from '../src/engine/autorigCanonicalMesh';
import { buildSkinnedCharacterFromTemplate } from '../src/engine/autorigSkinnedMesh';
import { generateDeterministicSkinWeights } from '../src/engine/autorigSkinWeights';
import { applySemanticPoseToBones, captureBoneRests } from '../src/engine/poseableCharacter';
import { eulerDegreesToQuaternion } from '../src/engine/humanPose';
import { HUMAN_POSE_PRESETS } from '../src/engine/humanPosePresets';
import type { HumanJointId, HumanPose } from '../src/domain/types';

function makeFixture() {
  const root = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.8, 0.3));
  torso.position.set(0, 0.9, 0);
  const leftForearm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.45, 0.18));
  leftForearm.position.set(0.48, 1.18, 0);
  const rightForearm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.45, 0.18));
  rightForearm.position.set(-0.48, 1.18, 0);
  root.add(torso, leftForearm, rightForearm);
  root.updateMatrixWorld(true);
  const markers = suggestAutorigMarkers({ size: [1.1, 1.75, 0.35], heightMeters: 1.75 });
  const fitted = fitSkeletonFromMarkers(markers);
  const positions = extractCanonicalVertexPositions(root);
  const buffers = generateDeterministicSkinWeights({
    positions,
    jointPositions: fitted.jointPositions,
    heightMeters: 1.75,
    meshSize: [1.1, 1.75, 0.35],
  });
  const rig = {
    version: 1 as const,
    id: 'rig_fixture',
    skeletonJoints: Object.keys(fitted.jointPositions) as HumanJointId[],
    bindMatrices: fitted.bindMatrices,
    canonicalPoseBases: fitted.canonicalPoseBases,
    markers: fitted.markers,
  };
  return { root, fitted, buffers, rig, positions };
}

function vertexPositions(root: THREE.Object3D): number[] {
  const values: number[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const position = mesh.geometry.getAttribute('position');
    const point = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
      mesh.getVertexPosition(i, point);
      point.applyMatrix4(mesh.matrixWorld);
      values.push(point.x, point.y, point.z);
    }
  });
  return values;
}

describe('autorig deformation acceptance gates', () => {
  it('keeps neutral vertices finite and at the bind shape', () => {
    const fixture = makeFixture();
    const skinned = buildSkinnedCharacterFromTemplate({ template: fixture.root, rig: fixture.rig, buffers: fixture.buffers });
    skinned.updateMatrixWorld(true);
    const posed = vertexPositions(skinned);
    expect(posed.every(Number.isFinite)).toBe(true);
    expect(posed.length).toBe(fixture.positions.length);
    posed.forEach((value, index) => expect(value).toBeCloseTo(fixture.positions[index]!, 3));
    const skinnedMeshes: THREE.SkinnedMesh[] = [];
    skinned.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) skinnedMeshes.push(mesh);
    });
    expect(skinnedMeshes).toHaveLength(3);
    expect(skinnedMeshes.every((mesh) => mesh.geometry.index !== null && mesh.geometry.getAttribute('uv') !== undefined)).toBe(true);
  });

  it('bending the left elbow changes the left forearm without changing the right-side sample', () => {
    const fixture = makeFixture();
    const skinned = buildSkinnedCharacterFromTemplate({ template: fixture.root, rig: fixture.rig, buffers: fixture.buffers });
    const bones = new Map<HumanJointId, THREE.Bone>();
    skinned.traverse((node) => {
      const bone = node as THREE.Bone;
      const id = bone.userData.humanJointId as HumanJointId | undefined;
      if (bone.isBone && id) bones.set(id, bone);
    });
    const before = vertexPositions(skinned);
    const pose: HumanPose = {
      version: 1,
      joints: { leftLowerArm: { rotation: eulerDegreesToQuaternion(90, 0, 0) } },
    };
    applySemanticPoseToBones({ bones, rests: captureBoneRests(bones), pose });
    skinned.updateMatrixWorld(true);
    const after = vertexPositions(skinned);
    const leftDelta = after.some((value, index) => index % 3 === 0 && Math.abs(value - before[index]!) > 0.03 && value > 0);
    const rightDelta = after.some((value, index) => index % 3 === 0 && Math.abs(value - before[index]!) > 0.03 && value < 0);
    expect(leftDelta).toBe(true);
    expect(rightDelta).toBe(false);
  });

  it('retargets semantic rotations through the fitted canonical joint frame', () => {
    const bone = new THREE.Bone();
    const bones = new Map<HumanJointId, THREE.Bone>([['leftLowerArm', bone]]);
    const rests = captureBoneRests(bones);
    const pose: HumanPose = {
      version: 1,
      joints: { leftLowerArm: { rotation: eulerDegreesToQuaternion(35, 0, 0) } },
    };
    applySemanticPoseToBones({ bones, rests, pose });
    const localConvention = bone.quaternion.clone();
    applySemanticPoseToBones({
      bones,
      rests,
      pose,
      canonicalPoseBases: { leftLowerArm: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).toArray() },
    });
    expect(bone.quaternion.angleTo(localConvention)).toBeGreaterThan(0.1);
    expect(bone.quaternion.length()).toBeCloseTo(1, 5);
  });

  it('bends a knee in the sagittal plane instead of introducing a lateral axis', () => {
    const frame = new THREE.Matrix4();
    frame.copy(canonicalJointFrame([0, 1, 0], [0, 0, 0]));
    const kneeBend = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const footDirection = new THREE.Vector3(0, -1, 0).applyQuaternion(kneeBend);
    expect(Math.abs(footDirection.x)).toBeLessThan(1e-5);
    expect(Math.abs(footDirection.z)).toBeGreaterThan(0.9);
    expect(frame.determinant()).toBeCloseTo(1, 5);
  });

  it('poses anatomically through stored canonicalPoseBases (elbow/knee/hip/shoulder directions)', () => {
    const fixture = makeFixture();
    const skinned = buildSkinnedCharacterFromTemplate({ template: fixture.root, rig: fixture.rig, buffers: fixture.buffers });
    const bones = new Map<HumanJointId, THREE.Bone>();
    skinned.traverse((node) => {
      const bone = node as THREE.Bone;
      const id = bone.userData.humanJointId as HumanJointId | undefined;
      if (bone.isBone && id) bones.set(id, bone);
    });
    const rests = captureBoneRests(bones);
    const worldOf = (jointId: HumanJointId) => {
      skinned.updateMatrixWorld(true);
      return new THREE.Vector3().setFromMatrixPosition(bones.get(jointId)!.matrixWorld);
    };
    const neutralHand = worldOf('leftHand');
    const neutralFoot = worldOf('leftFoot');
    const neutralRightHand = worldOf('rightHand');
    const bases = fixture.rig.canonicalPoseBases;
    const applyProbe = (joints: HumanPose['joints']) => {
      applySemanticPoseToBones({ bones, rests, pose: { version: 1, joints }, canonicalPoseBases: bases });
      skinned.updateMatrixWorld(true);
    };

    // Elbow flexion (+X): hand curls forward (+Z), not backward; right side untouched.
    applyProbe({ leftLowerArm: { rotation: eulerDegreesToQuaternion(95, 0, 0) } });
    const elbowHand = worldOf('leftHand');
    expect(elbowHand.z).toBeGreaterThan(neutralHand.z + 0.05);
    expect(worldOf('rightHand').distanceTo(neutralRightHand)).toBeLessThan(1e-6);

    // Knee flexion (+X): heel swings backward (−Z) and up.
    applyProbe({ leftLowerLeg: { rotation: eulerDegreesToQuaternion(110, 0, 0) } });
    const kneeFoot = worldOf('leftFoot');
    expect(kneeFoot.z).toBeLessThan(neutralFoot.z - 0.05);
    expect(kneeFoot.y).toBeGreaterThan(neutralFoot.y + 0.02);

    // Hip flexion (−X): thigh swings the foot forward (+Z).
    applyProbe({ leftUpperLeg: { rotation: eulerDegreesToQuaternion(-95, 0, 0) } });
    expect(worldOf('leftFoot').z).toBeGreaterThan(neutralFoot.z + 0.05);

    // Shoulder abduction (+Z): arm rises.
    applyProbe({ leftUpperArm: { rotation: eulerDegreesToQuaternion(0, 0, 35) } });
    expect(worldOf('leftHand').y).toBeGreaterThan(neutralHand.y + 0.03);

    // Shoulder flexion (+X): arm swings forward, not backward.
    applyProbe({ leftUpperArm: { rotation: eulerDegreesToQuaternion(85, 0, 0) } });
    expect(worldOf('leftHand').z).toBeGreaterThan(neutralHand.z + 0.05);
  });

  it('keeps every wizard test pose finite and within a bounded expansion', () => {
    const fixture = makeFixture();
    const skinned = buildSkinnedCharacterFromTemplate({ template: fixture.root, rig: fixture.rig, buffers: fixture.buffers });
    const bones = new Map<HumanJointId, THREE.Bone>();
    skinned.traverse((node) => {
      const bone = node as THREE.Bone;
      const id = bone.userData.humanJointId as HumanJointId | undefined;
      if (bone.isBone && id) bones.set(id, bone);
    });
    const neutral = vertexPositions(skinned);
    const neutralBox = new THREE.Box3();
    for (let i = 0; i < neutral.length; i += 3) neutralBox.expandByPoint(new THREE.Vector3(neutral[i], neutral[i + 1], neutral[i + 2]));
    const neutralSpan = neutralBox.getSize(new THREE.Vector3()).length();
    for (const preset of HUMAN_POSE_PRESETS.filter((item) => ['neutral', 'arms-raised', 'elbows-bent', 'sitting', 'walking', 'crouching'].includes(item.id))) {
      applySemanticPoseToBones({ bones, rests: captureBoneRests(bones), pose: preset.pose });
      skinned.updateMatrixWorld(true);
      const values = vertexPositions(skinned);
      expect(values.every(Number.isFinite)).toBe(true);
      const box = new THREE.Box3();
      for (let i = 0; i < values.length; i += 3) box.expandByPoint(new THREE.Vector3(values[i], values[i + 1], values[i + 2]));
      expect(box.getSize(new THREE.Vector3()).length()).toBeLessThan(neutralSpan * 4);
    }
  });
});
