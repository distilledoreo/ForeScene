import * as THREE from 'three';
import type { AssetRegistry, LocationProject, ProjectAsset, SceneObject } from '../domain/types';
import { getModelAssetStorageKey } from './importedMeshConstants';
import { getModelAsset, getModelAssetVersion } from './modelAssetStore';
import { verifyBinaryDigest } from './binaryIntegrity';
import { reopenSourceModelPackage } from './sourceModelPackage';
import {
  collectSourceResources, disposeSourceResources, isSourceRenderable,
  loadSourceModel, sourceNodeAtPath, type LoadedSourceModel,
} from './sourceModelLoader';

interface CacheEntry {
  key: string;
  model: LoadedSourceModel;
  prototypes: Map<string, THREE.Object3D>;
  references: number;
  idleSince: number;
  timer?: ReturnType<typeof setTimeout>;
}
const entries = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<void>>();
const errors = new Map<string, string>();
const leases = new WeakMap<THREE.Object3D, CacheEntry>();
const sharedGeometry = new WeakSet<THREE.BufferGeometry>();
const sharedMaterial = new WeakSet<THREE.Material>();
const listeners = new Set<() => void>();
const IDLE_MS = 30_000;
const MAX_IDLE_ENTRIES = 8;
let revision = 0;
let generation = 0;

export function isSourceModelAsset(asset: ProjectAsset | undefined): boolean {
  return asset?.type === 'model' && asset.metadata?.modelEncoding === 'source';
}
export function isSharedSourceGeometry(geometry: THREE.BufferGeometry): boolean { return sharedGeometry.has(geometry); }
export function isSharedSourceMaterial(material: THREE.Material): boolean { return sharedMaterial.has(material); }
export function getSourceModelRevision(): number { return revision; }
export function subscribeSourceModelReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify(): void { revision += 1; listeners.forEach((listener) => listener()); }
function cacheKey(asset: ProjectAsset): string {
  const storageKey = getModelAssetStorageKey(asset);
  return `${asset.id}\u0000${asset.uri}\u0000${getModelAssetVersion(storageKey ?? '') ?? 0}\u0000${asset.metadata?.sourceModel?.sourceHash ?? ''}`;
}

function evict(entry: CacheEntry): void {
  if (entry.references || entries.get(entry.key) !== entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  // Prototypes have their own skeletons/instance attributes, but share source geometry/materials.
  for (const prototype of entry.prototypes.values()) disposeInstanceState(prototype);
  disposeSourceResources(entry.model.scenes);
  entry.prototypes.clear();
  entries.delete(entry.key);
}
function scheduleEviction(entry: CacheEntry, trim = true): void {
  if (entry.references) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.idleSince = Date.now();
  entry.timer = setTimeout(() => evict(entry), IDLE_MS);
  if (typeof entry.timer === 'object' && 'unref' in entry.timer) entry.timer.unref();
  const idle = [...entries.values()].filter((item) => item.references === 0).sort((a, b) => a.idleSince - b.idleSince);
  while (trim && idle.length > MAX_IDLE_ENTRIES) evict(idle.shift()!);
}

/** Adopt one decoded template. Every scene/export instance receives a lease on its shared resources. */
export function primeSourceModel(asset: ProjectAsset, model: LoadedSourceModel): void {
  const key = cacheKey(asset);
  const old = entries.get(key);
  if (old) {
    if (old.model !== model) disposeSourceResources(model.scenes);
    return;
  }
  const resources = collectSourceResources(model.scenes);
  resources.geometries.forEach((geometry) => sharedGeometry.add(geometry));
  resources.materials.forEach((material) => sharedMaterial.add(material));
  const entry: CacheEntry = { key, model, prototypes: new Map(), references: 0, idleSince: Date.now() };
  entries.set(key, entry);
  errors.delete(key);
  scheduleEviction(entry, false);
  notify();
}

async function ensureSourceModel(asset: ProjectAsset): Promise<void> {
  const key = cacheKey(asset);
  if (entries.has(key)) return;
  const active = pending.get(key);
  if (active) return active;
  const epoch = generation;
  const promise = (async () => {
    const descriptor = asset.metadata?.sourceModel;
    const storageKey = getModelAssetStorageKey(asset);
    if (!descriptor || !storageKey) throw new Error('Preserved model has no source descriptor or local binary.');
    const bytes = await getModelAsset(storageKey);
    if (!bytes) throw new Error(`Source model ${asset.name} is missing. Locate the original file or reopen its .fsp package.`);
    await verifyBinaryDigest(bytes, descriptor.sourceHash, `Preserved source ${asset.name}`);
    const packaged = await reopenSourceModelPackage(bytes, descriptor);
    const model = await loadSourceModel(packaged);
    if (epoch !== generation) { disposeSourceResources(model.scenes); return; }
    primeSourceModel(asset, model);
  })().catch((error: unknown) => {
    if (epoch === generation) {
      errors.set(key, error instanceof Error ? error.message : String(error));
      notify();
    }
    throw error;
  }).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
  pending.set(key, promise);
  return promise;
}

/** Exports await this barrier; interactive viewports subscribe and can show explicit placeholders. */
export async function ensureSourceModelsForProject(
  project: Pick<LocationProject, 'scene' | 'assets'>,
  options: { tolerateErrors?: boolean } = {},
): Promise<void> {
  const ids = new Set(project.scene.objects.filter((object) => object.type === 'imported_model').map((object) => object.modelAssetId));
  // Pin every ready template until the whole barrier finishes. A later large
  // asset may take longer than the idle TTL; early assets must still exist when
  // the caller builds its scene. Concurrent barriers hold independent leases.
  const held = new Set<CacheEntry>();
  try {
    for (const id of ids) {
      const asset = id ? project.assets.assets[id] : undefined;
      if (!asset || !isSourceModelAsset(asset) || asset.resolutionStatus && asset.resolutionStatus !== 'available') continue;
      try {
        await ensureSourceModel(asset);
        const entry = entries.get(cacheKey(asset));
        if (!entry) throw new Error(`Source model ${asset.name} did not become ready.`);
        if (!held.has(entry)) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.references += 1;
          held.add(entry);
        }
        for (const object of project.scene.objects.filter((candidate) => candidate.modelAssetId === asset.id)) {
          if (object.sourceModelNodePath === undefined) continue;
          const path = object.sourceModelNodePath;
          if (!entry.model.nodes.some((node) => node.path.length === path.length && node.path.every((part, i) => part === path[i]))) {
            throw new Error(`Source node for ${object.name} is not present in ${asset.name}. Locate the matching original or reimport it.`);
          }
        }
      } catch (error) { if (!options.tolerateErrors) throw error; }
    }
  } finally {
    for (const entry of held) {
      entry.references -= 1;
      // Give the caller a fresh grace period to acquire its actual scene lease.
      scheduleEviction(entry, false);
    }
  }
}

/**
 * A selectable node keeps its ancestor transforms and every bone its skin uses.
 * Unselected mesh ancestors become transform-only groups, avoiding duplicate rendering.
 * Static objects therefore cost O(path depth), not a clone of the entire scene per mesh.
 */
function nodePrototype(entry: CacheEntry, path: readonly number[]): THREE.Object3D {
  const key = path.join('/');
  const cached = entry.prototypes.get(key);
  if (cached) return cached;
  const target = sourceNodeAtPath(entry.model.root, path);
  const descriptor = entry.model.nodes.find((node) => node.path.join('/') === path.join('/'));
  if (!descriptor) throw new Error('Source selection does not correspond to an authored renderable node.');
  const owned = new Set((descriptor.renderablePaths ?? [descriptor.path]).map((part) => sourceNodeAtPath(entry.model.root, part)));
  const keep = new Set<THREE.Object3D>();
  const addAncestors = (node: THREE.Object3D) => {
    let current: THREE.Object3D | null = node;
    while (current) {
      keep.add(current);
      if (current === entry.model.root) break;
      current = current.parent;
    }
    if (!current) throw new Error('Source node has a dependency outside its scene. Import the complete scene instead.');
  };
  addAncestors(target);
  const skins: THREE.SkinnedMesh[] = [];
  for (const node of owned) {
    addAncestors(node);
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) {
      const skin = node as THREE.SkinnedMesh;
      skins.push(skin); skin.skeleton.bones.forEach(addAncestors);
    }
  }
  const copies = new Map<THREE.Object3D, THREE.Object3D>();
  const copyTree = (source: THREE.Object3D): THREE.Object3D => {
    const result = !owned.has(source) && isSourceRenderable(source)
      ? new THREE.Group().copy(source, false)
      : source.clone(false);
    copies.set(source, result);
    for (const child of source.children) if (keep.has(child)) result.add(copyTree(child));
    return result;
  };
  const prototype = copyTree(entry.model.root);
  for (const skinned of skins) {
    const mesh = copies.get(skinned) as THREE.SkinnedMesh;
    mesh.skeleton = skinned.skeleton.clone();
    mesh.skeleton.bones = skinned.skeleton.bones.map((bone) => copies.get(bone) as THREE.Bone);
    if (mesh.skeleton.bones.some((bone) => !bone?.isBone)) throw new Error('Could not preserve the selected mesh skeleton.');
    mesh.bindMatrix.copy(skinned.bindMatrix);
    mesh.bindMatrixInverse.copy(skinned.bindMatrixInverse);
  }
  prototype.updateMatrixWorld(true);
  entry.prototypes.set(key, prototype);
  return prototype;
}

function fallback(object: SceneObject, asset: ProjectAsset, message: string): THREE.Object3D {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(...object.dimensions);
  const material = new THREE.MeshBasicMaterial({ color: 0xd97706, wireframe: true, transparent: true, opacity: 0.8 });
  root.add(new THREE.Mesh(geometry, material));
  root.scale.fromArray(object.transform.scale);
  root.userData.missingAssetPlaceholder = true;
  root.userData.missingAssetId = asset.id;
  root.userData.importedModelError = message;
  root.userData.sourceModelPending = !errors.has(cacheKey(asset));
  return root;
}

export function createSourceModelNode(object: SceneObject, asset: ProjectAsset, overrideMaterial?: THREE.Material): THREE.Object3D {
  const entry = entries.get(cacheKey(asset));
  if (!entry) return fallback(object, asset, errors.get(cacheKey(asset)) ?? 'Preserved source model is loading.');
  try {
    const path = object.sourceModelNodePath;
    const prototype = path === undefined ? entry.model.root : nodePrototype(entry, path);
    const sourceBounds = path === undefined ? entry.model.bounds
      : entry.model.nodes.find((node) => node.path.length === path.length && node.path.every((value, i) => value === path[i]))?.bounds;
    if (!sourceBounds) throw new Error('The saved source node is not present in this asset. Reimport or locate the matching original.');
    const instance = entry.model.clone(prototype);
    instance.animations = entry.model.animations;
    instance.traverse((node) => {
      if ((node as THREE.Light).isLight && object.sourceModelLightsEnabled !== true) node.visible = false;
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (overrideMaterial) mesh.material = overrideMaterial;
      }
    });
    const center = sourceBounds.min.map((value, i) => (value + sourceBounds.max[i]) / 2);
    const size = sourceBounds.min.map((value, i) => sourceBounds.max[i] - value);
    const pivot = new THREE.Group();
    pivot.name = 'ForeSceneSourcePivot';
    pivot.position.set(-center[0], -center[1], -center[2]);
    pivot.add(instance);
    const root = new THREE.Group();
    root.add(pivot);
    root.animations = entry.model.animations;
    root.userData.sourceModelPreserved = true;
    root.userData.sourceModelAssetId = asset.id;
    root.userData.sourceModelDimensionsScale = size.map((value, i) => Math.abs(value) > 1e-8 ? object.dimensions[i] / value : 1);
    updateSourceModelScale(root, object);
    entry.references += 1;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    leases.set(root, entry);
    return root;
  } catch (error) {
    return fallback(object, asset, error instanceof Error ? error.message : String(error));
  }
}

export function updateSourceModelScale(root: THREE.Object3D, object: Pick<SceneObject, 'transform'>): void {
  const dimensions = root.userData.sourceModelDimensionsScale as number[] | undefined;
  if (!dimensions) return;
  root.scale.set(dimensions[0] * object.transform.scale[0], dimensions[1] * object.transform.scale[1], dimensions[2] * object.transform.scale[2]);
}

function disposeInstanceState(root: THREE.Object3D): void {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((node as THREE.SkinnedMesh).skeleton);
    if ((node as THREE.InstancedMesh).isInstancedMesh) (node as THREE.InstancedMesh).dispose();
  });
  skeletons.forEach((skeleton) => skeleton.dispose());
}

/** Idempotent: multiple cleanup paths cannot release another live scene's resources. */
export function releaseSourceModelInstance(root: THREE.Object3D): void {
  const entry = leases.get(root);
  if (!entry) return;
  leases.delete(root);
  disposeInstanceState(root);
  entry.references = Math.max(0, entry.references - 1);
  scheduleEviction(entry);
}

export function sourceModelInventoryKey(project: Pick<LocationProject, 'scene' | 'assets'>): string {
  return JSON.stringify(project.scene.objects.filter((object) => object.type === 'imported_model' && object.visible).map((object) => {
    const asset = object.modelAssetId ? project.assets.assets[object.modelAssetId] : undefined;
    return asset && isSourceModelAsset(asset) ? [object.id, cacheKey(asset)] : null;
  }));
}

export function resetSourceModelRuntimeForTests(): void {
  generation += 1;
  for (const entry of entries.values()) {
    // Tests must dispose their scenes first; do not invalidate an outstanding instance silently.
    if (entry.references) throw new Error('Source model instances are still leased. Dispose scenes before resetting the cache.');
    evict(entry);
  }
  pending.clear(); errors.clear(); listeners.clear(); revision = 0;
}
