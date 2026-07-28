import * as THREE from 'three';
import type {
  AssetRegistry,
  HumanJointId,
  HumanPose,
  PoseableCharacterOrientation,
  PoseableRigAsset,
  ProjectAsset,
  SceneObject,
  Vec3,
} from '../domain/types';
import { MODEL_ASSET_URI_PREFIX } from './importedMesh';
import { getModelAsset } from './modelAssetStore';
import { createCanonicalHumanoidSkeleton } from './humanoidSkeleton';
import {
  applySemanticPoseToBones,
  captureBoneRests,
  registerAutoriggedPoseableCharacter,
  type BoneRestPose,
  type PoseableCharacter,
  type PoseableJoint,
} from './poseableCharacter';
import { degreesToRadians } from './sync';
import {
  applySkinBuffersToRig,
  generateDeterministicSkinWeights,
  writeSkinWeightBinaryAsset,
} from './autorigSkinWeights';
import {
  cloneSkinnedPrototypeInstance,
  ensureSkeletonCloneReady,
  ensureSkinBuffersForRig,
  extractWorldPositionsFromObject,
  getCachedSkinBuffers,
  getCachedSkinnedPrototype,
  getOrBuildSkinnedPrototype,
  isSkeletonCloneReady,
  jointPositionsFromRig,
  POSE_BONES_USERDATA_KEY,
  setCachedSkinBuffers,
  skinBufferCacheKey,
  skinnedPrototypeCacheKey,
} from './autorigSkinnedMesh';
import type { OrientedMeshBounds } from './autorigMarkerFrame';

function axisToVector(axis: NonNullable<PoseableCharacterOrientation['frontAxis']>): THREE.Vector3 {
  switch (axis) {
    case '+x': return new THREE.Vector3(1, 0, 0);
    case '-x': return new THREE.Vector3(-1, 0, 0);
    case '+y': return new THREE.Vector3(0, 1, 0);
    case '-y': return new THREE.Vector3(0, -1, 0);
    case '+z': return new THREE.Vector3(0, 0, 1);
    case '-z': return new THREE.Vector3(0, 0, -1);
  }
}

function orientationQuaternion(orientation: PoseableCharacterOrientation): THREE.Quaternion {
  const front = axisToVector(orientation.frontAxis).normalize();
  const up = axisToVector(orientation.upAxis).normalize();
  if (Math.abs(front.dot(up)) > 0.999) return new THREE.Quaternion();
  const targetFront = new THREE.Vector3(0, 0, 1);
  const targetUp = new THREE.Vector3(0, 1, 0);
  const basisFrom = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(up, front).normalize(),
    up.clone(),
    front.clone(),
  );
  const basisTo = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(targetUp, targetFront).normalize(),
    targetUp.clone(),
    targetFront.clone(),
  );
  const fromQuat = new THREE.Quaternion().setFromRotationMatrix(basisFrom);
  const toQuat = new THREE.Quaternion().setFromRotationMatrix(basisTo);
  return toQuat.multiply(fromQuat.invert());
}

const templates = new Map<string, THREE.Object3D>();
const loadPromises = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let revision = 0;

/** Latest assets registry for createInstance skin/rig resolution (avoids re-registering on every pose). */
let assetsContext: AssetRegistry | undefined;
/** Last hydration inventory key — skip full re-register when unchanged. */
let lastHydrationInventoryKey = '';
/** assetId:rigId → inventory fragment used at registration. */
const registeredInventoryFragments = new Map<string, string>();

export function getAutoriggedCharacterRevision(): number {
  return revision;
}

export function subscribeAutoriggedCharacterReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyReady(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function setAutoriggedAssetsContext(assets: AssetRegistry | undefined): void {
  assetsContext = assets;
}

export function getAutoriggedAssetsContext(): AssetRegistry | undefined {
  return assetsContext;
}

/**
 * Stable inventory key for poseable rigs. Pose-slider project mutations that do not
 * change rig identity / generation / skin asset leave this key unchanged.
 */
export function buildAutorigRigInventoryKey(assets: AssetRegistry): string {
  const parts: string[] = [];
  for (const asset of Object.values(assets.assets)) {
    if (asset.type !== 'poseable_rig') continue;
    const rig = asset.metadata?.poseableRig as PoseableRigAsset | undefined;
    if (!rig?.id) continue;
    parts.push([
      asset.id,
      String(rig.rigGenerationVersion ?? 0),
      rig.originalSourceAssetId ?? '',
      rig.sourceMeshAssetId ?? '',
      rig.skin?.skinAssetId ?? '',
    ].join('\u001f'));
  }
  parts.sort();
  return parts.join('\u001e');
}

function registrationFragment(assetId: string, rig: PoseableRigAsset, sourceAssetId: string): string {
  return [
    assetId,
    String(rig.rigGenerationVersion ?? 0),
    sourceAssetId,
    rig.skin?.skinAssetId ?? '',
  ].join('\u001f');
}

async function resolveSourceBytes(sourceAssetId: string, assets?: AssetRegistry): Promise<ArrayBuffer> {
  const registry = assets ?? assetsContext;
  const asset = registry?.assets[sourceAssetId];
  if (!asset) {
    throw new Error(`Poseable source asset ${sourceAssetId} is missing.`);
  }
  if (asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
    const key = asset.uri.slice(MODEL_ASSET_URI_PREFIX.length);
    const bytes = await getModelAsset(key);
    if (!bytes) throw new Error(`Poseable source bytes for ${asset.name} are missing from local storage.`);
    return bytes;
  }
  if (asset.uri.startsWith('data:')) {
    const response = await fetch(asset.uri);
    return response.arrayBuffer();
  }
  throw new Error(`Unsupported poseable source URI for ${asset.name}.`);
}

async function ensureTemplateLoaded(sourceAssetId: string, assets?: AssetRegistry): Promise<void> {
  if (templates.has(sourceAssetId)) return;
  const existing = loadPromises.get(sourceAssetId);
  if (existing) {
    await existing;
    return;
  }
  const promise = (async () => {
    const bytes = await resolveSourceBytes(sourceAssetId, assets);
    const [{ GLTFLoader }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      ensureSkeletonCloneReady(),
    ]);
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    templates.set(sourceAssetId, gltf.scene);
    notifyReady();
  })().catch((error) => {
    loadPromises.delete(sourceAssetId);
    throw error;
  });
  loadPromises.set(sourceAssetId, promise);
  await promise;
}

function createFallbackBox(
  object: SceneObject,
  material: THREE.MeshStandardMaterial,
  heightMeters: number,
): THREE.Object3D {
  const height = Math.max(object.dimensions[1] || heightMeters, 0.5);
  const width = Math.max(object.dimensions[0] || height * 0.3, 0.2);
  const depth = Math.max(object.dimensions[2] || height * 0.3, 0.2);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material.clone());
  mesh.name = object.name;
  return mesh;
}

function orientAndFitTemplate(
  template: THREE.Object3D,
  orientation: PoseableCharacterOrientation,
  targetHeight: number,
): { oriented: THREE.Group; fittedHeight: number } {
  const clone = template.clone(true);
  const oriented = new THREE.Group();
  oriented.quaternion.copy(orientationQuaternion(orientation));
  oriented.add(clone);
  oriented.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(oriented);
  const size = new THREE.Vector3();
  box.getSize(size);
  const sourceHeight = size.y > 1e-6 ? size.y : Math.max(size.x, size.z, 1);
  const scale = targetHeight / sourceHeight;
  oriented.scale.setScalar(scale);
  oriented.updateMatrixWorld(true);

  const scaledBox = new THREE.Box3().setFromObject(oriented);
  oriented.position.y += -scaledBox.min.y;
  oriented.position.x -= (scaledBox.min.x + scaledBox.max.x) / 2;
  oriented.position.z -= (scaledBox.min.z + scaledBox.max.z) / 2;
  return { oriented, fittedHeight: targetHeight };
}

function resolveRigForShell(params: {
  assetId: string;
  rig?: PoseableRigAsset;
}): PoseableRigAsset | undefined {
  const assets = assetsContext;
  return params.rig
    ?? (assets?.assets[params.assetId]?.metadata?.poseableRig as PoseableRigAsset | undefined);
}

export function createAutoriggedPoseableCharacterShell(params: {
  assetId: string;
  rigId: string;
  sourceAssetId: string;
  orientation?: PoseableCharacterOrientation;
  approximateHeightMeters?: number;
  assets?: AssetRegistry;
  rig?: PoseableRigAsset;
}): PoseableCharacter {
  const height = params.approximateHeightMeters ?? 1.75;
  const orientation = params.orientation ?? { frontAxis: '+z', upAxis: '+y', groundLevelMeters: 0 };
  const REST_USERDATA_KEY = 'panorefPoseRests';
  const BONES_USERDATA_KEY = POSE_BONES_USERDATA_KEY;

  return {
    source: { kind: 'autorigged', assetId: params.assetId, rigId: params.rigId },
    skeleton: createCanonicalHumanoidSkeleton(),

    async ensureLoaded() {
      await Promise.all([
        ensureTemplateLoaded(params.sourceAssetId, assetsContext ?? params.assets),
        ensureSkeletonCloneReady(),
      ]);
      const rig = resolveRigForShell(params);
      if (rig?.skin) {
        await ensureSkinBuffersForRig(rig, assetsContext ?? params.assets);
      }
    },

    isReady() {
      if (!templates.has(params.sourceAssetId)) return false;
      const rig = resolveRigForShell(params);
      if (!rig?.bindMatrices || !rig.skin) return true;
      const key = skinBufferCacheKey({
        skinAssetId: rig.skin.skinAssetId,
        rigId: rig.id,
        rigGenerationVersion: rig.rigGenerationVersion,
      });
      return getCachedSkinBuffers(key) !== undefined || Boolean(rig.skin.indices && rig.skin.weights);
    },

    createInstance(object: SceneObject, material: THREE.MeshStandardMaterial) {
      const template = templates.get(params.sourceAssetId);
      if (!template) {
        return createFallbackBox(object, material, height);
      }

      const root = new THREE.Group();
      root.name = object.name;

      const rig = resolveRigForShell(params);
      const referenceHeight = object.dimensions[1] || height;

      // Prefer cached skinned prototype (shared geometry) when buffers + SkeletonUtils are ready.
      if (rig?.bindMatrices && rig.skin) {
        const bufferKey = skinBufferCacheKey({
          skinAssetId: rig.skin.skinAssetId,
          rigId: rig.id,
          rigGenerationVersion: rig.rigGenerationVersion,
        });
        let buffers = getCachedSkinBuffers(bufferKey);
        if (!buffers && rig.skin.indices && rig.skin.weights) {
          buffers = {
            influencesPerVertex: rig.skin.influencesPerVertex || 4,
            indices: Uint16Array.from(rig.skin.indices),
            weights: Float32Array.from(rig.skin.weights),
            jointOrder: (rig.skeletonJoints?.length ? rig.skeletonJoints : []) as HumanJointId[],
          };
          setCachedSkinBuffers(bufferKey, buffers);
        }

        if (buffers && isSkeletonCloneReady()) {
          try {
            const protoKey = skinnedPrototypeCacheKey({
              assetId: params.assetId,
              rigId: params.rigId,
              rigGenerationVersion: rig.rigGenerationVersion,
            });
            let prototype = getCachedSkinnedPrototype(protoKey);
            if (!prototype) {
              const { oriented } = orientAndFitTemplate(template, orientation, height);
              prototype = getOrBuildSkinnedPrototype({
                cacheKey: protoKey,
                template: oriented,
                rig,
                buffers,
                materialFallback: material,
                referenceHeight: height,
              });
            }

            const skinned = cloneSkinnedPrototypeInstance(prototype.root);
            // Scale from prototype reference height to this instance's dimensions.
            const scale = referenceHeight / Math.max(prototype.referenceHeight, 1e-6);
            skinned.scale.multiplyScalar(scale);
            root.add(skinned);
            root.position.fromArray(object.transform.position);
            root.rotation.set(
              degreesToRadians(object.transform.rotation[0]),
              degreesToRadians(object.transform.rotation[1]),
              degreesToRadians(object.transform.rotation[2]),
            );
            return root;
          } catch {
            // Corrupt/mismatched skin payloads must not break the scene — show rigid mesh.
            const { oriented } = orientAndFitTemplate(template, orientation, referenceHeight);
            root.add(oriented);
            root.userData.poseableSkinFallback = 'corrupt-or-mismatched-skin';
            root.position.fromArray(object.transform.position);
            root.rotation.set(
              degreesToRadians(object.transform.rotation[0]),
              degreesToRadians(object.transform.rotation[1]),
              degreesToRadians(object.transform.rotation[2]),
            );
            return root;
          }
        }

        // Buffers or SkeletonUtils not ready — rigid mesh; viewport rebuilds when cache fills.
        const { oriented } = orientAndFitTemplate(template, orientation, referenceHeight);
        root.add(oriented);
        root.userData.poseableSkinFallback = buffers ? 'skeleton-clone-pending' : 'skin-buffers-pending';
        root.position.fromArray(object.transform.position);
        root.rotation.set(
          degreesToRadians(object.transform.rotation[0]),
          degreesToRadians(object.transform.rotation[1]),
          degreesToRadians(object.transform.rotation[2]),
        );
        return root;
      }

      // No skin yet — oriented rigid source mesh.
      const { oriented } = orientAndFitTemplate(template, orientation, referenceHeight);
      root.add(oriented);
      root.position.fromArray(object.transform.position);
      root.rotation.set(
        degreesToRadians(object.transform.rotation[0]),
        degreesToRadians(object.transform.rotation[1]),
        degreesToRadians(object.transform.rotation[2]),
      );
      return root;
    },

    bindInstance(instance: THREE.Object3D) {
      if (instance.userData[BONES_USERDATA_KEY]) return;
      const bones = new Map<HumanJointId, THREE.Bone>();
      instance.traverse((node) => {
        const bone = node as THREE.Bone;
        if (!bone.isBone) return;
        const jointId = bone.userData.humanJointId as HumanJointId | undefined;
        if (jointId) bones.set(jointId, bone);
      });
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
          displayName: id,
          parentId: undefined,
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
      // Skeleton matrix update is owned by applyHumanPoseToObject3D (generic wrapper).
    },
  };
}

/** Generate skin weights for a rig from its loaded source template and persist binary skin asset. */
export async function generateSkinWeightsForRigAsset(params: {
  rig: PoseableRigAsset;
  sourceAssetId: string;
  assets?: AssetRegistry;
}): Promise<{ rig: PoseableRigAsset; skinAsset: ProjectAsset }> {
  await ensureTemplateLoaded(params.sourceAssetId, params.assets);
  await ensureSkeletonCloneReady();
  const template = templates.get(params.sourceAssetId);
  if (!template) throw new Error('Poseable source mesh is not loaded.');

  const oriented = template.clone(true);
  const jointPositions = jointPositionsFromRig(params.rig);
  const positions = extractWorldPositionsFromObject(oriented);
  const buffers = generateDeterministicSkinWeights({
    positions,
    jointPositions,
    heightMeters: params.rig.generationSettings?.approximateHeightMeters,
  });
  const written = await writeSkinWeightBinaryAsset(buffers);
  const skinAsset: ProjectAsset = {
    id: written.assetId,
    type: 'model',
    name: `${params.rig.id}-skin.bin`,
    uri: written.uri,
    mimeType: 'application/octet-stream',
    createdAt: new Date().toISOString(),
    metadata: { poseableSkin: true, byteLength: written.byteLength },
  };
  // Compact metadata only — weights live in the binary asset + runtime cache.
  const rig = applySkinBuffersToRig(params.rig, buffers, skinAsset.id);
  const cacheKey = skinBufferCacheKey({
    skinAssetId: skinAsset.id,
    rigId: rig.id,
    rigGenerationVersion: rig.rigGenerationVersion,
  });
  setCachedSkinBuffers(cacheKey, buffers);
  return { rig, skinAsset };
}

/**
 * Hydrate in-memory adapters from poseable_rig assets.
 * Skips re-registration when the same asset/rig generation/skin is already registered.
 */
export function hydrateAutoriggedCharactersFromAssets(assets: AssetRegistry): number {
  setAutoriggedAssetsContext(assets);
  let registered = 0;
  for (const asset of Object.values(assets.assets)) {
    if (asset.type !== 'poseable_rig') continue;
    const rig = asset.metadata?.poseableRig as PoseableRigAsset | undefined;
    if (!rig?.id) continue;
    const sourceAssetId = rig.originalSourceAssetId ?? rig.sourceMeshAssetId;
    if (!sourceAssetId) continue;
    const mapKey = `${asset.id}:${rig.id}`;
    const fragment = registrationFragment(asset.id, rig, sourceAssetId);
    if (registeredInventoryFragments.get(mapKey) === fragment) {
      continue;
    }
    registerAutoriggedPoseableCharacter(
      asset.id,
      rig.id,
      createAutoriggedPoseableCharacterShell({
        assetId: asset.id,
        rigId: rig.id,
        sourceAssetId,
        orientation: rig.orientation,
        approximateHeightMeters: rig.generationSettings?.approximateHeightMeters,
        assets,
        rig,
      }),
    );
    registeredInventoryFragments.set(mapKey, fragment);
    registered += 1;
  }
  lastHydrationInventoryKey = buildAutorigRigInventoryKey(assets);
  return registered;
}

/**
 * True when ensure/hydrate would skip adapter re-registration because the
 * rig inventory key is unchanged from the last successful hydrate.
 */
export function isAutorigHydrationCurrent(assets: AssetRegistry): boolean {
  return lastHydrationInventoryKey !== ''
    && lastHydrationInventoryKey === buildAutorigRigInventoryKey(assets);
}

export async function ensureAutoriggedCharactersForProject(
  project: { scene: { objects: SceneObject[] }; assets: AssetRegistry },
): Promise<void> {
  setAutoriggedAssetsContext(project.assets);
  const inventoryKey = buildAutorigRigInventoryKey(project.assets);
  if (inventoryKey !== lastHydrationInventoryKey) {
    hydrateAutoriggedCharactersFromAssets(project.assets);
  }

  await ensureSkeletonCloneReady();

  const jobs: Promise<void>[] = [];
  const seenSources = new Set<string>();
  const seenSkins = new Set<string>();

  for (const object of project.scene.objects) {
    const source = object.poseableCharacter;
    if (!source || source.kind !== 'autorigged') continue;
    const rigAsset = project.assets.assets[source.assetId];
    const rig = rigAsset?.metadata?.poseableRig as PoseableRigAsset | undefined;
    const sourceAssetId = rig?.originalSourceAssetId ?? rig?.sourceMeshAssetId;
    if (sourceAssetId && !seenSources.has(sourceAssetId)) {
      seenSources.add(sourceAssetId);
      jobs.push(ensureTemplateLoaded(sourceAssetId, project.assets).catch(() => undefined));
    }
    if (rig?.skin) {
      const skinKey = skinBufferCacheKey({
        skinAssetId: rig.skin.skinAssetId,
        rigId: rig.id,
        rigGenerationVersion: rig.rigGenerationVersion,
      });
      if (!seenSkins.has(skinKey)) {
        seenSkins.add(skinKey);
        jobs.push(
          ensureSkinBuffersForRig(rig, project.assets)
            .then(() => {
              // Warm skinned prototype once buffers are ready.
              if (!templates.has(sourceAssetId ?? '') || !rig.bindMatrices) return;
              const template = templates.get(sourceAssetId!);
              if (!template) return;
              const buffers = getCachedSkinBuffers(skinKey);
              if (!buffers) return;
              const orientation = rig.orientation ?? { frontAxis: '+z' as const, upAxis: '+y' as const, groundLevelMeters: 0 };
              const refHeight = rig.generationSettings?.approximateHeightMeters ?? 1.75;
              const { oriented } = orientAndFitTemplate(template, orientation, refHeight);
              getOrBuildSkinnedPrototype({
                cacheKey: skinnedPrototypeCacheKey({
                  assetId: source.assetId,
                  rigId: source.rigId,
                  rigGenerationVersion: rig.rigGenerationVersion,
                }),
                template: oriented,
                rig,
                buffers,
                referenceHeight: refHeight,
              });
              notifyReady();
            })
            .catch(() => undefined),
        );
      }
    }
  }
  await Promise.all(jobs);
}

export function resetAutoriggedCharacterTemplatesForTests(): void {
  templates.clear();
  loadPromises.clear();
  revision = 0;
  listeners.clear();
  assetsContext = undefined;
  lastHydrationInventoryKey = '';
  registeredInventoryFragments.clear();
}

/** @internal test helper — count of adapter registrations performed (not skips). */
export function getRegisteredAutorigFragmentCountForTests(): number {
  return registeredInventoryFragments.size;
}

/** True when the GLTF source for this asset is already in the shared template cache. */
export function isAutorigSourceTemplateReady(sourceAssetId: string): boolean {
  return templates.has(sourceAssetId);
}

/**
 * Ensure the source GLB is loaded into the shared template cache (no second independent parse
 * path once warm). Safe to call from the marker wizard.
 */
export async function ensureAutorigSourceTemplate(
  sourceAssetId: string,
  assets?: AssetRegistry,
): Promise<void> {
  await ensureTemplateLoaded(sourceAssetId, assets ?? assetsContext);
}

/**
 * Build an oriented/scaled/grounded preview instance for the marker wizard.
 * Reuses the same template cache + orient/fit path as the character adapter.
 * Returns undefined until the source template is loaded.
 */
export function createAutorigPreviewInstance(params: {
  sourceAssetId: string;
  assets?: AssetRegistry;
  orientation?: PoseableCharacterOrientation;
  approximateHeightMeters?: number;
  /** Optional override; default is a light semi-transparent clay for marker readability. */
  material?: THREE.Material;
}): { root: THREE.Object3D; bounds: OrientedMeshBounds } | undefined {
  const template = templates.get(params.sourceAssetId);
  if (!template) return undefined;

  const orientation = params.orientation ?? { frontAxis: '+z', upAxis: '+y', groundLevelMeters: 0 };
  const height = params.approximateHeightMeters ?? 1.75;
  const { oriented } = orientAndFitTemplate(template, orientation, height);

  const previewMaterial = params.material ?? new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
    metalness: 0.04,
    roughness: 0.88,
  });

  oriented.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = previewMaterial;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });

  oriented.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(oriented);
  const min: Vec3 = [box.min.x, box.min.y, box.min.z];
  const max: Vec3 = [box.max.x, box.max.y, box.max.z];
  return { root: oriented, bounds: { min, max } };
}

/** Test helper: inject a prebuilt template without GLB parse. */
export function setAutorigSourceTemplateForTests(sourceAssetId: string, root: THREE.Object3D): void {
  templates.set(sourceAssetId, root);
  notifyReady();
}
