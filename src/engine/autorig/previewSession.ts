import * as THREE from 'three';
import type { HumanJointId, HumanPose } from '../../domain/types';
import type { SkinWeightBuffers } from '../autorigSkinWeights';
import type { CanonicalAutorigTopology } from './topology';
import type { BoneRestPose } from '../poseableCharacter';
import {
  applyPartialSkinUpdate,
  validatePartialSkinUpdate,
  type PartialSkinWeightUpdate,
} from './partialSkinUpdate';

export type { PartialSkinWeightUpdate };

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
  /** Monotonic correction revision for stale-result rejection. */
  editRevision: number;
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

/**
 * Push full skin buffers into existing skinned meshes without rebuilding the root.
 */
export function applySkinBuffersToPreviewSession(
  session: AutorigPreviewSession,
  buffers: SkinWeightBuffers,
): void {
  session.buffers = buffers;
  const ipv = buffers.influencesPerVertex;
  for (const binding of session.meshBindings) {
    const { mesh, canonicalVertexStart, vertexCount } = binding;
    const geometry = mesh.geometry;
    const indexAttr = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const weightAttr = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    if (!indexAttr || !weightAttr) continue;

    const srcStart = canonicalVertexStart * ipv;
    const srcEnd = (canonicalVertexStart + vertexCount) * ipv;
    const nextIndices = buffers.indices.subarray(srcStart, srcEnd);
    const nextWeights = buffers.weights.subarray(srcStart, srcEnd);

    const indexArray = indexAttr.array as Uint16Array | Float32Array;
    const weightArray = weightAttr.array as Float32Array;
    if (indexArray.length >= nextIndices.length && weightArray.length >= nextWeights.length) {
      for (let i = 0; i < nextIndices.length; i += 1) indexArray[i] = nextIndices[i]!;
      weightArray.set(nextWeights);
    } else {
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(nextIndices.slice(), ipv));
      geometry.setAttribute('skinWeight', new THREE.BufferAttribute(nextWeights.slice(), ipv));
    }
    const nextIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    const nextWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
    nextIndex.needsUpdate = true;
    nextWeight.needsUpdate = true;
  }
}

/**
 * Apply only dirty vertex influences onto existing mesh attributes.
 */
export function applyPartialSkinUpdateToPreviewSession(
  session: AutorigPreviewSession,
  update: PartialSkinWeightUpdate,
): { ok: true } | { ok: false; message: string } {
  const validated = validatePartialSkinUpdate({
    buffers: session.buffers,
    update,
    expectedRevision: session.editRevision,
  });
  if (!validated.ok) return validated;

  applyPartialSkinUpdate(session.buffers, update);

  const ipv = session.buffers.influencesPerVertex;
  for (const binding of session.meshBindings) {
    const { mesh, canonicalVertexStart, vertexCount } = binding;
    const geometry = mesh.geometry;
    const indexAttr = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const weightAttr = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    if (!indexAttr || !weightAttr) continue;
    const indexArray = indexAttr.array as Uint16Array;
    const weightArray = weightAttr.array as Float32Array;
    let touched = false;

    for (let i = 0; i < update.vertexIndices.length; i += 1) {
      const globalV = update.vertexIndices[i]!;
      if (globalV < canonicalVertexStart || globalV >= canonicalVertexStart + vertexCount) continue;
      const localV = globalV - canonicalVertexStart;
      const src = i * ipv;
      const dst = localV * ipv;
      for (let s = 0; s < ipv; s += 1) {
        indexArray[dst + s] = update.skinIndices[src + s]!;
        weightArray[dst + s] = update.skinWeights[src + s]!;
      }
      touched = true;
    }

    if (!touched) continue;
    indexAttr.needsUpdate = true;
    weightAttr.needsUpdate = true;
  }

  return { ok: true };
}

export function createAutorigPreviewSession(params: {
  root: THREE.Object3D;
  bones: Map<HumanJointId, THREE.Bone>;
  rests: Map<HumanJointId, BoneRestPose>;
  topology: CanonicalAutorigTopology;
  buffers: SkinWeightBuffers;
  activePoseId?: string;
  activePose?: HumanPose;
}): AutorigPreviewSession {
  return {
    root: params.root,
    bones: params.bones,
    rests: params.rests,
    topology: params.topology,
    buffers: params.buffers,
    activePoseId: params.activePoseId ?? 'neutral',
    activePose: params.activePose,
    meshBindings: collectPreviewMeshBindings(params.root),
    editRevision: 0,
  };
}

export {
  applyPartialSkinUpdate,
  validatePartialSkinUpdate,
  extractPartialSkinUpdate,
} from './partialSkinUpdate';
