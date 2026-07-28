import * as THREE from 'three';
import type {
  AssetRegistry,
  HumanJointId,
  HumanPose,
  PoseableCharacterSource,
  SceneObject,
} from '../domain/types';
import {
  HUMAN_JOINT_IDS,
  IDENTITY_QUATERNION,
  normalizePoseableCharacterSource,
} from './humanPose';
import {
  type HumanoidSkeleton,
} from './humanoidSkeleton';

export interface PoseableJoint {
  id: HumanJointId;
  displayName: string;
  parentId?: HumanJointId;
  /** Live bone node on a character instance. */
  node: THREE.Bone;
}

/**
 * Rig-agnostic poseable character contract.
 * Built-in mannequins and future autorigged imports both implement this.
 *
 * Conceptual shape (adapters bind instances for Three.js rendering):
 *   { skeleton: HumanoidSkeleton; applyPose(pose: HumanPose): void }
 */
export interface PoseableCharacter {
  readonly source: PoseableCharacterSource;
  /** Canonical semantic hierarchy + joint limits (not GLB-specific). */
  readonly skeleton: HumanoidSkeleton;
  ensureLoaded(): Promise<void>;
  isReady(): boolean;
  createInstance(
    object: SceneObject,
    material: THREE.MeshStandardMaterial,
  ): THREE.Object3D;
  /**
   * Capture rest local transforms for joints on an instance.
   * Called once after createInstance when the GLB is ready.
   */
  bindInstance(instance: THREE.Object3D): void;
  getJoints(instance: THREE.Object3D): readonly PoseableJoint[];
  applyPose(instance: THREE.Object3D, pose: HumanPose | undefined): void;
}

export function getPoseableCharacterSource(
  object: Pick<SceneObject, 'type' | 'poseableCharacter'>,
): PoseableCharacterSource | undefined {
  return normalizePoseableCharacterSource(object.poseableCharacter, object.type);
}

export function resolvePoseableCharacter(
  source: PoseableCharacterSource | undefined,
  _assets?: AssetRegistry,
): PoseableCharacter | undefined {
  if (!source) return undefined;
  if (source.kind === 'builtin') {
    // Registry populated by builtinMannequinCharacter side-effect import.
    return builtinPoseableCharacters.get(source.characterId);
  }
  // Adapters are registered at import time and re-hydrated on project parse /
  // ensureAutoriggedCharactersForProject (see autoriggedPoseableCharacter.ts).
  return autoriggedPoseableCharacters.get(`${source.assetId}:${source.rigId}`);
}

export function resolvePoseableCharacterForObject(
  object: Pick<SceneObject, 'type' | 'poseableCharacter'>,
  assets?: AssetRegistry,
): PoseableCharacter | undefined {
  return resolvePoseableCharacter(getPoseableCharacterSource(object), assets);
}

const builtinPoseableCharacters = new Map<string, PoseableCharacter>();
const autoriggedPoseableCharacters = new Map<string, PoseableCharacter>();

/** Register the built-in mannequin adapter (called from builtinMannequinCharacter). */
export function registerBuiltinPoseableCharacter(
  characterId: 'adult-male' | 'adult-female',
  character: PoseableCharacter,
): void {
  builtinPoseableCharacters.set(characterId, character);
}

/** Future: register an autorigged character after Milestone B generation. */
export function registerAutoriggedPoseableCharacter(
  assetId: string,
  rigId: string,
  character: PoseableCharacter,
): void {
  autoriggedPoseableCharacters.set(`${assetId}:${rigId}`, character);
}

export const SKINNED_MESHES_USERDATA_KEY = 'panorefSkinnedMeshes';

export function applyHumanPoseToObject3D(
  instance: THREE.Object3D,
  object: Pick<SceneObject, 'type' | 'poseableCharacter' | 'humanPose'>,
): void {
  const character = resolvePoseableCharacterForObject(object);
  if (!character) return;
  if (!character.isReady()) return;
  character.bindInstance(instance);
  character.applyPose(instance, object.humanPose);
  // Demand-rendered viewports may not tick; force skinned bone matrices once here.
  // Adapters must not also traverse/update skeletons (single owner).
  updateSkinnedMeshes(instance);
}

/** Single owner of skeleton matrix updates after pose apply. Prefer cached mesh list. */
export function updateSkinnedMeshes(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const cached = root.userData[SKINNED_MESHES_USERDATA_KEY] as THREE.SkinnedMesh[] | undefined;
  if (cached && cached.length > 0) {
    for (const mesh of cached) {
      if (mesh.isSkinnedMesh) mesh.skeleton.update();
    }
    return;
  }
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.skeleton.update();
    meshes.push(mesh);
  });
  if (meshes.length > 0) {
    root.userData[SKINNED_MESHES_USERDATA_KEY] = meshes;
  }
}

/** Test helper: count skeleton.update calls would traverse; uses cached list when present. */
export function collectSkinnedMeshesForUpdate(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const cached = root.userData[SKINNED_MESHES_USERDATA_KEY] as THREE.SkinnedMesh[] | undefined;
  if (cached && cached.length > 0) return cached;
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) meshes.push(mesh);
  });
  return meshes;
}

export type BoneRestPose = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
};

/**
 * Shared helpers for adapters that map semantic joints onto Three.js bones.
 */
export function collectBonesByName(root: THREE.Object3D): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>();
  root.traverse((node) => {
    const bone = node as THREE.Bone;
    if (bone.isBone) bones.set(bone.name, bone);
  });
  return bones;
}

export function captureBoneRests(
  bones: Map<HumanJointId, THREE.Bone>,
): Map<HumanJointId, BoneRestPose> {
  const rests = new Map<HumanJointId, BoneRestPose>();
  for (const [id, bone] of bones) {
    rests.set(id, {
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
    });
  }
  return rests;
}

export function applySemanticPoseToBones(params: {
  bones: Map<HumanJointId, THREE.Bone>;
  rests: Map<HumanJointId, BoneRestPose>;
  pose: HumanPose | undefined;
}): void {
  const delta = new THREE.Quaternion();
  for (const jointId of HUMAN_JOINT_IDS) {
    const bone = params.bones.get(jointId);
    const rest = params.rests.get(jointId);
    if (!bone || !rest) continue;
    bone.position.copy(rest.position);
    bone.quaternion.copy(rest.quaternion);

    const jointPose = params.pose?.joints[jointId];
    if (!jointPose) continue;

    const [x, y, z, w] = jointPose.rotation ?? IDENTITY_QUATERNION;
    delta.set(x, y, z, w).normalize();
    // Rest local * pose delta → posed local.
    bone.quaternion.copy(rest.quaternion).multiply(delta);

    if (jointId === 'hips' && jointPose.position) {
      bone.position.set(
        rest.position.x + jointPose.position[0],
        rest.position.y + jointPose.position[1],
        rest.position.z + jointPose.position[2],
      );
    }
  }
}
