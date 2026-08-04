import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import { parseForeSceneAgentPlan } from '../src/engine/agent/validation';
import { prepareAgentPlan, previewAgentPlan } from '../src/engine/agent/planCompiler';
import {
  analyzeProjectionDebugPixels,
  evaluateProjectionHealth,
  inspectShotEnvironment,
  verifyShotPanorama,
} from '../src/engine/previs/shotEnvironment';
import { compileShotList } from '../src/engine/previs/shotCompiler';
import { createEmptyCompiledContext } from '../src/engine/previs/locationCompiler';

function preparedProject() {
  const project = createDefaultProject();
  const shot = project.shots[0]!;
  const pano = {
    id: 'pano_prepared',
    name: 'Prepared panorama',
    imageAssetId: 'asset_pano',
    type: 'graybox_render' as const,
    projection: 'equirectangular' as const,
    origin: [0, 1.65, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    width: 4,
    height: 2,
    isCanonical: true,
    createdAt: new Date().toISOString(),
  };
  project.panoRefs.push(pano);
  project.workflow.production = {
    schemaVersion: 1,
    bindings: {},
    locations: {
      interior: {
        id: 'interior',
        objectIds: [],
        objectGroupIds: [],
        anchors: {},
        blockerObjectIds: [],
        panoIds: [pano.id],
        defaultPanoId: pano.id,
      },
    },
    shotContracts: {
      [shot.id]: {
        environment: {
          locationId: 'interior',
          requireProjection: true,
          minimumProjectionCoverage: 0.7,
        },
      },
    },
  };
  return { project, shot, pano };
}

describe('shot environment contracts', () => {
  it('resolves and verifies the prepared location panorama', () => {
    const { project, shot, pano } = preparedProject();
    shot.linkedPanoId = pano.id;

    expect(inspectShotEnvironment(project, shot)).toMatchObject({
      ok: true,
      contractPresent: true,
      locationId: 'interior',
      expectedPanoId: pano.id,
      actualPanoId: pano.id,
      requireProjection: true,
    });
    expect(verifyShotPanorama(project, shot).ok).toBe(true);

    shot.linkedPanoId = undefined;
    expect(verifyShotPanorama(project, shot).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'wrong_panorama_linked' }),
    ]));
  });

  it('hard-fails a contract with no prepared panorama', () => {
    const { project, shot } = preparedProject();
    project.workflow.production!.locations.interior.defaultPanoId = undefined;
    project.workflow.production!.locations.interior.panoIds = [];

    const result = inspectShotEnvironment(project, shot);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'expected_panorama_missing' }),
    ]));
  });

  it('emits an executable panorama-routing command during shot compilation', () => {
    const { project, pano } = preparedProject();
    const manifest: PrevisProductionManifestV1 = {
      version: 1,
      project: { name: 'Environment compile', aspectRatio: '16:9' },
      locations: [{ id: 'interior', name: 'Interior', template: 'interior_room' }],
      cast: [],
      shots: [{
        id: 'shot.001',
        shotNumber: '001',
        name: 'Master',
        description: '',
        locationId: 'interior',
        subjects: [],
        camera: { template: 'wide', subjects: [] },
      }],
    };
    project.workflow.production!.shotContracts['shot.001'] = {
      environment: {
        locationId: 'interior',
        expectedPanoId: pano.id,
      },
    };
    const context = createEmptyCompiledContext();
    context.locationOrigins.interior = [0, 0, 0];
    const compiled = compileShotList(manifest, context, { presenceProject: project });
    expect(compiled[0]!.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(compiled[0]!.plan.commands).toContainEqual({
      op: 'shot.setPanorama',
      shot: { ref: 'shot_001' },
      pano: { id: pano.id },
    });

    const parsed = parseForeSceneAgentPlan({
      version: 1,
      commands: [{ op: 'shot.setPanorama', shot: { id: project.shots[0]!.id }, pano: { id: pano.id } }],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.plan?.commands[0]).toEqual({
      op: 'shot.setPanorama',
      shot: { id: project.shots[0]!.id },
      pano: { id: pano.id },
    });

    const preview = previewAgentPlan(parsed.plan!, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]!.id,
    });
    expect(preview.ok).toBe(true);
    const prepared = prepareAgentPlan(parsed.plan!, {
      project,
      workspace: 'shots',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]!.id,
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.prepared.nextProject.shots[0]?.linkedPanoId).toBe(pano.id);
  });

  it('measures projected ownership colors and gates coverage/fallback', () => {
    const pixels = new Uint8Array([
      0, 255, 255, 255, // cyan covered
      255, 0, 0, 255, // red fallback
      255, 0, 255, 255, // magenta covered
      0, 0, 0, 255, // background
    ]);
    const analyzed = analyzeProjectionDebugPixels(pixels, 2, 2);
    expect(analyzed).toMatchObject({
      geometryPixelCount: 3,
      coveredPixelCount: 2,
      fallbackPixelCount: 1,
      projectionCoverage: 2 / 3,
      fallbackRatio: 1 / 3,
    });

    const diagnostics = evaluateProjectionHealth({
      projectedTextureAvailable: true,
      occlusionMapAvailable: true,
      projectedMaterialCount: 1,
      ...analyzed,
    }, { requireProjection: true, minimumProjectionCoverage: 0.8, shotId: 'shot.001' });
    expect(diagnostics.map((item) => item.code)).toContain('projection_coverage_low');
    expect(diagnostics.map((item) => item.code)).not.toContain('projection_fallback_excessive');
  });
});
