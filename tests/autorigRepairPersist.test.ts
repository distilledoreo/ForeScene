import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { AssetRegistry, PoseableRigAsset } from '../src/domain/types';
import {
  assertSkinWeightBuffersCompatible,
  cloneSkinWeightBuffers,
  type SkinWeightBuffers,
} from '../src/engine/autorigSkinWeights';
import {
  ensureSkinBuffersForRig,
  getSkinBinaryReadCount,
  resetAutorigRuntimeCachesForTests,
} from '../src/engine/autorigSkinnedMesh';
import {
  generateSkinWeightsForRigAsset,
  resetAutoriggedCharacterTemplatesForTests,
  setAutorigSourceTemplateForTests,
} from '../src/engine/autoriggedPoseableCharacter';
import { applyFittedSkeletonToRig, fitSkeletonFromMarkers, suggestAutorigMarkers } from '../src/engine/autorigMarkers';
import { HUMAN_JOINT_IDS } from '../src/engine/humanPose';

const SOURCE_ID = 'src_repair_persist';
const VERTEX_COUNT = 4;

function makeFittedRig(id = 'rig_repair_persist'): PoseableRigAsset {
  const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
  const fitted = fitSkeletonFromMarkers(markers, 'full');
  let rig: PoseableRigAsset = {
    version: 1,
    id,
    skeletonJoints: [...HUMAN_JOINT_IDS],
    originalSourceAssetId: SOURCE_ID,
    sourceMeshAssetId: SOURCE_ID,
    generationSettings: { approximateHeightMeters: 1.75 },
  };
  return applyFittedSkeletonToRig(rig, fitted);
}

/** Distinctive repaired weights that Binder regeneration would not recreate verbatim. */
function makeRepairedBuffers(vertexCount: number): SkinWeightBuffers {
  const ipv = 4;
  const jointOrder = [...HUMAN_JOINT_IDS];
  const hips = jointOrder.indexOf('hips');
  const leftUpperArm = jointOrder.indexOf('leftUpperArm');
  const indices = new Uint16Array(vertexCount * ipv);
  const weights = new Float32Array(vertexCount * ipv);
  for (let v = 0; v < vertexCount; v += 1) {
    const base = v * ipv;
    indices[base] = leftUpperArm;
    indices[base + 1] = hips;
    weights[base] = 0.73;
    weights[base + 1] = 0.27;
  }
  return {
    influencesPerVertex: ipv,
    indices,
    weights,
    jointOrder,
    fallbackVertexCount: 0,
  };
}

function seedTemplate(vertexCount: number): void {
  const positions = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v += 1) {
    positions[v * 3] = (v % 2) * 0.2;
    positions[v * 3 + 1] = 1 + Math.floor(v / 2) * 0.25;
    positions[v * 3 + 2] = 0;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const root = new THREE.Group();
  root.add(mesh);
  setAutorigSourceTemplateForTests(SOURCE_ID, root);
}

afterEach(() => {
  resetAutorigRuntimeCachesForTests();
  resetAutoriggedCharacterTemplatesForTests();
});

describe('autorig repaired skin buffer persistence', () => {
  it('cloneSkinWeightBuffers deep-copies so Apply can snapshot preview weights', () => {
    const original = makeRepairedBuffers(3);
    original.weights[0] = 0.42;
    const cloned = cloneSkinWeightBuffers(original);
    expect(cloned.weights[0]).toBeCloseTo(0.42, 5);
    expect(cloned.indices).not.toBe(original.indices);
    expect(cloned.weights).not.toBe(original.weights);
    expect(cloned.jointOrder).not.toBe(original.jointOrder);
    cloned.weights[0] = 0.99;
    expect(original.weights[0]).toBeCloseTo(0.42, 5);
  });

  it('assertSkinWeightBuffersCompatible rejects mismatched vertex count, ipv, joints, and indices', () => {
    const ok = makeRepairedBuffers(VERTEX_COUNT);
    expect(() => assertSkinWeightBuffersCompatible(ok, { vertexCount: VERTEX_COUNT })).not.toThrow();

    expect(() => assertSkinWeightBuffersCompatible(ok, { vertexCount: VERTEX_COUNT + 1 })).toThrow(/vertices/);
    expect(() => assertSkinWeightBuffersCompatible(
      { ...ok, influencesPerVertex: 3 },
      { vertexCount: VERTEX_COUNT },
    )).toThrow(/influencesPerVertex/);

    const badJoint = cloneSkinWeightBuffers(ok);
    badJoint.jointOrder[0] = 'notAJoint' as SkinWeightBuffers['jointOrder'][number];
    expect(() => assertSkinWeightBuffersCompatible(badJoint, { vertexCount: VERTEX_COUNT }))
      .toThrow(/jointOrder/);

    const emptyJoints = cloneSkinWeightBuffers(ok);
    emptyJoints.jointOrder = [];
    expect(() => assertSkinWeightBuffersCompatible(emptyJoints, { vertexCount: VERTEX_COUNT }))
      .toThrow(/non-empty jointOrder/);

    const oob = cloneSkinWeightBuffers(ok);
    oob.indices[0] = 9999;
    expect(() => assertSkinWeightBuffersCompatible(oob, { vertexCount: VERTEX_COUNT }))
      .toThrow(/outside jointOrder bounds/);
  });

  it('generateSkinWeightsForRigAsset persists supplied repaired buffers through binary write/readback', async () => {
    seedTemplate(VERTEX_COUNT);
    const rig = makeFittedRig();
    const repaired = makeRepairedBuffers(VERTEX_COUNT);
    // Marker fingerprint so regenerated Binder weights cannot accidentally match.
    repaired.weights[0] = 0.81;
    repaired.weights[1] = 0.19;

    const { rig: skinnedRig, skinAsset } = await generateSkinWeightsForRigAsset({
      rig,
      sourceAssetId: SOURCE_ID,
      skinBuffers: repaired,
    });

    expect(skinnedRig.skin?.skinAssetId).toBe(skinAsset.id);
    expect(skinnedRig.skin?.indices).toBeUndefined();
    expect(skinnedRig.skin?.weights).toBeUndefined();
    expect(skinAsset.metadata?.previewRepaired).toBe(true);

    // Drop the in-memory cache so the next load must read the binary asset.
    resetAutorigRuntimeCachesForTests();
    const assets: AssetRegistry = {
      assets: {
        [skinAsset.id]: skinAsset,
      },
    };
    const readsBefore = getSkinBinaryReadCount();
    const loaded = await ensureSkinBuffersForRig(skinnedRig, assets);
    expect(getSkinBinaryReadCount()).toBe(readsBefore + 1);
    expect(loaded).toBeTruthy();
    expect(loaded!.influencesPerVertex).toBe(4);
    expect(loaded!.indices.length).toBe(VERTEX_COUNT * 4);
    expect(loaded!.weights[0]).toBeCloseTo(0.81, 5);
    expect(loaded!.weights[1]).toBeCloseTo(0.19, 5);
    expect(loaded!.indices[0]).toBe(repaired.indices[0]);
    expect(loaded!.indices[1]).toBe(repaired.indices[1]);
  });

  it('generateSkinWeightsForRigAsset rejects incompatible supplied buffers before write', async () => {
    seedTemplate(VERTEX_COUNT);
    const rig = makeFittedRig();
    const wrongVertexCount = makeRepairedBuffers(VERTEX_COUNT + 2);
    await expect(generateSkinWeightsForRigAsset({
      rig,
      sourceAssetId: SOURCE_ID,
      skinBuffers: wrongVertexCount,
    })).rejects.toThrow(/vertices/);
  });
});
