import { describe, expect, it } from 'vitest';
import {
  collectAutorigRequestTransferables,
  collectAutorigResponseTransferables,
  type AutorigWorkerRequest,
  type AutorigWorkerResponse,
} from '../src/engine/autorig/workerProtocol';
import { buildAndClassifyRegionsFromBuffers } from '../src/engine/autorig/generateRegionMap';
import { suggestAutorigMarkers, fitSkeletonFromMarkers } from '../src/engine/autorigMarkers';
import { resolveRegionLabels, AUTORIG_REGION_CODE } from '../src/engine/autorig/regions';

describe('autorig worker protocol', () => {
  it('collects transferable buffers from auto-label requests', () => {
    const positions = new Float32Array([0, 1, 0]);
    const triangles = new Uint32Array([0, 0, 0]);
    const request: AutorigWorkerRequest = {
      kind: 'auto-label',
      jobId: 'job_1',
      positions,
      triangles,
      jointPositions: {},
    };
    const transfer = collectAutorigRequestTransferables(request);
    expect(transfer).toContain(positions.buffer);
    expect(transfer).toContain(triangles.buffer);
  });

  it('collects transferable buffers from auto-label responses', () => {
    const suggested = new Uint8Array([1, 2]);
    const overrides = new Uint8Array([0, 4]);
    const resolved = new Uint8Array([1, 4]);
    const confidence = new Float32Array([0.9, 0.4]);
    const adjacencyOffsets = new Uint32Array([0, 0, 0]);
    const adjacencyVertices = new Uint32Array(0);
    const vertexComponent = new Int32Array([0, 0]);
    const componentOffsets = new Uint32Array([0, 2]);
    const componentVertices = new Uint32Array([0, 1]);
    const response: AutorigWorkerResponse = {
      kind: 'auto-label',
      jobId: 'job_1',
      topologyHash: 'hash',
      suggested,
      overrides,
      resolved,
      confidence,
      uncertainVertexCount: 1,
      adjacencyOffsets,
      adjacencyVertices,
      vertexComponent,
      componentOffsets,
      componentVertices,
      componentCount: 1,
    };
    const transfer = collectAutorigResponseTransferables(response);
    expect(transfer).toContain(suggested.buffer);
    expect(transfer).toContain(overrides.buffer);
    expect(transfer).toContain(resolved.buffer);
    expect(transfer).toContain(confidence.buffer);
    expect(transfer).toContain(componentOffsets.buffer);
  });

  it('supports the same classify path the worker uses', () => {
    const markers = suggestAutorigMarkers({ size: [0.8, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    const left = fitted.jointPositions.leftHand ?? [0.4, 0.9, 0];
    const right = fitted.jointPositions.rightHand ?? [-0.4, 0.9, 0];
    const positions = Float32Array.from([
      left[0], left[1], left[2],
      left[0] + 0.02, left[1], left[2],
      left[0], left[1] + 0.02, left[2],
      right[0], right[1], right[2],
      right[0] - 0.02, right[1], right[2],
      right[0], right[1] + 0.02, right[2],
    ]);
    const triangles = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    const result = buildAndClassifyRegionsFromBuffers({
      positions,
      triangles,
      jointPositions: fitted.jointPositions,
    });
    expect(result.resolved[0]).toBe(AUTORIG_REGION_CODE.leftArm);
    expect(result.resolved[3]).toBe(AUTORIG_REGION_CODE.rightArm);

    const overrides = new Uint8Array(result.suggested.length);
    overrides[0] = AUTORIG_REGION_CODE.torso;
    const resolved = resolveRegionLabels({
      suggested: result.suggested,
      overrides,
    });
    expect(resolved[0]).toBe(AUTORIG_REGION_CODE.torso);
    expect(resolved[3]).toBe(AUTORIG_REGION_CODE.rightArm);
  });
});
