import { describe, expect, it } from 'vitest';
import {
  buildTriangleAdjacency,
  smartGrowRegionPatch,
} from '../src/engine/autorig/smartRegionGrow';
import {
  applyBrushRegionCorrection,
} from '../src/engine/autorig/regionSelection';
import {
  AUTORIG_REGION_CODE,
  resolveRegionLabels,
} from '../src/engine/autorig/regions';
import { buildCanonicalTopologyFromBuffers } from '../src/engine/autorig/topology';
import { formatAutorigCorrectionMessage } from '../src/components/autorig/AutorigCorrectionFeedback';

function makeSleeveStrip() {
  // A strip of quads: verts 0-3 are "torso" (wrong), 4-9 are a sleeve wrongly labeled torso.
  // Layout along +X so leftArm skeleton proximity can guide growth.
  const positions = Float32Array.from([
    // torso block
    0.00, 1.20, 0,
    0.10, 1.20, 0,
    0.10, 1.30, 0,
    0.00, 1.30, 0,
    // sleeve mid
    0.20, 1.20, 0,
    0.30, 1.20, 0,
    0.30, 1.30, 0,
    0.20, 1.30, 0,
    // sleeve tip
    0.40, 1.20, 0,
    0.50, 1.20, 0,
    0.50, 1.30, 0,
    0.40, 1.30, 0,
  ]);
  const triangles = Uint32Array.from([
    0, 1, 2, 0, 2, 3,
    1, 4, 7, 1, 7, 2,
    4, 5, 6, 4, 6, 7,
    5, 8, 11, 5, 11, 6,
    8, 9, 10, 8, 10, 11,
  ]);
  const topology = buildCanonicalTopologyFromBuffers({ positions, triangles });
  // Entire strip mislabeled as torso — Smart Paint should grow leftArm across it.
  const suggested = new Uint8Array(12).fill(AUTORIG_REGION_CODE.torso);
  return { topology, suggested, positions };
}

describe('triangle adjacency', () => {
  it('links triangles that share an edge', () => {
    const topology = buildCanonicalTopologyFromBuffers({
      positions: Float32Array.from([
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      ]),
      triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    });
    const adj = buildTriangleAdjacency(topology);
    expect(adj.triangleOffsets[1]! - adj.triangleOffsets[0]!).toBe(1);
    expect(adj.adjacentTriangles[adj.triangleOffsets[0]!]).toBe(1);
  });
});

describe('Smart Paint growth', () => {
  it('expands beyond the brushed seeds across wrongly labeled geometry', () => {
    const { topology, suggested, positions } = makeSleeveStrip();
    const overrides = new Uint8Array(suggested.length);
    const resolved = resolveRegionLabels({ suggested, overrides });

    // Seed only the sleeve tip (verts 8-11 / last quads).
    const seedTriangles = Uint32Array.from([8, 9]);
    const grown = smartGrowRegionPatch({
      topology,
      positions,
      resolvedLabels: resolved,
      seedTriangles,
      seedVertices: Uint32Array.from([8, 9, 10, 11]),
      targetRegion: 'leftArm',
      jointPositions: {
        leftUpperArm: [0.2, 1.25, 0],
        leftLowerArm: [0.35, 1.25, 0],
        leftHand: [0.5, 1.25, 0],
        hips: [0, 0.9, 0],
        chest: [0, 1.25, 0],
      },
      reach: 'normal',
    });

    expect(grown.expandedVertices.length).toBeGreaterThan(grown.seedVertexCount);
    // Should reach mid-sleeve vertices.
    expect(Array.from(grown.expandedVertices)).toEqual(
      expect.arrayContaining([4, 5, 6, 7, 8, 9, 10, 11]),
    );
  });

  it('selects an entire small disconnected component', () => {
    // Large body component + tiny shoe component.
    const body: number[] = [];
    const bodyTris: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const x = (i % 3) * 0.1;
      const y = Math.floor(i / 3) * 0.1;
      body.push(x, y, 0);
    }
    bodyTris.push(0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4);
    const shoe = [5, 0, 0, 5.1, 0, 0, 5, 0.1, 0];
    const positions = Float32Array.from([...body, ...shoe]);
    const triangles = Uint32Array.from([...bodyTris, 6, 7, 8]);
    const topology = buildCanonicalTopologyFromBuffers({ positions, triangles });
    const resolved = new Uint8Array(9).fill(AUTORIG_REGION_CODE.torso);
    const grown = smartGrowRegionPatch({
      topology,
      resolvedLabels: resolved,
      seedTriangles: Uint32Array.from([4]),
      seedVertices: Uint32Array.from([6]),
      targetRegion: 'leftLeg',
      reach: 'normal',
    });
    expect(grown.selectedWholeComponent).toBe(true);
    expect(Array.from(grown.expandedVertices).sort()).toEqual([6, 7, 8]);
  });

  it('rejects growing into the opposite limb', () => {
    const positions = Float32Array.from([
      // left strip
      0.4, 1.2, 0, 0.5, 1.2, 0, 0.5, 1.3, 0, 0.4, 1.3, 0,
      // right strip sharing nothing but close in index space after a bridge
      -0.4, 1.2, 0, -0.5, 1.2, 0, -0.5, 1.3, 0, -0.4, 1.3, 0,
      // bridge verts near torso midline connecting left to right geometrically
      0.05, 1.25, 0, -0.05, 1.25, 0, 0.0, 1.35, 0,
    ]);
    // Separate components intentionally — opposite rejection is mainly label/skeleton based
    // within a connected mesh. Build one connected chain left→mid→right.
    const triangles = Uint32Array.from([
      0, 1, 2, 0, 2, 3,
      0, 8, 10, 0, 10, 3,
      8, 9, 10,
      9, 4, 7, 9, 7, 10,
      4, 5, 6, 4, 6, 7,
    ]);
    const topology = buildCanonicalTopologyFromBuffers({ positions, triangles });
    const resolved = new Uint8Array([
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.rightArm,
      AUTORIG_REGION_CODE.rightArm,
      AUTORIG_REGION_CODE.rightArm,
      AUTORIG_REGION_CODE.rightArm,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
    ]);
    const grown = smartGrowRegionPatch({
      topology,
      positions,
      resolvedLabels: resolved,
      seedTriangles: Uint32Array.from([0, 1]),
      seedVertices: Uint32Array.from([0, 1, 2, 3]),
      targetRegion: 'leftArm',
      jointPositions: {
        leftUpperArm: [0.45, 1.25, 0],
        leftHand: [0.55, 1.25, 0],
        rightUpperArm: [-0.45, 1.25, 0],
        rightHand: [-0.55, 1.25, 0],
        chest: [0, 1.3, 0],
      },
      reach: 'broad',
    });
    const expanded = new Set(Array.from(grown.expandedVertices));
    // Must not claim the opposite arm verts.
    expect(expanded.has(4)).toBe(false);
    expect(expanded.has(5)).toBe(false);
    expect(expanded.has(6)).toBe(false);
    expect(expanded.has(7)).toBe(false);
  });
});

describe('brush correction uses Smart Paint', () => {
  it('one stroke across a mislabeled tip corrects a larger sleeve patch', () => {
    const { topology, suggested } = makeSleeveStrip();
    const overrides = new Uint8Array(suggested.length);
    const resolved = resolveRegionLabels({ suggested, overrides });
    const result = applyBrushRegionCorrection({
      topology,
      suggested,
      overrides,
      resolved,
      region: 'leftArm',
      stroke: [{ x: 0.45, y: 1.25, radius: 0.08 }],
      projectVertex: (v) => ({
        x: topology.positions[v * 3]!,
        y: topology.positions[v * 3 + 1]!,
      }),
      // Force the tip triangles as visible picks.
      visibleTriangleIds: Uint32Array.from([8, 9]),
      jointPositions: {
        leftUpperArm: [0.2, 1.25, 0],
        leftLowerArm: [0.35, 1.25, 0],
        leftHand: [0.5, 1.25, 0],
      },
      reach: 'normal',
    });
    expect(result.result.status).toBe('changed');
    if (result.result.status === 'changed') {
      expect(result.result.affectedVertexCount).toBeGreaterThan(result.seedVertices.length);
      expect(['local', 'expanded', 'component']).toContain(result.result.selectionKind);
      expect(formatAutorigCorrectionMessage(result.result)).toMatch(/Left arm|surface|vertices/i);
    }
    const next = resolveRegionLabels({ suggested, overrides: result.overrides });
    expect(next[8]).toBe(AUTORIG_REGION_CODE.leftArm);
    expect(next[5]).toBe(AUTORIG_REGION_CODE.leftArm);
  });
});
