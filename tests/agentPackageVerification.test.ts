import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { ExportPlan, PlannedArtifact } from '../src/engine/exportPlan';
import { verifyPackageAgainstExportPlan } from '../src/engine/agent/packageVerification';

const artifacts: PlannedArtifact[] = [
  artifact('clay-viewport', 'shot-01/inputs/viewport_clay.png'),
  artifact('clay-viewport', 'shot-01/inputs/viewport_clay_clean_plate.png', 'clean_plate'),
  artifact('projected-viewport', 'shot-01/inputs/viewport_projected.png'),
  artifact('depth-viewport', 'shot-01/inputs/viewport_depth.png'),
  artifact('character-still', 'shot-01/inputs/characters.png'),
];

function artifact(kind: PlannedArtifact['kind'], path: string, variant?: 'with_people' | 'clean_plate'): PlannedArtifact {
  return {
    id: `shot-01:${kind}:${path}`,
    shotId: 'shot-01',
    kind,
    disposition: 'produce',
    ...(variant ? { variant } : {}),
    files: [{ path, kind: 'image', required: true, manifestEntry: true }],
    workUnits: 1,
  };
}

function plan(): Pick<ExportPlan, 'shots' | 'sharedArtifacts'> {
  return {
    shots: [{
      shotId: 'shot-01',
      rootFolder: 'shot-01',
      resolvedSettings: {} as ExportPlan['shots'][number]['resolvedSettings'],
      hasOverrides: false,
      artifacts,
      workUnits: artifacts.length,
      estimatedFileCount: artifacts.length,
      sharedReferenceIds: [],
    }],
    sharedArtifacts: [],
  };
}

async function packageWith(paths: string[]): Promise<Blob> {
  const zip = new JSZip();
  paths.forEach((path) => zip.file(path, 'pass'));
  return zip.generateAsync({ type: 'blob' });
}

describe('agent package verification', () => {
  it('accepts a package containing every artifact requested by the export plan', async () => {
    const expectedPaths = artifacts.flatMap((entry) => entry.files.map((file) => file.path));

    await expect(verifyPackageAgainstExportPlan(plan(), await packageWith(expectedPaths))).resolves.toMatchObject({
      ok: true,
      expectedEntryCount: 5,
      missing: [],
    });
  });

  it('reports every missing requested pass by artifact kind', async () => {
    const result = await verifyPackageAgainstExportPlan(
      plan(),
      await packageWith(['shot-01/inputs/viewport_clay.png']),
    );

    expect(result.ok).toBe(false);
    expect(result.missing.map((entry) => entry.kind)).toEqual([
      'clay-viewport',
      'projected-viewport',
      'depth-viewport',
      'character-still',
    ]);
    expect(result.missing.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'shot-01/inputs/viewport_clay_clean_plate.png',
      'shot-01/inputs/viewport_projected.png',
      'shot-01/inputs/viewport_depth.png',
      'shot-01/inputs/characters.png',
    ]));
  });

  it('accepts the browser API envelope written by agent:plan-exports', async () => {
    const expectedPaths = artifacts.flatMap((entry) => entry.files.map((file) => file.path));

    await expect(verifyPackageAgainstExportPlan(
      { plan: plan() },
      await packageWith(expectedPaths),
    )).resolves.toMatchObject({ ok: true, missing: [] });
  });
});
