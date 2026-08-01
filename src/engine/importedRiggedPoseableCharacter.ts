import * as THREE from 'three';
import type {
  AssetRegistry,
  HumanJointId,
  HumanPose,
  PoseableRigAsset,
  ProjectAsset,
  SceneObject,
} from '../domain/types';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { getModelAsset } from './modelAssetStore';
import { createCanonicalHumanoidSkeleton } from './humanoidSkeleton';
import {
  applySemanticPoseToBones,
  captureBoneRests,
  registerImportedRigPoseableCharacter,
  type BoneRestPose,
  type PoseableCharacter,
  type PoseableJoint,
} from './poseableCharacter';
import {
  cloneSkinnedPrototypeInstance,
  ensureSkeletonCloneReady,
  isSkeletonCloneReady,
  markSharedSkinnedPrototypeResources,
  cacheSkinnedMeshesOnInstance,
} from './autorigSkinnedMesh';
import { loadPoseableSource } from './poseableSourceLoader';
import { resolveRootRelativeNodePath } from './importedRig/bonePaths';
import { canonicalOrientationQuaternion } from './autorigCanonicalMesh';
import { normalizePoseableRigAsset } from './poseableRigNormalize';
import { degreesToRadians } from './sync';

const templates = new Map<string, THREE.Object3D>();
const sourceHeights = new Map<string, number>();
const loadPromises = new Map<string, Promise<void>>();
const prototypes = new Map<string, THREE.Object3D>();
let assetsContext: AssetRegistry | undefined;
let revision = 0;
const readyListeners = new Set<() => void>();

export function getImportedRiggedCharacterRevision(): number { return revision; }
export function subscribeImportedRiggedCharacterReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}
function notifyReady(): void {
  revision += 1;
  for (const listener of readyListeners) listener();
}

async function resolveSourceBytes(sourceAssetId: string, assets?: AssetRegistry): Promise<{ asset: ProjectAsset; bytes: ArrayBuffer }> {
  const source = (assets ?? assetsContext)?.assets[sourceAssetId];
  if (!source) throw new Error(`Imported rig source asset ${sourceAssetId} is missing.`);
  if (!source.uri.startsWith(MODEL_ASSET_URI_PREFIX)) throw new Error(`Imported rig source ${source.name} is not in local model storage.`);
  const bytes = await getModelAsset(source.uri.slice(MODEL_ASSET_URI_PREFIX.length));
  if (!bytes) throw new Error(`Imported rig source bytes for ${source.name} are missing from local storage.`);
  return { asset: source, bytes };
}

async function ensureTemplateLoaded(sourceAssetId: string, assets?: AssetRegistry): Promise<void> {
  if (templates.has(sourceAssetId)) return;
  const existing = loadPromises.get(sourceAssetId);
  if (existing) return existing;
  const promise = (async () => {
    const { asset, bytes } = await resolveSourceBytes(sourceAssetId, assets);
    const loaded = await loadPoseableSource(asset, bytes);
    if (loaded.skinnedMeshes.length === 0 || loaded.bones.length === 0) {
      throw new Error('Preserved-rig mode requires at least one skinned mesh and one deformation skeleton.');
    }
    if (loaded.skeletonRoots.length > 1) throw new Error('Preserved-rig mode supports one unrelated skeleton.');
    templates.set(sourceAssetId, loaded.root);
    sourceHeights.set(sourceAssetId, loaded.heightMeters);
    notifyReady();
  })().catch((error) => {
    loadPromises.delete(sourceAssetId);
    throw error;
  });
  loadPromises.set(sourceAssetId, promise);
  await promise;
}

function fallbackBox(object: SceneObject, material: THREE.MeshStandardMaterial): THREE.Object3D {
  const height = Math.max(object.dimensions[1] || 1.75, 0.5);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(object.dimensions[0] || height * 0.3, 0.2), height, Math.max(object.dimensions[2] || height * 0.3, 0.2)),
    material.clone(),
  );
  mesh.name = object.name;
  return mesh;
}

function applyObjectTransform(root: THREE.Object3D, object: SceneObject): void {
  root.position.fromArray(object.transform.position);
  root.rotation.set(
    degreesToRadians(object.transform.rotation[0]),
    degreesToRadians(object.transform.rotation[1]),
    degreesToRadians(object.transform.rotation[2]),
  );
}

function normalizedPrototype(params: {
  sourceAssetId: string;
  binding: NonNullable<PoseableRigAsset['importedRigBinding']>;
}): THREE.Object3D {
  const key = `${params.sourceAssetId}:${params.binding.id}:${params.binding.restPoseHash}`;
  const existing = prototypes.get(key);
  if (existing) return existing;
  const template = templates.get(params.sourceAssetId);
  if (!template) throw new Error('Imported rig source is not loaded.');
  const wrapper = new THREE.Group();
  wrapper.name = 'forescene-imported-rig-prototype';
  wrapper.quaternion.copy(canonicalOrientationQuaternion(params.binding.orientation));
  wrapper.add(template);
  wrapper.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(wrapper);
  const size = bounds.getSize(new THREE.Vector3());
  const sourceHeight = size.y > 1e-6 ? size.y : Math.max(size.x, size.z, 1);
  wrapper.scale.setScalar(params.binding.approximateHeightMeters / sourceHeight);
  wrapper.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(wrapper);
  wrapper.position.set(
    -(fitted.min.x + fitted.max.x) * 0.5,
    params.binding.orientation.groundLevelMeters - fitted.min.y,
    -(fitted.min.z + fitted.max.z) * 0.5,
  );
  wrapper.updateMatrixWorld(true);
  markSharedSkinnedPrototypeResources(wrapper);
  prototypes.set(key, wrapper);
  return wrapper;
}

export function createImportedRiggedPoseableCharacter(params: {
  assetId: string;
  rigId: string;
  sourceAssetId: string;
  binding: NonNullable<PoseableRigAsset['importedRigBinding']>;
  assets?: AssetRegistry;
}): PoseableCharacter {
  const restKey = 'panorefImportedRigRests';
  const bonesKey = 'panorefImportedRigBones';
  const sourceRootKey = 'panorefImportedRigSourceRoot';
  return {
    source: { kind: 'importedRig', assetId: params.assetId, rigId: params.rigId },
    skeleton: createCanonicalHumanoidSkeleton(),
    async ensureLoaded() {
      await ensureTemplateLoaded(params.sourceAssetId, assetsContext ?? params.assets);
      await ensureSkeletonCloneReady();
    },
    isReady() {
      return templates.has(params.sourceAssetId) && isSkeletonCloneReady();
    },
    createInstance(object, material) {
      if (!templates.has(params.sourceAssetId) || !isSkeletonCloneReady()) return fallbackBox(object, material);
      try {
        const prototype = normalizedPrototype({ sourceAssetId: params.sourceAssetId, binding: params.binding });
        const instance = cloneSkinnedPrototypeInstance(prototype);
        instance.name = object.name;
        instance.userData[sourceRootKey] = instance.children[0];
        instance.userData.importedRigPreserved = true;
        const targetHeight = object.dimensions[1] || params.binding.approximateHeightMeters;
        // The prototype is already fitted to the binding's canonical height.
        // Scale only for a later object-dimension edit; applying the raw source
        // height again would shrink or enlarge the character twice.
        instance.scale.multiplyScalar(targetHeight / Math.max(params.binding.approximateHeightMeters, 1e-6));
        applyObjectTransform(instance, object);
        cacheSkinnedMeshesOnInstance(instance);
        return instance;
      } catch {
        return fallbackBox(object, material);
      }
    },
    bindInstance(instance) {
      if (instance.userData[bonesKey]) return;
      const sourceRoot = instance.userData[sourceRootKey] as THREE.Object3D | undefined;
      if (!sourceRoot) return;
      const bones = new Map<HumanJointId, THREE.Bone>();
      for (const [jointId, path] of Object.entries(params.binding.boneMap) as Array<[HumanJointId, string]>) {
        const node = resolveRootRelativeNodePath(sourceRoot, path);
        if (node instanceof THREE.Bone) bones.set(jointId, node);
      }
      if (bones.size === 0) return;
      instance.userData[bonesKey] = bones;
      instance.userData[restKey] = captureBoneRests(bones);
    },
    getJoints(instance) {
      this.bindInstance(instance);
      const bones = instance.userData[bonesKey] as Map<HumanJointId, THREE.Bone> | undefined;
      if (!bones) return [];
      return [...bones.entries()].map(([id, node]): PoseableJoint => ({
        id,
        displayName: id,
        parentId: undefined,
        node,
      }));
    },
    applyPose(instance, pose: HumanPose | undefined) {
      this.bindInstance(instance);
      const bones = instance.userData[bonesKey] as Map<HumanJointId, THREE.Bone> | undefined;
      const rests = instance.userData[restKey] as Map<HumanJointId, BoneRestPose> | undefined;
      if (!bones || !rests) return;
      applySemanticPoseToBones({
        bones,
        rests,
        pose,
        canonicalPoseBases: params.binding.canonicalPoseBases,
      });
    },
  };
}

export function hydrateImportedRiggedCharactersFromAssets(assets: AssetRegistry): number {
  assetsContext = assets;
  let registered = 0;
  for (const asset of Object.values(assets.assets)) {
    if (asset.type !== 'poseable_rig') continue;
    const rig = normalizePoseableRigAsset(asset.metadata?.poseableRig);
    const binding = rig?.importedRigBinding;
    if (!binding || !binding.sourceAssetId) continue;
    registerImportedRigPoseableCharacter(
      asset.id,
      rig.id,
      createImportedRiggedPoseableCharacter({
        assetId: asset.id,
        rigId: rig.id,
        sourceAssetId: binding.sourceAssetId,
        binding,
        assets,
      }),
    );
    registered += 1;
  }
  if (registered > 0) notifyReady();
  return registered;
}

export async function ensureImportedRiggedCharactersForProject(project: {
  scene: { objects: SceneObject[] };
  assets: AssetRegistry;
}): Promise<void> {
  assetsContext = project.assets;
  hydrateImportedRiggedCharactersFromAssets(project.assets);
  const sources = new Set<string>();
  for (const object of project.scene.objects) {
    if (object.poseableCharacter?.kind !== 'importedRig') continue;
    const rig = project.assets.assets[object.poseableCharacter.assetId]?.metadata?.poseableRig;
    const binding = rig?.importedRigBinding;
    if (binding?.sourceAssetId) sources.add(binding.sourceAssetId);
  }
  await Promise.all([...sources].map((sourceAssetId) => ensureTemplateLoaded(sourceAssetId, project.assets).catch(() => undefined)));
  await ensureSkeletonCloneReady();
}

export function resetImportedRigRuntimeCachesForTests(): void {
  templates.clear();
  sourceHeights.clear();
  loadPromises.clear();
  prototypes.clear();
  assetsContext = undefined;
  revision = 0;
}
