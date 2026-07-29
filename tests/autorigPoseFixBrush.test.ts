import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyBrushRegionCorrection,
  brushStrokeBoundingRect,
  classifyRegionCorrection,
  clearRegionOverridesAt,
  pointHitsBrushStroke,
  selectTrianglesInBrushCpu,
  simplifyBrushStroke,
  trianglesToSeedVertices,
} from '../src/engine/autorig/regionSelection';
import {
  AUTORIG_REGION_CODE,
  resolveRegionLabels,
} from '../src/engine/autorig/regions';
import { buildCanonicalTopologyFromBuffers } from '../src/engine/autorig/topology';
import {
  migrateAutorigWizardStep,
  normalizeAutorigWizardDraft,
} from '../src/engine/autorig/regionDraftStore';
import { formatAutorigCorrectionMessage } from '../src/components/autorig/AutorigCorrectionFeedback';
import { collectPreviewMeshBindings } from '../src/components/autorig/hooks/useAutorigPreviewSession';
import * as THREE from 'three';

function makeArmTorsoTopology() {
  const sharedPositions = Float32Array.from([
    20, 100, 0,
    40, 100, 0,
    40, 120, 0,
    20, 120, 0,
    70, 100, 0,
    70, 120, 0,
  ]);
  const triangles = Uint32Array.from([
    0, 1, 2,
    0, 2, 3,
    1, 4, 5,
    1, 5, 2,
  ]);
  return buildCanonicalTopologyFromBuffers({
    positions: sharedPositions,
    triangles,
  });
}

describe('brush stroke helpers', () => {
  it('simplifies and interpolates sparse gaps', () => {
    const simplified = simplifyBrushStroke([
      { x: 0, y: 0, radius: 10 },
      { x: 40, y: 0, radius: 10 },
    ], 2);
    expect(simplified.length).toBeGreaterThan(2);
    expect(pointHitsBrushStroke(20, 0, simplified)).toBe(true);
    expect(pointHitsBrushStroke(20, 30, simplified)).toBe(false);
  });

  it('expands bounds by brush radius', () => {
    const bounds = brushStrokeBoundingRect([
      { x: 50, y: 50, radius: 12 },
      { x: 80, y: 50, radius: 8 },
    ]);
    expect(bounds).toEqual({ minX: 38, minY: 38, maxX: 88, maxY: 62 });
  });
});

describe('brush region correction', () => {
  it('selects triangles under a circular brush and paints left arm', () => {
    const topology = makeArmTorsoTopology();
    const suggested = new Uint8Array([
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.torso,
    ]);
    const overrides = new Uint8Array(suggested.length);
    const resolved = resolveRegionLabels({ suggested, overrides });
    const projectWorld = (v: number) => ({
      x: topology.positions[v * 3]!,
      y: topology.positions[v * 3 + 1]!,
    });

    const stroke = [{ x: 70, y: 110, radius: 18 }];
    const triangleHits = selectTrianglesInBrushCpu({
      topology,
      projectVertex: projectWorld,
      stroke,
    });
    expect(triangleHits.length).toBeGreaterThan(0);

    const result = applyBrushRegionCorrection({
      topology,
      suggested,
      overrides,
      resolved,
      region: 'leftArm',
      stroke,
      projectVertex: projectWorld,
    });
    expect(result.result.status).toBe('changed');
    if (result.result.status === 'changed') {
      expect(result.result.affectedVertexCount).toBeGreaterThan(0);
      expect(result.result.newRegion).toBe('leftArm');
    }
    const nextResolved = resolveRegionLabels({
      suggested,
      overrides: result.overrides,
    });
    expect(nextResolved[4]).toBe(AUTORIG_REGION_CODE.leftArm);
    expect(nextResolved[5]).toBe(AUTORIG_REGION_CODE.leftArm);
  });

  it('returns empty for a stroke that misses the mesh', () => {
    const topology = makeArmTorsoTopology();
    const suggested = new Uint8Array(6).fill(AUTORIG_REGION_CODE.torso);
    const overrides = new Uint8Array(6);
    const result = applyBrushRegionCorrection({
      topology,
      suggested,
      overrides,
      resolved: suggested,
      region: 'leftArm',
      stroke: [{ x: 400, y: 400, radius: 8 }],
      projectVertex: (v) => ({
        x: topology.positions[v * 3]!,
        y: topology.positions[v * 3 + 1]!,
      }),
    });
    expect(result.result.status).toBe('empty');
    expect(formatAutorigCorrectionMessage(result.result)).toMatch(/No character surface/);
  });

  it('returns unchanged when painting an area that already matches', () => {
    // Isolated arm-only triangle — grow has nowhere else to claim.
    const topology = buildCanonicalTopologyFromBuffers({
      positions: Float32Array.from([
        70, 100, 0,
        80, 100, 0,
        75, 110, 0,
      ]),
      triangles: Uint32Array.from([0, 1, 2]),
    });
    const suggested = new Uint8Array([
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
    ]);
    const overrides = new Uint8Array([
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
    ]);
    const resolved = resolveRegionLabels({ suggested, overrides });
    const result = applyBrushRegionCorrection({
      topology,
      suggested,
      overrides,
      resolved,
      region: 'leftArm',
      stroke: [{ x: 75, y: 105, radius: 18 }],
      projectVertex: (v) => ({
        x: topology.positions[v * 3]!,
        y: topology.positions[v * 3 + 1]!,
      }),
    });
    expect(result.result.status).toBe('unchanged');
    expect(formatAutorigCorrectionMessage(result.result)).toMatch(/already belongs/);
  });

  it('Restore Automatic clears hard overrides on painted vertices', () => {
    const topology = makeArmTorsoTopology();
    const suggested = new Uint8Array(6).fill(AUTORIG_REGION_CODE.torso);
    const overrides = new Uint8Array([
      0, 0, 0, 0,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.leftArm,
    ]);
    const resolved = resolveRegionLabels({ suggested, overrides });
    const result = applyBrushRegionCorrection({
      topology,
      suggested,
      overrides,
      resolved,
      region: 'leftArm',
      stroke: [{ x: 70, y: 110, radius: 18 }],
      projectVertex: (v) => ({
        x: topology.positions[v * 3]!,
        y: topology.positions[v * 3 + 1]!,
      }),
      restoreAutomatic: true,
    });
    expect(result.result.status).toBe('changed');
    expect(result.overrides[4]).toBe(AUTORIG_REGION_CODE.unknown);
    expect(result.overrides[5]).toBe(AUTORIG_REGION_CODE.unknown);
    const cleared = clearRegionOverridesAt({
      overrides,
      vertexIndices: [4, 5],
    });
    expect(Array.from(cleared.slice(4, 6))).toEqual([0, 0]);
  });
});

describe('correction classification + draft migration', () => {
  it('classifies empty / unchanged / changed outcomes', () => {
    expect(classifyRegionCorrection({
      previousOverrides: new Uint8Array([0]),
      nextOverrides: new Uint8Array([0]),
      previousResolved: new Uint8Array([2]),
      nextResolved: new Uint8Array([2]),
      seedVertices: [],
      region: 'torso',
    }).status).toBe('empty');

    expect(classifyRegionCorrection({
      previousOverrides: new Uint8Array([3]),
      nextOverrides: new Uint8Array([3]),
      previousResolved: new Uint8Array([3]),
      nextResolved: new Uint8Array([3]),
      seedVertices: [0],
      region: 'leftArm',
    })).toEqual({ status: 'unchanged', region: 'leftArm' });

    const changed = classifyRegionCorrection({
      previousOverrides: new Uint8Array([0, 0]),
      nextOverrides: new Uint8Array([3, 3]),
      previousResolved: new Uint8Array([2, 2]),
      nextResolved: new Uint8Array([3, 3]),
      seedVertices: [0, 1],
      region: 'leftArm',
    });
    expect(changed.status).toBe('changed');
  });

  it('maps legacy wizard steps onto pose-fix', () => {
    expect(migrateAutorigWizardStep('joints')).toBe('joints');
    expect(migrateAutorigWizardStep('regions')).toBe('pose-fix');
    expect(migrateAutorigWizardStep('preview')).toBe('pose-fix');
    expect(migrateAutorigWizardStep('pose-fix')).toBe('pose-fix');
    const normalized = normalizeAutorigWizardDraft({
      rigId: 'x',
      step: 'preview',
      markersJson: '[]',
      updatedAt: 1,
    });
    expect(normalized.step).toBe('pose-fix');
    expect(normalized.version).toBe(2);
  });

  it('Pose & Fix wizard source exposes two steps and fix painting controls', () => {
    const dialog = readFileSync(resolve('src/components/autorig/AutorigRigWizardDialog.tsx'), 'utf8');
    const progress = readFileSync(resolve('src/components/autorig/AutorigWizardProgress.tsx'), 'utf8');
    const poseFix = readFileSync(resolve('src/components/autorig/AutorigPoseFixStep.tsx'), 'utf8');
    expect(progress).toMatch(/Pose & Fix/);
    expect(progress).not.toMatch(/Body parts/);
    expect(progress).not.toMatch(/Check pose/);
    expect(dialog).toMatch(/AutorigPoseFixStep/);
    expect(dialog).toMatch(/AutorigBrushOverlay/);
    expect(dialog).not.toMatch(/Fix body parts/);
    expect(dialog).not.toMatch(/data-autorig-body-parts-step/);
    expect(dialog).not.toMatch(/data-autorig-continue-regions/);
    expect(poseFix).toMatch(/data-autorig-pose-fix-step/);
    expect(poseFix).toMatch(/Fix deformation/);
  });
});

describe('preview mesh bindings', () => {
  it('reads global vertex offsets from skinned mesh userData', () => {
    const root = new THREE.Group();
    const geoA = new THREE.BufferGeometry();
    geoA.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const meshA = new THREE.SkinnedMesh(geoA);
    meshA.userData.autorigVertexStart = 0;
    meshA.userData.autorigTriangleStart = 0;
    meshA.userData.autorigVertexCount = 3;
    meshA.userData.autorigTriangleCount = 1;
    const geoB = new THREE.BufferGeometry();
    geoB.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    const meshB = new THREE.SkinnedMesh(geoB);
    meshB.userData.autorigVertexStart = 3;
    meshB.userData.autorigTriangleStart = 1;
    meshB.userData.autorigVertexCount = 4;
    meshB.userData.autorigTriangleCount = 2;
    root.add(meshA);
    root.add(meshB);

    const bindings = collectPreviewMeshBindings(root);
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toMatchObject({
      canonicalVertexStart: 0,
      vertexCount: 3,
      triangleStart: 0,
      triangleCount: 1,
    });
    expect(bindings[1]).toMatchObject({
      canonicalVertexStart: 3,
      vertexCount: 4,
      triangleStart: 1,
      triangleCount: 2,
    });
  });

  it('maps triangle seeds to canonical vertices for multi-triangle selections', () => {
    const topology = makeArmTorsoTopology();
    const seeds = trianglesToSeedVertices(topology, [2, 3]);
    expect(Array.from(seeds).sort()).toEqual([1, 2, 4, 5]);
  });
});
