/// <reference lib="webworker" />

import {
  buildCanonicalTopologyFromBuffers,
} from '../engine/autorig/topology';
import {
  autoLabelBodyRegions,
  ensureAllVerticesLabeled,
  resolveRegionLabels,
} from '../engine/autorig/regions';
import { generateRegionConstrainedSkinWeights } from '../engine/autorig/regionConstrainedWeights';
import type {
  AutorigWorkerRequest,
  AutorigWorkerResponse,
  AutorigWorkerProgressStage,
} from '../engine/autorig/workerProtocol';
import { collectAutorigResponseTransferables } from '../engine/autorig/workerProtocol';

const cancelledJobs = new Set<string>();

function post(response: AutorigWorkerResponse): void {
  const transfer = collectAutorigResponseTransferables(response);
  self.postMessage(response, { transfer });
}

function progress(
  jobId: string,
  stage: AutorigWorkerProgressStage,
  value: number,
  message: string,
): void {
  post({
    kind: 'progress',
    jobId,
    stage,
    progress: value,
    message,
  });
}

self.onmessage = (event: MessageEvent<AutorigWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'cancel') {
      cancelledJobs.add(request.jobId);
      post({ kind: 'cancelled', jobId: request.jobId });
      return;
    }

    if (cancelledJobs.has(request.jobId)) {
      post({ kind: 'cancelled', jobId: request.jobId });
      return;
    }

    if (request.kind === 'build-topology') {
      progress(request.jobId, 'preparing', 0.1, 'Preparing model…');
      const topology = buildCanonicalTopologyFromBuffers({
        positions: request.positions,
        triangles: request.triangles,
        meshParts: request.meshParts,
        vertexMeshPart: request.vertexMeshPart,
        triangleMeshPart: request.triangleMeshPart,
      });
      if (cancelledJobs.has(request.jobId)) {
        post({ kind: 'cancelled', jobId: request.jobId });
        return;
      }
      post({
        kind: 'build-topology',
        jobId: request.jobId,
        topologyHash: topology.topologyHash,
        vertexCount: Math.floor(topology.positions.length / 3),
        componentCount: topology.componentCount,
        adjacencyOffsets: topology.adjacencyOffsets,
        adjacencyVertices: topology.adjacencyVertices,
        vertexComponent: topology.vertexComponent,
        componentOffsets: topology.componentOffsets,
        componentVertices: topology.componentVertices,
      });
      return;
    }

    if (request.kind === 'auto-label') {
      progress(request.jobId, 'preparing', 0.15, 'Preparing model…');
      const topology = buildCanonicalTopologyFromBuffers({
        positions: request.positions,
        triangles: request.triangles,
        meshParts: request.meshParts,
        vertexMeshPart: request.vertexMeshPart,
        triangleMeshPart: request.triangleMeshPart,
      });
      if (cancelledJobs.has(request.jobId)) {
        post({ kind: 'cancelled', jobId: request.jobId });
        return;
      }
      progress(request.jobId, 'assigning', 0.55, 'Assigning body parts…');
      const labeled = autoLabelBodyRegions({
        topology,
        jointPositions: request.jointPositions,
        poseHint: request.poseHint,
      });
      const vertexCount = labeled.suggested.length;
      const overrides = request.overrides && request.overrides.length === vertexCount
        ? new Uint8Array(request.overrides)
        : new Uint8Array(vertexCount);
      const withOverrides = resolveRegionLabels({
        suggested: labeled.suggested,
        overrides,
      });
      const resolved = ensureAllVerticesLabeled({
        labels: withOverrides,
        topology,
        jointPositions: request.jointPositions,
      });
      if (cancelledJobs.has(request.jobId)) {
        post({ kind: 'cancelled', jobId: request.jobId });
        return;
      }
      post({
        kind: 'auto-label',
        jobId: request.jobId,
        topologyHash: request.topologyHash ?? topology.topologyHash,
        suggested: labeled.suggested,
        overrides,
        resolved,
        confidence: labeled.confidence,
        uncertainVertexCount: labeled.uncertainVertexCount,
        adjacencyOffsets: topology.adjacencyOffsets,
        adjacencyVertices: topology.adjacencyVertices,
        vertexComponent: topology.vertexComponent,
        componentOffsets: topology.componentOffsets,
        componentVertices: topology.componentVertices,
        componentCount: topology.componentCount,
      });
      return;
    }

    if (request.kind === 'apply-region-overrides') {
      const resolved = resolveRegionLabels({
        suggested: request.suggested,
        overrides: request.overrides,
      });
      post({
        kind: 'apply-region-overrides',
        jobId: request.jobId,
        resolved,
      });
      return;
    }

    if (request.kind === 'generate-weights') {
      progress(request.jobId, 'generating', 0.4, 'Generating rig…');
      let topology = undefined as ReturnType<typeof buildCanonicalTopologyFromBuffers> | undefined;
      if (request.triangles && request.adjacencyOffsets && request.adjacencyVertices) {
        topology = buildCanonicalTopologyFromBuffers({
          positions: request.positions,
          triangles: request.triangles,
        });
        // Prefer precomputed adjacency when provided (already transferred).
        if (request.adjacencyOffsets && request.adjacencyVertices) {
          topology = {
            ...topology,
            adjacencyOffsets: request.adjacencyOffsets,
            adjacencyVertices: request.adjacencyVertices,
            ...(request.vertexComponent ? { vertexComponent: request.vertexComponent } : {}),
          };
        }
      } else if (request.triangles) {
        topology = buildCanonicalTopologyFromBuffers({
          positions: request.positions,
          triangles: request.triangles,
        });
      }
      if (cancelledJobs.has(request.jobId)) {
        post({ kind: 'cancelled', jobId: request.jobId });
        return;
      }
      const buffers = generateRegionConstrainedSkinWeights({
        positions: request.positions,
        regionLabels: request.regionLabels,
        jointPositions: request.jointPositions,
        topology: topology ?? null,
        heightMeters: request.heightMeters,
        meshSize: request.meshSize,
      });
      if (cancelledJobs.has(request.jobId)) {
        post({ kind: 'cancelled', jobId: request.jobId });
        return;
      }
      progress(request.jobId, 'checking', 0.9, 'Checking deformation…');
      post({
        kind: 'generate-weights',
        jobId: request.jobId,
        influencesPerVertex: buffers.influencesPerVertex,
        indices: buffers.indices,
        weights: buffers.weights,
        jointOrder: buffers.jointOrder,
        fallbackVertexCount: buffers.fallbackVertexCount ?? 0,
        ...(buffers.warnings ? { warnings: buffers.warnings } : {}),
      });
      return;
    }

    post({
      kind: 'error',
      jobId: (request as { jobId?: string }).jobId ?? 'unknown',
      message: 'Unknown autorig worker request.',
    });
  } catch (error) {
    post({
      kind: 'error',
      jobId: (request as { jobId?: string }).jobId ?? 'unknown',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
