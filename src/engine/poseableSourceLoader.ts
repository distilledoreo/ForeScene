import * as THREE from 'three';
import type { ProjectAsset, ImportedRigSourceFormat } from '../domain/types';

export interface LoadedPoseableSource {
  root: THREE.Object3D;
  format: ImportedRigSourceFormat;
  skinnedMeshes: THREE.SkinnedMesh[];
  bones: THREE.Bone[];
  skeletonRoots: THREE.Bone[];
  animationClips: THREE.AnimationClip[];
  bounds: THREE.Box3;
  heightMeters: number;
  warnings: string[];
}

function sourceFormat(asset: ProjectAsset): ImportedRigSourceFormat {
  const candidate = asset.metadata?.format;
  if (candidate === 'glb' || candidate === 'gltf' || candidate === 'fbx') return candidate;
  const match = asset.name.toLowerCase().match(/\.(glb|gltf|fbx)$/);
  if (match?.[1] === 'glb' || match?.[1] === 'gltf' || match?.[1] === 'fbx') return match[1];
  throw new Error(`Could not determine the poseable source format for ${asset.name}.`);
}

function hasExternalGltfBuffer(text: string): boolean {
  try {
    const document = JSON.parse(text) as { buffers?: Array<{ uri?: unknown }> };
    return (document.buffers ?? []).some((buffer) => (
      typeof buffer.uri === 'string' && !buffer.uri.startsWith('data:')
    ));
  } catch {
    return /"uri"\s*:\s*"(?!data:)[^"]+"/i.test(text);
  }
}

function finiteObjectTransform(object: THREE.Object3D): boolean {
  return [
    object.position.x, object.position.y, object.position.z,
    object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w,
    object.scale.x, object.scale.y, object.scale.z,
  ].every(Number.isFinite);
}

function collectSkeletonData(root: THREE.Object3D): {
  skinnedMeshes: THREE.SkinnedMesh[];
  bones: THREE.Bone[];
  skeletonRoots: THREE.Bone[];
  warnings: string[];
} {
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  const bones = new Set<THREE.Bone>();
  const skeletonRoots = new Set<THREE.Bone>();
  const warnings: string[] = [];
  let invalidTransform = false;
  root.traverse((node) => {
    if (!finiteObjectTransform(node)) invalidTransform = true;
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    skinnedMeshes.push(mesh);
    for (const bone of mesh.skeleton.bones) {
      bones.add(bone);
      let rootBone = bone;
      while (rootBone.parent instanceof THREE.Bone) rootBone = rootBone.parent;
      skeletonRoots.add(rootBone);
    }
  });
  if (invalidTransform) warnings.push('The source contains non-finite node transforms.');
  if (skinnedMeshes.length === 0) warnings.push('No skinned mesh was found in the source.');
  if (bones.size === 0) warnings.push('No deformation bones were found in the source.');
  if (skeletonRoots.size > 1) warnings.push('The source contains multiple unrelated skeletons; preserved-rig mode supports one.');
  return {
    skinnedMeshes,
    bones: [...bones],
    skeletonRoots: [...skeletonRoots],
    warnings,
  };
}

export async function loadPoseableSource(
  asset: ProjectAsset,
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<LoadedPoseableSource> {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  const format = sourceFormat(asset);
  let root: THREE.Object3D;
  let animationClips: THREE.AnimationClip[] = [];
  if (format === 'fbx') {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    root = new FBXLoader().parse(bytes, '');
    animationClips = root.animations ?? [];
  } else {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    let parsed: Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>;
    if (format === 'gltf') {
      const text = new TextDecoder().decode(bytes);
      if (hasExternalGltfBuffer(text)) {
        throw new Error('External glTF buffers are not supported. Use an embedded glTF or GLB.');
      }
      parsed = await loader.parseAsync(text, '');
    } else {
      parsed = await loader.parseAsync(bytes, '');
    }
    root = parsed.scene;
    animationClips = parsed.animations;
  }
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');

  root.updateMatrixWorld(true);
  const skeleton = collectSkeletonData(root);
  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  const extent = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z];
  if (!extent.every(Number.isFinite)) throw new Error('The poseable source has invalid bounds.');
  const heightMeters = size.y > 1e-6 ? size.y : Math.max(size.x, size.z);
  if (!(heightMeters > 1e-6) || !Number.isFinite(heightMeters)) {
    throw new Error('The poseable source has zero-area bounds.');
  }
  if (skeleton.warnings.some((warning) => warning.includes('non-finite'))) {
    throw new Error('The poseable source contains non-finite bone transforms.');
  }
  return {
    root,
    format,
    ...skeleton,
    animationClips,
    bounds,
    heightMeters,
    warnings: [
      ...skeleton.warnings,
      ...(animationClips.length > 0 ? [`Found ${animationClips.length} source animation clip${animationClips.length === 1 ? '' : 's'}; clips are preserved as metadata but not played on the ForeScene timeline.`] : []),
    ],
  };
}
