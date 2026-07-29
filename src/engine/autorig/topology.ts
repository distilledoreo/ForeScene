import * as THREE from 'three';

/**
 * Canonical mesh topology for guided autorig: positions, triangles, mesh-part
 * provenance, CSR adjacency, and a topology identity hash.
 *
 * Positions may change with orientation/height; the hash intentionally ignores
 * floating-point positions and uses mesh-part structure + index buffers only.
 */

export interface CanonicalAutorigMeshPart {
  id: number;
  name: string;
  vertexStart: number;
  vertexCount: number;
  triangleStart: number;
  triangleCount: number;
}

export interface CanonicalAutorigTopology {
  positions: Float32Array;
  triangles: Uint32Array;

  vertexMeshPart: Uint32Array;
  triangleMeshPart: Uint32Array;

  meshParts: CanonicalAutorigMeshPart[];

  /** CSR: neighbors of v are adjacencyVertices[adjacencyOffsets[v] .. adjacencyOffsets[v+1]) */
  adjacencyOffsets: Uint32Array;
  adjacencyVertices: Uint32Array;

  /** Connected component id per vertex (−1 unused). */
  vertexComponent: Int32Array;
  componentCount: number;

  topologyHash: string;
}

export interface TopologyBuffersInput {
  positions: Float32Array;
  triangles: Uint32Array;
  meshParts?: CanonicalAutorigMeshPart[];
  vertexMeshPart?: Uint32Array;
  triangleMeshPart?: Uint32Array;
}

/** FNV-1a 64-bit hex digest over typed bytes (sync, worker-safe). */
export function fnv1a64Hex(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function appendUint32(out: number[], value: number): void {
  out.push(value >>> 0);
}

/**
 * Topology identity from ordered mesh-part counts and index buffers.
 * Does not hash transformed positions.
 */
export function computeTopologyHash(params: {
  meshParts: Array<{ vertexCount: number; triangleCount: number }>;
  triangles: Uint32Array;
}): string {
  const words: number[] = [];
  appendUint32(words, 1); // hash schema version
  appendUint32(words, params.meshParts.length);
  for (const part of params.meshParts) {
    appendUint32(words, part.vertexCount >>> 0);
    appendUint32(words, part.triangleCount >>> 0);
  }
  appendUint32(words, params.triangles.length);
  for (let i = 0; i < params.triangles.length; i += 1) {
    appendUint32(words, params.triangles[i]! >>> 0);
  }
  const bytes = new Uint8Array(new Uint32Array(words).buffer);
  return fnv1a64Hex(bytes);
}

/** Build undirected CSR adjacency from triangle indices (duplicate edges collapsed). */
export function buildVertexAdjacency(
  vertexCount: number,
  triangles: Uint32Array,
): { adjacencyOffsets: Uint32Array; adjacencyVertices: Uint32Array } {
  if (vertexCount <= 0) {
    return {
      adjacencyOffsets: new Uint32Array(1),
      adjacencyVertices: new Uint32Array(0),
    };
  }

  // First pass: count directed edges (each undirected edge counted twice).
  const degree = new Uint32Array(vertexCount);
  const triCount = Math.floor(triangles.length / 3);
  for (let t = 0; t < triCount; t += 1) {
    const i0 = triangles[t * 3]!;
    const i1 = triangles[t * 3 + 1]!;
    const i2 = triangles[t * 3 + 2]!;
    if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) continue;
    if (i0 !== i1) {
      degree[i0]! += 1;
      degree[i1]! += 1;
    }
    if (i1 !== i2) {
      degree[i1]! += 1;
      degree[i2]! += 1;
    }
    if (i2 !== i0) {
      degree[i2]! += 1;
      degree[i0]! += 1;
    }
  }

  const adjacencyOffsets = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v += 1) {
    adjacencyOffsets[v + 1] = adjacencyOffsets[v]! + degree[v]!;
  }
  const adjacencyVertices = new Uint32Array(adjacencyOffsets[vertexCount]!);
  const write = new Uint32Array(vertexCount);

  const pushEdge = (a: number, b: number) => {
    if (a === b || a >= vertexCount || b >= vertexCount) return;
    const slot = adjacencyOffsets[a]! + write[a]!;
    adjacencyVertices[slot] = b;
    write[a]! += 1;
  };

  for (let t = 0; t < triCount; t += 1) {
    const i0 = triangles[t * 3]!;
    const i1 = triangles[t * 3 + 1]!;
    const i2 = triangles[t * 3 + 2]!;
    pushEdge(i0, i1);
    pushEdge(i1, i0);
    pushEdge(i1, i2);
    pushEdge(i2, i1);
    pushEdge(i2, i0);
    pushEdge(i0, i2);
  }

  // Deduplicate neighbors per vertex in-place.
  const stamp = new Int32Array(vertexCount);
  stamp.fill(-1);
  let writeTotal = 0;
  const compactOffsets = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v += 1) {
    compactOffsets[v] = writeTotal;
    const start = adjacencyOffsets[v]!;
    const end = adjacencyOffsets[v + 1]!;
    for (let i = start; i < end; i += 1) {
      const n = adjacencyVertices[i]!;
      if (stamp[n] === v) continue;
      stamp[n] = v;
      adjacencyVertices[writeTotal] = n;
      writeTotal += 1;
    }
  }
  compactOffsets[vertexCount] = writeTotal;
  return {
    adjacencyOffsets: compactOffsets,
    adjacencyVertices: adjacencyVertices.subarray(0, writeTotal),
  };
}

/** Connected components over vertex adjacency (isolated vertices are their own component). */
export function computeConnectedComponents(
  vertexCount: number,
  adjacencyOffsets: Uint32Array,
  adjacencyVertices: Uint32Array,
): { vertexComponent: Int32Array; componentCount: number } {
  const vertexComponent = new Int32Array(vertexCount);
  vertexComponent.fill(-1);
  let componentCount = 0;
  const queue = new Uint32Array(vertexCount);
  for (let seed = 0; seed < vertexCount; seed += 1) {
    if (vertexComponent[seed] >= 0) continue;
    const componentId = componentCount;
    componentCount += 1;
    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = seed;
    vertexComponent[seed] = componentId;
    while (qHead < qTail) {
      const v = queue[qHead++]!;
      const start = adjacencyOffsets[v]!;
      const end = adjacencyOffsets[v + 1]!;
      for (let i = start; i < end; i += 1) {
        const n = adjacencyVertices[i]!;
        if (vertexComponent[n] >= 0) continue;
        vertexComponent[n] = componentId;
        queue[qTail++] = n;
      }
    }
  }
  return { vertexComponent, componentCount };
}

function defaultSingleMeshParts(
  vertexCount: number,
  triangleCount: number,
): {
  meshParts: CanonicalAutorigMeshPart[];
  vertexMeshPart: Uint32Array;
  triangleMeshPart: Uint32Array;
} {
  const meshParts: CanonicalAutorigMeshPart[] = [{
    id: 0,
    name: 'mesh',
    vertexStart: 0,
    vertexCount,
    triangleStart: 0,
    triangleCount,
  }];
  const vertexMeshPart = new Uint32Array(vertexCount);
  const triangleMeshPart = new Uint32Array(triangleCount);
  return { meshParts, vertexMeshPart, triangleMeshPart };
}

/** Build full topology from already-extracted typed buffers (worker-safe). */
export function buildCanonicalTopologyFromBuffers(input: TopologyBuffersInput): CanonicalAutorigTopology {
  const vertexCount = Math.floor(input.positions.length / 3);
  const triangleCount = Math.floor(input.triangles.length / 3);
  const triangles = input.triangles;

  let meshParts = input.meshParts;
  let vertexMeshPart = input.vertexMeshPart;
  let triangleMeshPart = input.triangleMeshPart;
  if (!meshParts || !vertexMeshPart || !triangleMeshPart) {
    const defaults = defaultSingleMeshParts(vertexCount, triangleCount);
    meshParts = meshParts ?? defaults.meshParts;
    vertexMeshPart = vertexMeshPart ?? defaults.vertexMeshPart;
    triangleMeshPart = triangleMeshPart ?? defaults.triangleMeshPart;
  }

  const { adjacencyOffsets, adjacencyVertices } = buildVertexAdjacency(vertexCount, triangles);
  const { vertexComponent, componentCount } = computeConnectedComponents(
    vertexCount,
    adjacencyOffsets,
    adjacencyVertices,
  );
  const topologyHash = computeTopologyHash({ meshParts, triangles });

  return {
    positions: input.positions,
    triangles,
    vertexMeshPart,
    triangleMeshPart,
    meshParts,
    adjacencyOffsets,
    adjacencyVertices,
    vertexComponent,
    componentCount,
    topologyHash,
  };
}

/**
 * Extract positions, triangles, and mesh-part provenance from a canonical root
 * in the same traversal order as extractCanonicalVertexPositions/Topology.
 */
export function extractCanonicalMeshParts(root: THREE.Object3D): {
  positions: Float32Array;
  triangles: Uint32Array;
  meshParts: CanonicalAutorigMeshPart[];
  vertexMeshPart: Uint32Array;
  triangleMeshPart: Uint32Array;
} {
  root.updateMatrixWorld(true);
  const positionValues: number[] = [];
  const triangleValues: number[] = [];
  const vertexMeshPartValues: number[] = [];
  const triangleMeshPartValues: number[] = [];
  const meshParts: CanonicalAutorigMeshPart[] = [];
  let vertexOffset = 0;
  let triangleOffset = 0;
  let partId = 0;
  const point = new THREE.Vector3();

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;

    const vertexStart = vertexOffset;
    const triangleStart = triangleOffset;
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      positionValues.push(point.x, point.y, point.z);
      vertexMeshPartValues.push(partId);
    }

    const index = mesh.geometry.getIndex();
    let addedTriangles = 0;
    if (index) {
      for (let i = 0; i + 2 < index.count; i += 3) {
        triangleValues.push(
          vertexOffset + index.getX(i),
          vertexOffset + index.getX(i + 1),
          vertexOffset + index.getX(i + 2),
        );
        triangleMeshPartValues.push(partId);
        addedTriangles += 1;
      }
    } else {
      for (let i = 0; i + 2 < position.count; i += 3) {
        triangleValues.push(vertexOffset + i, vertexOffset + i + 1, vertexOffset + i + 2);
        triangleMeshPartValues.push(partId);
        addedTriangles += 1;
      }
    }

    meshParts.push({
      id: partId,
      name: mesh.name || `mesh_${partId}`,
      vertexStart,
      vertexCount: position.count,
      triangleStart,
      triangleCount: addedTriangles,
    });
    vertexOffset += position.count;
    triangleOffset += addedTriangles;
    partId += 1;
  });

  return {
    positions: Float32Array.from(positionValues),
    triangles: Uint32Array.from(triangleValues),
    meshParts,
    vertexMeshPart: Uint32Array.from(vertexMeshPartValues),
    triangleMeshPart: Uint32Array.from(triangleMeshPartValues),
  };
}

/** Build topology from a prepared canonical Three.js root. */
export function buildCanonicalAutorigTopology(root: THREE.Object3D): CanonicalAutorigTopology {
  const extracted = extractCanonicalMeshParts(root);
  return buildCanonicalTopologyFromBuffers(extracted);
}
