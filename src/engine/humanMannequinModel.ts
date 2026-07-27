import * as THREE from 'three';
import type { LocationProject, SceneObject } from '../domain/types';
import { degreesToRadians } from './sync';
const DEFAULT_MODEL_URL = '/models/human-mannequin.glb';
export const HUMAN_MANNEQUIN_REFERENCE_DIMENSIONS: [number, number, number] = [0.55, 1.75, 0.55];

let template: THREE.Object3D | null = null;
let loadPromise: Promise<void> | null = null;
let cloneSkinnedObject: ((source: THREE.Object3D) => THREE.Object3D) | null = null;
let revision = 0;
const listeners = new Set<() => void>();

export function getHumanMannequinRevision(): number {
  return revision;
}

export function subscribeHumanMannequinReady(listener: () => void): () => void {
  listeners.add(listener);
  if (template) listener();
  return () => listeners.delete(listener);
}

export function isHumanMannequinModelReady(): boolean {
  return template !== null;
}

export type HumanMannequinModelSource = string | ArrayBuffer | SharedArrayBuffer;

export async function ensureHumanMannequinModel(source: HumanMannequinModelSource = DEFAULT_MODEL_URL): Promise<void> {
  if (template) return;
  if (!loadPromise) {
    loadPromise = loadTemplate(source).catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  await loadPromise;
}

/** Avoid fetching and parsing the optional GLB for scenes that only use the procedural fallback. */
export function projectHasVisibleHumanMannequin(project: Pick<LocationProject, 'scene'>): boolean {
  return project.scene.objects.some((object) => object.type === 'human_dummy' && object.visible);
}

export async function ensureHumanMannequinForProject(
  project: Pick<LocationProject, 'scene'>,
  source: HumanMannequinModelSource = DEFAULT_MODEL_URL,
): Promise<void> {
  if (!projectHasVisibleHumanMannequin(project)) return;
  await ensureHumanMannequinModel(source);
}

export function resetHumanMannequinModelForTests() {
  template = null;
  loadPromise = null;
  cloneSkinnedObject = null;
  revision = 0;
  listeners.clear();
}

export function createHumanMannequinObject(
  object: SceneObject,
  material: THREE.MeshStandardMaterial,
): THREE.Object3D {
  if (!template || !cloneSkinnedObject) {
    return createHumanMannequinFallback(object, material);
  }

  const instance = cloneSkinnedObject(template);
  applyMannequinMaterial(instance, material);

  const [referenceWidth, referenceHeight, referenceDepth] = HUMAN_MANNEQUIN_REFERENCE_DIMENSIONS;
  const [width, height, depth] = object.dimensions;
  instance.scale.set(
    width / referenceWidth,
    height / referenceHeight,
    depth / referenceDepth,
  );
  instance.position.fromArray(object.transform.position);
  instance.rotation.set(
    degreesToRadians(object.transform.rotation[0]),
    degreesToRadians(object.transform.rotation[1]),
    degreesToRadians(object.transform.rotation[2]),
  );
  instance.name = object.name;
  return instance;
}

async function loadTemplate(source: HumanMannequinModelSource): Promise<void> {
  const [{ GLTFLoader }, skeletonUtils] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/utils/SkeletonUtils.js'),
  ]);
  const loader = new GLTFLoader();
  const gltf = typeof source === 'string'
    ? await loader.loadAsync(source)
    : await loader.parseAsync(source, '');
  const root = gltf.scene;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  const wrapper = new THREE.Group();
  wrapper.name = 'HumanMannequinTemplate';
  wrapper.add(root);
  normalizeHumanTemplateRoot(root, HUMAN_MANNEQUIN_REFERENCE_DIMENSIONS[1]);
  template = wrapper;
  cloneSkinnedObject = skeletonUtils.clone;
  revision += 1;
  listeners.forEach((listener) => listener());
}

function normalizeHumanTemplateRoot(root: THREE.Object3D, targetHeight: number) {
  const bounds = getMeshBounds(root);
  const size = bounds.getSize(new THREE.Vector3());
  const heightScale = targetHeight / Math.max(size.y, 1e-6);
  root.scale.setScalar(heightScale);
  root.updateMatrixWorld(true);

  const scaledBounds = getMeshBounds(root);
  const center = scaledBounds.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= scaledBounds.min.y + targetHeight / 2;
  root.updateMatrixWorld(true);
}

function getMeshBounds(root: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) bounds.expandByObject(mesh);
  });
  if (bounds.isEmpty()) bounds.setFromObject(root);
  return bounds;
}

function applyMannequinMaterial(root: THREE.Object3D, material: THREE.MeshStandardMaterial) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) mesh.material = material;
  });
}

function createHumanMannequinFallback(
  object: SceneObject,
  material: THREE.MeshStandardMaterial,
): THREE.Object3D {
  const [, height] = object.dimensions;
  const group = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.42, 6, 12), material);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 12), material);
  head.position.y = height * 0.34;
  torso.position.y = 0;
  group.add(torso, head);
  group.name = object.name;
  group.position.fromArray(object.transform.position);
  group.rotation.set(
    degreesToRadians(object.transform.rotation[0]),
    degreesToRadians(object.transform.rotation[1]),
    degreesToRadians(object.transform.rotation[2]),
  );
  return group;
}
