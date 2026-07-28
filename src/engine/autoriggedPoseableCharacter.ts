import * as THREE from 'three';
import type {
  AssetRegistry,
  HumanPose,
  PoseableCharacterOrientation,
  PoseableRigAsset,
  SceneObject,
} from '../domain/types';
import { MODEL_ASSET_URI_PREFIX } from './importedMesh';
import { getModelAsset } from './modelAssetStore';
import { createCanonicalHumanoidSkeleton } from './humanoidSkeleton';
import {
  registerAutoriggedPoseableCharacter,
  type PoseableCharacter,
  type PoseableJoint,
} from './poseableCharacter';
import { degreesToRadians } from './sync';

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

async function resolveSourceBytes(sourceAssetId: string, assets?: AssetRegistry): Promise<ArrayBuffer> {
  const asset = assets?.assets[sourceAssetId];
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
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
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

export function createAutoriggedPoseableCharacterShell(params: {
  assetId: string;
  rigId: string;
  sourceAssetId: string;
  orientation?: PoseableCharacterOrientation;
  approximateHeightMeters?: number;
  assets?: AssetRegistry;
}): PoseableCharacter {
  const height = params.approximateHeightMeters ?? 1.75;
  const orientation = params.orientation ?? { frontAxis: '+z', upAxis: '+y', groundLevelMeters: 0 };

  return {
    source: { kind: 'autorigged', assetId: params.assetId, rigId: params.rigId },
    skeleton: createCanonicalHumanoidSkeleton(),

    async ensureLoaded() {
      await ensureTemplateLoaded(params.sourceAssetId, params.assets);
    },

    isReady() {
      return templates.has(params.sourceAssetId);
    },

    createInstance(object: SceneObject, material: THREE.MeshStandardMaterial) {
      const template = templates.get(params.sourceAssetId);
      if (!template) {
        return createFallbackBox(object, material, height);
      }

      const root = new THREE.Group();
      root.name = object.name;
      const clone = template.clone(true);
      // Preserve original materials/textures from the import. Clay export paths
      // may still override materials later; the live Build view keeps author look.
      const oriented = new THREE.Group();
      oriented.quaternion.copy(orientationQuaternion(orientation));
      oriented.add(clone);
      oriented.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(oriented);
      const size = new THREE.Vector3();
      box.getSize(size);
      const sourceHeight = size.y > 1e-6 ? size.y : Math.max(size.x, size.z, 1);
      const targetHeight = object.dimensions[1] || height;
      const scale = targetHeight / sourceHeight;
      oriented.scale.setScalar(scale);
      oriented.updateMatrixWorld(true);

      const scaledBox = new THREE.Box3().setFromObject(oriented);
      oriented.position.y += -scaledBox.min.y;
      // Center XZ inside the object transform.
      oriented.position.x -= (scaledBox.min.x + scaledBox.max.x) / 2;
      oriented.position.z -= (scaledBox.min.z + scaledBox.max.z) / 2;

      root.add(oriented);
      root.position.fromArray(object.transform.position);
      root.rotation.set(
        degreesToRadians(object.transform.rotation[0]),
        degreesToRadians(object.transform.rotation[1]),
        degreesToRadians(object.transform.rotation[2]),
      );
      return root;
    },

    bindInstance(_instance: THREE.Object3D) {
      // 2A: no skeleton bones yet. Markers / skin arrive in later PRs.
    },

    getJoints(_instance: THREE.Object3D): readonly PoseableJoint[] {
      return [];
    },

    applyPose(_instance: THREE.Object3D, _pose: HumanPose | undefined) {
      // 2A intentionally does not deform the mesh. Pose UI can still store humanPose.
    },
  };
}

/** Hydrate in-memory adapters from poseable_rig assets after project load. */
export function hydrateAutoriggedCharactersFromAssets(assets: AssetRegistry): number {
  let registered = 0;
  for (const asset of Object.values(assets.assets)) {
    if (asset.type !== 'poseable_rig') continue;
    const rig = asset.metadata?.poseableRig as PoseableRigAsset | undefined;
    if (!rig?.id) continue;
    const sourceAssetId = rig.originalSourceAssetId ?? rig.sourceMeshAssetId;
    if (!sourceAssetId) continue;
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
      }),
    );
    registered += 1;
  }
  return registered;
}

export async function ensureAutoriggedCharactersForProject(
  project: { scene: { objects: SceneObject[] }; assets: AssetRegistry },
): Promise<void> {
  hydrateAutoriggedCharactersFromAssets(project.assets);
  const jobs: Promise<void>[] = [];
  for (const object of project.scene.objects) {
    const source = object.poseableCharacter;
    if (!source || source.kind !== 'autorigged') continue;
    const rigAsset = project.assets.assets[source.assetId];
    const rig = rigAsset?.metadata?.poseableRig as PoseableRigAsset | undefined;
    const sourceAssetId = rig?.originalSourceAssetId ?? rig?.sourceMeshAssetId;
    if (!sourceAssetId) continue;
    jobs.push(ensureTemplateLoaded(sourceAssetId, project.assets).catch(() => undefined));
  }
  await Promise.all(jobs);
}

export function resetAutoriggedCharacterTemplatesForTests(): void {
  templates.clear();
  loadPromises.clear();
  revision = 0;
  listeners.clear();
}
