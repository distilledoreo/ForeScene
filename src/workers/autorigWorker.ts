/// <reference lib="webworker" />

import {
  buildCanonicalTopologyFromBuffers,
} from '../engine/autorig/topology';
import {
  autoLabelBodyRegions,
  resolveRegionLabels,
} from '../engine/autorig/regions';
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
      if (cancelledJobs.has(request.jobId)) {
        post({ kind: 'cancelled', jobId: request.jobId });
        return;
      }
      post({
        kind: 'auto-label',
        jobId: request.jobId,
        topologyHash: request.topologyHash ?? topology.topologyHash,
        suggested: labeled.suggested,
        confidence: labeled.confidence,
        uncertainVertexCount: labeled.uncertainVertexCount,
        adjacencyOffsets: topology.adjacencyOffsets,
        adjacencyVertices: topology.adjacencyVertices,
        vertexComponent: topology.vertexComponent,
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
      post({
        kind: 'error',
        jobId: request.jobId,
        message: 'Region-constrained weight generation is not available yet.',
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
