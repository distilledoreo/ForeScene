import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildDirtyVertexSet,
  createRegionEditFromLabels,
  expandVertexRings,
} from '../src/engine/autorig/dirtyRegionSet';
import {
  assertNoForbiddenInfluences,
  generatePartialRegionConstrainedSkinWeights,
  generateRegionConstrainedSkinWeights,
} from '../src/engine/autorig/regionConstrainedWeights';
import {
  applyPartialSkinUpdate,
  extractPartialSkinUpdate,
  validatePartialSkinUpdate,
} from '../src/engine/autorig/partialSkinUpdate';
import {
  applyPartialSkinUpdateToPreviewSession,
  applySkinBuffersToPreviewSession,
  collectPreviewMeshBindings,
  createAutorigPreviewSession,
} from '../src/engine/autorig/previewSession';
import { AUTORIG_REGION_CODE } from '../src/engine/autorig/regions';
import { buildCanonicalTopologyFromBuffers } from '../src/engine/autorig/topology';
import { fitSkeletonFromMarkers, suggestAutorigMarkers } from '../src/engine/autorigMarkers';
import { captureBoneRests } from '../src/engine/poseableCharacter';
import type { HumanJointId } from '../src/domain/types';
import type { PoseableRigAsset } from '../src/domain/types';
import { buildSkinnedCharacterFromTemplate } from '../src/engine/autorigSkinnedMesh';
import { applyFittedSkeletonToRig } from '../src/engine/autorigMarkers';

function makeChainTopology() {
  // Two quads sharing an edge: verts 0-3 left, 1-2-4-5 right.
  const positions = Float32Array.from([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
    2, 0, 0,
    2, 1, 0,
  ]);
  const triangles = Uint32Array.from([
    0, 1, 2,
    0, 2, 3,
    1, 4, 5,
    1, 5, 2,
  ]);
  return buildCanonicalTopologyFromBuffers({ positions, triangles });
}

function makeSeparatedHumanoid() {
  const markers = suggestAutorigMarkers({ size: [0.9, 1.75, 0.35], heightMeters: 1.75, poseHint: 'a-pose' });
  const fitted = fitSkeletonFromMarkers(markers, 'full');
  const jp = fitted.jointPositions;
  const seeds: Array<[number, number, number, number]> = [
    [...(jp.head ?? [0, 1.65, 0]), AUTORIG_REGION_CODE.head],
    [...(jp.chest ?? [0, 1.2, 0]), AUTORIG_REGION_CODE.torso],
    [...(jp.leftHand ?? [0.55, 0.95, 0]), AUTORIG_REGION_CODE.leftArm],
    [...(jp.rightHand ?? [-0.55, 0.95, 0]), AUTORIG_REGION_CODE.rightArm],
    [...(jp.leftFoot ?? [0.15, 0.05, 0.05]), AUTORIG_REGION_CODE.leftLeg],
    [...(jp.rightFoot ?? [-0.15, 0.05, 0.05]), AUTORIG_REGION_CODE.rightLeg],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  const labels: number[] = [];
  seeds.forEach((seed, index) => {
    const base = index * 3;
    const [x, y, z, code] = seed;
    positions.push(x, y, z, x + 0.02, y + 0.01, z, x - 0.02, y + 0.01, z);
    triangles.push(base, base + 1, base + 2);
    labels.push(code, code, code);
  });
  return {
    positions: Float32Array.from(positions),
    triangles: Uint32Array.from(triangles),
    labels: Uint8Array.from(labels),
    jointPositions: fitted.jointPositions,
    fitted,
    markers,
  };
}

describe('dirty region set', () => {
  it('expands seed vertices across adjacency rings', () => {
    const topology = makeChainTopology();
    const expanded = expandVertexRings({
      topology,
      seeds: [0],
      rings: 2,
    });
    expect(Array.from(expanded).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('builds a dirty set from painted verts plus seam rings', () => {
    const topology = makeChainTopology();
    const previous = Uint8Array.from([
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
    ]);
    const next = Uint8Array.from([
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
    ]);
    const edit = createRegionEditFromLabels({ previousLabels: previous, nextLabels: next });
    expect(edit).not.toBeNull();
    const dirty = buildDirtyVertexSet({
      topology,
      edit: edit!,
      paintRings: 1,
      seamRings: 1,
    });
    expect(dirty.length).toBeGreaterThan(0);
    expect(Array.from(dirty)).toContain(4);
    expect(Array.from(dirty)).toContain(5);
  });
});

describe('partial Binder V2 rebind', () => {
  it('matches full regeneration for dirty vertices and leaves others byte-identical', () => {
    const fixture = makeSeparatedHumanoid();
    const topology = buildCanonicalTopologyFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
    });
    const before = generateRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: fixture.labels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
    });

    const nextLabels = new Uint8Array(fixture.labels);
    // Relabel left-arm cluster as torso then back — simulate a correction.
    nextLabels[6] = AUTORIG_REGION_CODE.torso;
    nextLabels[7] = AUTORIG_REGION_CODE.torso;
    nextLabels[8] = AUTORIG_REGION_CODE.torso;

    const fullAfter = generateRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: nextLabels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
    });

    const live = {
      ...before,
      indices: before.indices.slice(),
      weights: before.weights.slice(),
    };
    const partial = generatePartialRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: nextLabels,
      previousRegionLabels: fixture.labels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
      revision: 1,
    });
    expect(partial.vertexIndices.length).toBeGreaterThan(0);
    applyPartialSkinUpdate(live, partial);

    const ipv = live.influencesPerVertex;
    for (let i = 0; i < partial.vertexIndices.length; i += 1) {
      const v = partial.vertexIndices[i]!;
      const base = v * ipv;
      for (let s = 0; s < ipv; s += 1) {
        expect(live.indices[base + s]).toBe(fullAfter.indices[base + s]);
        expect(live.weights[base + s]).toBeCloseTo(fullAfter.weights[base + s]!, 5);
      }
    }

    const dirty = new Set(Array.from(partial.vertexIndices));
    for (let v = 0; v < fixture.labels.length; v += 1) {
      if (dirty.has(v)) continue;
      const base = v * ipv;
      for (let s = 0; s < ipv; s += 1) {
        expect(live.indices[base + s]).toBe(before.indices[base + s]);
        expect(live.weights[base + s]).toBe(before.weights[base + s]);
      }
    }

    const check = assertNoForbiddenInfluences({
      indices: live.indices,
      weights: live.weights,
      jointOrder: live.jointOrder,
      regionLabels: nextLabels,
    });
    expect(check.ok).toBe(true);
  });

  it('rejects stale revisions and invalid weight payloads', () => {
    const buffers = {
      influencesPerVertex: 4,
      indices: new Uint16Array(8),
      weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
      jointOrder: ['hips', 'spine'] as HumanJointId[],
    };
    const update = extractPartialSkinUpdate({
      buffers,
      vertexIndices: [0],
      revision: 2,
    });
    expect(validatePartialSkinUpdate({
      buffers,
      update,
      expectedRevision: 1,
    }).ok).toBe(false);

    const bad = {
      ...update,
      revision: 1,
      skinWeights: new Float32Array([Number.NaN, 0, 0, 0]),
    };
    expect(validatePartialSkinUpdate({ buffers, update: bad, expectedRevision: 1 }).ok).toBe(false);
  });
});

describe('in-place preview session updates', () => {
  it('patches skinned mesh attributes without replacing the root', () => {
    const fixture = makeSeparatedHumanoid();
    const topology = buildCanonicalTopologyFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
    });
    const buffers = generateRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: fixture.labels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
    });

    // Minimal template matching the fixture vertex count.
    const template = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(fixture.positions.slice(), 3));
    geo.setIndex(Array.from(fixture.triangles));
    template.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));

    const rig = applyFittedSkeletonToRig({
      id: 'rig-test',
      name: 'test',
      kind: 'poseable_rig',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      markers: fixture.markers,
      skeletonJoints: buffers.jointOrder,
      bindMatrices: {},
      generationSettings: { approximateHeightMeters: 1.75 },
    } as unknown as PoseableRigAsset, fixture.fitted);

    const root = buildSkinnedCharacterFromTemplate({ template, rig, buffers });
    const bones = new Map<HumanJointId, THREE.Bone>();
    root.traverse((node) => {
      const bone = node as THREE.Bone;
      const jointId = bone.userData.humanJointId as HumanJointId | undefined;
      if (bone.isBone && jointId) bones.set(jointId, bone);
    });
    const session = createAutorigPreviewSession({
      root,
      bones,
      rests: captureBoneRests(bones),
      topology,
      buffers: {
        ...buffers,
        indices: buffers.indices.slice(),
        weights: buffers.weights.slice(),
      },
    });
    expect(collectPreviewMeshBindings(root).length).toBeGreaterThan(0);

    const rootBefore = session.root;
    const nextLabels = new Uint8Array(fixture.labels);
    nextLabels[6] = AUTORIG_REGION_CODE.torso;
    const partial = generatePartialRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: nextLabels,
      previousRegionLabels: fixture.labels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
      revision: 1,
    });
    session.editRevision = 1;
    const applied = applyPartialSkinUpdateToPreviewSession(session, partial);
    expect(applied.ok).toBe(true);
    expect(session.root).toBe(rootBefore);

    // Full buffer replace also keeps the same root.
    const full = generateRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: nextLabels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
    });
    applySkinBuffersToPreviewSession(session, full);
    expect(session.root).toBe(rootBefore);
  });
});
