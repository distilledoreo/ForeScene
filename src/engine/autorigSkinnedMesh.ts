import * as THREE from 'three';
import type { HumanJointId, PoseableRigAsset, Vec3 } from '../domain/types';
import { HUMAN_JOINT_IDS, HUMAN_JOINT_LABELS } from './humanPose';
import { HUMAN_JOINT_PARENT } from './humanoidSkeleton';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { getModelAsset } from './modelAssetStore';
import type { SkinWeightBuffers } from './autorigSkinWeights';

export async function loadSkinWeightBuffers(
  rig: PoseableRigAsset,
): Promise<SkinWeightBuffers | undefined> {
  const skin = rig.skin;
  if (!skin) return undefined;
  const jointOrder = (rig.skeletonJoints?.length ? rig.skeletonJoints : [...HUMAN_JOINT_IDS]) as HumanJointId[];

  if (skin.skinAssetId) {
    // Resolve via assets map is caller's job; here we only support direct IDB keys encoded in metadata later.
    return undefined;
  }
  if (skin.indices && skin.weights) {
    return {
      influencesPerVertex: skin.influencesPerVertex || 4,
      indices: Uint16Array.from(skin.indices),
      weights: Float32Array.from(skin.weights),
      jointOrder,
    };
  }
  return undefined;
}

export async function loadSkinWeightBuffersFromUri(uri: string, jointOrder: HumanJointId[]): Promise<SkinWeightBuffers> {
  if (!uri.startsWith(MODEL_ASSET_URI_PREFIX)) {
    throw new Error('Skin payload URI must be a local model asset.');
  }
  const key = uri.slice(MODEL_ASSET_URI_PREFIX.length);
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
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  template.updateMatrixWorld(true);
  template.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometries.push(geometry);
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    materials.push(material ?? params.materialFallback ?? new THREE.MeshStandardMaterial({ color: '#9ca3af' }));
  });
  if (geometries.length === 0) {
    root.add(template.clone(true));
    return root;
  }

  // Merge into one geometry for a single skin binding.
  const merged = geometries.length === 1
    ? geometries[0]!
    : mergeBufferGeometriesCompat(geometries);
  const position = merged.getAttribute('position');
  if (!position || position.count * buffers.influencesPerVertex !== buffers.indices.length) {
    // Vertex count mismatch (multi-mesh merge vs weights from first pass) — fall back to rigid.
    root.add(template.clone(true));
    return root;
  }

  const skinIndex = new THREE.BufferAttribute(new Uint16Array(buffers.indices), buffers.influencesPerVertex);
  const skinWeight = new THREE.BufferAttribute(new Float32Array(buffers.weights), buffers.influencesPerVertex);
  merged.setAttribute('skinIndex', skinIndex);
  merged.setAttribute('skinWeight', skinWeight);

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
  const material = materials[0] ?? new THREE.MeshStandardMaterial({ color: '#9ca3af' });
  const skinned = new THREE.SkinnedMesh(merged, material);
  skinned.frustumCulled = false;
  skinned.add(bones.find((bone) => !bone.parent || !(bone.parent as THREE.Bone).isBone) ?? bones[0]!);
  skinned.bind(skeleton);
  root.add(skinned);

  // Keep labels available for pose UI / debugging.
  for (const jointId of buffers.jointOrder) {
    const bone = boneById.get(jointId);
    if (bone) bone.userData.displayName = HUMAN_JOINT_LABELS[jointId];
  }
  root.userData.panorefPoseBones = boneById;
  return root;
}

function mergeBufferGeometriesCompat(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Minimal position merge (enough for skinning attribute alignment when counts match).
  let count = 0;
  for (const geometry of geometries) count += geometry.getAttribute('position')?.count ?? 0;
  const positions = new Float32Array(count * 3);
  let offset = 0;
  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    if (!position) continue;
    for (let i = 0; i < position.count; i += 1) {
      positions[(offset + i) * 3] = position.getX(i);
      positions[(offset + i) * 3 + 1] = position.getY(i);
      positions[(offset + i) * 3 + 2] = position.getZ(i);
    }
    offset += position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  return merged;
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
    positions[marker.jointId] = [...marker.position] as Vec3;
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
