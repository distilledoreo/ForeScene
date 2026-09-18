import { describe, expect, it } from 'vitest';
import type { ProjectAsset, SceneObject, Vec3 } from '../src/domain/types';
import { createDefaultProject, createTransform } from '../src/domain/defaults';
import { encodePackedGrayboxMesh } from '../src/engine/importedMesh';
import {
  buildSceneAcceleration,
  compareOriginPair,
  evaluateOrigin,
  extractCoverageScene,
  generateOriginCandidates,
  optimizeProjectionCoverage,
  projectCandidateToFloor,
  rankAllPairs,
  rankSecondOrigins,
  resolveCoverageOptions,
  sampleMeshSurface,
  type CoverageSceneData,
  type OriginEvaluation,
} from '../src/engine/projectionCoverage';

interface TestTriangle { a: Vec3; b: Vec3; c: Vec3 }

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function packedScene(
  triangles: TestTriangle[],
  floorTriangleIndices: number[] = [],
  bounds = { min: [-2, 0, -2] as Vec3, max: [2, 3, 2] as Vec3 },
): CoverageSceneData {
  const positions = new Float32Array(triangles.length * 9);
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, triangleIndex) => {
    positions.set([...triangle.a, ...triangle.b, ...triangle.c], triangleIndex * 9);
    indices.set([triangleIndex * 3, triangleIndex * 3 + 1, triangleIndex * 3 + 2], triangleIndex * 3);
  });
  const floorBounds = new Float32Array(floorTriangleIndices.length * 4);
  floorTriangleIndices.forEach((triangleIndex, floorIndex) => {
    const { a, b, c } = triangles[triangleIndex];
    floorBounds.set([
      Math.min(a[0], b[0], c[0]), Math.max(a[0], b[0], c[0]),
      Math.min(a[2], b[2], c[2]), Math.max(a[2], b[2], c[2]),
    ], floorIndex * 4);
  });
  return {
    positions,
    indices,
    triangleMeshIds: new Uint32Array(triangles.length),
    meshMatrices: new Float32Array(IDENTITY_MATRIX),
    floorTriangleIndices: new Uint32Array(floorTriangleIndices),
    floorBounds,
    bounds,
    diagonal: Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ),
  };
}

function floorTriangles(y = 0, extent = 2): TestTriangle[] {
  return [
    { a: [-extent, y, -extent], b: [extent, y, extent], c: [extent, y, -extent] },
    { a: [-extent, y, -extent], b: [-extent, y, extent], c: [extent, y, extent] },
  ];
}

function floorScene(): CoverageSceneData {
  return packedScene(floorTriangles(), [0, 1]);
}

function evaluation(bits: number, quality: number[], position: Vec3): OriginEvaluation {
  return {
    position,
    coverageBits: new Uint32Array([bits]),
    visibleBits: new Uint32Array([bits]),
    quality: new Uint8Array(quality),
    individualCoverage: quality.filter((_, index) => Boolean(bits & (1 << index))).length / quality.length,
    averageQuality: quality.reduce((sum, value) => sum + value, 0) / (255 * quality.length),
    clearance: 1,
  };
}

describe('projection coverage engine', () => {
  it('samples world-space surface area deterministically and proportionally', () => {
    const scene = packedScene([
      { a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0] },
      { a: [2, 0, 0], b: [6, 0, 0], c: [2, 2, 0] },
    ]);
    const first = sampleMeshSurface(scene, 5_000, 1234);
    const second = sampleMeshSurface(scene, 5_000, 1234);
    expect(second).toEqual(first);
    const largeCount = first.filter((sample) => sample.triangleIndex === 1).length;
    expect(largeCount / first.length).toBeGreaterThan(0.86);
    expect(largeCount / first.length).toBeLessThan(0.92);
  });

  it('uses double-sided BVH segment hits to reject geometry-hidden samples', () => {
    const scene = packedScene([
      { a: [1, -1, -1], b: [1, 1, -1], c: [1, 0, 1] },
      { a: [2, -1, -1], b: [2, 0, 1], c: [2, 1, -1] },
    ]);
    const acceleration = buildSceneAcceleration(scene);
    expect(acceleration.raycastAny([0, 0, 0], [1, 0, 0], 1.99, 1)).toBe(true);
    const options = resolveCoverageOptions(floorScene(), { minimumTexelDensity: 0, targetTexelDensity: 1 });
    const result = evaluateOrigin(
      { position: [0, 0, 0], clearance: 1 },
      [{ position: [2, 0, 0], geometricNormal: [-1, 0, 0], meshId: 0, triangleId: 1, triangleIndex: 1 }],
      acceleration,
      4,
      options,
    );
    expect(result.individualCoverage).toBe(0);
  });

  it('ranks fixed-first marginal union and joint complementary pairs', () => {
    const first = evaluation(0b0011, [220, 220, 0, 0], [0, 0, 0]);
    const redundant = evaluation(0b0011, [255, 255, 0, 0], [1, 0, 0]);
    const complementary = evaluation(0b1100, [0, 0, 200, 200], [2, 0, 0]);
    const partial = evaluation(0b0110, [0, 180, 180, 0], [3, 0, 0]);
    expect(rankSecondOrigins(first, [redundant, complementary, partial])[0].evaluation).toBe(complementary);
    const bestPair = rankAllPairs([redundant, complementary, partial], 0.5, 4, 1)[0];
    expect(new Set([bestPair.evaluationA, bestPair.evaluationB])).toEqual(new Set([redundant, complementary]));
    expect(compareOriginPair(redundant, complementary).unionCoverage).toBe(1);
  });

  it('keeps imported-room interior candidates by using triangle clearance instead of an enclosing AABB', () => {
    const triangles = [...floorTriangles(0, 3)];
    // One imported mesh can contain floor and all four walls; its object AABB encloses the room.
    triangles.push(
      { a: [-3, 0, -3], b: [-3, 3, -3], c: [3, 3, -3] },
      { a: [-3, 0, -3], b: [3, 3, -3], c: [3, 0, -3] },
      { a: [3, 0, 3], b: [3, 3, 3], c: [-3, 3, 3] },
      { a: [3, 0, 3], b: [-3, 3, 3], c: [-3, 0, 3] },
      { a: [-3, 0, 3], b: [-3, 3, 3], c: [-3, 3, -3] },
      { a: [-3, 0, 3], b: [-3, 3, -3], c: [-3, 0, -3] },
      { a: [3, 0, -3], b: [3, 3, -3], c: [3, 3, 3] },
      { a: [3, 0, -3], b: [3, 3, 3], c: [3, 0, 3] },
    );
    const scene = packedScene(triangles, [0, 1], { min: [-3, 0, -3], max: [3, 3, 3] });
    const options = resolveCoverageOptions(scene, { candidateSpacing: 1, cameraClearanceRadius: 0.3 });
    const candidates = generateOriginCandidates(scene, options, buildSceneAcceleration(scene));
    expect(candidates.some((candidate) => Math.hypot(candidate.position[0], candidate.position[2]) < 0.1)).toBe(true);
  });

  it('extracts one imported room object and retains its concave empty interior', async () => {
    const triangles = [...floorTriangles(0, 3)];
    const propTopStart = triangles.length;
    // A disconnected upward-facing tabletop lives in the same imported mesh.
    // It must not become a legal camera floor merely because it faces upward.
    triangles.push(...floorTriangles(0.8, 0.7));
    triangles.push(
      { a: [-3, 0, -3], b: [-3, 3, -3], c: [3, 3, -3] },
      { a: [-3, 0, -3], b: [3, 3, -3], c: [3, 0, -3] },
      { a: [3, 0, 3], b: [3, 3, 3], c: [-3, 3, 3] },
      { a: [3, 0, 3], b: [-3, 3, 3], c: [-3, 0, 3] },
      { a: [-3, 0, 3], b: [-3, 3, 3], c: [-3, 3, -3] },
      { a: [-3, 0, 3], b: [-3, 3, -3], c: [-3, 0, -3] },
      { a: [3, 0, -3], b: [3, 3, -3], c: [3, 3, 3] },
      { a: [3, 0, -3], b: [3, 3, 3], c: [3, 0, 3] },
    );
    const positions = new Float32Array(triangles.length * 9);
    const indices = new Uint32Array(triangles.length * 3);
    triangles.forEach((triangle, triangleIndex) => {
      positions.set([...triangle.a, ...triangle.b, ...triangle.c], triangleIndex * 9);
      indices.set([triangleIndex * 3, triangleIndex * 3 + 1, triangleIndex * 3 + 2], triangleIndex * 3);
    });
    const packed = encodePackedGrayboxMesh(positions, indices);
    const asset: ProjectAsset = {
      id: 'coverage_imported_room', type: 'model', name: 'room.panoref-mesh',
      uri: packed.uri, createdAt: new Date(0).toISOString(),
    };
    const object: SceneObject = {
      id: 'coverage_room_object', name: 'Imported Room', type: 'imported_model',
      transform: createTransform([0, 0, 0]), dimensions: [6, 3, 6],
      category: 'architecture', locked: false, visible: true, modelAssetId: asset.id,
    };
    const project = createDefaultProject();
    project.scene.objects = [object];
    project.assets.assets[asset.id] = asset;
    const scene = await extractCoverageScene(project);
    expect(Array.from(scene.floorTriangleIndices)).not.toContain(propTopStart);
    expect(Array.from(scene.floorTriangleIndices)).not.toContain(propTopStart + 1);
    const options = resolveCoverageOptions(scene, { candidateSpacing: 1, cameraClearanceRadius: 0.3 });
    const candidates = generateOriginCandidates(scene, options, buildSceneAcceleration(scene));
    expect(candidates.some((candidate) => Math.hypot(candidate.position[0], candidate.position[2]) < 0.1)).toBe(true);
    expect(candidates.every((candidate) => candidate.position[1] < 2)).toBe(true);
  });

  it('uses an explicit allowed floor region to reject a large prop top in one imported object', async () => {
    const triangles = [...floorTriangles(0, 3), ...floorTriangles(0.8, 1.5)];
    const positions = new Float32Array(triangles.length * 9);
    const indices = new Uint32Array(triangles.length * 3);
    triangles.forEach((triangle, triangleIndex) => {
      positions.set([...triangle.a, ...triangle.b, ...triangle.c], triangleIndex * 9);
      indices.set([triangleIndex * 3, triangleIndex * 3 + 1, triangleIndex * 3 + 2], triangleIndex * 3);
    });
    const asset: ProjectAsset = {
      id: 'coverage_imported_large_top', type: 'model', name: 'large-top.panoref-mesh',
      uri: encodePackedGrayboxMesh(positions, indices).uri, createdAt: new Date(0).toISOString(),
    };
    const object: SceneObject = {
      id: 'coverage_large_top_object', name: 'Imported Floor and Large Top', type: 'imported_model',
      transform: createTransform([0, 0, 0]), dimensions: [6, 1, 6],
      category: 'architecture', locked: false, visible: true, modelAssetId: asset.id,
    };
    const project = createDefaultProject();
    project.scene.objects = [object];
    project.assets.assets[asset.id] = asset;
    const scene = await extractCoverageScene(project, undefined, [{
      min: [-3.1, -0.1, -3.1],
      max: [3.1, 0.1, 3.1],
    }]);
    expect(Array.from(scene.floorTriangleIndices)).toEqual([0, 1]);
    const candidates = generateOriginCandidates(
      scene,
      resolveCoverageOptions(scene, { candidateSpacing: 1, cameraClearanceRadius: 0.3 }),
      buildSceneAcceleration(scene),
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.position[1] === 1.6)).toBe(true);
  });

  it('scores only surface samples inside the analysis region and keeps candidates there', () => {
    const nearFloor = floorTriangles(0, 2);
    const farFloor = floorTriangles(0, 2).map((triangle) => ({
      a: [triangle.a[0] + 12, triangle.a[1], triangle.a[2]] as Vec3,
      b: [triangle.b[0] + 12, triangle.b[1], triangle.b[2]] as Vec3,
      c: [triangle.c[0] + 12, triangle.c[1], triangle.c[2]] as Vec3,
    }));
    const nearWall: TestTriangle = { a: [-2, 0, -2], b: [2, 0, -2], c: [0, 2.5, -2] };
    const farWall: TestTriangle = { a: [10, 0, -2], b: [14, 0, -2], c: [12, 2.5, -2] };
    const scene = packedScene(
      [...nearFloor, ...farFloor, nearWall, farWall],
      [0, 1, 2, 3],
      { min: [-2, 0, -2], max: [14, 3, 2] },
    );
    scene.allowedFloorRegions = [{ min: [-2.1, -0.1, -2.1], max: [2.1, 2.8, 2.1] }];
    scene.diagonal = 25;

    const samples = sampleMeshSurface(scene, 400, 99);
    expect(samples.length).toBe(400);
    expect(samples.every((sample) => (
      sample.position[0] >= -2.1 && sample.position[0] <= 2.1
      && sample.position[1] >= -0.1 && sample.position[1] <= 2.8
      && sample.position[2] >= -2.1 && sample.position[2] <= 2.1
    ))).toBe(true);
    expect(samples.some((sample) => sample.position[0] > 5)).toBe(false);

    const options = resolveCoverageOptions(scene, {
      candidateSpacing: 0.75,
      maximumCandidateCount: 48,
      cameraClearanceRadius: 0.1,
      minimumOriginSeparation: 1,
      coarseSampleCount: 64,
      fineSampleCount: 128,
      coarsePairSeedCount: 4,
      localRefinementLevels: 1,
      minimumTexelDensity: 0,
      targetTexelDensity: 1,
    });
    // Unrestricted defaults would use the 25 m scene diagonal (~1.5 m separation floor
    // from spacing alone is fine, but region-aware defaults stay room-scale).
    const unrestricted = resolveCoverageOptions({ ...scene, allowedFloorRegions: undefined });
    expect(unrestricted.minimumOriginSeparation).toBeGreaterThan(options.minimumOriginSeparation);

    const result = optimizeProjectionCoverage({
      mode: 'fixed-first',
      scene,
      firstOrigin: [0, 1.6, 0],
      options,
    });
    expect(result.originB[0]).toBeGreaterThanOrEqual(-2.1);
    expect(result.originB[0]).toBeLessThanOrEqual(2.1);
    expect(result.originB[2]).toBeGreaterThanOrEqual(-2.1);
    expect(result.originB[2]).toBeLessThanOrEqual(2.1);
    expect(Math.abs(result.originB[0])).toBeLessThan(5);
  });

  it('uses one fine validation bank for reachable metrics and enforces fixed-first separation', () => {
    const scene = floorScene();
    const options = resolveCoverageOptions(scene, {
      candidateSpacing: 1,
      maximumCandidateCount: 16,
      cameraClearanceRadius: 0.1,
      minimumOriginSeparation: 1.5,
      coarseSampleCount: 32,
      fineSampleCount: 64,
      coarsePairSeedCount: 4,
      localRefinementLevels: 2,
      minimumTexelDensity: 0,
      targetTexelDensity: 1,
    });
    const fixed = optimizeProjectionCoverage({ mode: 'fixed-first', scene, firstOrigin: [0, 1.6, 0], options });
    expect(fixed.reachableCoverage).toBeGreaterThanOrEqual(fixed.combinedCoverage);
    expect(fixed.reachableEfficiency).toBeLessThanOrEqual(1);
    expect(Math.hypot(
      fixed.originA[0] - fixed.originB[0],
      fixed.originA[1] - fixed.originB[1],
      fixed.originA[2] - fixed.originB[2],
    )).toBeGreaterThanOrEqual(1.5);
  });

  it('reprojects local X/Z offsets onto the nearest sloped or multilevel floor', () => {
    const lower = floorTriangles(0, 2);
    const upper = floorTriangles(3, 1).map((triangle) => ({
      a: [triangle.a[0] + 3, triangle.a[1], triangle.a[2]] as Vec3,
      b: [triangle.b[0] + 3, triangle.b[1], triangle.b[2]] as Vec3,
      c: [triangle.c[0] + 3, triangle.c[1], triangle.c[2]] as Vec3,
    }));
    const slope: TestTriangle = { a: [-2, 0, 3], b: [2, 1, 5], c: [2, 0, 3] };
    const scene = packedScene([...lower, ...upper, slope], [0, 1, 2, 3, 4], {
      min: [-2, 0, -2], max: [4, 4, 5],
    });
    const upperPosition = projectCandidateToFloor(scene, 3, 0, 1.6, 3);
    const slopePosition = projectCandidateToFloor(scene, 1.5, 4.5, 1.6, 0.5);
    expect(upperPosition?.[1]).toBeCloseTo(4.6, 5);
    expect(slopePosition?.[1]).toBeGreaterThan(1.6);
    expect(slopePosition?.[1]).toBeLessThan(2.6);
  });

  it('generates candidates and runs both shared search modes', () => {
    const scene = floorScene();
    const options = resolveCoverageOptions(scene, {
      candidateSpacing: 1, maximumCandidateCount: 16, cameraClearanceRadius: 0.1,
      minimumOriginSeparation: 1, coarseSampleCount: 32, fineSampleCount: 64,
      coarsePairSeedCount: 4, localRefinementLevels: 1, minimumTexelDensity: 0, targetTexelDensity: 1,
    });
    const candidates = generateOriginCandidates(scene, options, buildSceneAcceleration(scene));
    expect(candidates.length).toBeGreaterThan(2);
    expect(candidates.every((candidate) => candidate.position[1] === 1.6)).toBe(true);
    const fixed = optimizeProjectionCoverage({ mode: 'fixed-first', scene, firstOrigin: [0, 1.6, 0], options });
    const joint = optimizeProjectionCoverage({ mode: 'joint-pair', scene, options });
    expect(fixed.sampleCount).toBe(64);
    expect(fixed.combinedCoverage).toBeGreaterThan(0.9);
    expect(joint.combinedCoverage).toBeGreaterThan(0.9);
  });

  it('prefers authored floors over upward-facing prop and roof surfaces', async () => {
    const scene = await extractCoverageScene(createDefaultProject());
    expect(scene.floorTriangleIndices.length).toBeGreaterThan(0);
    const positions = Array.from(scene.floorTriangleIndices).flatMap((triangleIndex) => {
      const offset = triangleIndex * 3;
      return [
        scene.positions[scene.indices[offset] * 3 + 1],
        scene.positions[scene.indices[offset + 1] * 3 + 1],
        scene.positions[scene.indices[offset + 2] * 3 + 1],
      ];
    });
    expect(Math.max(...positions)).toBeLessThan(0.25);
  });

  it('runs both complete optimizer modes on a 100k+ triangle indexed fixture', () => {
    const cells = 225;
    const side = cells + 1;
    const positions = new Float32Array(side * side * 3);
    for (let z = 0; z < side; z += 1) {
      for (let x = 0; x < side; x += 1) {
        const offset = (z * side + x) * 3;
        positions[offset] = x * 0.1;
        positions[offset + 2] = z * 0.1;
      }
    }
    const indices = new Uint32Array(cells * cells * 6);
    let offset = 0;
    for (let z = 0; z < cells; z += 1) {
      for (let x = 0; x < cells; x += 1) {
        const a = z * side + x; const b = a + 1; const c = a + side; const d = c + 1;
        indices.set([a, d, b, a, c, d], offset);
        offset += 6;
      }
    }
    const scene: CoverageSceneData = {
      positions,
      indices,
      triangleMeshIds: new Uint32Array(indices.length / 3),
      meshMatrices: new Float32Array(IDENTITY_MATRIX),
      floorTriangleIndices: new Uint32Array(indices.length / 3),
      floorBounds: new Float32Array((indices.length / 3) * 4),
      bounds: { min: [0, 0, 0], max: [22.5, 0, 22.5] },
      diagonal: Math.hypot(22.5, 22.5),
    };
    for (let triangleIndex = 0; triangleIndex < scene.floorTriangleIndices.length; triangleIndex += 1) {
      scene.floorTriangleIndices[triangleIndex] = triangleIndex;
      const indexOffset = triangleIndex * 3;
      const a = scene.indices[indexOffset] * 3;
      const b = scene.indices[indexOffset + 1] * 3;
      const c = scene.indices[indexOffset + 2] * 3;
      scene.floorBounds.set([
        Math.min(scene.positions[a], scene.positions[b], scene.positions[c]),
        Math.max(scene.positions[a], scene.positions[b], scene.positions[c]),
        Math.min(scene.positions[a + 2], scene.positions[b + 2], scene.positions[c + 2]),
        Math.max(scene.positions[a + 2], scene.positions[b + 2], scene.positions[c + 2]),
      ], triangleIndex * 4);
    }
    const packedBytes = positions.byteLength + indices.byteLength
      + scene.triangleMeshIds.byteLength + scene.meshMatrices.byteLength;
    expect(indices.length / 3).toBeGreaterThan(100_000);
    expect(packedBytes).toBeLessThan(3_000_000);
    const acceleration = buildSceneAcceleration(scene);
    expect(acceleration.distanceToGeometry([11, 1.6, 11])).toBeCloseTo(1.6, 3);
    const options = resolveCoverageOptions(scene, {
      candidateSpacing: 5,
      maximumCandidateCount: 16,
      cameraClearanceRadius: 0.3,
      minimumOriginSeparation: 4,
      coarseSampleCount: 128,
      fineSampleCount: 256,
      coarsePairSeedCount: 4,
      localRefinementLevels: 1,
      minimumTexelDensity: 0,
      targetTexelDensity: 1,
    });
    const fixed = optimizeProjectionCoverage({
      mode: 'fixed-first',
      scene,
      firstOrigin: [2.5, 1.6, 2.5],
      options,
    });
    const joint = optimizeProjectionCoverage({ mode: 'joint-pair', scene, options });
    for (const result of [fixed, joint]) {
      expect(result.sampleCount).toBe(256);
      expect(result.candidateCount).toBeGreaterThan(2);
      expect(result.reachableCoverage).toBeGreaterThanOrEqual(result.combinedCoverage);
      expect(result.originA.every(Number.isFinite)).toBe(true);
      expect(result.originB.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(
        result.originA[0] - result.originB[0],
        result.originA[1] - result.originB[1],
        result.originA[2] - result.originB[2],
      )).toBeGreaterThanOrEqual(4);
    }
  }, 90_000);
});
