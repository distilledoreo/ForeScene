import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildCanonicalAutorigTopology,
  buildCanonicalTopologyFromBuffers,
  buildVertexAdjacency,
  computeConnectedComponents,
  computeTopologyHash,
  fnv1a64Hex,
} from '../src/engine/autorig/topology';
import {
  AUTORIG_REGION_CODE,
  autoLabelBodyRegions,
  applyRegionEditDelta,
  clearMirrorCorrespondenceCache,
  createRegionEditDelta,
  ensureAllVerticesLabeled,
  getOrBuildMirrorCorrespondence,
  mirrorRegionOverrides,
  normalizeRegionLabels,
  resolveRegionLabels,
} from '../src/engine/autorig/regions';
import { buildAndClassifyRegionsFromBuffers, generateRegionMapFromBuffers } from '../src/engine/autorig/generateRegionMap';
import { suggestAutorigMarkers, fitSkeletonFromMarkers } from '../src/engine/autorigMarkers';
import { prepareCanonicalAutorigMesh } from '../src/engine/autorigCanonicalMesh';
import { getReferencedProjectAssetIds, pruneUnreferencedProjectAssets } from '../src/engine/projectAssets';
import { normalizePoseableRigAsset } from '../src/engine/poseableRigNormalize';
import { createDefaultProject } from '../src/domain/defaults';
import { createId } from '../src/utils/ids';
import { MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import type { PoseableRigAsset, SceneObject } from '../src/domain/types';
import { HUMAN_JOINT_IDS } from '../src/engine/humanPose';
import {
  decodeRegionMapBinary,
  encodeRegionMapBinary,
  regionMapMatchesTopology,
  writeRegionMapBinaryAsset,
  loadRegionMapLabelsFromUri,
  applyRegionMapToRig,
} from '../src/engine/autorig/regionPersistence';

function makeSeparatedHumanoidPositions(): {
  positions: Float32Array;
  triangles: Uint32Array;
  jointPositions: ReturnType<typeof fitSkeletonFromMarkers>['jointPositions'];
} {
  const markers = suggestAutorigMarkers({ size: [0.9, 1.75, 0.35], heightMeters: 1.75, poseHint: 'a-pose' });
  const fitted = fitSkeletonFromMarkers(markers, 'full');
  const jp = fitted.jointPositions;
  // One vertex near each major region center + a tiny triangle fan per point.
  const seeds: Array<[number, number, number]> = [
    jp.head ?? [0, 1.65, 0],
    jp.chest ?? [0, 1.2, 0],
    jp.leftHand ?? [0.55, 0.95, 0],
    jp.rightHand ?? [-0.55, 0.95, 0],
    jp.leftFoot ?? [0.15, 0.05, 0.05],
    jp.rightFoot ?? [-0.15, 0.05, 0.05],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  seeds.forEach((seed, index) => {
    const base = index * 3;
    positions.push(
      seed[0], seed[1], seed[2],
      seed[0] + 0.02, seed[1] + 0.01, seed[2],
      seed[0] - 0.02, seed[1] + 0.01, seed[2],
    );
    triangles.push(base, base + 1, base + 2);
  });
  return {
    positions: Float32Array.from(positions),
    triangles: Uint32Array.from(triangles),
    jointPositions: fitted.jointPositions,
  };
}

describe('autorig topology', () => {
  it('builds CSR adjacency and connected components', () => {
    // Two disconnected triangles.
    const positions = Float32Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      5, 0, 0, 6, 0, 0, 5, 1, 0,
    ]);
    const triangles = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    const topology = buildCanonicalTopologyFromBuffers({ positions, triangles });
    expect(topology.componentCount).toBe(2);
    expect(topology.adjacencyOffsets.length).toBe(7);
    expect(topology.adjacencyVertices.length).toBeGreaterThan(0);
    expect(topology.topologyHash.length).toBe(16);
  });

  it('hashes topology by indices, not positions', () => {
    const triangles = Uint32Array.from([0, 1, 2, 0, 2, 3]);
    const parts = [{ vertexCount: 4, triangleCount: 2 }];
    const hashA = computeTopologyHash({ meshParts: parts, triangles });
    const hashB = computeTopologyHash({ meshParts: parts, triangles: Uint32Array.from(triangles) });
    expect(hashA).toBe(hashB);
    const hashC = computeTopologyHash({
      meshParts: parts,
      triangles: Uint32Array.from([0, 2, 1, 0, 2, 3]),
    });
    expect(hashC).not.toBe(hashA);
  });

  it('keeps the standard FNV-1a 64-bit digest while using numeric word arithmetic', () => {
    expect(fnv1a64Hex(new TextEncoder().encode('a'))).toBe('af63dc4c8601ec8c');
  });

  it('extracts multi-mesh parts from a canonical root', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.3));
    a.name = 'torso';
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2));
    b.name = 'glasses';
    b.position.set(0, 1.5, 0.15);
    root.add(a, b);
    root.updateMatrixWorld(true);
    const topology = buildCanonicalAutorigTopology(root);
    expect(topology.meshParts.length).toBe(2);
    expect(topology.meshParts[0]?.name).toBe('torso');
    expect(topology.meshParts[1]?.name).toBe('glasses');
    expect(topology.vertexMeshPart[0]).toBe(0);
    expect(topology.componentCount).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates adjacency neighbors', () => {
    const { adjacencyOffsets, adjacencyVertices } = buildVertexAdjacency(
      3,
      Uint32Array.from([0, 1, 2, 0, 2, 1]),
    );
    const start = adjacencyOffsets[0]!;
    const end = adjacencyOffsets[1]!;
    const neighbors = Array.from(adjacencyVertices.subarray(start, end));
    expect(new Set(neighbors).size).toBe(neighbors.length);
  });
});

describe('autorig region map', () => {
  it('round-trips binary region labels with separate overrides', () => {
    const resolved = Uint8Array.from([1, 2, 3, 4, 5, 6, 2, 2]);
    const overrides = Uint8Array.from([0, 4, 0, 0, 0, 0, 0, 3]);
    const encoded = encodeRegionMapBinary({
      resolved,
      overrides,
      topologyHash: 'abc123def4567890',
    });
    const decoded = decodeRegionMapBinary(encoded);
    expect(decoded.formatVersion).toBe(2);
    expect(decoded.vertexCount).toBe(8);
    expect(decoded.topologyHash).toBe('abc123def4567890');
    expect(Array.from(decoded.resolved)).toEqual(Array.from(resolved));
    expect(Array.from(decoded.overrides)).toEqual(Array.from(overrides));
  });

  it('reads legacy v1 binaries as resolved-only with empty overrides', () => {
    // Manually craft a v1 payload: magic, version=1, count, hashLen, hash, labels.
    const labels = Uint8Array.from([1, 2, 3]);
    const hash = new TextEncoder().encode('legacyhash000001');
    const header = new Uint32Array([0x47524e50, 1, 3, hash.length]);
    const bytes = new Uint8Array(header.byteLength + hash.length + labels.length);
    bytes.set(new Uint8Array(header.buffer), 0);
    bytes.set(hash, header.byteLength);
    bytes.set(labels, header.byteLength + hash.length);
    const decoded = decodeRegionMapBinary(bytes.buffer);
    expect(decoded.formatVersion).toBe(1);
    expect(Array.from(decoded.resolved)).toEqual([1, 2, 3]);
    expect(Array.from(decoded.overrides)).toEqual([0, 0, 0]);
  });

  it('detects topology-hash mismatches', () => {
    expect(regionMapMatchesTopology({
      version: 1,
      regionAssetId: 'r1',
      vertexCount: 10,
      topologyHash: 'aaa',
      sourceAssetId: 's1',
    }, 'aaa', 10)).toBe(true);
    expect(regionMapMatchesTopology({
      version: 1,
      regionAssetId: 'r1',
      vertexCount: 10,
      topologyHash: 'aaa',
      sourceAssetId: 's1',
    }, 'bbb', 10)).toBe(false);
  });

  it('normalizes unknown labels and honours hard overrides', () => {
    const suggested = Uint8Array.from([0, 1, 2, 3]);
    expect(Array.from(normalizeRegionLabels(suggested))).toEqual([2, 1, 2, 3]);
    const overrides = Uint8Array.from([0, 4, 0, 0]);
    expect(Array.from(resolveRegionLabels({ suggested, overrides }))).toEqual([2, 4, 2, 3]);
  });

  it('stores compact undo deltas', () => {
    const before = Uint8Array.from([1, 2, 3, 4]);
    const after = Uint8Array.from([1, 5, 3, 6]);
    const delta = createRegionEditDelta(before, after);
    expect(delta).not.toBeNull();
    expect(Array.from(delta!.vertexIndices)).toEqual([1, 3]);
    const undone = applyRegionEditDelta(new Uint8Array(after), delta!, 'undo');
    expect(Array.from(undone)).toEqual([1, 2, 3, 4]);
    const redone = applyRegionEditDelta(undone, delta!, 'redo');
    expect(Array.from(redone)).toEqual([1, 5, 3, 6]);
  });

  it('mirrors left/right hard overrides across X=0', () => {
    clearMirrorCorrespondenceCache();
    const positions = Float32Array.from([
      0.4, 1, 0,
      -0.4, 1, 0,
      0, 1.2, 0,
    ]);
    const overrides = Uint8Array.from([
      AUTORIG_REGION_CODE.leftArm,
      0,
      0,
    ]);
    const mirrored = mirrorRegionOverrides({
      positions,
      overrides,
      tolerance: 0.1,
      topologyHash: 'mirror_fixture',
    });
    expect(mirrored[1]).toBe(AUTORIG_REGION_CODE.rightArm);
    // Cached correspondence should be reused for the same topology hash.
    const again = getOrBuildMirrorCorrespondence({
      positions,
      tolerance: 0.1,
      topologyHash: 'mirror_fixture',
    });
    expect(again[0]).toBe(1);
    expect(again[1]).toBe(0);
  });

  it('preserves hard overrides when regenerating suggested labels', () => {
    const fixture = makeSeparatedHumanoidPositions();
    const first = buildAndClassifyRegionsFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
      jointPositions: fixture.jointPositions,
    });
    const overrides = new Uint8Array(first.suggested.length);
    overrides[0] = AUTORIG_REGION_CODE.torso; // force head seed → torso
    const second = buildAndClassifyRegionsFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
      jointPositions: fixture.jointPositions,
      overrides,
    });
    expect(second.overrides[0]).toBe(AUTORIG_REGION_CODE.torso);
    expect(second.resolved[0]).toBe(AUTORIG_REGION_CODE.torso);
    // Non-overridden limb seeds stay automatic.
    expect(second.overrides[6]).toBe(0);
    expect(second.resolved[6]).toBe(AUTORIG_REGION_CODE.leftArm);
  });

  it('persists resolved and overrides together through generateRegionMapFromBuffers', async () => {
    resetModelAssetStoreForTests();
    const fixture = makeSeparatedHumanoidPositions();
    const overrides = new Uint8Array(fixture.positions.length / 3);
    overrides[0] = AUTORIG_REGION_CODE.torso;
    const rig: PoseableRigAsset = {
      version: 1,
      id: 'rig_gen_buffers',
      skeletonJoints: [...HUMAN_JOINT_IDS],
      originalSourceAssetId: 'src_gen',
      generationSettings: { approximateHeightMeters: 1.75, poseHint: 'a-pose' },
    };
    const result = await generateRegionMapFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
      jointPositions: fixture.jointPositions,
      rig,
      sourceAssetId: 'src_gen',
      overrides,
      preferWorker: false,
    });
    expect(result.usedWorker).toBe(false);
    expect(result.overrides[0]).toBe(AUTORIG_REGION_CODE.torso);
    expect(result.resolved[0]).toBe(AUTORIG_REGION_CODE.torso);
    const decoded = await loadRegionMapLabelsFromUri(result.regionAsset.uri);
    expect(Array.from(decoded.overrides)).toEqual(Array.from(result.overrides));
    expect(Array.from(decoded.resolved)).toEqual(Array.from(result.resolved));
  });

  it('auto-labels separated A-pose landmarks into the six regions', () => {
    const fixture = makeSeparatedHumanoidPositions();
    const result = buildAndClassifyRegionsFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
      jointPositions: fixture.jointPositions,
      poseHint: 'a-pose',
    });
    expect(result.resolved.length).toBe(18);
    expect(result.resolved.every((code) => code >= 1 && code <= 6)).toBe(true);
    // Seed triangles: head, torso, left arm, right arm, left leg, right leg
    expect(result.resolved[0]).toBe(AUTORIG_REGION_CODE.head);
    expect(result.resolved[3]).toBe(AUTORIG_REGION_CODE.torso);
    expect(result.resolved[6]).toBe(AUTORIG_REGION_CODE.leftArm);
    expect(result.resolved[9]).toBe(AUTORIG_REGION_CODE.rightArm);
    expect(result.resolved[12]).toBe(AUTORIG_REGION_CODE.leftLeg);
    expect(result.resolved[15]).toBe(AUTORIG_REGION_CODE.rightLeg);
  });

  it('assigns disconnected accessories to the nearest region chain', () => {
    const markers = suggestAutorigMarkers({ size: [0.8, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    const head = fitted.jointPositions.head ?? [0, 1.65, 0];
    // Main head triangle + disconnected glasses triangle near the head.
    const positions = Float32Array.from([
      head[0], head[1], head[2],
      head[0] + 0.05, head[1], head[2],
      head[0], head[1] + 0.05, head[2],
      head[0], head[1] + 0.02, head[2] + 0.08,
      head[0] + 0.03, head[1] + 0.02, head[2] + 0.08,
      head[0], head[1] + 0.04, head[2] + 0.08,
    ]);
    const triangles = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    const topology = buildCanonicalTopologyFromBuffers({ positions, triangles });
    expect(topology.componentCount).toBe(2);
    const labeled = autoLabelBodyRegions({
      topology,
      jointPositions: fitted.jointPositions,
    });
    expect(labeled.suggested[3]).toBe(AUTORIG_REGION_CODE.head);
    expect(labeled.suggested[4]).toBe(AUTORIG_REGION_CODE.head);
    expect(labeled.suggested[5]).toBe(AUTORIG_REGION_CODE.head);
  });

  it('ensures every vertex receives a valid region', () => {
    const fixture = makeSeparatedHumanoidPositions();
    const topology = buildCanonicalTopologyFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
    });
    const blank = new Uint8Array(topology.positions.length / 3);
    const filled = ensureAllVerticesLabeled({
      labels: blank,
      topology,
      jointPositions: fixture.jointPositions,
    });
    expect(filled.every((code) => code >= 1 && code <= 6)).toBe(true);
  });

  it('persists region assets and keeps them reachable for pruning', async () => {
    resetModelAssetStoreForTests();
    const resolved = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const overrides = Uint8Array.from([0, 0, 4, 0, 0, 0]);
    const written = await writeRegionMapBinaryAsset({
      resolved,
      overrides,
      topologyHash: 'topo_test_hash_01',
      sourceAssetId: 'src_region',
    });
    const decoded = await loadRegionMapLabelsFromUri(written.uri);
    expect(Array.from(decoded.resolved)).toEqual(Array.from(resolved));
    expect(Array.from(decoded.overrides)).toEqual(Array.from(overrides));

    let rig: PoseableRigAsset = {
      version: 1,
      id: 'rig_region',
      skeletonJoints: [...HUMAN_JOINT_IDS],
      originalSourceAssetId: 'src_region',
      sourceMeshAssetId: 'src_region',
    };
    rig = applyRegionMapToRig(rig, written.reference, 1);
    expect(rig.regionMap?.regionAssetId).toBe(written.assetId);
    expect(rig.binderVersion).toBe(1);

    const project = createDefaultProject();
    project.assets.assets.src_region = {
      id: 'src_region',
      type: 'model',
      name: 'src.glb',
      uri: `${MODEL_ASSET_URI_PREFIX}poseable-source-region`,
      createdAt: new Date().toISOString(),
    };
    project.assets.assets[written.assetId] = {
      id: written.assetId,
      type: 'model',
      name: 'regions.bin',
      uri: written.uri,
      createdAt: new Date().toISOString(),
      metadata: { poseableRegionMap: true },
    };
    project.assets.assets.asset_region = {
      id: 'asset_region',
      type: 'poseable_rig',
      name: 'rig',
      uri: 'data:application/json,{}',
      createdAt: new Date().toISOString(),
      metadata: { poseableRig: rig },
    };
    const object: SceneObject = {
      id: createId('obj'),
      name: 'Region Char',
      type: 'human_dummy',
      category: 'helper',
      transform: { position: [0, 0.9, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [0.55, 1.75, 0.55],
      visible: true,
      locked: false,
      stagingRole: 'person',
      poseableCharacter: { kind: 'autorigged', assetId: 'asset_region', rigId: rig.id },
      humanPose: { version: 1, joints: {} },
    };
    project.scene.objects.push(object);

    const referenced = getReferencedProjectAssetIds(project);
    expect(referenced.has(written.assetId)).toBe(true);
    const pruned = pruneUnreferencedProjectAssets(project);
    expect(pruned.assets.assets[written.assetId]).toBeTruthy();
  });

  it('normalizes regionMap metadata on load', () => {
    const normalized = normalizePoseableRigAsset({
      id: 'rig_n',
      skeletonJoints: [...HUMAN_JOINT_IDS],
      binderVersion: 1.9,
      regionMap: {
        version: 1,
        regionAssetId: 'region_1',
        vertexCount: 12.7,
        topologyHash: 'hash',
        sourceAssetId: 'src',
      },
    });
    expect(normalized?.binderVersion).toBe(1);
    expect(normalized?.regionMap).toEqual({
      version: 1,
      regionAssetId: 'region_1',
      vertexCount: 12,
      topologyHash: 'hash',
      sourceAssetId: 'src',
    });
  });

  it('classifies a canonical boxy humanoid mesh without throwing', () => {
    const orientation = { frontAxis: '+z' as const, upAxis: '+y' as const, groundLevelMeters: 0 };
    const source = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.3));
    torso.position.set(0, 0.9, 0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.3, 0.25));
    head.position.set(0, 1.55, 0);
    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.12));
    leftArm.position.set(0.35, 1.1, 0);
    const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.12));
    rightArm.position.set(-0.35, 1.1, 0);
    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.14));
    leftLeg.position.set(0.12, 0.35, 0);
    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.14));
    rightLeg.position.set(-0.12, 0.35, 0);
    source.add(torso, head, leftArm, rightArm, leftLeg, rightLeg);
    const canonical = prepareCanonicalAutorigMesh({
      source,
      orientation,
      targetHeightMeters: 1.75,
    });
    const markers = suggestAutorigMarkers({ size: canonical.size, heightMeters: 1.75, poseHint: 'a-pose' });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    const topology = buildCanonicalAutorigTopology(canonical.root);
    const labeled = autoLabelBodyRegions({
      topology,
      jointPositions: fitted.jointPositions,
      poseHint: 'a-pose',
    });
    expect(labeled.suggested.length).toBe(Math.floor(topology.positions.length / 3));
    expect(labeled.suggested.every((code) => code >= 1 && code <= 6)).toBe(true);
    const counts = new Uint32Array(7);
    for (const code of labeled.suggested) counts[code]! += 1;
    expect(counts[AUTORIG_REGION_CODE.head]!).toBeGreaterThan(0);
    expect(counts[AUTORIG_REGION_CODE.torso]!).toBeGreaterThan(0);
    expect(counts[AUTORIG_REGION_CODE.leftArm]!).toBeGreaterThan(0);
    expect(counts[AUTORIG_REGION_CODE.rightArm]!).toBeGreaterThan(0);
    expect(counts[AUTORIG_REGION_CODE.leftLeg]!).toBeGreaterThan(0);
    expect(counts[AUTORIG_REGION_CODE.rightLeg]!).toBeGreaterThan(0);
  });
});

describe('connected component helpers', () => {
  it('reports isolated vertices as their own components with CSR lists', () => {
    const {
      vertexComponent,
      componentCount,
      componentOffsets,
      componentVertices,
    } = computeConnectedComponents(
      3,
      new Uint32Array([0, 0, 0, 0]),
      new Uint32Array(0),
    );
    expect(componentCount).toBe(3);
    expect(Array.from(vertexComponent)).toEqual([0, 1, 2]);
    expect(Array.from(componentOffsets)).toEqual([0, 1, 2, 3]);
    expect(Array.from(componentVertices)).toEqual([0, 1, 2]);
  });
});
