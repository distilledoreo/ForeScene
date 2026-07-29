import { describe, expect, it } from 'vitest';
import {
  applyLassoRegionCorrection,
  applyRegionLassoOverride,
  expandRegionCorrection,
  pointInPolygon,
  selectTrianglesInLassoCpu,
  simplifyLassoPolygon,
  trianglesToSeedVertices,
} from '../src/engine/autorig/regionSelection';
import {
  AUTORIG_REGION_CODE,
  applyRegionEditDelta,
  createRegionEditDelta,
  resolveRegionLabels,
} from '../src/engine/autorig/regions';
import { buildCanonicalTopologyFromBuffers } from '../src/engine/autorig/topology';
import {
  AUTORIG_REGION_COLORS,
  fillRegionColorAttribute,
  regionColorCss,
} from '../src/engine/autorig/regionOverlay';
import {
  clearAutorigWizardDraftSyncForTests,
  decodeRegionDraftBytes,
  encodeRegionDraftBytes,
  loadAutorigWizardDraftSyncForTests,
  saveAutorigWizardDraftSyncForTests,
} from '../src/engine/autorig/regionDraftStore';
import { computeAutorigOrthoFrame, worldToCanvas } from '../src/engine/autorigMarkerFrame';

describe('lasso polygon helpers', () => {
  it('simplifies and closes a noisy path', () => {
    const simplified = simplifyLassoPolygon([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.2 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ], 2);
    expect(simplified.length).toBeGreaterThanOrEqual(4);
    expect(pointInPolygon(5, 5, simplified)).toBe(true);
    expect(pointInPolygon(20, 20, simplified)).toBe(false);
  });
});

describe('region lasso correction', () => {
  it('overrides visible seeds and expands across a matching connected arm', () => {
    // Shared-edge torso/arm quads in canvas-scale coordinates so simplifyLassoPolygon
    // (pixel min-distance) does not collapse the polygon.
    const sharedPositions = Float32Array.from([
      20, 100, 0, // 0 torso
      40, 100, 0, // 1 shared
      40, 120, 0, // 2 shared
      20, 120, 0, // 3 torso
      70, 100, 0, // 4 arm
      70, 120, 0, // 5 arm
    ]);
    const triangles = Uint32Array.from([
      0, 1, 2,
      0, 2, 3,
      1, 4, 5,
      1, 5, 2,
    ]);
    const topology = buildCanonicalTopologyFromBuffers({
      positions: sharedPositions,
      triangles,
    });
    const suggested = new Uint8Array([
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso, // mislabeled arm — user corrects
      AUTORIG_REGION_CODE.torso,
    ]);
    const overrides = new Uint8Array(suggested.length);
    const resolved = resolveRegionLabels({ suggested, overrides });
    const projectWorld = (v: number) => ({
      x: sharedPositions[v * 3]!,
      y: sharedPositions[v * 3 + 1]!,
    });
    const armPolygon = [
      { x: 45, y: 95 },
      { x: 80, y: 95 },
      { x: 80, y: 125 },
      { x: 45, y: 125 },
    ];

    const triangleHits = selectTrianglesInLassoCpu({
      topology,
      projectVertex: projectWorld,
      polygon: armPolygon,
    });
    expect(triangleHits.length).toBeGreaterThan(0);

    const result = applyLassoRegionCorrection({
      topology,
      suggested,
      overrides,
      resolved,
      region: 'leftArm',
      polygon: armPolygon,
      projectVertex: projectWorld,
    });
    expect(result.affectedVertices.length).toBeGreaterThan(0);
    const nextResolved = resolveRegionLabels({
      suggested,
      overrides: result.overrides,
    });
    expect(nextResolved[4]).toBe(AUTORIG_REGION_CODE.leftArm);
    expect(nextResolved[5]).toBe(AUTORIG_REGION_CODE.leftArm);
    // Far torso vertex stays torso.
    expect(nextResolved[0]).toBe(AUTORIG_REGION_CODE.torso);
  });

  it('stores compact undo deltas for override edits', () => {
    const before = new Uint8Array([0, 0, 0, 0]);
    const after = applyRegionLassoOverride({
      overrides: before,
      vertexIndices: [1, 2],
      region: 'head',
    });
    const delta = createRegionEditDelta(before, after);
    expect(delta).not.toBeNull();
    expect(delta!.vertexIndices.length).toBe(2);
    const undone = applyRegionEditDelta(new Uint8Array(after), delta!, 'undo');
    expect(Array.from(undone)).toEqual([0, 0, 0, 0]);
    const redone = applyRegionEditDelta(new Uint8Array(undone), delta!, 'redo');
    expect(redone[1]).toBe(AUTORIG_REGION_CODE.head);
  });

  it('expands only within the same connected component and region', () => {
    const positions = Float32Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      5, 0, 0, 6, 0, 0, 5, 1, 0,
    ]);
    const triangles = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    const topology = buildCanonicalTopologyFromBuffers({ positions, triangles });
    const resolved = new Uint8Array([
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.rightArm,
      AUTORIG_REGION_CODE.rightArm,
      AUTORIG_REGION_CODE.rightArm,
    ]);
    const expanded = expandRegionCorrection({
      topology,
      resolved,
      seedVertices: [0],
      region: 'leftArm',
    });
    expect(Array.from(expanded).sort()).toEqual([0, 1, 2]);
  });

  it('trianglesToSeedVertices deduplicates shared corners', () => {
    const topology = buildCanonicalTopologyFromBuffers({
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      triangles: Uint32Array.from([0, 1, 2, 1, 3, 2]),
    });
    const seeds = trianglesToSeedVertices(topology, [0, 1]);
    expect(Array.from(seeds).sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('region overlay colors', () => {
  it('fills RGB attributes for all six regions', () => {
    const labels = Uint8Array.from([
      AUTORIG_REGION_CODE.head,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.rightArm,
      AUTORIG_REGION_CODE.leftLeg,
      AUTORIG_REGION_CODE.rightLeg,
    ]);
    const colors = fillRegionColorAttribute({ labels });
    expect(colors.length).toBe(18);
    expect(colors[0]).toBeCloseTo(AUTORIG_REGION_COLORS.head[0]);
    expect(regionColorCss('leftArm')).toMatch(/^rgb\(/);
  });

  it('tints low-confidence vertices toward pale uncertain color', () => {
    const labels = Uint8Array.from([AUTORIG_REGION_CODE.torso]);
    const confidence = Float32Array.from([0.05]);
    const colors = fillRegionColorAttribute({ labels, confidence, uncertainThreshold: 0.22 });
    const solid = fillRegionColorAttribute({ labels });
    // Uncertain mix should differ from solid torso color.
    expect(colors[0]).not.toBeCloseTo(solid[0]!, 3);
  });
});

describe('region draft encoding', () => {
  it('round-trips label bytes and migrates legacy regions step to pose-fix', () => {
    const labels = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const b64 = encodeRegionDraftBytes(labels);
    expect(Array.from(decodeRegionDraftBytes(b64)!)).toEqual([1, 2, 3, 4, 5, 6]);
    clearAutorigWizardDraftSyncForTests();
    saveAutorigWizardDraftSyncForTests({
      rigId: 'rig-1',
      step: 'regions',
      markersJson: '[]',
      suggestedB64: b64,
      overridesB64: b64,
      updatedAt: 1,
    });
    const loaded = loadAutorigWizardDraftSyncForTests('rig-1');
    expect(loaded?.step).toBe('pose-fix');
    expect(loaded?.version).toBe(2);
    clearAutorigWizardDraftSyncForTests('rig-1');
    expect(loadAutorigWizardDraftSyncForTests('rig-1')).toBeNull();
  });
});

describe('back orthographic view', () => {
  it('maps character left (+X) consistently for front vs back canvas X', () => {
    const bounds = { min: [-0.4, 0, -0.2] as [number, number, number], max: [0.4, 1.8, 0.2] as [number, number, number] };
    const front = computeAutorigOrthoFrame({
      bounds,
      view: 'front',
      canvasWidth: 200,
      canvasHeight: 200,
    });
    const back = computeAutorigOrthoFrame({
      bounds,
      view: 'back',
      canvasWidth: 200,
      canvasHeight: 200,
    });
    const leftShoulder: [number, number, number] = [0.3, 1.4, 0];
    const frontPt = worldToCanvas(leftShoulder, front);
    const backPt = worldToCanvas(leftShoulder, back);
    // Front: +X → right side of canvas. Back uses −X mapping so +X → left side.
    expect(frontPt.x).toBeGreaterThan(100);
    expect(backPt.x).toBeLessThan(100);
  });
});
