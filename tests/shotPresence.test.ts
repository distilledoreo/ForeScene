import { describe, expect, it } from 'vitest';
import { createCameraKeyframe, createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import type { ProductionConfiguration } from '../src/domain/types';
import { createEmptyCompiledContext } from '../src/engine/previs/locationCompiler';
import { compileShotList } from '../src/engine/previs/shotCompiler';
import {
  applyClosedWorldShotPresence,
  deriveDynamicObjectUniverse,
  inspectShotPresence,
  verifyShotPresence,
} from '../src/engine/previs/shotPresence';

function preparedProject() {
  const project = createDefaultProject();
  const shot = project.shots[0]!;
  const lead = createSceneObject('human_dummy', 1);
  lead.name = 'Lead';
  const alternate = createSceneObject('human_dummy', 2);
  alternate.name = 'Alternate';
  const prop = createSceneObject('box', 3);
  prop.name = 'Prop';
  prop.stagingRole = 'prop';
  project.scene.objects.push(lead, alternate, prop);
  project.workflow.production = {
    schemaVersion: 1,
    bindings: {},
    locations: {},
    shotContracts: {
      [shot.id]: {
        presence: {
          expectedVisibleObjectIds: [lead.id],
          expectedVisibleGroupIds: [],
          allowUnspecifiedDynamicObjects: false,
        },
      },
    },
  } satisfies ProductionConfiguration;
  return { project, shot, lead, alternate, prop };
}

describe('closed-world shot presence', () => {
  it('reports an extra character and keeps static architecture outside the dynamic universe', () => {
    const { project, shot, lead, alternate } = preparedProject();
    const wall = project.scene.objects.find((object) => object.type === 'wall')!;
    const inspection = inspectShotPresence(project, shot);

    expect(inspection.dynamicObjectIds).toEqual(expect.arrayContaining([lead.id, alternate.id]));
    expect(inspection.diagnostics.some((item) => (
      item.code === 'unexpected_dynamic_object' && item.objectId === alternate.id
    ))).toBe(true);
    expect(inspection.actualVisibleObjectIds).toContain(alternate.id);
    expect(wall.visible).toBe(true);
    expect(inspection.actualVisibleObjectIds).not.toContain(wall.id);
  });

  it('detects a visible variant when only the intended role is contracted', () => {
    const { project, shot, lead, alternate } = preparedProject();
    const result = verifyShotPresence(project, shot, {
      expectedVisibleObjectIds: [lead.id],
      expectedVisibleGroupIds: [],
      allowUnspecifiedDynamicObjects: false,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unexpected_dynamic_object', objectId: alternate.id }),
    ]));
  });

  it('resolves multipart groups and rejects partial visibility', () => {
    const { project, shot, lead } = preparedProject();
    const partA = createSceneObject('box', 4);
    const partB = createSceneObject('box', 5);
    partA.stagingRole = 'prop';
    partB.stagingRole = 'prop';
    project.scene.objects.push(partA, partB);
    project.scene.objectGroups = {
      assembly: { id: 'assembly', name: 'Assembly', objectIds: [partA.id, partB.id] },
    };
    project.workflow.production!.shotContracts[shot.id]!.presence = {
      expectedVisibleObjectIds: [lead.id],
      expectedVisibleGroupIds: ['assembly'],
      allowUnspecifiedDynamicObjects: false,
    };
    shot.objectOverrides = { [partB.id]: { visible: false } };

    const inspection = inspectShotPresence(project, shot);
    expect(inspection.expectedVisibleObjectIds).toEqual(expect.arrayContaining([partA.id, partB.id]));
    expect(inspection.diagnostics.some((item) => item.code === 'partial_group_visibility')).toBe(true);
    expect(inspection.diagnostics.some((item) => item.code === 'expected_dynamic_object_hidden' && item.objectId === partB.id)).toBe(true);
  });

  it('catches a dynamic prop inherited from global project visibility', () => {
    const { project, shot, prop } = preparedProject();
    expect(prop.visible).toBe(true);
    const inspection = inspectShotPresence(project, shot);

    expect(inspection.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unexpected_dynamic_object', objectId: prop.id }),
    ]));
  });

  it('samples timeline states and catches a keyframe that introduces an extra object', () => {
    const { project, shot, lead, alternate } = preparedProject();
    shot.cameraKeyframes = [
      createCameraKeyframe({
        label: 'Start',
        timeSeconds: 0,
        camera: shot.camera,
        objectOverrides: {
          [lead.id]: { visible: true },
          [alternate.id]: { visible: false },
        },
      }),
      createCameraKeyframe({
        label: 'End',
        timeSeconds: 2,
        camera: shot.camera,
        objectOverrides: {
          [lead.id]: { visible: true },
          [alternate.id]: { visible: true },
        },
      }),
    ];

    const inspection = inspectShotPresence(project, shot);
    expect(inspection.samples.length).toBeGreaterThan(2);
    expect(inspection.diagnostics.some((item) => item.code === 'dynamic_presence_changed_over_time')).toBe(true);
    expect(inspection.diagnostics.some((item) => (
      item.code === 'unexpected_dynamic_object' && item.objectId === alternate.id && item.sampleTimeSeconds === 2
    ))).toBe(true);
  });

  it('repairs exact presence without changing camera or authored transforms', () => {
    const { project, shot, lead, alternate } = preparedProject();
    shot.objectOverrides = {
      [lead.id]: {
        visible: true,
        transform: structuredClone(lead.transform),
      },
      [alternate.id]: { visible: true },
    };
    const cameraBefore = structuredClone(shot.camera);
    const result = applyClosedWorldShotPresence(project, shot);

    expect(result.ok).toBe(true);
    expect(result.project.shots[0]!.camera).toEqual(cameraBefore);
    expect(result.project.shots[0]!.objectOverrides?.[lead.id]?.visible ?? lead.visible).toBe(true);
    expect(result.project.shots[0]!.objectOverrides?.[alternate.id]?.visible).toBe(false);
    expect(result.inspection.ok).toBe(true);
    expect(result.inspection.actualVisibleObjectIds).toEqual([lead.id]);
  });

  it('derives multipart dynamic members as one project-wide presence universe', () => {
    const { project, part } = (() => {
      const base = preparedProject();
      const part = createSceneObject('box', 6);
      part.stagingRole = 'prop';
      base.project.scene.objects.push(part);
      base.project.scene.objectGroups = {
        creature: { id: 'creature', name: 'Creature', objectIds: [base.lead.id, part.id] },
      };
      return { project: base.project, part };
    })();

    const universe = deriveDynamicObjectUniverse(project);
    expect(universe.find((item) => item.objectId === part.id)?.groupIds).toEqual(['creature']);
  });

  it('emits closed-world stage commands for prepared dynamic objects during compilation', () => {
    const { project, shot, lead, alternate } = preparedProject();
    const manifest: PrevisProductionManifestV1 = {
      version: 1,
      project: { name: 'Presence compile', aspectRatio: '16:9' },
      locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
      cast: [{ id: 'lead', name: 'Lead', type: 'human_dummy', defaultPose: 'standing' }],
      shots: [{
        id: 'shot.001',
        shotNumber: '001',
        name: 'Shot 001',
        description: '',
        locationId: 'room',
        subjects: ['lead'],
        camera: { template: 'wide', subjects: ['lead'] },
      }],
    };
    project.workflow.production!.shotContracts['shot.001'] = project.workflow.production!.shotContracts[shot.id]!;
    const context = createEmptyCompiledContext();
    context.locationOrigins.room = [0, 0, 0];
    context.entities['cast.lead'] = { objectId: lead.id, refs: { [lead.id]: lead.id } };

    const compiled = compileShotList(manifest, context, { presenceProject: project });
    const stages = compiled[0]!.plan.commands.filter((command) => command.op === 'shot.stageObject');
    const alternateStage = stages.find((command) => (
      command.op === 'shot.stageObject'
      && 'id' in command.object
      && command.object.id === alternate.id
    ));

    expect(alternateStage?.visible).toBe(false);
  });
});
