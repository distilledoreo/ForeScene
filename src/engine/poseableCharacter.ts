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
  HUMAN_TWIST_FOLLOWER,
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
  if (source.kind === 'importedRig') {
    return importedRigPoseableCharacters.get(`${source.assetId}:${source.rigId}`);
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
const importedRigPoseableCharacters = new Map<string, PoseableCharacter>();

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

export function registerImportedRigPoseableCharacter(
  assetId: string,
  rigId: string,
  character: PoseableCharacter,
): void {
  importedRigPoseableCharacters.set(`${assetId}:${rigId}`, character);
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

/** Terminal tip joints exist for bone axes/skin segments; they must not share a parent bone's pose slot. */
const TERMINAL_TIP_JOINTS: ReadonlySet<HumanJointId> = new Set([
  'leftHandEnd',
  'rightHandEnd',
  'leftToeBase',
  'rightToeBase',
]);

export function applySemanticPoseToBones(params: {
  bones: Map<HumanJointId, THREE.Bone>;
  rests: Map<HumanJointId, BoneRestPose>;
  pose: HumanPose | undefined;
  /** Canonical joint-frame quaternions, keyed by semantic joint. */
  canonicalPoseBases?: Partial<Record<HumanJointId, number[]>>;
}): void {
  const delta = new THREE.Quaternion();
  const canonicalToLocal = new THREE.Quaternion();
  const localSemanticDelta = new THREE.Quaternion();

  // Reset each unique bone once. Tip aliases that share a parent bone must not
  // re-reset after the hand/foot pose is applied (would wipe the pose to identity).
  const resetBones = new Set<THREE.Bone>();
  for (const jointId of HUMAN_JOINT_IDS) {
    const bone = params.bones.get(jointId);
    const rest = params.rests.get(jointId);
    if (!bone || !rest || resetBones.has(bone)) continue;
    resetBones.add(bone);
    bone.position.copy(rest.position);
    bone.quaternion.copy(rest.quaternion);
  }

  for (const jointId of HUMAN_JOINT_IDS) {
    // Tips are bind endpoints, not independent pose channels (unless explicitly posed).
    if (TERMINAL_TIP_JOINTS.has(jointId) && !params.pose?.joints[jointId]) continue;

    const bone = params.bones.get(jointId);
    const rest = params.rests.get(jointId);
    if (!bone || !rest) continue;

    const jointPose = params.pose?.joints[jointId];
    if (!jointPose) continue;

    const [x, y, z, w] = jointPose.rotation ?? IDENTITY_QUATERNION;
    delta.set(x, y, z, w).normalize();
    const basis = params.canonicalPoseBases?.[jointId];
    if (basis && basis.length === 4 && basis.every(Number.isFinite)) {
      // Convert the semantic rotation from the canonical anatomical frame
      // into this bone's local frame before applying it to the rest pose.
      canonicalToLocal.set(basis[0]!, basis[1]!, basis[2]!, basis[3]!).normalize();
      localSemanticDelta.copy(canonicalToLocal).invert().multiply(delta).multiply(canonicalToLocal);
      bone.quaternion.copy(rest.quaternion).multiply(localSemanticDelta);
    } else {
      // Built-in rigs retain their established local semantic convention.
      bone.quaternion.copy(rest.quaternion).multiply(delta);
    }

    // Distribute part of the primary limb rotation onto its twist helper so the
    // twist bones are live deformation channels, not empty hierarchy stubs.
    const twistId = HUMAN_TWIST_FOLLOWER[jointId];
    if (twistId && !params.pose?.joints[twistId]) {
      const twistBone = params.bones.get(twistId);
      const twistRest = params.rests.get(twistId);
      if (twistBone && twistRest) {
        const appliedDelta = (
          basis && basis.length === 4 && basis.every(Number.isFinite)
        )
          ? localSemanticDelta
          : delta;
        const half = new THREE.Quaternion().slerpQuaternions(
          new THREE.Quaternion(0, 0, 0, 1),
          appliedDelta,
          0.5,
        );
        twistBone.quaternion.copy(twistRest.quaternion).multiply(half);
      }
    }

    if (jointId === 'hips' && jointPose.position) {
      bone.position.set(
        rest.position.x + jointPose.position[0],
        rest.position.y + jointPose.position[1],
        rest.position.z + jointPose.position[2],
      );
    }
  }
}
