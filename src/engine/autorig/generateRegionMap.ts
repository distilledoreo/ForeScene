import type { Object3D } from 'three';
import type { HumanJointId, PoseableRigAsset, ProjectAsset, Vec3 } from '../../domain/types';
import { CURRENT_AUTORIG_BINDER_VERSION } from '../poseableRigNormalize';
import {
  autoLabelBodyRegions,
  ensureAllVerticesLabeled,
  resolveRegionLabels,
  type AutoLabelResult,
} from './regions';
import {
  applyRegionMapToRig,
  createRegionMapProjectAsset,
  writeRegionMapBinaryAsset,
} from './regionPersistence';
import {
  buildCanonicalTopologyFromBuffers,
  extractCanonicalMeshParts,
  type CanonicalAutorigMeshPart,
  type CanonicalAutorigTopology,
} from './topology';
import { cacheCanonicalTopology } from './topologyCache';
import { runAutorigAutoLabel } from './autorigWorkerClient';
import type { AutorigWorkerProgress } from './workerProtocol';

export interface GenerateRegionMapResult {
  topology: CanonicalAutorigTopology;
  suggested: Uint8Array;
  /** Hard overrides that were persisted (0 = automatic). */
  overrides: Uint8Array;
  resolved: Uint8Array;
  confidence: Float32Array;
  uncertainVertexCount: number;
  regionAsset: ProjectAsset;
  rig: PoseableRigAsset;
  /** True when classification ran in a Web Worker. */
  usedWorker: boolean;
}

/** Run automatic classification on an already-built topology (sync / tests / worker). */
export function classifyCanonicalRegions(params: {
  topology: CanonicalAutorigTopology;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  poseHint?: 'a-pose' | 't-pose';
  overrides?: Uint8Array | null;
}): AutoLabelResult & { resolved: Uint8Array; overrides: Uint8Array } {
  const labeled = autoLabelBodyRegions({
    topology: params.topology,
    jointPositions: params.jointPositions,
    poseHint: params.poseHint,
  });
  const overrides = params.overrides && params.overrides.length === labeled.suggested.length
    ? new Uint8Array(params.overrides)
    : new Uint8Array(labeled.suggested.length);
  const withOverrides = resolveRegionLabels({
    suggested: labeled.suggested,
    overrides,
  });
  const resolved = ensureAllVerticesLabeled({
    labels: withOverrides,
    topology: params.topology,
    jointPositions: params.jointPositions,
  });
  return {
    ...labeled,
    suggested: labeled.suggested,
    overrides,
    resolved,
  };
}

/** Build topology + auto-label from typed buffers (no Three.js). Sync path. */
export function buildAndClassifyRegionsFromBuffers(params: {
  positions: Float32Array;
  triangles: Uint32Array;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  poseHint?: 'a-pose' | 't-pose';
  overrides?: Uint8Array | null;
  meshParts?: CanonicalAutorigMeshPart[];
  vertexMeshPart?: Uint32Array;
  triangleMeshPart?: Uint32Array;
}): AutoLabelResult & {
  topology: CanonicalAutorigTopology;
  resolved: Uint8Array;
  overrides: Uint8Array;
} {
  const topology = buildCanonicalTopologyFromBuffers({
    positions: params.positions,
    triangles: params.triangles,
    meshParts: params.meshParts,
    vertexMeshPart: params.vertexMeshPart,
    triangleMeshPart: params.triangleMeshPart,
  });
  cacheCanonicalTopology(topology);
  const classified = classifyCanonicalRegions({
    topology,
    jointPositions: params.jointPositions,
    poseHint: params.poseHint,
    overrides: params.overrides,
  });
  return { topology, ...classified };
}

function workersAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

async function classifyRegionsViaWorker(params: {
  positions: Float32Array;
  triangles: Uint32Array;
  meshParts?: CanonicalAutorigMeshPart[];
  vertexMeshPart?: Uint32Array;
  triangleMeshPart?: Uint32Array;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  poseHint?: 'a-pose' | 't-pose';
  overrides?: Uint8Array | null;
  onProgress?: (progress: AutorigWorkerProgress) => void;
}): Promise<AutoLabelResult & {
  topology: CanonicalAutorigTopology;
  resolved: Uint8Array;
  overrides: Uint8Array;
}> {
  // Transfer copies — keep caller buffers intact for concurrent skin generation.
  const positions = params.positions.slice();
  const triangles = params.triangles.slice();
  const vertexMeshPart = params.vertexMeshPart?.slice();
  const triangleMeshPart = params.triangleMeshPart?.slice();
  const overrides = params.overrides ? params.overrides.slice() : undefined;

  const task = runAutorigAutoLabel({
    positions,
    triangles,
    meshParts: params.meshParts,
    vertexMeshPart,
    triangleMeshPart,
    jointPositions: params.jointPositions,
    poseHint: params.poseHint,
    overrides,
  }, params.onProgress);
  const result = await task.promise;

  const topology: CanonicalAutorigTopology = {
    positions: params.positions,
    triangles: params.triangles,
    vertexMeshPart: params.vertexMeshPart ?? new Uint32Array(Math.floor(params.positions.length / 3)),
    triangleMeshPart: params.triangleMeshPart ?? new Uint32Array(Math.floor(params.triangles.length / 3)),
    meshParts: params.meshParts ?? [{
      id: 0,
      name: 'mesh',
      vertexStart: 0,
      vertexCount: Math.floor(params.positions.length / 3),
      triangleStart: 0,
      triangleCount: Math.floor(params.triangles.length / 3),
    }],
    adjacencyOffsets: result.adjacencyOffsets,
    adjacencyVertices: result.adjacencyVertices,
    vertexComponent: result.vertexComponent,
    componentCount: result.componentCount,
    componentOffsets: result.componentOffsets,
    componentVertices: result.componentVertices,
    topologyHash: result.topologyHash,
  };
  cacheCanonicalTopology(topology);
  return {
    topology,
    suggested: result.suggested,
    overrides: result.overrides,
    resolved: result.resolved,
    confidence: result.confidence,
    uncertainVertexCount: result.uncertainVertexCount,
  };
}

async function persistClassifiedRegionMap(params: {
  topology: CanonicalAutorigTopology;
  suggested: Uint8Array;
  overrides: Uint8Array;
  resolved: Uint8Array;
  confidence: Float32Array;
  uncertainVertexCount: number;
  rig: PoseableRigAsset;
  sourceAssetId: string;
  usedWorker: boolean;
}): Promise<GenerateRegionMapResult> {
  const written = await writeRegionMapBinaryAsset({
    resolved: params.resolved,
    overrides: params.overrides,
    topologyHash: params.topology.topologyHash,
    sourceAssetId: params.sourceAssetId,
  });
  const regionAsset = createRegionMapProjectAsset({
    assetId: written.assetId,
    uri: written.uri,
    byteLength: written.byteLength,
    rigId: params.rig.id,
    topologyHash: params.topology.topologyHash,
    vertexCount: params.resolved.length,
  });
  const rig = applyRegionMapToRig(params.rig, written.reference, CURRENT_AUTORIG_BINDER_VERSION);
  return {
    topology: params.topology,
    suggested: params.suggested,
    overrides: params.overrides,
    resolved: params.resolved,
    confidence: params.confidence,
    uncertainVertexCount: params.uncertainVertexCount,
    regionAsset,
    rig,
    usedWorker: params.usedWorker,
  };
}

/**
 * Produce a persistent six-color region map from typed buffers.
 * Prefers the autorig worker so dense classification does not block the UI.
 */
export async function generateRegionMapFromBuffers(params: {
  positions: Float32Array;
  triangles: Uint32Array;
  meshParts?: CanonicalAutorigMeshPart[];
  vertexMeshPart?: Uint32Array;
  triangleMeshPart?: Uint32Array;
  rig: PoseableRigAsset;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  sourceAssetId: string;
  overrides?: Uint8Array | null;
  preferWorker?: boolean;
  onProgress?: (progress: AutorigWorkerProgress) => void;
}): Promise<GenerateRegionMapResult> {
  const preferWorker = params.preferWorker !== false;
  let classified: AutoLabelResult & {
    topology: CanonicalAutorigTopology;
    resolved: Uint8Array;
    overrides: Uint8Array;
  };
  let usedWorker = false;

  if (preferWorker && workersAvailable()) {
    try {
      classified = await classifyRegionsViaWorker({
        positions: params.positions,
        triangles: params.triangles,
        meshParts: params.meshParts,
        vertexMeshPart: params.vertexMeshPart,
        triangleMeshPart: params.triangleMeshPart,
        jointPositions: params.jointPositions,
        poseHint: params.rig.generationSettings?.poseHint,
        overrides: params.overrides,
        onProgress: params.onProgress,
      });
      usedWorker = true;
    } catch {
      // Fall back to sync classification if the worker fails to start/run.
      classified = buildAndClassifyRegionsFromBuffers({
        positions: params.positions,
        triangles: params.triangles,
        meshParts: params.meshParts,
        vertexMeshPart: params.vertexMeshPart,
        triangleMeshPart: params.triangleMeshPart,
        jointPositions: params.jointPositions,
        poseHint: params.rig.generationSettings?.poseHint,
        overrides: params.overrides,
      });
    }
  } else {
    classified = buildAndClassifyRegionsFromBuffers({
      positions: params.positions,
      triangles: params.triangles,
      meshParts: params.meshParts,
      vertexMeshPart: params.vertexMeshPart,
      triangleMeshPart: params.triangleMeshPart,
      jointPositions: params.jointPositions,
      poseHint: params.rig.generationSettings?.poseHint,
      overrides: params.overrides,
    });
  }

  return persistClassifiedRegionMap({
    topology: classified.topology,
    suggested: classified.suggested,
    overrides: classified.overrides,
    resolved: classified.resolved,
    confidence: classified.confidence,
    uncertainVertexCount: classified.uncertainVertexCount,
    rig: params.rig,
    sourceAssetId: params.sourceAssetId,
    usedWorker,
  });
}

/**
 * Produce a persistent six-color region map for a fitted rig and register the binary asset.
 * Extracts typed arrays on the main thread, then classifies via worker when available.
 */
export async function generateRegionMapForCanonicalRoot(params: {
  root: Object3D;
  rig: PoseableRigAsset;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  sourceAssetId: string;
  overrides?: Uint8Array | null;
  preferWorker?: boolean;
  onProgress?: (progress: AutorigWorkerProgress) => void;
}): Promise<GenerateRegionMapResult> {
  const extracted = extractCanonicalMeshParts(params.root);
  return generateRegionMapFromBuffers({
    positions: extracted.positions,
    triangles: extracted.triangles,
    meshParts: extracted.meshParts,
    vertexMeshPart: extracted.vertexMeshPart,
    triangleMeshPart: extracted.triangleMeshPart,
    rig: params.rig,
    jointPositions: params.jointPositions,
    sourceAssetId: params.sourceAssetId,
    overrides: params.overrides,
    preferWorker: params.preferWorker,
    onProgress: params.onProgress,
  });
}
