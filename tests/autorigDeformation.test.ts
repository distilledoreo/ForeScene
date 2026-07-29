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

/** Place a thin box centered on a bone segment so limb capsules enclose the mesh. */
function limbBoxAlongSegment(start: [number, number, number], end: [number, number, number], radius: number): THREE.Mesh {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dz = end[2] - start[2];
  const length = Math.max(Math.hypot(dx, dy, dz), 0.05);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(radius * 2, length, radius * 2));
  mesh.position.set(
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2,
    (start[2] + end[2]) / 2,
  );
  // Default box is Y-aligned; rotate so local +Y follows the bone.
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return mesh;
}

function makeFixture() {
  const markers = suggestAutorigMarkers({ size: [1.1, 1.75, 0.35], heightMeters: 1.75 });
  const fitted = fitSkeletonFromMarkers(markers);
  const jp = fitted.jointPositions;
  const root = new THREE.Group();
  // Torso box spans the chest; half-width stays inside the shoulder gate.
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.3));
  torso.position.set(0, 0.9, 0);
  // ~8cm half-thickness — thick enough that a fixed tiny capsule would miss, so
  // mesh-driven radii must expand to enclose these verts.
  const leftForearm = limbBoxAlongSegment(
    (jp.leftLowerArm ?? [0.4, 1.1, 0]) as [number, number, number],
    (jp.leftHand ?? [0.5, 0.85, 0]) as [number, number, number],
    0.08,
  );
  const rightForearm = limbBoxAlongSegment(
    (jp.rightLowerArm ?? [-0.4, 1.1, 0]) as [number, number, number],
    (jp.rightHand ?? [-0.5, 0.85, 0]) as [number, number, number],
    0.08,
  );
  root.add(torso, leftForearm, rightForearm);
  root.updateMatrixWorld(true);
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

  /**
   * Regression: inflated limb capsules + missing torso gate let arm bones claim
   * upper-chest vertices (~26% weight), so posing the arm dragged the torso.
   * Capsule shrink + lateral torso protection + region-aware smoothing must keep
   * arm influence on a near-shoulder torso sample under 5%.
   */
  it('keeps near-shoulder torso vertices free of arm-bone influence', () => {
    const markers = suggestAutorigMarkers({ size: [1.1, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers);
    // Chest surface cloud so mesh-driven torso radii engage, plus the historical
    // bleed probe at upper-right chest (x=0.2) near the shoulder.
    const positions: number[] = [];
    for (let ix = -2; ix <= 2; ix += 1) {
      for (let iy = 0; iy <= 3; iy += 1) {
        for (let iz = -1; iz <= 1; iz += 1) {
          positions.push(ix * 0.08, 1.05 + iy * 0.1, iz * 0.08);
        }
      }
    }
    const probeIndex = positions.length / 3;
    positions.push(0.2, 1.3, 0);
    const buffers = generateDeterministicSkinWeights({
      positions: Float32Array.from(positions),
      jointPositions: fitted.jointPositions,
      heightMeters: 1.75,
      meshSize: [1.1, 1.75, 0.35],
    });
    const armJointIndexes = new Set(
      (['leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'] as const)
        .map((id) => buffers.jointOrder.indexOf(id))
        .filter((index) => index >= 0),
    );
    const torsoJointIndexes = new Set(
      (['hips', 'spine', 'chest', 'neck'] as const)
        .map((id) => buffers.jointOrder.indexOf(id))
        .filter((index) => index >= 0),
    );
    let armWeight = 0;
    let torsoWeight = 0;
    const base = probeIndex * 4;
    for (let i = 0; i < 4; i += 1) {
      const joint = buffers.indices[base + i]!;
      const weight = buffers.weights[base + i]!;
      if (armJointIndexes.has(joint)) armWeight += weight;
      if (torsoJointIndexes.has(joint)) torsoWeight += weight;
    }
    expect(armWeight).toBeLessThan(0.05);
    expect(torsoWeight).toBeGreaterThan(0.9);
  });

  it('posing the left arm moves arm vertices without dragging the torso', () => {
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
      joints: {
        leftUpperArm: { rotation: eulerDegreesToQuaternion(70, 0, 25) },
        leftLowerArm: { rotation: eulerDegreesToQuaternion(90, 0, 0) },
      },
    };
    applySemanticPoseToBones({
      bones,
      rests: captureBoneRests(bones),
      pose,
      canonicalPoseBases: fixture.rig.canonicalPoseBases,
    });
    skinned.updateMatrixWorld(true);
    const after = vertexPositions(skinned);

    // Classify bind vertices from the fixture: torso box |x|≤0.2; left forearm
    // follows the fitted lower-arm bone (x well past the shoulder).
    const leftShoulderX = Math.abs(fixture.fitted.jointPositions.leftUpperArm?.[0] ?? 0.24);
    let maxTorsoDelta = 0;
    let maxArmDelta = 0;
    let torsoSamples = 0;
    let armSamples = 0;
    for (let i = 0; i < before.length; i += 3) {
      const bx = before[i]!;
      const by = before[i + 1]!;
      const bz = before[i + 2]!;
      const dx = after[i]! - bx;
      const dy = after[i + 1]! - by;
      const dz = after[i + 2]! - bz;
      const delta = Math.hypot(dx, dy, dz);
      // Interior torso corners of the chest box.
      if (Math.abs(bx) <= 0.21 && by > 0.55 && by < 1.35 && Math.abs(bz) <= 0.16) {
        maxTorsoDelta = Math.max(maxTorsoDelta, delta);
        torsoSamples += 1;
      }
      // Left forearm past the shoulder joint.
      if (bx > leftShoulderX + 0.05 && by > 0.7 && by < 1.3) {
        maxArmDelta = Math.max(maxArmDelta, delta);
        armSamples += 1;
      }
    }
    expect(torsoSamples).toBeGreaterThan(0);
    expect(armSamples).toBeGreaterThan(0);
    // Arm must actually deform.
    expect(maxArmDelta).toBeGreaterThan(0.05);
    // Torso interior must stay put (no arm-weight drag).
    expect(maxTorsoDelta).toBeLessThan(0.02);
  });
});
