import * as THREE from 'three';
import type { LocationProject, Vec3 } from '../../domain/types';
import { releaseImportedGeometry } from '../importedMesh';
import { createResolvedObject3D } from '../sceneObjects';
import { resolveSceneRelationships } from '../sceneRelationships';
import { ensureSourceModelsForProject, releaseSourceModelInstance, isSharedSourceGeometry } from '../sourceModelRuntime';
import {
  readWorldTriangle,
  triangleAreaNormal,
  triangleCount,
  writeTriangleBounds,
} from './geometryAccess';
import type {
  CoverageBounds,
  CoverageExtractionProgress,
  CoverageSceneData,
  SurfaceSample,
} from './types';

const MIN_TRIANGLE_AREA = 1e-8;
const COPY_CHUNK_VALUES = 262_144;
const FLOOR_VERTEX_QUANTIZATION_METERS = 1e-4;
const MIN_IMPORTED_FLOOR_AREA_SQUARE_METERS = 2.5;
const MIN_IMPORTED_FLOOR_LONG_SPAN_METERS = 1.5;
const MIN_IMPORTED_FLOOR_SHORT_SPAN_METERS = 0.65;

interface ImportedFloorComponent {
  root: number;
  area: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function quantizedVertexKey(x: number, y: number, z: number): string {
  const scale = 1 / FLOOR_VERTEX_QUANTIZATION_METERS;
  return `${Math.round(x * scale)}:${Math.round(y * scale)}:${Math.round(z * scale)}`;
}

/**
 * Imported meshes commonly contain floors, shelves, tables, roofs, and props in
 * one object. Group upward triangles by connected world-space vertices and keep
 * only components large enough to plausibly support a camera. This preserves
 * multiple substantial floor levels while rejecting isolated prop tops.
 */
function filterImportedFloorComponents(
  scene: CoverageSceneData,
  floorFlags: Uint8Array,
): Uint8Array {
  const parent = new Int32Array(floorFlags.length);
  parent.fill(-1);
  const vertexOwner = new Map<string, number>();
  const triangleScratch = new Float64Array(9);

  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    let current = value;
    while (parent[current] !== current) {
      const next = parent[current];
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let triangleIndex = 0; triangleIndex < floorFlags.length; triangleIndex += 1) {
    if (floorFlags[triangleIndex] !== 1) continue;
    parent[triangleIndex] = triangleIndex;
    readWorldTriangle(scene, triangleIndex, triangleScratch);
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = vertex * 3;
      const key = quantizedVertexKey(
        triangleScratch[offset],
        triangleScratch[offset + 1],
        triangleScratch[offset + 2],
      );
      const owner = vertexOwner.get(key);
      if (owner === undefined) vertexOwner.set(key, triangleIndex);
      else union(triangleIndex, owner);
    }
  }

  const normalScratch = new Float64Array(3);
  const components = new Map<number, ImportedFloorComponent>();
  for (let triangleIndex = 0; triangleIndex < floorFlags.length; triangleIndex += 1) {
    if (floorFlags[triangleIndex] !== 1) continue;
    const root = find(triangleIndex);
    readWorldTriangle(scene, triangleIndex, triangleScratch);
    const area = triangleAreaNormal(triangleScratch, normalScratch);
    const component = components.get(root) ?? {
      root,
      area: 0,
      minX: Infinity,
      maxX: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    };
    component.area += area;
    component.minX = Math.min(component.minX, triangleScratch[0], triangleScratch[3], triangleScratch[6]);
    component.maxX = Math.max(component.maxX, triangleScratch[0], triangleScratch[3], triangleScratch[6]);
    component.minZ = Math.min(component.minZ, triangleScratch[2], triangleScratch[5], triangleScratch[8]);
    component.maxZ = Math.max(component.maxZ, triangleScratch[2], triangleScratch[5], triangleScratch[8]);
    components.set(root, component);
  }

  const ranked = [...components.values()].sort((a, b) => b.area - a.area);
  const largestArea = ranked[0]?.area ?? 0;
  const minimumArea = Math.max(
    MIN_IMPORTED_FLOOR_AREA_SQUARE_METERS,
    Math.min(8, largestArea * 0.03),
  );
  const acceptedRoots = new Set(ranked.filter((component) => {
    const width = component.maxX - component.minX;
    const depth = component.maxZ - component.minZ;
    const longSpan = Math.max(width, depth);
    const shortSpan = Math.min(width, depth);
    return component.area >= minimumArea
      && longSpan >= MIN_IMPORTED_FLOOR_LONG_SPAN_METERS
      && shortSpan >= MIN_IMPORTED_FLOOR_SHORT_SPAN_METERS;
  }).map((component) => component.root));
  // A small but otherwise valid imported platform must not collapse analysis to
  // zero candidates. Keep the largest component as the deterministic fallback.
  if (acceptedRoots.size === 0 && ranked[0]) acceptedRoots.add(ranked[0].root);

  const selected = new Uint8Array(floorFlags.length);
  for (let triangleIndex = 0; triangleIndex < floorFlags.length; triangleIndex += 1) {
    if (floorFlags[triangleIndex] === 1 && acceptedRoots.has(find(triangleIndex))) {
      selected[triangleIndex] = 1;
    }
  }
  return selected;
}

function toVec3(vector: THREE.Vector3): Vec3 {
  return [vector.x, vector.y, vector.z];
}

function disposeExtractedNode(root: THREE.Object3D): void {
  const released = new Set<THREE.BufferGeometry>();
  root.traverse((child) => {
    releaseSourceModelInstance(child);
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || released.has(mesh.geometry)) return;
    released.add(mesh.geometry);
    if (!isSharedSourceGeometry(mesh.geometry) && !releaseImportedGeometry(mesh.geometry)) mesh.geometry.dispose();
  });
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function normalizeAllowedFloorRegions(
  regions: readonly CoverageBounds[] | undefined,
): CoverageBounds[] | undefined {
  const normalized = regions?.filter((region) => (
    region.min.every(Number.isFinite)
    && region.max.every(Number.isFinite)
    && region.min[0] <= region.max[0]
    && region.min[1] <= region.max[1]
    && region.min[2] <= region.max[2]
  )).map((region) => ({
    min: [...region.min] as Vec3,
    max: [...region.max] as Vec3,
  }));
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function pointIsInCoverageRegions(
  x: number,
  y: number,
  z: number,
  regions: readonly CoverageBounds[],
): boolean {
  return regions.some((region) => (
    x >= region.min[0] && x <= region.max[0]
    && y >= region.min[1] && y <= region.max[1]
    && z >= region.min[2] && z <= region.max[2]
  ));
}

/** Longest axis-aligned diagonal across analysis regions (or scene diagonal when unrestricted). */
export function coverageAnalysisDiagonal(scene: CoverageSceneData): number {
  const regions = scene.allowedFloorRegions;
  if (!regions?.length) return scene.diagonal;
  let longest = 0;
  for (const region of regions) {
    longest = Math.max(
      longest,
      Math.hypot(
        region.max[0] - region.min[0],
        region.max[1] - region.min[1],
        region.max[2] - region.min[2],
      ),
    );
  }
  return Math.max(longest, 1e-3);
}

function triangleIntersectsAllowedFloorRegion(
  triangle: Float64Array,
  regions: readonly CoverageBounds[],
): boolean {
  const minX = Math.min(triangle[0], triangle[3], triangle[6]);
  const maxX = Math.max(triangle[0], triangle[3], triangle[6]);
  const minY = Math.min(triangle[1], triangle[4], triangle[7]);
  const maxY = Math.max(triangle[1], triangle[4], triangle[7]);
  const minZ = Math.min(triangle[2], triangle[5], triangle[8]);
  const maxZ = Math.max(triangle[2], triangle[5], triangle[8]);
  return regions.some((region) => (
    maxX >= region.min[0] && minX <= region.max[0]
    && maxY >= region.min[1] && minY <= region.max[1]
    && maxZ >= region.min[2] && minZ <= region.max[2]
  ));
}

async function forEachProjectMesh(
  project: LocationProject,
  visit: (mesh: THREE.Mesh, explicitFloor: boolean) => Promise<void> | void,
  onProgress?: CoverageExtractionProgress,
  progressStart = 0,
  progressSpan = 1,
): Promise<void> {
  await ensureSourceModelsForProject(project);
  const objects = project.scene.objects.filter(
    (object) => object.visible && object.type !== 'sun_marker' && object.category !== 'helper',
  );
  const relationshipResolution = resolveSceneRelationships(project);
  for (let objectIndex = 0; objectIndex < objects.length; objectIndex += 1) {
    const object = objects[objectIndex];
    const root = createResolvedObject3D(project, object, false, 'light', relationshipResolution);
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry.getAttribute('position')) meshes.push(mesh);
    });
    try {
      for (const mesh of meshes) {
        // Analysis gets a derived snapshot, never mutates the retained source.
        const deforming = (mesh as THREE.SkinnedMesh).isSkinnedMesh || Boolean(mesh.morphTargetInfluences?.length);
        let geometry = mesh.geometry;
        if (deforming) {
          geometry = new THREE.BufferGeometry();
          const count = mesh.geometry.getAttribute('position').count;
          const positions = new Float32Array(count * 3);
          const point = new THREE.Vector3();
          for (let i = 0; i < count; i += 1) {
            mesh.getVertexPosition(i, point).toArray(positions, i * 3);
            if (i && i % 65536 === 0) await yieldToMainThread();
          }
          geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          geometry.setIndex(mesh.geometry.index);
        }
        try {
          const instanced = mesh as THREE.InstancedMesh;
          const count = instanced.isInstancedMesh ? instanced.count : 1;
          const matrix = new THREE.Matrix4();
          for (let i = 0; i < count; i += 1) {
            const snapshot = new THREE.Mesh(geometry, mesh.material);
            snapshot.matrixWorld.copy(mesh.matrixWorld);
            if (instanced.isInstancedMesh) {
              instanced.getMatrixAt(i, matrix);
              snapshot.matrixWorld.multiply(matrix);
            }
            await visit(snapshot, object.type === 'floor');
          }
        } finally { if (deforming) geometry.dispose(); }
      }
    } finally { disposeExtractedNode(root); }
    onProgress?.(
      progressStart + progressSpan * ((objectIndex + 1) / Math.max(1, objects.length)),
      'Preparing indexed scene geometry…',
    );
    await yieldToMainThread();
  }
}

async function copyPositionAttribute(
  target: Float32Array,
  targetOffset: number,
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): Promise<void> {
  if (!attribute.normalized && !(attribute instanceof THREE.InterleavedBufferAttribute) && attribute.itemSize === 3) {
    const source = attribute.array;
    for (let offset = 0; offset < source.length; offset += COPY_CHUNK_VALUES) {
      const end = Math.min(source.length, offset + COPY_CHUNK_VALUES);
      target.set(source.subarray(offset, end), targetOffset + offset);
      if (end < source.length) await yieldToMainThread();
    }
    return;
  }
  for (let vertex = 0; vertex < attribute.count; vertex += 1) {
    const offset = targetOffset + vertex * 3;
    target[offset] = attribute.getX(vertex);
    target[offset + 1] = attribute.getY(vertex);
    target[offset + 2] = attribute.getZ(vertex);
    if (vertex > 0 && vertex % (COPY_CHUNK_VALUES / 3) === 0) await yieldToMainThread();
  }
}

/**
 * Extract indexed mesh buffers without expanding triangles. Work is chunked
 * between objects and large buffer ranges so complex imports do not monopolize
 * the browser event loop before worker optimization begins.
 */
export async function extractCoverageScene(
  project: LocationProject,
  onProgress?: CoverageExtractionProgress,
  allowedFloorRegions?: readonly CoverageBounds[],
): Promise<CoverageSceneData> {
  let vertexCount = 0;
  let indexCount = 0;
  let meshCount = 0;
  const sceneBounds = new THREE.Box3();

  await forEachProjectMesh(project, (mesh) => {
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    const meshIndexCount = index ? Math.floor(index.count / 3) * 3 : Math.floor(position.count / 3) * 3;
    if (meshIndexCount === 0) return;
    vertexCount += position.count;
    indexCount += meshIndexCount;
    meshCount += 1;
    sceneBounds.union(new THREE.Box3().setFromObject(mesh, true));
  }, onProgress, 0, 0.15);

  if (indexCount === 0 || vertexCount === 0 || sceneBounds.isEmpty()) {
    throw new Error('Coverage analysis requires at least one visible solid mesh.');
  }

  const normalizedAllowedFloorRegions = normalizeAllowedFloorRegions(allowedFloorRegions);
  const scene: CoverageSceneData = {
    positions: new Float32Array(vertexCount * 3),
    indices: new Uint32Array(indexCount),
    triangleMeshIds: new Uint32Array(indexCount / 3),
    meshMatrices: new Float32Array(meshCount * 16),
    floorTriangleIndices: new Uint32Array(0),
    floorBounds: new Float32Array(0),
    allowedFloorRegions: normalizedAllowedFloorRegions,
    bounds: { min: toVec3(sceneBounds.min), max: toVec3(sceneBounds.max) },
    diagonal: Math.max(sceneBounds.getSize(new THREE.Vector3()).length(), 1e-3),
  };
  const floorFlags = new Uint8Array(indexCount / 3);
  let explicitFloorSeen = false;
  let vertexBase = 0;
  let indexBase = 0;
  let meshId = 0;
  const triangleScratch = new Float64Array(9);
  const normalScratch = new Float64Array(3);

  await forEachProjectMesh(project, async (mesh, explicitFloor) => {
    const position = mesh.geometry.getAttribute('position');
    const sourceIndex = mesh.geometry.index;
    const meshIndexCount = sourceIndex
      ? Math.floor(sourceIndex.count / 3) * 3
      : Math.floor(position.count / 3) * 3;
    if (meshIndexCount === 0) return;
    await copyPositionAttribute(scene.positions, vertexBase * 3, position);
    scene.meshMatrices.set(mesh.matrixWorld.elements, meshId * 16);
    for (let offset = 0; offset < meshIndexCount; offset += 1) {
      scene.indices[indexBase + offset] = vertexBase + (sourceIndex ? sourceIndex.getX(offset) : offset);
      if (offset > 0 && offset % COPY_CHUNK_VALUES === 0) await yieldToMainThread();
    }
    const triangleStart = indexBase / 3;
    const meshTriangleCount = meshIndexCount / 3;
    scene.triangleMeshIds.fill(meshId, triangleStart, triangleStart + meshTriangleCount);
    for (let localTriangle = 0; localTriangle < meshTriangleCount; localTriangle += 1) {
      const triangleIndex = triangleStart + localTriangle;
      readWorldTriangle(scene, triangleIndex, triangleScratch);
      const area = triangleAreaNormal(triangleScratch, normalScratch);
      if (area > MIN_TRIANGLE_AREA && normalScratch[1] > 0.8) {
        floorFlags[triangleIndex] = explicitFloor ? 2 : 1;
        if (explicitFloor) explicitFloorSeen = true;
      }
      if (localTriangle > 0 && localTriangle % 65_536 === 0) await yieldToMainThread();
    }
    vertexBase += position.count;
    indexBase += meshIndexCount;
    meshId += 1;
  }, onProgress, 0.15, 0.7);

  const selectedFloorFlags = normalizedAllowedFloorRegions
    ? floorFlags
    : explicitFloorSeen
      ? floorFlags
      : filterImportedFloorComponents(scene, floorFlags);
  const selectedFlag = normalizedAllowedFloorRegions ? undefined : explicitFloorSeen ? 2 : 1;
  const isSelectedFloor = (triangleIndex: number): boolean => {
    if (selectedFlag !== undefined) return selectedFloorFlags[triangleIndex] === selectedFlag;
    if (selectedFloorFlags[triangleIndex] === 0 || !normalizedAllowedFloorRegions) return false;
    readWorldTriangle(scene, triangleIndex, triangleScratch);
    return triangleIntersectsAllowedFloorRegion(triangleScratch, normalizedAllowedFloorRegions);
  };
  let floorCount = 0;
  for (let triangleIndex = 0; triangleIndex < floorFlags.length; triangleIndex += 1) {
    if (isSelectedFloor(triangleIndex)) floorCount += 1;
  }
  scene.floorTriangleIndices = new Uint32Array(floorCount);
  scene.floorBounds = new Float32Array(floorCount * 4);
  const boundsScratch = new Float32Array(6);
  let floorOffset = 0;
  for (let triangleIndex = 0; triangleIndex < floorFlags.length; triangleIndex += 1) {
    if (!isSelectedFloor(triangleIndex)) continue;
    scene.floorTriangleIndices[floorOffset] = triangleIndex;
    readWorldTriangle(scene, triangleIndex, triangleScratch);
    writeTriangleBounds(triangleScratch, boundsScratch, 0);
    const target = floorOffset * 4;
    scene.floorBounds[target] = boundsScratch[0];
    scene.floorBounds[target + 1] = boundsScratch[3];
    scene.floorBounds[target + 2] = boundsScratch[2];
    scene.floorBounds[target + 3] = boundsScratch[5];
    floorOffset += 1;
    if (floorOffset % 65_536 === 0) await yieldToMainThread();
  }
  onProgress?.(1, 'Indexed geometry is ready for worker analysis.');
  return scene;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function lowerBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Deterministic area-weighted Monte Carlo samples from compact indexed geometry.
 * When `allowedFloorRegions` is set, only surfaces inside that volume are scored
 * (room-local coverage). Occlusion still uses the full scene BVH.
 */
export function sampleMeshSurface(
  scene: CoverageSceneData,
  sampleCount: number,
  seed: number,
): SurfaceSample[] {
  const count = triangleCount(scene);
  if (count === 0 || sampleCount <= 0) return [];
  const regions = scene.allowedFloorRegions;
  const cumulativeArea = new Float64Array(count);
  const triangleScratch = new Float64Array(9);
  const normalScratch = new Float64Array(3);
  let totalArea = 0;
  for (let triangleIndex = 0; triangleIndex < count; triangleIndex += 1) {
    readWorldTriangle(scene, triangleIndex, triangleScratch);
    if (regions && !triangleIntersectsAllowedFloorRegion(triangleScratch, regions)) {
      cumulativeArea[triangleIndex] = totalArea;
      continue;
    }
    const area = triangleAreaNormal(triangleScratch, normalScratch);
    totalArea += area > MIN_TRIANGLE_AREA ? area : 0;
    cumulativeArea[triangleIndex] = totalArea;
  }
  if (!(totalArea > 0)) return [];

  const rng = mulberry32(seed);
  const samples: SurfaceSample[] = [];
  let attempts = 0;
  const maxAttempts = sampleCount * (regions ? 24 : 1);
  while (samples.length < sampleCount && attempts < maxAttempts) {
    attempts += 1;
    const triangleIndex = lowerBound(cumulativeArea, rng() * totalArea);
    readWorldTriangle(scene, triangleIndex, triangleScratch);
    triangleAreaNormal(triangleScratch, normalScratch);
    const r1 = rng();
    const r2 = rng();
    const sqrtR1 = Math.sqrt(r1);
    const b0 = 1 - sqrtR1;
    const b1 = sqrtR1 * (1 - r2);
    const b2 = sqrtR1 * r2;
    const position: Vec3 = [
      triangleScratch[0] * b0 + triangleScratch[3] * b1 + triangleScratch[6] * b2,
      triangleScratch[1] * b0 + triangleScratch[4] * b1 + triangleScratch[7] * b2,
      triangleScratch[2] * b0 + triangleScratch[5] * b1 + triangleScratch[8] * b2,
    ];
    if (regions && !pointIsInCoverageRegions(position[0], position[1], position[2], regions)) {
      continue;
    }
    samples.push({
      position,
      geometricNormal: [normalScratch[0], normalScratch[1], normalScratch[2]],
      meshId: scene.triangleMeshIds[triangleIndex],
      triangleId: triangleIndex,
      triangleIndex,
    });
  }
  return samples;
}
