import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type { ProductionConfiguration } from '../src/domain/types';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import {
  classifyProductionObject,
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
  it('accepts prepared object, group, and location bindings', () => {
    const project = validPreparedProject();
    const result = validateProductionConfiguration(project, manifest());

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.checkedEntityIds).toEqual(['cast.lead', 'prop.table', 'location.interior']);
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

  it('derives dynamic classification from prepared object semantics', () => {
    const project = createDefaultProject();
    const hero = project.scene.objects.find((object) => object.type === 'human_dummy')!;
    const wall = project.scene.objects.find((object) => object.type === 'wall')!;
    expect(classifyProductionObject(hero, 'cast')).toBe('dynamic_subject');
    expect(classifyProductionObject(wall)).toBe('static_environment');
    expect(classifyProductionObject({ ...wall, category: 'landmark', stagingRole: undefined }, 'prop')).toBe('dynamic_prop');
  });
});
