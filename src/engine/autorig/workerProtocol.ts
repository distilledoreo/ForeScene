/**
 * Autorig worker request/response protocol.
 * Heavy one-time topology / labeling / (later) weight work runs off the main thread.
 */

import type { HumanJointId, Vec3 } from '../../domain/types';
import type { CanonicalAutorigMeshPart } from './topology';

export type AutorigWorkerProgressStage =
  | 'preparing'
  | 'assigning'
  | 'generating'
  | 'checking';

export interface AutorigWorkerProgress {
  kind: 'progress';
  jobId: string;
  stage: AutorigWorkerProgressStage;
  /** 0..1 */
  progress: number;
  message: string;
}

export interface AutorigBuildTopologyRequest {
  kind: 'build-topology';
  jobId: string;
  positions: Float32Array;
  triangles: Uint32Array;
  meshParts?: CanonicalAutorigMeshPart[];
  vertexMeshPart?: Uint32Array;
  triangleMeshPart?: Uint32Array;
}

export interface AutorigAutoLabelRequest {
  kind: 'auto-label';
  jobId: string;
  positions: Float32Array;
  triangles: Uint32Array;
  meshParts?: CanonicalAutorigMeshPart[];
  vertexMeshPart?: Uint32Array;
  triangleMeshPart?: Uint32Array;
  /** Optional precomputed topology hash; recomputed when omitted. */
  topologyHash?: string;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
  poseHint?: 'a-pose' | 't-pose';
  /** Hard user overrides (0 = automatic). Preserved across reclassification. */
  overrides?: Uint8Array;
}

export interface AutorigApplyRegionOverridesRequest {
  kind: 'apply-region-overrides';
  jobId: string;
  suggested: Uint8Array;
  overrides: Uint8Array;
}

export interface AutorigGenerateWeightsRequest {
  kind: 'generate-weights';
  jobId: string;
  /** Reserved for Binder V2 — rejected until implemented. */
  positions: Float32Array;
  regionLabels: Uint8Array;
  jointPositions: Partial<Record<HumanJointId, Vec3>>;
}

export interface AutorigCancelRequest {
  kind: 'cancel';
  jobId: string;
}

export type AutorigWorkerRequest =
  | AutorigBuildTopologyRequest
  | AutorigAutoLabelRequest
  | AutorigApplyRegionOverridesRequest
  | AutorigGenerateWeightsRequest
  | AutorigCancelRequest;

export interface AutorigBuildTopologyResult {
  kind: 'build-topology';
  jobId: string;
  topologyHash: string;
  vertexCount: number;
  componentCount: number;
  adjacencyOffsets: Uint32Array;
  adjacencyVertices: Uint32Array;
  vertexComponent: Int32Array;
  componentOffsets: Uint32Array;
  componentVertices: Uint32Array;
}

export interface AutorigAutoLabelResultMessage {
  kind: 'auto-label';
  jobId: string;
  topologyHash: string;
  suggested: Uint8Array;
  /** Hard overrides echoed / normalized (0 = automatic). */
  overrides: Uint8Array;
  /** Suggested with hard overrides applied and unknowns filled. */
  resolved: Uint8Array;
  confidence: Float32Array;
  uncertainVertexCount: number;
  adjacencyOffsets: Uint32Array;
  adjacencyVertices: Uint32Array;
  vertexComponent: Int32Array;
  componentOffsets: Uint32Array;
  componentVertices: Uint32Array;
  componentCount: number;
}

export interface AutorigApplyRegionOverridesResult {
  kind: 'apply-region-overrides';
  jobId: string;
  resolved: Uint8Array;
}

export interface AutorigWorkerError {
  kind: 'error';
  jobId: string;
  message: string;
}

export interface AutorigWorkerCancelled {
  kind: 'cancelled';
  jobId: string;
}

export type AutorigWorkerResponse =
  | AutorigBuildTopologyResult
  | AutorigAutoLabelResultMessage
  | AutorigApplyRegionOverridesResult
  | AutorigWorkerProgress
  | AutorigWorkerError
  | AutorigWorkerCancelled;

/** Collect transferable ArrayBuffers from a request for postMessage. */
export function collectAutorigRequestTransferables(
  request: AutorigWorkerRequest,
): Transferable[] {
  const buffers: Transferable[] = [];
  const push = (value: ArrayBufferView | undefined) => {
    if (value && value.buffer instanceof ArrayBuffer) buffers.push(value.buffer);
  };
  switch (request.kind) {
    case 'build-topology':
      push(request.positions);
      push(request.triangles);
      push(request.vertexMeshPart);
      push(request.triangleMeshPart);
      break;
    case 'auto-label':
      push(request.positions);
      push(request.triangles);
      push(request.vertexMeshPart);
      push(request.triangleMeshPart);
      push(request.overrides);
      break;
    case 'apply-region-overrides':
      push(request.suggested);
      push(request.overrides);
      break;
    case 'generate-weights':
      push(request.positions);
      push(request.regionLabels);
      break;
    case 'cancel':
      break;
  }
  return buffers;
}

/** Collect transferable ArrayBuffers from a successful result payload. */
export function collectAutorigResponseTransferables(
  response: AutorigWorkerResponse,
): Transferable[] {
  const buffers: Transferable[] = [];
  const push = (value: ArrayBufferView | undefined) => {
    if (value && value.buffer instanceof ArrayBuffer) buffers.push(value.buffer);
  };
  if (response.kind === 'build-topology') {
    push(response.adjacencyOffsets);
    push(response.adjacencyVertices);
    push(response.vertexComponent);
    push(response.componentOffsets);
    push(response.componentVertices);
  } else if (response.kind === 'auto-label') {
    push(response.suggested);
    push(response.overrides);
    push(response.resolved);
    push(response.confidence);
    push(response.adjacencyOffsets);
    push(response.adjacencyVertices);
    push(response.vertexComponent);
    push(response.componentOffsets);
    push(response.componentVertices);
  } else if (response.kind === 'apply-region-overrides') {
    push(response.resolved);
  }
  return buffers;
}
