import { describe, expect, it } from 'vitest';
import { createDefaultProject, createShot } from '../src/domain/defaults';
import {
  cameraToOpenCvPrior,
  createGenerativeWorldRequest,
  createHyWorld2CameraPriorFile,
  resolveGenerativeWorldCleanPlate,
  runMockGenerativeWorldBackend,
  validateGenerativeWorldRequest,
} from '../src/engine/generativeWorldBoundary';

describe('generative-world boundary', () => {
  it('converts ForeScene cameras into OpenCV c2w and pixel intrinsics', () => {
    const prior = cameraToOpenCvPrior({
      position: [0, 1.5, 5],
      target: [0, 1.5, 0],
      fovDegrees: 60,
      aspectRatio: 16 / 9,
      near: 0.1,
      far: 100,
    }, 1920, 1080);

    expect(prior.c2w).toEqual([
      [1, 0, 0, 0],
      [0, -1, 0, 1.5],
      [0, 0, -1, 5],
      [0, 0, 0, 1],
    ]);
    expect(prior.intrinsicsPixels[0][0]).toBeCloseTo(935.307, 3);
    expect(prior.intrinsicsPixels[1][1]).toBeCloseTo(935.307, 3);
    expect(prior.intrinsicsPixels[0][2]).toBe(960);
    expect(prior.intrinsicsPixels[1][2]).toBe(540);
  });

  it('preserves authored camera trajectories and ForeScene semantic authority', () => {
    const project = createDefaultProject();
    const shot = createShot({
      index: 2,
      camera: structuredClone(project.shots[0]!.camera),
    });
    shot.id = 'shot-motion';
    shot.productionShotId = '020';
    shot.cameraKeyframes = [{
      id: 'kf-0',
      label: 'Start',
      timeSeconds: 0,
      camera: { ...shot.camera, position: [0, 1.6, 5], target: [0, 1, 0] },
      easing: 'linear',
    }, {
      id: 'kf-1',
      label: 'End',
      timeSeconds: 2,
      camera: { ...shot.camera, position: [2, 1.6, 5], target: [2, 1, 0] },
      easing: 'linear',
    }];
    project.shots = [shot];
    project.workflow.production = {
      schemaVersion: 1,
      bindings: {},
      locations: {},
      shotContracts: { [shot.id]: { actions: [] } },
    };

    const request = createGenerativeWorldRequest({ project });

    expect(validateGenerativeWorldRequest(request)).toEqual({ ok: true, errors: [] });
    expect(request.authority).toMatchObject({
      semanticWorld: 'forescene',
      actionContinuity: 'forescene',
      cinematography: 'forescene',
    });
    expect(request.views.map((view) => view.timeSeconds)).toEqual([0, 2]);
    expect(request.trajectories[0]!.samples).toHaveLength(2);
    expect(request.views.every((view) => view.image.contentMode === 'clean_plate')).toBe(true);
    expect(request.compatibility.worldMirrorDepthPrior).toBe('ready');
  });

  it('emits the documented HY-World camera prior shape and runs a deterministic mock backend', () => {
    const project = createDefaultProject();
    const request = createGenerativeWorldRequest({ project, desiredRepresentations: ['mesh'] });
    const prior = createHyWorld2CameraPriorFile(request);
    const result = runMockGenerativeWorldBackend(request);

    expect(prior.num_cameras).toBe(request.views.length);
    expect(prior.extrinsics[0]).toMatchObject({ camera_id: request.views[0]!.viewId });
    expect(prior.intrinsics[0]!.matrix).toHaveLength(3);
    expect(result).toMatchObject({
      requestId: request.requestId,
      status: 'completed',
      backend: { mock: true },
      semanticAuthority: 'forescene',
      cameraAuthority: 'forescene',
      generatedAssets: [{ kind: 'mesh', coordinateSystem: 'right-handed-y-up-meters' }],
    });
    expect(result.acceptedViewIds).toEqual(request.views.map((view) => view.viewId));
  });

  it('removes semantically bound creatures and assemblies from clean plates while retaining location geometry', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const environment = project.scene.objects[0]!;
    const creaturePart = project.scene.objects[1]!;
    environment.visible = true;
    creaturePart.visible = true;
    project.scene.objectGroups = {
      creature: { id: 'creature', name: 'Creature', objectIds: [creaturePart.id] },
    };
    project.workflow.production = {
      schemaVersion: 1,
      bindings: {
        ruins: { kind: 'location', locationId: 'ruins' },
        monster: { kind: 'group', groupId: 'creature' },
        wall: { kind: 'object', objectId: environment.id },
      },
      locations: {
        ruins: {
          id: 'ruins',
          objectIds: [environment.id],
          objectGroupIds: [],
          anchors: {},
          blockerObjectIds: [],
        },
      },
      shotContracts: {},
    };

    const plate = resolveGenerativeWorldCleanPlate(project, shot);

    expect(plate.hiddenObjectIds).toEqual([creaturePart.id]);
    expect(plate.project.scene.objects.find((object) => object.id === creaturePart.id)?.visible).toBe(false);
    expect(plate.shot.objectOverrides?.[creaturePart.id]?.visible).toBe(false);
    expect(plate.project.scene.objects.find((object) => object.id === environment.id)?.visible).toBe(true);
    expect(project.scene.objects.find((object) => object.id === creaturePart.id)?.visible).toBe(true);
  });
});
