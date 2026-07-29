import type { HumanJointId, HumanPose } from '../../../domain/types';
import type { CanonicalAutorigTopology } from '../../../engine/autorig/topology';
import type { SkinWeightBuffers } from '../../../engine/autorigSkinWeights';
import type { BoneRestPose } from '../../../engine/poseableCharacter';
import type * as THREE from 'three';

export interface AutorigPreviewMeshBinding {
  mesh: THREE.SkinnedMesh;
  canonicalVertexStart: number;
  vertexCount: number;
  triangleStart: number;
  triangleCount: number;
}

export interface AutorigPreviewSession {
  root: THREE.Object3D;
  bones: Map<HumanJointId, THREE.Bone>;
  rests: Map<HumanJointId, BoneRestPose>;
  topology: CanonicalAutorigTopology;
  buffers: SkinWeightBuffers;
  activePoseId: string;
  activePose?: HumanPose;
  meshBindings: AutorigPreviewMeshBinding[];
}

/** Collect canonical vertex/triangle offsets from skinned meshes. */
export function collectPreviewMeshBindings(root: THREE.Object3D): AutorigPreviewMeshBinding[] {
  const bindings: AutorigPreviewMeshBinding[] = [];
  let fallbackVertex = 0;
  let fallbackTriangle = 0;
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute('position');
    const vertexCount = position?.count
      ?? Number(mesh.userData.autorigVertexCount)
      ?? 0;
    const index = mesh.geometry.getIndex();
    const triangleCount = Number(mesh.userData.autorigTriangleCount)
      || (index ? Math.floor(index.count / 3) : Math.floor(vertexCount / 3));
    const canonicalVertexStart = typeof mesh.userData.autorigVertexStart === 'number'
      ? mesh.userData.autorigVertexStart
      : fallbackVertex;
    const triangleStart = typeof mesh.userData.autorigTriangleStart === 'number'
      ? mesh.userData.autorigTriangleStart
      : fallbackTriangle;
    bindings.push({
      mesh,
      canonicalVertexStart,
      vertexCount,
      triangleStart,
      triangleCount,
    });
    fallbackVertex = canonicalVertexStart + vertexCount;
    fallbackTriangle = triangleStart + triangleCount;
  });
  return bindings;
}
