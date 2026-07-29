/// <reference lib="webworker" />

import {
  buildCanonicalTopologyFromBuffers,
} from '../engine/autorig/topology';
import {
  autoLabelBodyRegions,
  ensureAllVerticesLabeled,
  resolveRegionLabels,
} from '../engine/autorig/regions';
import {
  generatePartialRegionConstrainedSkinWeights,
  generateRegionConstrainedSkinWeights,
} from '../engine/autorig/regionConstrainedWeights';
import { applyPartialSkinUpdate } from '../engine/autorig/partialSkinUpdate';
import { createRegionEditFromLabels, buildDirtyVertexSet } from '../engine/autorig/dirtyRegionSet';
import type { SkinWeightBuffers } from '../engine/autorigSkinWeights';
import type { HumanJointId, Vec3 } from '../domain/types';
import type {
  AutorigWorkerRequest,
  AutorigWorkerResponse,
  AutorigWorkerProgressStage,
} from '../engine/autorig/workerProtocol';
import { collectAutorigResponseTransferables } from '../engine/autorig/workerProtocol';
import type { CanonicalAutorigTopology } from '../engine/autorig/topology';

const cancelledJobs = new Set<string>();

interface WorkerRigSession {
  sessionId: string;
  positions: Float32Array;
  triangles: Uint32Array;
  adjacencyOffsets: Uint32Array;
  adjacencyVertices: Uint32Array;
  vertexComponent: Int32Array;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  regionLabels: Uint8Array;
  heightMeters?: number;
  meshSize?: Vec3;
  buffers: SkinWeightBuffers;
}

const rigSessions = new Map<string, WorkerRigSession>();

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

function buildTopologyFromSession(session: WorkerRigSession): CanonicalAutorigTopology {
  const base = buildCanonicalTopologyFromBuffers({
    positions: session.positions,
    triangles: session.triangles,
  });
  return {
    ...base,
    adjacencyOffsets: session.adjacencyOffsets,
    adjacencyVertices: session.adjacencyVertices,
    vertexComponent: session.vertexComponent,
  };
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
        topology = {
          ...topology,
          adjacencyOffsets: request.adjacencyOffsets,
          adjacencyVertices: request.adjacencyVertices,
          ...(request.vertexComponent ? { vertexComponent: request.vertexComponent } : {}),
        };
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

    if (request.kind === 'initialize-rig-session') {
      progress(request.jobId, 'generating', 0.35, 'Preparing pose preview…');
      const topology = {
        ...buildCanonicalTopologyFromBuffers({
          positions: request.positions,
          triangles: request.triangles,
        }),
        adjacencyOffsets: request.adjacencyOffsets,
        adjacencyVertices: request.adjacencyVertices,
        vertexComponent: request.vertexComponent,
      };
      const buffers = generateRegionConstrainedSkinWeights({
        positions: request.positions,
        regionLabels: request.regionLabels,
        jointPositions: request.jointPositions,
        topology,
        heightMeters: request.heightMeters,
        meshSize: request.meshSize,
      });
      if (cancelledJobs.has(request.jobId)) {
        post({ kind: 'cancelled', jobId: request.jobId });
        return;
      }
      rigSessions.set(request.sessionId, {
        sessionId: request.sessionId,
        positions: request.positions,
        triangles: request.triangles,
        adjacencyOffsets: request.adjacencyOffsets,
        adjacencyVertices: request.adjacencyVertices,
        vertexComponent: request.vertexComponent,
        jointPositions: request.jointPositions,
        regionLabels: new Uint8Array(request.regionLabels),
        heightMeters: request.heightMeters,
        meshSize: request.meshSize,
        buffers: {
          ...buffers,
          indices: buffers.indices.slice(),
          weights: buffers.weights.slice(),
        },
      });
      post({
        kind: 'initialize-rig-session',
        jobId: request.jobId,
        sessionId: request.sessionId,
        influencesPerVertex: buffers.influencesPerVertex,
        indices: buffers.indices,
        weights: buffers.weights,
        jointOrder: buffers.jointOrder,
        fallbackVertexCount: buffers.fallbackVertexCount ?? 0,
        ...(buffers.warnings ? { warnings: buffers.warnings } : {}),
      });
      return;
    }

    if (request.kind === 'update-rig-regions') {
      const session = rigSessions.get(request.sessionId);
      if (!session) {
        post({
          kind: 'error',
          jobId: request.jobId,
          message: 'Unknown autorig rig session.',
        });
        return;
      }
      progress(request.jobId, 'generating', 0.45, 'Updating deformation…');
      const previousLabels = new Uint8Array(session.regionLabels);
      if (request.regionLabels && request.regionLabels.length === session.regionLabels.length) {
        session.regionLabels.set(request.regionLabels);
      } else {
        for (let i = 0; i < request.changedVertices.length; i += 1) {
          const v = request.changedVertices[i]!;
          if (v < session.regionLabels.length) {
            session.regionLabels[v] = request.changedLabels[i]!;
          }
        }
      }
      const topology = buildTopologyFromSession(session);
      const edit = createRegionEditFromLabels({
        previousLabels,
        nextLabels: session.regionLabels,
      });
      const dirtyVertices = edit
        ? buildDirtyVertexSet({ topology, edit })
        : new Uint32Array(0);
      const partial = generatePartialRegionConstrainedSkinWeights({
        positions: session.positions,
        regionLabels: session.regionLabels,
        previousRegionLabels: previousLabels,
        jointPositions: session.jointPositions,
        topology,
        heightMeters: session.heightMeters,
        meshSize: session.meshSize,
        revision: request.revision,
        dirtyVertices,
      });
      if (cancelledJobs.has(request.jobId)) {
        post({ kind: 'cancelled', jobId: request.jobId });
        return;
      }
      if (partial.vertexIndices.length > 0) {
        applyPartialSkinUpdate(session.buffers, partial);
      }
      post({
        kind: 'update-rig-regions',
        jobId: request.jobId,
        sessionId: request.sessionId,
        revision: request.revision,
        vertexIndices: partial.vertexIndices,
        skinIndices: partial.skinIndices,
        skinWeights: partial.skinWeights,
        warnings: partial.warnings,
        fallbackVertexCount: partial.fallbackVertexCount,
      });
      return;
    }

    if (request.kind === 'dispose-rig-session') {
      rigSessions.delete(request.sessionId);
      post({
        kind: 'dispose-rig-session',
        jobId: request.jobId,
        sessionId: request.sessionId,
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
