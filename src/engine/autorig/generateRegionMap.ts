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
  buildCanonicalAutorigTopology,
  buildCanonicalTopologyFromBuffers,
  type CanonicalAutorigTopology,
} from './topology';
import { cacheCanonicalTopology } from './topologyCache';

export interface GenerateRegionMapResult {
  topology: CanonicalAutorigTopology;
  suggested: Uint8Array;
  resolved: Uint8Array;
  confidence: Float32Array;
  uncertainVertexCount: number;
  regionAsset: ProjectAsset;
  rig: PoseableRigAsset;
}

/** Run automatic classification on an already-built topology (sync / tests / worker). */
export function classifyCanonicalRegions(params: {
  topology: CanonicalAutorigTopology;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  poseHint?: 'a-pose' | 't-pose';
  overrides?: Uint8Array | null;
}): AutoLabelResult & { resolved: Uint8Array } {
  const labeled = autoLabelBodyRegions({
    topology: params.topology,
    jointPositions: params.jointPositions,
    poseHint: params.poseHint,
  });
  const withOverrides = resolveRegionLabels({
    suggested: labeled.suggested,
    overrides: params.overrides,
  });
  const resolved = ensureAllVerticesLabeled({
    labels: withOverrides,
    topology: params.topology,
    jointPositions: params.jointPositions,
  });
  return {
    ...labeled,
    suggested: labeled.suggested,
    resolved,
  };
}

/** Build topology + auto-label from typed buffers (no Three.js). */
export function buildAndClassifyRegionsFromBuffers(params: {
  positions: Float32Array;
  triangles: Uint32Array;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  poseHint?: 'a-pose' | 't-pose';
  overrides?: Uint8Array | null;
}): AutoLabelResult & { topology: CanonicalAutorigTopology; resolved: Uint8Array } {
  const topology = buildCanonicalTopologyFromBuffers({
    positions: params.positions,
    triangles: params.triangles,
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

/**
 * Produce a persistent six-color region map for a fitted rig and register the binary asset.
 */
export async function generateRegionMapForCanonicalRoot(params: {
  root: Object3D;
  rig: PoseableRigAsset;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  sourceAssetId: string;
  overrides?: Uint8Array | null;
}): Promise<GenerateRegionMapResult> {
  const topology = buildCanonicalAutorigTopology(params.root);
  cacheCanonicalTopology(topology);
  const classified = classifyCanonicalRegions({
    topology,
    jointPositions: params.jointPositions,
    poseHint: params.rig.generationSettings?.poseHint,
    overrides: params.overrides,
  });
  const written = await writeRegionMapBinaryAsset({
    labels: classified.resolved,
    topologyHash: topology.topologyHash,
    sourceAssetId: params.sourceAssetId,
  });
  const regionAsset = createRegionMapProjectAsset({
    assetId: written.assetId,
    uri: written.uri,
    byteLength: written.byteLength,
    rigId: params.rig.id,
    topologyHash: topology.topologyHash,
    vertexCount: classified.resolved.length,
  });
  const rig = applyRegionMapToRig(params.rig, written.reference, CURRENT_AUTORIG_BINDER_VERSION);
  return {
    topology,
    suggested: classified.suggested,
    resolved: classified.resolved,
    confidence: classified.confidence,
    uncertainVertexCount: classified.uncertainVertexCount,
    regionAsset,
    rig,
  };
}
