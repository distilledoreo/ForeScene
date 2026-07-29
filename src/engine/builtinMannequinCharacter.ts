import * as THREE from 'three';
import type {
  HumanJointId,
  HumanPose,
  SceneObject,
} from '../domain/types';
import { HUMAN_JOINT_LABELS } from './humanPose';
import { createCanonicalHumanoidSkeleton, HUMAN_JOINT_PARENT } from './humanoidSkeleton';
import {
  createHumanMannequinObject,
  ensureHumanMannequinModel,
  isHumanMannequinModelReady,
} from './humanMannequinModel';
import {
  applySemanticPoseToBones,
  captureBoneRests,
  collectBonesByName,
  registerBuiltinPoseableCharacter,
  type BoneRestPose,
  type PoseableCharacter,
  type PoseableJoint,
} from './poseableCharacter';

/**
 * Quaternius Animated Human Mixamo-style bone names → semantic joints.
 * Project files never persist these strings.
 */
/**
 * Semantic joint → GLB bone name. Tip joints (handEnd / toeBase) are omitted:
 * they are autorig bind endpoints and must not alias the hand/foot bones (that
 * would wipe hand poses when applySemanticPoseToBones resets every joint id).
 */
export const BUILTIN_MANNEQUIN_BONE_MAP: Partial<Record<HumanJointId, string>> = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  leftUpperArm: 'LeftArm',
  leftLowerArm: 'LeftForeArm',
  leftHand: 'LeftHand',
  rightUpperArm: 'RightArm',
  rightLowerArm: 'RightForeArm',
  rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg',
  leftLowerLeg: 'LeftLeg',
  leftFoot: 'LeftFoot',
  leftToeBase: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg',
  rightLowerLeg: 'RightLeg',
  rightFoot: 'RightFoot',
  rightToeBase: 'RightToeBase',
};

const REST_USERDATA_KEY = 'panorefPoseRests';
const BONES_USERDATA_KEY = 'panorefPoseBones';

function createBuiltinMannequinCharacter(
  characterId: 'adult-male' | 'adult-female',
): PoseableCharacter {
  return {
    source: { kind: 'builtin', characterId },
    skeleton: createCanonicalHumanoidSkeleton(),

    async ensureLoaded() {
      await ensureHumanMannequinModel();
    },

    isReady() {
      return isHumanMannequinModelReady();
    },

    createInstance(object: SceneObject, material: THREE.MeshStandardMaterial) {
      return createHumanMannequinObject(object, material);
    },

    bindInstance(instance: THREE.Object3D) {
      if (instance.userData[BONES_USERDATA_KEY]) return;
      const byName = collectBonesByName(instance);
      const bones = new Map<HumanJointId, THREE.Bone>();
      for (const [jointId, boneName] of Object.entries(BUILTIN_MANNEQUIN_BONE_MAP) as Array<[HumanJointId, string | undefined]>) {
        if (!boneName) continue;
        const bone = byName.get(boneName);
        if (bone) bones.set(jointId, bone);
      }
      if (bones.size === 0) return;
      instance.userData[BONES_USERDATA_KEY] = bones;
      instance.userData[REST_USERDATA_KEY] = captureBoneRests(bones);
    },

    getJoints(instance: THREE.Object3D): readonly PoseableJoint[] {
      this.bindInstance(instance);
      const bones = instance.userData[BONES_USERDATA_KEY] as Map<HumanJointId, THREE.Bone> | undefined;
      if (!bones) return [];
      const joints: PoseableJoint[] = [];
      for (const [id, node] of bones) {
        joints.push({
          id,
          displayName: HUMAN_JOINT_LABELS[id],
          parentId: HUMAN_JOINT_PARENT[id],
          node,
        });
      }
      return joints;
    },

    applyPose(instance: THREE.Object3D, pose: HumanPose | undefined) {
      this.bindInstance(instance);
      const bones = instance.userData[BONES_USERDATA_KEY] as Map<HumanJointId, THREE.Bone> | undefined;
      const rests = instance.userData[REST_USERDATA_KEY] as Map<HumanJointId, BoneRestPose> | undefined;
      if (!bones || !rests) return;
      applySemanticPoseToBones({ bones, rests, pose });
    },
  };
}

registerBuiltinPoseableCharacter('adult-male', createBuiltinMannequinCharacter('adult-male'));
// Female uses the same GLB for now; future assets can diverge without changing pose storage.
registerBuiltinPoseableCharacter('adult-female', createBuiltinMannequinCharacter('adult-female'));
