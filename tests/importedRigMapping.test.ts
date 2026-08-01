import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { HumanJointId } from '../src/domain/types';
import { applySemanticPoseToBones, captureBoneRests } from '../src/engine/poseableCharacter';
import { createEmptyHumanPose, eulerDegreesToQuaternion } from '../src/engine/humanPose';
import { analyzeHumanoidSkeleton } from '../src/engine/importedRig/analyzeSkeleton';
import { calculateCanonicalPoseBases, validateCanonicalPoseBases } from '../src/engine/importedRig/canonicalFrames';
import { getRootRelativeNodePath, resolveRootRelativeNodePath } from '../src/engine/importedRig/bonePaths';
import { validateHumanoidMapping } from '../src/engine/importedRig/mappingValidation';
import { sourceBoneSide } from '../src/engine/importedRig/mappingProfiles';

function createSourceRig(): { root: THREE.Group; bones: THREE.Bone[] } {
  const root = new THREE.Group();
  const armature = new THREE.Group();
  armature.name = 'Armature';
  root.add(armature);
  const bones: THREE.Bone[] = [];
  const add = (name: string, position: [number, number, number], parent: THREE.Object3D = armature): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = `mixamorig:${name}`;
    bone.position.set(...position);
    parent.add(bone);
    bones.push(bone);
    return bone;
  };
  const hips = add('Hips', [0, 1, 0]);
  const spine = add('Spine', [0, 0.2, 0], hips);
  const chest = add('Spine1', [0, 0.2, 0], spine);
  const upperSpine = add('Spine2', [0, 0.2, 0], chest);
  const neck = add('Neck', [0, 0.2, 0], upperSpine);
  add('Head', [0, 0.2, 0], neck);
  add('LeftShoulder', [-0.15, 0.1, 0], upperSpine);
  const leftArm = add('LeftArm', [-0.35, 0, 0], upperSpine);
  const leftForeArm = add('LeftForeArm', [-0.35, 0, 0], leftArm);
  add('LeftHand', [-0.3, 0, 0], leftForeArm);
  add('RightShoulder', [0.15, 0.1, 0], upperSpine);
  const rightArm = add('RightArm', [0.35, 0, 0], upperSpine);
  const rightForeArm = add('RightForeArm', [0.35, 0, 0], rightArm);
  add('RightHand', [0.3, 0, 0], rightForeArm);
  const leftLeg = add('LeftUpLeg', [-0.15, -0.45, 0], hips);
  add('LeftLeg', [0, -0.45, 0], leftLeg);
  const leftLower = bones[bones.length - 1]!;
  add('LeftFoot', [0, -0.4, 0.15], leftLower);
  const rightLeg = add('RightUpLeg', [0.15, -0.45, 0], hips);
  add('RightLeg', [0, -0.45, 0], rightLeg);
  const rightLower = bones[bones.length - 1]!;
  add('RightFoot', [0, -0.4, 0.15], rightLower);
  root.updateMatrixWorld(true);
  return { root, bones };
}

describe('imported rig mapping', () => {
  it('uses token-aware side detection', () => {
    expect(sourceBoneSide('Leg_R')).toBe('right');
    expect(sourceBoneSide('LowerLeg.R')).toBe('right');
    expect(sourceBoneSide('arm_L')).toBe('left');
    expect(sourceBoneSide('mixamorig:LeftArm')).toBe('left');
    expect(sourceBoneSide('L_Arm')).toBe('left');
    expect(sourceBoneSide('Root')).toBeUndefined();
    expect(sourceBoneSide('Radius')).toBeUndefined();
  });

  it('maps namespaced Mixamo bones and resolves indexed paths', () => {
    const source = createSourceRig();
    const analysis = analyzeHumanoidSkeleton(source);
    expect(analysis.detectedProfile).toBe('mixamo');
    expect(analysis.requiredMissing).toEqual([]);
    expect(analysis.boneMap.leftUpperArm).toContain('LeftArm');
    const arm = resolveRootRelativeNodePath(source.root, analysis.boneMap.leftUpperArm!);
    expect(arm?.name).toBe('mixamorig:LeftArm');
    expect(getRootRelativeNodePath(source.root, arm!)).toBe(analysis.boneMap.leftUpperArm);
    expect(analysis.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('rejects duplicate semantic assignments and mirrored sides', () => {
    const source = createSourceRig();
    const analysis = analyzeHumanoidSkeleton(source);
    const map = {
      ...analysis.boneMap,
      rightUpperArm: analysis.boneMap.leftUpperArm,
    } as Partial<Record<HumanJointId, string>>;
    const validation = validateHumanoidMapping({ root: source.root, boneMap: map });
    expect(validation.ok).toBe(false);
    expect(validation.duplicateAssignments.length).toBeGreaterThan(0);
    expect(validation.sideMismatches).toContain('rightUpperArm');
  });

  it('creates normalized canonical frames and resets imported bones to exact rest', () => {
    const source = createSourceRig();
    const analysis = analyzeHumanoidSkeleton(source);
    const bases = calculateCanonicalPoseBases({ root: source.root, boneMap: analysis.boneMap });
    expect(validateCanonicalPoseBases(bases)).toEqual([]);
    const boneMap = new Map<HumanJointId, THREE.Bone>();
    for (const [jointId, path] of Object.entries(analysis.boneMap) as Array<[HumanJointId, string]>) {
      const bone = resolveRootRelativeNodePath(source.root, path);
      if (bone instanceof THREE.Bone) boneMap.set(jointId, bone);
    }
    const rests = captureBoneRests(boneMap);
    const pose = { ...createEmptyHumanPose(), joints: { leftUpperArm: { rotation: eulerDegreesToQuaternion(20, 0, 0) } } };
    applySemanticPoseToBones({ bones: boneMap, rests, pose, canonicalPoseBases: bases });
    expect(boneMap.get('leftUpperArm')!.quaternion.equals(rests.get('leftUpperArm')!.quaternion)).toBe(false);
    applySemanticPoseToBones({ bones: boneMap, rests, pose: createEmptyHumanPose(), canonicalPoseBases: bases });
    expect(boneMap.get('leftUpperArm')!.quaternion.equals(rests.get('leftUpperArm')!.quaternion)).toBe(true);
  });

  it('deforms a skinned vertex while preserving source weights', () => {
    const source = createSourceRig();
    const analysis = analyzeHumanoidSkeleton(source);
    const leftArm = resolveRootRelativeNodePath(source.root, analysis.boneMap.leftUpperArm!) as THREE.Bone;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.add(leftArm.clone());
    const instanceBone = mesh.children[0] as THREE.Bone;
    mesh.bind(new THREE.Skeleton([instanceBone]));
    const weightsBefore = [...(geometry.getAttribute('skinWeight').array as Float32Array)];
    const before = mesh.getVertexPosition(0, new THREE.Vector3()).clone();
    instanceBone.rotation.z = Math.PI / 2;
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    const after = mesh.getVertexPosition(0, new THREE.Vector3());
    expect(after.distanceTo(before)).toBeGreaterThan(0.01);
    expect([...((geometry.getAttribute('skinWeight').array) as Float32Array)]).toEqual(weightsBefore);
  });
});
