import { describe, expect, it } from 'vitest';
import {
  buildSkinBoneSegments,
  generateDeterministicSkinWeights,
} from '../src/engine/autorigSkinWeights';
import { suggestAutorigMarkers, fitSkeletonFromMarkers } from '../src/engine/autorigMarkers';
import { HUMAN_JOINT_IDS } from '../src/engine/humanPose';

describe('deterministic autorig skin weights', () => {
  it('builds bone segments from fitted joint positions', () => {
    const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    const segments = buildSkinBoneSegments(fitted.jointPositions);
    expect(segments.length).toBeGreaterThan(10);
    expect(segments.every((segment) => Number.isFinite(segment.start[0]))).toBe(true);
  });

  it('assigns normalized top-4 weights and blocks opposite-limb influence', () => {
    const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    // Synthetic vertices: left wrist area and head top.
    const leftHand = fitted.jointPositions.leftHand ?? [0.4, 0.9, 0];
    const head = fitted.jointPositions.head ?? [0, 1.7, 0];
    const positions = Float32Array.from([
      leftHand[0], leftHand[1], leftHand[2],
      head[0], head[1], head[2],
    ]);
    const buffers = generateDeterministicSkinWeights({
      positions,
      jointPositions: fitted.jointPositions,
      heightMeters: 1.75,
    });
    expect(buffers.influencesPerVertex).toBe(4);
    expect(buffers.indices.length).toBe(8);
    expect(buffers.weights.length).toBe(8);

    const leftSum = buffers.weights[0]! + buffers.weights[1]! + buffers.weights[2]! + buffers.weights[3]!;
    expect(leftSum).toBeCloseTo(1, 5);

    const jointOrder = buffers.jointOrder;
    const rightArmIndexes = new Set(
      (['rightUpperArm', 'rightLowerArm', 'rightHand'] as const)
        .map((id) => jointOrder.indexOf(id))
        .filter((index) => index >= 0),
    );
    for (let i = 0; i < 4; i += 1) {
      expect(rightArmIndexes.has(buffers.indices[i]!)).toBe(false);
    }
  });

  it('covers every semantic joint that has a position in the order list', () => {
    const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    const buffers = generateDeterministicSkinWeights({
      positions: Float32Array.from([0, 1, 0]),
      jointPositions: fitted.jointPositions,
    });
    expect(buffers.jointOrder.length).toBeGreaterThan(10);
    expect(buffers.jointOrder.every((id) => (HUMAN_JOINT_IDS as readonly string[]).includes(id))).toBe(true);
  });
});
