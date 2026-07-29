import { describe, expect, it } from 'vitest';
import {
  assertNoForbiddenInfluences,
  generateRegionConstrainedSkinWeights,
} from '../src/engine/autorig/regionConstrainedWeights';
import {
  AUTORIG_REGION_CODE,
  autoLabelBodyRegions,
} from '../src/engine/autorig/regions';
import { buildCanonicalTopologyFromBuffers } from '../src/engine/autorig/topology';
import { fitSkeletonFromMarkers, suggestAutorigMarkers } from '../src/engine/autorigMarkers';
import { CURRENT_AUTORIG_BINDER_VERSION } from '../src/engine/poseableRigNormalize';
import { normalizePoseableRigAsset } from '../src/engine/poseableRigNormalize';
import type { PoseableRigAsset } from '../src/domain/types';

function makeSeparatedHumanoid() {
  const markers = suggestAutorigMarkers({ size: [0.9, 1.75, 0.35], heightMeters: 1.75, poseHint: 'a-pose' });
  const fitted = fitSkeletonFromMarkers(markers, 'full');
  const jp = fitted.jointPositions;
  const seeds: Array<[number, number, number, number]> = [
    [...(jp.head ?? [0, 1.65, 0]), AUTORIG_REGION_CODE.head],
    [...(jp.chest ?? [0, 1.2, 0]), AUTORIG_REGION_CODE.torso],
    [...(jp.leftHand ?? [0.55, 0.95, 0]), AUTORIG_REGION_CODE.leftArm],
    [...(jp.rightHand ?? [-0.55, 0.95, 0]), AUTORIG_REGION_CODE.rightArm],
    [...(jp.leftFoot ?? [0.15, 0.05, 0.05]), AUTORIG_REGION_CODE.leftLeg],
    [...(jp.rightFoot ?? [-0.15, 0.05, 0.05]), AUTORIG_REGION_CODE.rightLeg],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  const labels: number[] = [];
  seeds.forEach((seed, index) => {
    const base = index * 3;
    const [x, y, z, code] = seed;
    positions.push(x, y, z, x + 0.02, y + 0.01, z, x - 0.02, y + 0.01, z);
    triangles.push(base, base + 1, base + 2);
    labels.push(code, code, code);
  });
  return {
    positions: Float32Array.from(positions),
    triangles: Uint32Array.from(triangles),
    labels: Uint8Array.from(labels),
    jointPositions: fitted.jointPositions,
  };
}

describe('Binder V2 region constraints', () => {
  it('never assigns opposite-limb or cross-body forbidden bones', () => {
    const fixture = makeSeparatedHumanoid();
    const topology = buildCanonicalTopologyFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
    });
    const buffers = generateRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: fixture.labels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
      meshSize: [0.9, 1.75, 0.35],
    });

    const check = assertNoForbiddenInfluences({
      indices: buffers.indices,
      weights: buffers.weights,
      jointOrder: buffers.jointOrder,
      regionLabels: fixture.labels,
    });
    expect(check.ok).toBe(true);

    // Explicit opposite-limb probes.
    const leftArmVerts = [6, 7, 8];
    for (const v of leftArmVerts) {
      const base = v * 4;
      for (let i = 0; i < 4; i += 1) {
        if (buffers.weights[base + i]! <= 1e-6) continue;
        const joint = buffers.jointOrder[buffers.indices[base + i]!]!;
        expect(joint.startsWith('right')).toBe(false);
        expect(joint.includes('Leg') || joint.includes('Foot') || joint.includes('Toe')).toBe(false);
        expect(joint === 'head' || joint === 'hips').toBe(false);
      }
    }
  });

  it('keeps weight sums at one and top-four slots', () => {
    const fixture = makeSeparatedHumanoid();
    const topology = buildCanonicalTopologyFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
    });
    const buffers = generateRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: fixture.labels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
    });
    expect(buffers.influencesPerVertex).toBe(4);
    for (let v = 0; v < fixture.labels.length; v += 1) {
      let sum = 0;
      for (let i = 0; i < 4; i += 1) {
        const w = buffers.weights[v * 4 + i]!;
        expect(w).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(w)).toBe(true);
        sum += w;
      }
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('does not fall back left-arm vertices to hips', () => {
    const fixture = makeSeparatedHumanoid();
    // Push arm vertices far from all capsules.
    fixture.positions[6 * 3] = 2.5;
    fixture.positions[6 * 3 + 1] = 0.9;
    fixture.positions[6 * 3 + 2] = 0;
    const topology = buildCanonicalTopologyFromBuffers({
      positions: fixture.positions,
      triangles: fixture.triangles,
    });
    const buffers = generateRegionConstrainedSkinWeights({
      positions: fixture.positions,
      regionLabels: fixture.labels,
      jointPositions: fixture.jointPositions,
      topology,
      heightMeters: 1.75,
    });
    const base = 6 * 4;
    const joints: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      if (buffers.weights[base + i]! <= 1e-6) continue;
      joints.push(buffers.jointOrder[buffers.indices[base + i]!]!);
    }
    expect(joints.every((j) => j !== 'hips' && !j.startsWith('right') && !j.includes('Leg'))).toBe(true);
    expect(joints.some((j) => j.startsWith('left'))).toBe(true);
  });

  it('auto-labeled topology still satisfies hard region gates', () => {
    const markers = suggestAutorigMarkers({ size: [0.9, 1.75, 0.35], heightMeters: 1.75, poseHint: 't-pose' });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    // Dense-ish box body for auto-label.
    const positions: number[] = [];
    const triangles: number[] = [];
    let v = 0;
    for (let y = 0; y <= 8; y += 1) {
      for (let x = -4; x <= 4; x += 1) {
        positions.push(x * 0.08, y * 0.2, 0);
        if (x < 4 && y < 8) {
          const i = v;
          // Will fix indices after full grid known — build as grid below.
          void i;
        }
        v += 1;
      }
    }
    const width = 9;
    const height = 9;
    for (let row = 0; row < height - 1; row += 1) {
      for (let col = 0; col < width - 1; col += 1) {
        const i = row * width + col;
        triangles.push(i, i + 1, i + width);
        triangles.push(i + 1, i + width + 1, i + width);
      }
    }
    const topology = buildCanonicalTopologyFromBuffers({
      positions: Float32Array.from(positions),
      triangles: Uint32Array.from(triangles),
    });
    const labeled = autoLabelBodyRegions({
      topology,
      jointPositions: fitted.jointPositions,
      poseHint: 't-pose',
    });
    const buffers = generateRegionConstrainedSkinWeights({
      positions: topology.positions,
      regionLabels: labeled.suggested,
      jointPositions: fitted.jointPositions,
      topology,
      heightMeters: 1.75,
      meshSize: [0.72, 1.6, 0.2],
    });
    const check = assertNoForbiddenInfluences({
      indices: buffers.indices,
      weights: buffers.weights,
      jointOrder: buffers.jointOrder,
      regionLabels: labeled.suggested,
    });
    expect(check.violations).toBe(0);
  });
});

describe('binder version migration', () => {
  it('marks older binder skins as requiring rerigging', () => {
    expect(CURRENT_AUTORIG_BINDER_VERSION).toBe(2);
    const raw = {
      version: 1,
      id: 'rig-old',
      skeletonJoints: [],
      rigGenerationVersion: 6,
      binderVersion: 1,
      skin: { influencesPerVertex: 4, skinAssetId: 'skin-1' },
    } as unknown as PoseableRigAsset;
    const normalized = normalizePoseableRigAsset(raw);
    expect(normalized?.requiresRerigging).toBe(true);
  });
});
