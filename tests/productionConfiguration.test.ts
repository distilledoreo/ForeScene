import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type { ProductionConfiguration } from '../src/domain/types';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import {
  classifyProductionObject,
  deriveShotActionContracts,
  validateProductionConfiguration,
} from '../src/engine/previs/productionConfiguration';

function manifest(): PrevisProductionManifestV1 {
  return {
    version: 1,
    project: { name: 'Prepared test', aspectRatio: '16:9' },
    locations: [{ id: 'location.interior', name: 'Interior', template: 'interior_room' }],
    cast: [{ id: 'cast.lead', name: 'Lead', type: 'human_dummy', defaultPose: 'standing' }],
    props: [{ id: 'prop.table', name: 'Table', primitive: 'table' }],
    shots: [{
      id: 'shot.001',
      shotNumber: '001',
      name: 'Master',
      description: 'Prepared test shot',
      locationId: 'location.interior',
      subjects: ['cast.lead'],
      camera: { template: 'wide', subjects: ['cast.lead'] },
    }],
  };
}

function validPreparedProject() {
  const project = createDefaultProject();
  const hero = project.scene.objects.find((object) => object.type === 'human_dummy')!;
  // The `table` manifest primitive is represented by normal renderable boxes
  // in the current scene schema.
  const table = createSceneObject('box');
  table.name = 'Prepared table';
  table.stagingRole = 'prop';
  const tableTop = createSceneObject('box', 2);
  tableTop.name = 'Prepared table top';
  tableTop.productionClass = 'dynamic_prop';
  project.scene.objects.push(table, tableTop);
  project.scene.objectGroups = {
    tableAssembly: {
      id: 'tableAssembly',
      name: 'Table assembly',
      objectIds: [table.id, tableTop.id],
    },
  };

  const production: ProductionConfiguration = {
    schemaVersion: 1,
    bindings: {
      'cast.lead': { kind: 'object', objectId: hero.id },
      'prop.table': { kind: 'group', groupId: 'tableAssembly' },
      'location.interior': { kind: 'location', locationId: 'location.interior' },
    },
    locations: {
      'location.interior': {
        id: 'location.interior',
        objectIds: [],
        objectGroupIds: ['tableAssembly'],
        anchors: {},
        blockerObjectIds: [],
      },
    },
    shotContracts: {},
  };
  project.workflow.production = production;
  return project;
}

describe('production configuration validation', () => {
  it('turns unambiguous authored action language into persisted exact native poses', () => {
    const definition = manifest().shots[0]!;
    definition.name = 'Sprint chase';
    definition.blocking = [{
      subject: 'cast.lead',
      placement: { type: 'location_slot', slot: 'center' },
    }];
    definition.motion = {
      durationSeconds: 2,
      keyframes: [{
        timeSeconds: 0,
        staging: [{ subject: 'cast.lead', transform: { position: [0, 0.875, 0] } }],
      }, {
        timeSeconds: 2,
        staging: [{ subject: 'cast.lead', transform: { position: [0, 0.875, 4] } }],
      }],
    };

    const actions = deriveShotActionContracts(definition, {
      poseableEntityIds: new Set(['cast.lead']),
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      entityId: 'cast.lead',
      mode: 'timeline',
      samples: [
        { requestedPose: 'walk-contact-left', resolvedPose: 'walk-contact-left', requiresReview: false },
        { requestedPose: 'walk-contact-left', resolvedPose: 'walk-contact-left', requiresReview: false },
      ],
    });
  });

  it('derives persistent static-pose and timeline action intent from a shot manifest', () => {
    const definition = manifest().shots[0]!;
    definition.blocking = [{
      subject: 'cast.lead',
      placement: { type: 'location_slot', slot: 'center' },
      pose: 'shield-ready',
    }];
    definition.motion = {
      durationSeconds: 2,
      keyframes: [{
        timeSeconds: 0,
        staging: [{
          subject: 'cast.lead',
          posePreset: 'walk-contact-left',
          transform: { position: [0, 0.875, 0] },
        }],
      }, {
        timeSeconds: 2,
        staging: [{
          subject: 'cast.lead',
          posePreset: 'walk-contact-right',
          transform: { position: [0, 0.875, 4] },
        }],
      }],
    };

    const actions = deriveShotActionContracts(definition);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      entityId: 'cast.lead',
      mode: 'static_pose',
      samples: [{ requestedPose: 'shield-ready', resolvedPose: 'elbows-bent' }],
    });
    expect(actions[1]).toMatchObject({
      entityId: 'cast.lead',
      mode: 'timeline',
      durationSeconds: 2,
      samples: [
        { timeSeconds: 0, resolvedPose: 'walk-contact-left', position: [0, 0.875, 0] },
        { timeSeconds: 2, resolvedPose: 'walk-contact-right', position: [0, 0.875, 4] },
      ],
    });
    expect(actions[0]!.samples[0]).toMatchObject({
      poseRelationship: 'approximate',
      requiresReview: true,
    });
    expect(actions[1]!.samples.every((sample) => sample.poseRelationship === 'exact')).toBe(true);
  });

  it('accepts prepared object, group, and location bindings', () => {
    const project = validPreparedProject();
    const result = validateProductionConfiguration(project, manifest());

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.checkedEntityIds).toEqual(['cast.lead', 'prop.table', 'location.interior']);
  });

  it('allows declared embedded props to alias their host production object', () => {
    const project = validPreparedProject();
    const heroId = (project.workflow.production!.bindings['cast.lead'] as { kind: 'object'; objectId: string }).objectId;
    project.workflow.production!.bindings['prop.table'] = { kind: 'object', objectId: heroId };
    const embeddedManifest = manifest();
    embeddedManifest.props = [{
      id: 'prop.table',
      name: 'Embedded table fixture',
      primitive: 'box',
      embeddedIn: { subject: 'cast.lead', joint: 'leftHand' },
    }];

    const result = validateProductionConfiguration(project, embeddedManifest);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports missing and stale binding targets before compilation', () => {
    const project = validPreparedProject();
    project.workflow.production!.bindings['prop.table'] = { kind: 'group', groupId: 'missing-group' };
    delete project.workflow.production!.bindings['location.interior'];

    const result = validateProductionConfiguration(project, manifest());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'stale_group_id',
      'missing_binding',
    ]));
  });

  it('rejects empty and partial multipart groups', () => {
    const project = validPreparedProject();
    project.scene.objectGroups!.empty = { id: 'empty', name: 'Empty', objectIds: [] };
    project.workflow.production!.bindings['prop.table'] = { kind: 'group', groupId: 'empty' };
    project.workflow.production!.locations['location.interior'].objectGroupIds = ['tableAssembly'];
    project.scene.objectGroups!.tableAssembly.objectIds = [
      project.scene.objectGroups!.tableAssembly.objectIds[0]!,
      'missing-part',
    ];

    const result = validateProductionConfiguration(project, manifest());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'empty_object_group',
      'partial_assembly',
    ]));
  });

  it('rejects non-renderable, duplicate, unknown panorama, and unclassified dynamic bindings', () => {
    const project = validPreparedProject();
    const sun = project.scene.objects.find((object) => object.type === 'sun_marker')!;
    project.workflow.production!.bindings['cast.lead'] = { kind: 'object', objectId: sun.id };
    project.workflow.production!.bindings['prop.table'] = { kind: 'object', objectId: sun.id };
    project.workflow.production!.locations['location.interior'].panoIds = ['missing-pano'];
    project.workflow.production!.locations['location.interior'].defaultPanoId = 'missing-pano';
    project.workflow.production!.locations['location.interior'].objectIds = [sun.id];
    project.workflow.production!.locations['location.interior'].objectGroupIds = [];
    project.scene.objects.find((object) => object.id === sun.id)!.productionClass = 'unclassified';

    const result = validateProductionConfiguration(project, manifest());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'bound_entity_not_renderable',
      'ambiguous_duplicate_binding',
      'unknown_panorama_id',
      'unclassified_dynamic_object',
      'location_geometry_missing',
    ]));
  });

  it('blocks an explicitly pose-required shot bound to static geometry', () => {
    const project = validPreparedProject();
    const staticObject = project.scene.objects.find((object) => object.type === 'wall')!;
    project.workflow.production!.bindings['cast.lead'] = { kind: 'object', objectId: staticObject.id };
    project.workflow.production!.shotContracts['shot.001'] = {
      capabilityRequirements: [{ entityId: 'cast.lead', requires: { poseable: true, deforming: true } }],
    };

    const result = validateProductionConfiguration(project, manifest());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.code === 'required_poseable_asset_static')).toBe(true);
  });

  it('rejects malformed action intent and actions for unbound entities', () => {
    const project = validPreparedProject();
    project.workflow.production!.shotContracts['shot.001'] = {
      actions: [{
        actionId: 'shot.001:missing:timeline',
        entityId: 'cast.missing',
        mode: 'timeline',
        durationSeconds: 1,
        samples: [{ timeSeconds: 2, requestedPose: 'walking' }],
      }],
    };

    const result = validateProductionConfiguration(project, manifest());

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'action_binding_missing',
      'action_contract_invalid',
    ]));
  });

  it('persists a stable deformation-free locomotion orientation', () => {
    const definition = manifest().shots[0]!;
    definition.name = 'Sprint chase';
    definition.subjects = ['cast.lead', 'asset.pursuer'];
    definition.camera = { template: 'full', subjects: ['cast.lead', 'asset.pursuer'], angle: 'three_quarter' };
    definition.motion = {
      durationSeconds: 3,
      keyframes: [{
        timeSeconds: 0,
        camera: { position: [1.2, 1.6, -2], target: [0, 0.9, -5.8], fovDegrees: 50 },
        staging: [
          { subject: 'cast.lead', transform: { position: [0, 0.875, -5.3] } },
          { subject: 'asset.pursuer', transform: { position: [0, 0, -6.5] } },
        ],
      }, {
        timeSeconds: 3,
        camera: { position: [1.2, 1.6, 8.6], target: [0, 0.9, 4.8], fovDegrees: 50 },
        staging: [
          { subject: 'cast.lead', transform: { position: [0, 0.875, 5.3] } },
          { subject: 'asset.pursuer', transform: { position: [0, 0, 4.1] } },
        ],
      }],
    };

    const actions = deriveShotActionContracts(definition, {
      rigidLocomotionEntityIds: new Set(['cast.lead', 'asset.pursuer']),
    });

    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.mode).toBe('timeline');
      expect(action.samples[0]?.rotation?.[0]).toBeGreaterThan(12);
      expect(action.samples[0]?.rotation).toEqual(action.samples[1]?.rotation);
      expect(action.samples[0]?.position?.[0]).not.toBe(0);
      expect(action.samples[0]?.position?.[2]).toBe(
        action.entityId === 'cast.lead' ? -5.3 : -6.5,
      );
    }
    const leadX = actions.find((action) => action.entityId === 'cast.lead')?.samples[0]?.position?.[0] ?? 0;
    const pursuerX = actions.find((action) => action.entityId === 'asset.pursuer')?.samples[0]?.position?.[0] ?? 0;
    expect(pursuerX - leadX).toBeCloseTo(0.96, 5);
  });

  it('derives dynamic classification from prepared object semantics', () => {
    const project = createDefaultProject();
    const hero = project.scene.objects.find((object) => object.type === 'human_dummy')!;
    const wall = project.scene.objects.find((object) => object.type === 'wall')!;
    expect(classifyProductionObject(hero, 'cast')).toBe('dynamic_subject');
    expect(classifyProductionObject(wall)).toBe('static_environment');
    expect(classifyProductionObject({ ...wall, category: 'landmark', stagingRole: undefined }, 'prop')).toBe('dynamic_prop');
  });
});
