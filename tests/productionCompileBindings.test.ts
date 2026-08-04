import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type { ProductionConfiguration } from '../src/domain/types';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import { compileCastPhase, compilePropsPhase, createEmptyCompiledContext } from '../src/engine/previs/locationCompiler';
import { buildProductionCompileEntityBindings } from '../src/engine/previs/productionCompileBindings';
import { compileShotBatch } from '../src/engine/previs/shotCompiler';

function manifest(): PrevisProductionManifestV1 {
  return {
    version: 1,
    project: { name: 'Multipart fixture', aspectRatio: '16:9' },
    locations: [{ id: 'location.interior', name: 'Interior', template: 'interior_room' }],
    cast: [{ id: 'cast.lead', name: 'Lead', type: 'human_dummy', defaultPose: 'standing' }],
    props: [{ id: 'prop.table', name: 'Table', primitive: 'box' }],
    shots: [{
      id: 'shot.001',
      shotNumber: '001',
      name: 'Master',
      description: 'Prepared multipart shot',
      locationId: 'location.interior',
      subjects: ['cast.lead'],
      camera: { template: 'wide', subjects: ['cast.lead'] },
      requirements: { visibleProps: ['prop.table'] },
    }],
  };
}

function preparedMultipartProject() {
  const project = createDefaultProject();
  const hero = project.scene.objects.find((object) => object.type === 'human_dummy')!;
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
  return { project, hero, table, tableTop };
}

describe('production compile group bindings', () => {
  it('resolves prepared group bindings for compile phases', () => {
    const { project, table, tableTop } = preparedMultipartProject();
    const bindings = buildProductionCompileEntityBindings(project);
    expect(bindings['prop.table']).toEqual({
      kind: 'group',
      groupId: 'tableAssembly',
      objectIds: [table.id, tableTop.id],
    });
    const cast = compileCastPhase(manifest(), createEmptyCompiledContext(), { entityBindings: bindings });
    const props = compilePropsPhase(manifest(), cast.context, { entityBindings: bindings });
    expect(cast.plan.commands).toHaveLength(0);
    expect(props.plan.commands).toHaveLength(0);
    expect(props.context.entities['props.prop.table']).toMatchObject({
      groupId: 'tableAssembly',
      objectIds: [table.id, tableTop.id],
    });
  });

  it('stages all group members with rigid offsets during shot compile', () => {
    const { project, table, tableTop } = preparedMultipartProject();
    const bindings = buildProductionCompileEntityBindings(project);
    const cast = compileCastPhase(manifest(), createEmptyCompiledContext(), { entityBindings: bindings });
    const props = compilePropsPhase(manifest(), cast.context, { entityBindings: bindings });
    const batch = compileShotBatch(manifest(), props.context, manifest().shots, 0, {
      presenceProject: project,
    });
    const stageCommands = batch.plan.commands.filter((command) => command.op === 'shot.stageObject');
    const stagedPropMembers = stageCommands.filter((command) => (
      command.op === 'shot.stageObject'
      && 'id' in command.object
      && (command.object.id === table.id || command.object.id === tableTop.id)
    ));
    expect(stagedPropMembers.length).toBeGreaterThanOrEqual(2);
    expect(stagedPropMembers.every((command) => command.visible === true)).toBe(true);
  });
});
