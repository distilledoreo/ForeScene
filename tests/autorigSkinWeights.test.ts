import { describe, expect, it } from 'vitest';
import {
  buildSkinBoneSegments,
  estimateMeshCapsuleRadii,
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

  it('reports vertices that require the explicit fallback assignment', () => {
    const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    const buffers = generateDeterministicSkinWeights({
      positions: Float32Array.from([4, 4, 4]),
      jointPositions: fitted.jointPositions,
    });
    expect(buffers.warnings?.some((warning) => warning.includes('hips fallback'))).toBe(true);
  });

  it('derives larger limb capsules from thicker mesh samples around that bone', () => {
    const markers = suggestAutorigMarkers({ size: [1.1, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    const segments = buildSkinBoneSegments(fitted.jointPositions);
    const upper = fitted.jointPositions.leftUpperArm!;
    const lower = fitted.jointPositions.leftLowerArm!;
    const abx = lower[0]! - upper[0]!;
    const aby = lower[1]! - upper[1]!;
    const abz = lower[2]! - upper[2]!;
    const len = Math.hypot(abx, aby, abz) || 1;
    // Build an orthonormal radial basis around the upper-arm bone.
    const dir = [abx / len, aby / len, abz / len] as const;
    const tmp = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const rx = tmp[1]! * dir[2] - tmp[2]! * dir[1];
    const ry = tmp[2]! * dir[0] - tmp[0]! * dir[2];
    const rz = tmp[0]! * dir[1] - tmp[1]! * dir[0];
    const rLen = Math.hypot(rx, ry, rz) || 1;
    const radial = [rx / rLen, ry / rLen, rz / rLen] as const;

    const ring = (radius: number) => {
      const positions: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        const t = 0.2 + (i / 12) * 0.6;
        const cx = upper[0]! + abx * t;
        const cy = upper[1]! + aby * t;
        const cz = upper[2]! + abz * t;
        const ang = (i / 12) * Math.PI * 2;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        // Rotate radial in a simple plane for a ring (good enough for radius stats).
        positions.push(
          cx + radial[0]! * radius * cos,
          cy + radial[1]! * radius * cos + radius * 0.15 * sin,
          cz + radial[2]! * radius * cos,
        );
      }
      return Float32Array.from(positions);
    };

    const height = 1.75;
    const meshThickness = 0.35;
    const shoulderX = Math.abs(upper[0]!);
    const hipY = fitted.jointPositions.hips![1]!;
    const thin = estimateMeshCapsuleRadii({
      positions: ring(0.04),
      segments,
      height,
      meshThickness,
      shoulderX,
      hipY,
      torsoHalfWidth: shoulderX,
    });
    const thick = estimateMeshCapsuleRadii({
      positions: ring(0.11),
      segments,
      height,
      meshThickness,
      shoulderX,
      hipY,
      torsoHalfWidth: shoulderX,
    });
    const upperIdx = segments.findIndex((segment) => segment.jointId === 'leftUpperArm');
    expect(upperIdx).toBeGreaterThanOrEqual(0);
    expect(thick[upperIdx]!).toBeGreaterThan(thin[upperIdx]! + 0.03);
    // Thick arm should be near the measured surface, not the old meshThickness floor (~0.16).
    expect(thick[upperIdx]!).toBeGreaterThan(0.1);
    expect(thick[upperIdx]!).toBeLessThan(0.2);
  });
});
