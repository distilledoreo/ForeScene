import { describe, expect, it } from 'vitest';
import {
  blendNeighborhoodWeights,
  detectLocalDeformationOutliers,
  formatDeformationAutoRepairMessage,
  groupOutlierPatches,
  overridesFromRepairedLabels,
  proposeDeformationRepairs,
  runHighConfidenceDeformationAutoRepair,
  scoreDeformationAnomalies,
  selectDeformationAutoRepairPoseIds,
  shouldExpandAutoRepairWithWalking,
  validateAndApplyRepairs,
} from '../src/engine/autorig/deformationAutoRepair';
import { AUTORIG_REGION_CODE } from '../src/engine/autorig/regions';
import { buildCanonicalTopologyFromBuffers } from '../src/engine/autorig/topology';
import type { SkinWeightBuffers } from '../src/engine/autorigSkinWeights';

/** Flat strip of quads: a sleeve-like chain along +X. */
function makeSleeveMesh(cols: number, rows: number) {
  const positions: number[] = [];
  const triangles: number[] = [];
  for (let y = 0; y <= rows; y += 1) {
    for (let x = 0; x <= cols; x += 1) {
      positions.push(x * 0.05, 1.2 + y * 0.04, 0);
    }
  }
  const width = cols + 1;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i0 = y * width + x;
      const i1 = i0 + 1;
      const i2 = i0 + width;
      const i3 = i2 + 1;
      triangles.push(i0, i2, i1, i1, i2, i3);
    }
  }
  return {
    positions: Float32Array.from(positions),
    triangles: Uint32Array.from(triangles),
    width,
    vertexCount: (cols + 1) * (rows + 1),
  };
}

function makeBuffers(vertexCount: number, jointOrder = ['hips', 'leftUpperArm', 'leftLowerArm'] as const): SkinWeightBuffers {
  const ipv = 4;
  const indices = new Uint16Array(vertexCount * ipv);
  const weights = new Float32Array(vertexCount * ipv);
  for (let v = 0; v < vertexCount; v += 1) {
    indices[v * ipv] = 2; // leftLowerArm
    weights[v * ipv] = 1;
  }
  return {
    influencesPerVertex: ipv,
    indices,
    weights,
    jointOrder: [...jointOrder],
  };
}

describe('deformationAutoRepair', () => {
  it('flags an isolated vertex whose edges stretch while neighbors stay calm', () => {
    const mesh = makeSleeveMesh(6, 2);
    const topology = buildCanonicalTopologyFromBuffers({
      positions: mesh.positions,
      triangles: mesh.triangles,
    });
    const labels = new Uint8Array(mesh.vertexCount).fill(AUTORIG_REGION_CODE.leftArm);
    // One torso island in the middle of the sleeve.
    const spike = Math.floor(mesh.width * 1 + 3);
    labels[spike] = AUTORIG_REGION_CODE.torso;

    const posed = new Float32Array(mesh.positions);
    // Bend the sleeve in +Y except the spike (stays put) → long needles.
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      if (v === spike) continue;
      posed[v * 3 + 1]! += 0.35;
    }

    const outliers = detectLocalDeformationOutliers({
      restPositions: mesh.positions,
      topology,
      regionLabels: labels,
      buffers: makeBuffers(mesh.vertexCount),
      frames: [{ poseId: 'elbows-bent', positions: posed }],
    });

    expect(outliers.some((o) => o.vertexIndex === spike)).toBe(true);
    const spikeOutlier = outliers.find((o) => o.vertexIndex === spike)!;
    expect(spikeOutlier.maxEdgeStretch).toBeGreaterThan(3);
    expect(spikeOutlier.regionDisagreement).toBeGreaterThan(0.5);

    const patches = groupOutlierPatches(outliers, topology);
    const spikePatch = patches.find((p) => p.vertexIndices.includes(spike));
    expect(spikePatch?.kind).toBe('spike');
    expect(spikePatch?.confidence).toBe('automatic');
  });

  it('proposes region majority repair for a tiny torso island in a sleeve', () => {
    const mesh = makeSleeveMesh(8, 2);
    const topology = buildCanonicalTopologyFromBuffers({
      positions: mesh.positions,
      triangles: mesh.triangles,
    });
    const labels = new Uint8Array(mesh.vertexCount).fill(AUTORIG_REGION_CODE.leftArm);
    const island = [
      Math.floor(mesh.width * 1 + 3),
      Math.floor(mesh.width * 1 + 4),
    ];
    for (const v of island) labels[v] = AUTORIG_REGION_CODE.torso;

    const posed = new Float32Array(mesh.positions);
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      if (island.includes(v)) continue;
      posed[v * 3]! += 0.02;
      posed[v * 3 + 1]! += 0.4;
    }

    const buffers = makeBuffers(mesh.vertexCount);
    const outliers = detectLocalDeformationOutliers({
      restPositions: mesh.positions,
      topology,
      regionLabels: labels,
      buffers,
      frames: [{ poseId: 'elbows-bent', positions: posed }],
    });
    const patches = groupOutlierPatches(outliers, topology);
    const proposals = proposeDeformationRepairs({
      patches,
      outliers,
      topology,
      positions: mesh.positions,
      regionLabels: labels,
      buffers,
      jointPositions: {
        leftUpperArm: [0.15, 1.35, 0],
        leftLowerArm: [0.35, 1.15, 0],
        leftHand: [0.45, 1.0, 0],
        hips: [0, 0.9, 0],
        spine: [0, 1.1, 0],
        chest: [0, 1.25, 0],
      },
    });

    const regionFix = proposals.find(
      (p) => p.kind === 'region' && p.confidence === 'automatic' && p.newRegionCode === AUTORIG_REGION_CODE.leftArm,
    );
    expect(regionFix).toBeTruthy();
    expect(regionFix!.patch.vertexIndices.length).toBeLessThanOrEqual(5);
  });

  it('proposes neighborhood weight blend when region matches but influences disagree', () => {
    const mesh = makeSleeveMesh(5, 1);
    const topology = buildCanonicalTopologyFromBuffers({
      positions: mesh.positions,
      triangles: mesh.triangles,
    });
    const labels = new Uint8Array(mesh.vertexCount).fill(AUTORIG_REGION_CODE.leftArm);
    const buffers = makeBuffers(mesh.vertexCount);
    const spike = Math.floor(mesh.width * 0 + 2);
    // Everyone follows lower arm; spike stuck on upper arm / hips.
    const ipv = buffers.influencesPerVertex;
    buffers.indices[spike * ipv] = 1; // leftUpperArm
    buffers.weights[spike * ipv] = 1;
    buffers.indices[spike * ipv + 1] = 0;
    buffers.weights[spike * ipv + 1] = 0;

    const posed = new Float32Array(mesh.positions);
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      if (v === spike) continue;
      posed[v * 3 + 1]! += 0.45;
    }

    const outliers = detectLocalDeformationOutliers({
      restPositions: mesh.positions,
      topology,
      regionLabels: labels,
      buffers,
      frames: [{ poseId: 'elbows-bent', positions: posed }],
    });
    const patches = groupOutlierPatches(outliers, topology);
    const proposals = proposeDeformationRepairs({
      patches,
      outliers,
      topology,
      positions: mesh.positions,
      regionLabels: labels,
      buffers,
    });

    const weightFix = proposals.find((p) => p.kind === 'weights' && p.weightPatch);
    expect(weightFix).toBeTruthy();
    expect(weightFix!.confidence).toBe('automatic');

    const blended = blendNeighborhoodWeights({
      vertexIndices: [spike],
      topology,
      positions: mesh.positions,
      regionLabels: labels,
      buffers,
    });
    // Blended weights should pull toward leftLowerArm (joint index 2).
    expect(blended.indices[0]).toBe(2);
    expect(blended.weights[0]!).toBeGreaterThan(0.5);
  });

  it('keeps repairs only when anomaly score improves and rejects regressions', () => {
    const mesh = makeSleeveMesh(4, 1);
    const topology = buildCanonicalTopologyFromBuffers({
      positions: mesh.positions,
      triangles: mesh.triangles,
    });
    const labels = new Uint8Array(mesh.vertexCount).fill(AUTORIG_REGION_CODE.leftArm);
    const spike = 2;
    labels[spike] = AUTORIG_REGION_CODE.torso;
    const buffers = makeBuffers(mesh.vertexCount);

    const posed = new Float32Array(mesh.positions);
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      if (v === spike) continue;
      posed[v * 3 + 1]! += 0.4;
    }

    const outliers = detectLocalDeformationOutliers({
      restPositions: mesh.positions,
      topology,
      regionLabels: labels,
      buffers,
      frames: [{ poseId: 'elbows-bent', positions: posed }],
    });
    const patches = groupOutlierPatches(outliers, topology);
    const proposals = proposeDeformationRepairs({
      patches,
      outliers,
      topology,
      positions: mesh.positions,
      regionLabels: labels,
      buffers,
      jointPositions: {
        leftUpperArm: [0.1, 1.3, 0],
        leftLowerArm: [0.25, 1.1, 0],
        hips: [0, 0.9, 0],
        spine: [0, 1.1, 0],
      },
    });

    const baseline = scoreDeformationAnomalies({
      restPositions: mesh.positions,
      topology,
      regionLabels: labels,
      buffers,
      frames: [{ poseId: 'elbows-bent', positions: posed }],
    });

    const good = validateAndApplyRepairs({
      proposals,
      regionLabels: labels,
      buffers,
      scoreCurrent: baseline.total,
      evaluateCandidate: ({ regionLabels: nextLabels }) => {
        // Simulate successful fix: spike moves with neighbors.
        const fixedPose = new Float32Array(posed);
        if (nextLabels[spike] === AUTORIG_REGION_CODE.leftArm) {
          fixedPose[spike * 3 + 1] = mesh.positions[spike * 3 + 1]! + 0.4;
        }
        const next = scoreDeformationAnomalies({
          restPositions: mesh.positions,
          topology,
          regionLabels: nextLabels,
          buffers,
          frames: [{ poseId: 'elbows-bent', positions: fixedPose }],
        });
        return { score: next.total, neutralMaxDrift: 0 };
      },
    });
    expect(good.applied.length).toBeGreaterThan(0);
    expect(good.regionLabels[spike]).toBe(AUTORIG_REGION_CODE.leftArm);

    const bad = validateAndApplyRepairs({
      proposals,
      regionLabels: labels,
      buffers,
      scoreCurrent: baseline.total,
      evaluateCandidate: () => ({ score: baseline.total + 5, neutralMaxDrift: 0 }),
    });
    expect(bad.applied.length).toBe(0);
    expect(bad.rejected.length).toBeGreaterThan(0);
    expect(bad.regionLabels[spike]).toBe(AUTORIG_REGION_CODE.torso);
  });

  it('runHighConfidenceDeformationAutoRepair relabels and retests', () => {
    const mesh = makeSleeveMesh(6, 1);
    const topology = buildCanonicalTopologyFromBuffers({
      positions: mesh.positions,
      triangles: mesh.triangles,
    });
    const labels = new Uint8Array(mesh.vertexCount).fill(AUTORIG_REGION_CODE.leftArm);
    const spike = 3;
    labels[spike] = AUTORIG_REGION_CODE.torso;
    const buffers = makeBuffers(mesh.vertexCount);

    const makePosed = (regionLabels: Uint8Array) => {
      const posed = new Float32Array(mesh.positions);
      for (let v = 0; v < mesh.vertexCount; v += 1) {
        if (regionLabels[v] === AUTORIG_REGION_CODE.torso) continue;
        posed[v * 3 + 1]! += 0.4;
      }
      return posed;
    };

    const result = runHighConfidenceDeformationAutoRepair({
      restPositions: mesh.positions,
      topology,
      regionLabels: labels,
      buffers,
      frames: [{ poseId: 'elbows-bent', positions: makePosed(labels) }],
      jointPositions: {
        leftUpperArm: [0.1, 1.3, 0],
        leftLowerArm: [0.3, 1.1, 0],
        leftHand: [0.4, 0.95, 0],
        hips: [0, 0.9, 0],
        spine: [0, 1.1, 0],
        chest: [0, 1.25, 0],
      },
      regenerateWeights: (nextLabels) => {
        // Keep weights; region change alone is enough for this synthetic case.
        void nextLabels;
        return {
          influencesPerVertex: buffers.influencesPerVertex,
          indices: new Uint16Array(buffers.indices),
          weights: new Float32Array(buffers.weights),
          jointOrder: buffers.jointOrder.slice(),
        };
      },
      evaluatePoseFrames: (nextBuffers) => {
        void nextBuffers;
        // evaluatePoseFrames receives buffers after repair; labels are applied
        // inside runHighConfidence — use a closure-updated pose via buffers identity.
        return {
          frames: [{ poseId: 'elbows-bent', positions: makePosed(
            // The runner updates labels before calling evaluate; we need the
            // repaired labels. Approximate: if weights unchanged, check via
            // re-detecting isn't possible here — return improved pose assuming
            // spike was fixed when regenerateWeights was called.
            (() => {
              const fixed = new Uint8Array(labels);
              fixed[spike] = AUTORIG_REGION_CODE.leftArm;
              return fixed;
            })(),
          ) }],
          neutralMaxDrift: 0,
        };
      },
    });

    expect(result.repairedVertexCount).toBeGreaterThan(0);
    expect(result.regionLabels[spike]).toBe(AUTORIG_REGION_CODE.leftArm);
  });

  it('does not auto-cross left/right anatomy', () => {
    const mesh = makeSleeveMesh(4, 1);
    const topology = buildCanonicalTopologyFromBuffers({
      positions: mesh.positions,
      triangles: mesh.triangles,
    });
    const labels = new Uint8Array(mesh.vertexCount).fill(AUTORIG_REGION_CODE.leftArm);
    const spike = 1;
    labels[spike] = AUTORIG_REGION_CODE.rightArm;

    const posed = new Float32Array(mesh.positions);
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      if (v === spike) continue;
      posed[v * 3 + 1]! += 0.4;
    }

    const buffers = makeBuffers(mesh.vertexCount);
    const outliers = detectLocalDeformationOutliers({
      restPositions: mesh.positions,
      topology,
      regionLabels: labels,
      buffers,
      frames: [{ poseId: 'elbows-bent', positions: posed }],
    });
    const patches = groupOutlierPatches(outliers, topology);
    const proposals = proposeDeformationRepairs({
      patches,
      outliers,
      topology,
      positions: mesh.positions,
      regionLabels: labels,
      buffers,
    });

    const autoCross = proposals.find(
      (p) => p.confidence === 'automatic'
        && p.kind === 'region'
        && p.newRegionCode === AUTORIG_REGION_CODE.leftArm
        && p.patch.vertexIndices.includes(spike),
    );
    expect(autoCross).toBeFalsy();
  });

  it('formats the prepare notice and builds overrides only for changed labels', () => {
    expect(formatDeformationAutoRepairMessage({
      repairedVertexCount: 18,
      applied: [{ } as never],
    })).toBe('Rig prepared — 18 deformation spikes corrected automatically.');
    expect(formatDeformationAutoRepairMessage({
      repairedVertexCount: 1,
      applied: [{ } as never],
    })).toBe('Rig prepared — 1 deformation spike corrected automatically.');
    expect(formatDeformationAutoRepairMessage({
      repairedVertexCount: 0,
      applied: [],
    })).toBeNull();

    const suggested = Uint8Array.from([
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.torso,
    ]);
    const repaired = Uint8Array.from([
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
    ]);
    const overrides = overridesFromRepairedLabels({
      suggested,
      previousOverrides: null,
      repairedLabels: repaired,
    });
    expect(overrides[0]).toBe(0);
    expect(overrides[1]).toBe(AUTORIG_REGION_CODE.torso);
    expect(overrides[2]).toBe(0);
  });

  it('selects elbows-bent + sitting always, arms-raised for smaller meshes, walking on demand', () => {
    expect(selectDeformationAutoRepairPoseIds({ vertexCount: 10_000 })).toEqual([
      'elbows-bent',
      'sitting',
      'arms-raised',
    ]);
    expect(selectDeformationAutoRepairPoseIds({ vertexCount: 90_000 })).toEqual([
      'elbows-bent',
      'sitting',
    ]);
    expect(selectDeformationAutoRepairPoseIds({
      vertexCount: 10_000,
      includeWalking: true,
    })).toEqual([
      'elbows-bent',
      'sitting',
      'arms-raised',
      'walking',
    ]);
    expect(selectDeformationAutoRepairPoseIds({
      vertexCount: 90_000,
      includeWalking: true,
    })).toEqual([
      'elbows-bent',
      'sitting',
      'walking',
    ]);
  });

  it('expands with walking when outliers land on leg regions', () => {
    const labels = Uint8Array.from([
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftLeg,
      AUTORIG_REGION_CODE.torso,
    ]);
    expect(shouldExpandAutoRepairWithWalking({
      regionLabels: labels,
      outliers: [{ vertexIndex: 0 }],
    })).toBe(false);
    expect(shouldExpandAutoRepairWithWalking({
      regionLabels: labels,
      outliers: [{ vertexIndex: 1 }],
    })).toBe(true);
  });
});
