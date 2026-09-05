import * as THREE from 'three';
import type { AssetRegistry, HumanJointId, PoseableRigAsset, Vec3 } from '../domain/types';
import { HUMAN_JOINT_IDS, HUMAN_JOINT_LABELS } from './humanPose';
import { HUMAN_JOINT_PARENT } from './humanoidSkeleton';
import { getModelAssetStorageKey } from './importedMeshConstants';
import { getModelAsset } from './modelAssetStore';
import type { SkinWeightBuffers } from './autorigSkinWeights';

/** disposeScene skips geometries tagged with this userData key. */
export const SHARED_SKINNED_GEOMETRY_USERDATA = 'panorefSharedSkinnedGeometry';
/** disposeScene skips materials tagged with this userData key (SkeletonUtils clones share them). */
export const SHARED_SKINNED_MATERIAL_USERDATA = 'panorefSharedSkinnedMaterial';

const skinBufferCache = new Map<string, SkinWeightBuffers>();
const skinLoadPromises = new Map<string, Promise<SkinWeightBuffers | undefined>>();
const prototypeCache = new Map<string, SkinnedPrototypeEntry>();
let skinBinaryReadCount = 0;
let prototypeBuildCount = 0;
let skeletonCloneFn: ((source: THREE.Object3D) => THREE.Object3D) | null = null;

export const SKINNED_MESHES_USERDATA_KEY = 'panorefSkinnedMeshes';
export const POSE_BONES_USERDATA_KEY = 'panorefPoseBones';

export interface SkinnedPrototypeEntry {
  root: THREE.Object3D;
  referenceHeight: number;
  cacheKey: string;
}

export function skinBufferCacheKey(params: {
  skinAssetId?: string;
  rigId?: string;
  rigGenerationVersion?: number;
}): string {
  if (params.skinAssetId) return `skin:${params.skinAssetId}`;
  return `rig:${params.rigId ?? 'unknown'}:v${params.rigGenerationVersion ?? 0}`;
}

export function skinnedPrototypeCacheKey(params: {
  assetId: string;
  rigId: string;
  rigGenerationVersion?: number;
}): string {
  return `${params.assetId}:${params.rigId}:v${params.rigGenerationVersion ?? 0}`;
}

export function getCachedSkinBuffers(key: string): SkinWeightBuffers | undefined {
  return skinBufferCache.get(key);
}

export function setCachedSkinBuffers(key: string, buffers: SkinWeightBuffers): void {
  skinBufferCache.set(key, buffers);
}

export function getSkinBinaryReadCount(): number {
  return skinBinaryReadCount;
}

export function getPrototypeBuildCount(): number {
  return prototypeBuildCount;
}

export function getCachedSkinnedPrototype(key: string): SkinnedPrototypeEntry | undefined {
  return prototypeCache.get(key);
}

export function invalidateSkinnedPrototype(key: string): void {
  prototypeCache.delete(key);
}

export function resetAutorigRuntimeCachesForTests(): void {
  for (const key of [...prototypeCache.keys()]) {
    invalidateSkinnedPrototype(key);
  }
  skinBufferCache.clear();
  skinLoadPromises.clear();
  prototypeCache.clear();
  skinBinaryReadCount = 0;
  prototypeBuildCount = 0;
  skeletonCloneFn = null;
}

/** Prefer binary skin asset; fall back to legacy inline arrays once, then cache. */
export async function ensureSkinBuffersForRig(
  rig: PoseableRigAsset,
  assets?: AssetRegistry,
): Promise<SkinWeightBuffers | undefined> {
  if (!rig.skin) return undefined;
  const key = skinBufferCacheKey({
    skinAssetId: rig.skin.skinAssetId,
    rigId: rig.id,
    rigGenerationVersion: rig.rigGenerationVersion,
  });
  const cached = skinBufferCache.get(key);
  if (cached) return cached;

  const existing = skinLoadPromises.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<SkinWeightBuffers | undefined> => {
    const jointOrder = (
      rig.skeletonJoints?.length ? rig.skeletonJoints : [...HUMAN_JOINT_IDS]
    ) as HumanJointId[];

    if (rig.skin?.skinAssetId && assets) {
      const skinAsset = assets.assets[rig.skin.skinAssetId];
      if (skinAsset?.uri) {
        skinBinaryReadCount += 1;
        const buffers = await loadSkinWeightBuffersFromUri(skinAsset.uri, jointOrder);
        skinBufferCache.set(key, buffers);
        return buffers;
      }
    }

    if (rig.skin?.indices && rig.skin.weights) {
      const buffers: SkinWeightBuffers = {
        influencesPerVertex: rig.skin.influencesPerVertex || 4,
        indices: Uint16Array.from(rig.skin.indices),
        weights: Float32Array.from(rig.skin.weights),
        jointOrder,
      };
      skinBufferCache.set(key, buffers);
      return buffers;
    }

    return undefined;
  })();

  skinLoadPromises.set(key, promise);
  try {
    return await promise;
  } finally {
    skinLoadPromises.delete(key);
  }
}

/**
 * @deprecated Prefer ensureSkinBuffersForRig + runtime cache.
 * Sync helper for legacy inline-only fixtures.
 */
export async function loadSkinWeightBuffers(
  rig: PoseableRigAsset,
): Promise<SkinWeightBuffers | undefined> {
  return ensureSkinBuffersForRig(rig);
}

export async function loadSkinWeightBuffersFromUri(uri: string, jointOrder: HumanJointId[]): Promise<SkinWeightBuffers> {
  const key = getModelAssetStorageKey({ uri });
  if (!key) {
    throw new Error('Skin payload URI must be a local model asset.');
  }
  const bytes = await getModelAsset(key);
  if (!bytes) throw new Error('Skin payload is missing from local storage.');
  const view = new DataView(bytes);
  const version = view.getUint32(0, true);
  if (version !== 1) throw new Error(`Unsupported skin payload version ${version}.`);
  const influencesPerVertex = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const weightCount = view.getUint32(12, true);
  const indexBytes = view.getUint32(16, true);
  const headerBytes = 24;
  const indices = new Uint16Array(bytes, headerBytes, indexCount);
  const weights = new Float32Array(bytes, headerBytes + indexBytes, weightCount);
  return {
    influencesPerVertex,
    indices: new Uint16Array(indices),
    weights: new Float32Array(weights),
    jointOrder,
  };
}

export async function ensureSkeletonCloneReady(): Promise<void> {
  if (skeletonCloneFn) return;
  const skeletonUtils = await import('three/addons/utils/SkeletonUtils.js');
  skeletonCloneFn = skeletonUtils.clone;
}

export function isSkeletonCloneReady(): boolean {
  return skeletonCloneFn !== null;
}

/**
 * Build (or return cached) skinned prototype for a rig generation.
 * Geometry/materials are shared across SkeletonUtils clones; bones are per-instance.
 */
export function getOrBuildSkinnedPrototype(params: {
  cacheKey: string;
  template: THREE.Object3D;
  rig: PoseableRigAsset;
  buffers: SkinWeightBuffers;
  materialFallback?: THREE.Material;
  referenceHeight: number;
  centerForSceneObject?: boolean;
}): SkinnedPrototypeEntry {
  const existing = prototypeCache.get(params.cacheKey);
  if (existing) return existing;

  const built = buildSkinnedCharacterFromTemplate({
    template: params.template,
    rig: params.rig,
    buffers: params.buffers,
    materialFallback: params.materialFallback,
  });
  cacheSkinnedMeshesOnInstance(built);
  // Shared across SkeletonUtils clones — must not be disposed with any one scene instance.
  markSharedSkinnedPrototypeResources(built);
  let displayRoot: THREE.Object3D = built;
  let referenceHeight = params.referenceHeight;
  if (params.centerForSceneObject) {
    // Move the completed skin AND skeleton together; moving vertices before
    // binding changes their rotation pivots and tears even modest poses apart.
    const box = new THREE.Box3().setFromObject(params.template);
    referenceHeight = box.getSize(new THREE.Vector3()).y;
    displayRoot = new THREE.Group();
    displayRoot.add(built);
    built.position.copy(box.getCenter(new THREE.Vector3()).negate());
    displayRoot.updateMatrixWorld(true);
    cacheSkinnedMeshesOnInstance(displayRoot);
  }
  const entry: SkinnedPrototypeEntry = {
    root: displayRoot,
    referenceHeight,
    cacheKey: params.cacheKey,
  };
  prototypeCache.set(params.cacheKey, entry);
  prototypeBuildCount += 1;
  return entry;
}

/** Tag geometry + materials so disposeScene cannot poison the prototype cache. */
export function markSharedSkinnedPrototypeResources(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) {
      mesh.geometry.userData[SHARED_SKINNED_GEOMETRY_USERDATA] = true;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material) material.userData[SHARED_SKINNED_MATERIAL_USERDATA] = true;
    }
  });
}

/** Clone a prepared skinned prototype; shares BufferGeometry with the prototype. */
export function cloneSkinnedPrototypeInstance(prototype: THREE.Object3D): THREE.Object3D {
  if (!skeletonCloneFn) {
    throw new Error('SkeletonUtils clone is not ready; call ensureSkeletonCloneReady first.');
  }
  const instance = skeletonCloneFn(prototype);
  clearPoseRuntimeUserData(instance);
  cacheSkinnedMeshesOnInstance(instance);
  // Clones share materials/geometry with the prototype — re-assert tags after clone.
  markSharedSkinnedPrototypeResources(instance);
  return instance;
}

/** Whether two Object3D trees share any BufferGeometry identity (prototype reuse proof). */
export function shareAnyBufferGeometry(a: THREE.Object3D, b: THREE.Object3D): boolean {
  const geos = new Set<THREE.BufferGeometry>();
  a.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) geos.add(mesh.geometry);
  });
  let shared = false;
  b.traverse((node) => {
    if (shared) return;
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry && geos.has(mesh.geometry)) shared = true;
  });
  return shared;
}

export function cacheSkinnedMeshesOnInstance(root: THREE.Object3D): void {
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) meshes.push(mesh);
  });
  root.userData[SKINNED_MESHES_USERDATA_KEY] = meshes;
}

export function clearPoseRuntimeUserData(root: THREE.Object3D): void {
  delete root.userData[POSE_BONES_USERDATA_KEY];
  delete root.userData.panorefPoseRests;
  delete root.userData[SKINNED_MESHES_USERDATA_KEY];
  root.traverse((node) => {
    if (node === root) return;
    delete node.userData[POSE_BONES_USERDATA_KEY];
    delete node.userData.panorefPoseRests;
  });
}

function matrixFromColumnMajor(values: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.fromArray(values);
  return m;
}

/**
 * Build a SkinnedMesh hierarchy from a rest-pose template + fitted bind matrices + skin weights.
 * Bones use semantic HumanJointId names so applyPose can target them.
 */
export function buildSkinnedCharacterFromTemplate(params: {
  template: THREE.Object3D;
  rig: PoseableRigAsset;
  buffers: SkinWeightBuffers;
  materialFallback?: THREE.Material;
}): THREE.Object3D {
  const { template, rig, buffers } = params;
  const root = new THREE.Group();
  root.name = 'autorigged-skinned';

  // Collect mesh geometries in world space of the template.
  const meshParts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; vertexCount: number }> = [];
  template.updateMatrixWorld(true);
  template.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    const material = mesh.material ?? params.materialFallback ?? new THREE.MeshStandardMaterial({ color: '#9ca3af' });
    meshParts.push({ geometry, material, vertexCount: geometry.getAttribute('position')?.count ?? 0 });
  });
  if (meshParts.length === 0) {
    root.add(template.clone(true));
    return root;
  }

  const totalVertices = meshParts.reduce((sum, part) => sum + part.vertexCount, 0);
  if (totalVertices * buffers.influencesPerVertex !== buffers.indices.length) {
    // Weight payloads are generated in the same mesh traversal order.
    root.add(template.clone(true));
    return root;
  }

  // Build bone hierarchy.
  const bones: THREE.Bone[] = [];
  const boneById = new Map<HumanJointId, THREE.Bone>();
  for (const jointId of buffers.jointOrder) {
    const bone = new THREE.Bone();
    bone.name = jointId;
    bone.userData.humanJointId = jointId;
    bones.push(bone);
    boneById.set(jointId, bone);
  }
  for (const jointId of buffers.jointOrder) {
    const bone = boneById.get(jointId);
    if (!bone) continue;
    const parentId = HUMAN_JOINT_PARENT[jointId];
    const parent = parentId ? boneById.get(parentId) : undefined;
    if (parent) parent.add(bone);
    else root.add(bone);
  }

  // Place bones using bind matrices (world) then compute inverse binds.
  const inverses: THREE.Matrix4[] = [];
  for (const jointId of buffers.jointOrder) {
    const bone = boneById.get(jointId)!;
    const bind = rig.bindMatrices?.[jointId];
    if (bind && bind.length === 16) {
      const world = matrixFromColumnMajor(bind);
      const parent = bone.parent as THREE.Bone | THREE.Object3D | null;
      if (parent && (parent as THREE.Bone).isBone) {
        const parentWorld = new THREE.Matrix4();
        parent.updateWorldMatrix(true, false);
        parentWorld.copy(parent.matrixWorld);
        const local = parentWorld.clone().invert().multiply(world);
        local.decompose(bone.position, bone.quaternion, bone.scale);
      } else {
        world.decompose(bone.position, bone.quaternion, bone.scale);
      }
    }
  }
  root.updateMatrixWorld(true);
  for (const jointId of buffers.jointOrder) {
    const bone = boneById.get(jointId)!;
    inverses.push(bone.matrixWorld.clone().invert());
  }

  const skeleton = new THREE.Skeleton(bones, inverses);
  let vertexOffset = 0;
  let triangleOffset = 0;
  for (const part of meshParts) {
    const indicesStart = vertexOffset * buffers.influencesPerVertex;
    const indicesEnd = (vertexOffset + part.vertexCount) * buffers.influencesPerVertex;
    part.geometry.setAttribute(
      'skinIndex',
      new THREE.BufferAttribute(buffers.indices.slice(indicesStart, indicesEnd), buffers.influencesPerVertex),
    );
    part.geometry.setAttribute(
      'skinWeight',
      new THREE.BufferAttribute(buffers.weights.slice(indicesStart, indicesEnd), buffers.influencesPerVertex),
    );
    const skinned = new THREE.SkinnedMesh(part.geometry, part.material);
    skinned.frustumCulled = false;
    skinned.bind(skeleton);
    const index = part.geometry.getIndex();
    const triangleCount = index
      ? Math.floor(index.count / 3)
      : Math.floor(part.vertexCount / 3);
    skinned.userData.autorigVertexStart = vertexOffset;
    skinned.userData.autorigTriangleStart = triangleOffset;
    skinned.userData.autorigVertexCount = part.vertexCount;
    skinned.userData.autorigTriangleCount = triangleCount;
    root.add(skinned);
    vertexOffset += part.vertexCount;
    triangleOffset += triangleCount;
  }

  // Keep labels available for pose UI / debugging.
  for (const jointId of buffers.jointOrder) {
    const bone = boneById.get(jointId);
    if (bone) bone.userData.displayName = HUMAN_JOINT_LABELS[jointId];
  }
  root.userData[POSE_BONES_USERDATA_KEY] = boneById;
  cacheSkinnedMeshesOnInstance(root);
  return root;
}

export function extractWorldPositionsFromObject(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true);
  const chunks: number[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const v = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      chunks.push(v.x, v.y, v.z);
    }
  });
  return Float32Array.from(chunks);
}

export function jointPositionsFromRig(rig: PoseableRigAsset): Partial<Record<HumanJointId, Vec3>> {
  const positions: Partial<Record<HumanJointId, Vec3>> = {};
  for (const marker of rig.markers ?? []) {
    if (!marker || typeof marker.jointId !== 'string' || !Array.isArray(marker.position)) continue;
    const x = Number(marker.position[0]);
    const y = Number(marker.position[1]);
    const z = Number(marker.position[2]);
    if (![x, y, z].every(Number.isFinite)) continue;
    positions[marker.jointId] = [x, y, z];
  }
  // Prefer bind matrix translation when markers missing.
  for (const jointId of HUMAN_JOINT_IDS) {
    if (positions[jointId]) continue;
    const bind = rig.bindMatrices?.[jointId];
    if (bind && bind.length >= 16) {
      positions[jointId] = [bind[12]!, bind[13]!, bind[14]!];
    }
  }
  return positions;
}
