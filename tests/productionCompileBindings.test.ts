import { describe, expect, it } from 'vitest';
import { createDefaultProject, createLandmark, createSceneObject } from '../src/domain/defaults';
import type { ProductionConfiguration, Vec3 } from '../src/domain/types';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import { compileCastPhase, compilePropsPhase, createEmptyCompiledContext } from '../src/engine/previs/locationCompiler';
import {
  buildProductionCompileEntityBindings,
  buildProductionCompileLocationBindings,
  inferExistingProjectLocationBindings,
} from '../src/engine/previs/productionCompileBindings';
import { compileProduction } from '../src/engine/previs/productionCompiler';
import {
  buildCanaryMutationExpectation,
  verifyProductionMutationScope,
} from '../src/engine/previs/productionMutationScope';
import { compileShotBatch } from '../src/engine/previs/shotCompiler';
import { planProductionCanary } from '../src/engine/previs/productionGates';

function manifest(overrides?: Partial<PrevisProductionManifestV1>): PrevisProductionManifestV1 {
  return {
    version: 1,
    project: { name: 'Multipart fixture', aspectRatio: '16:9' },
    locations: [{ id: 'location.interior', name: 'Interior', template: 'interior_room' }],
    cast: [{ id: 'cast.lead', name: 'Lead', type: 'human_dummy', defaultPose: 'standing-neutral' }],
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
    ...overrides,
  };
}

function preparedMultipartProject() {
  const project = createDefaultProject();
  const hero = project.scene.objects.find((object) => object.type === 'human_dummy')!;
  const table = createSceneObject('box');
  table.name = 'Prepared table';
  table.stagingRole = 'prop';
  table.transform.position = [0, 0.5, 0];
  const tableTop = createSceneObject('box', 2);
  tableTop.name = 'Prepared table top';
  tableTop.productionClass = 'dynamic_prop';
  tableTop.transform.position = [1, 1.5, 0];
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

function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

describe('production compile group bindings', () => {
  it('binds landmarked existing-project locations without replacement geometry', () => {
    const project = createDefaultProject();
    const ruins = createSceneObject('floor');
    ruins.transform.position = [0, 0, 0];
    const armory = createSceneObject('floor');
    armory.transform.position = [100, 0, 0];
    project.scene.objects = [ruins, armory];
    project.landmarks = [
      { ...createLandmark(1, [0, 1.2, 0]), name: 'ruins_center' },
      { ...createLandmark(2, [0, 1.2, -4]), name: 'ruins_platform' },
      { ...createLandmark(3, [100, 1.2, 0]), name: 'armory_center' },
    ];
    const input = manifest({
      project: { name: 'Existing set', aspectRatio: '16:9', operatingMode: 'existing-project-refinement' },
      locations: [
        { id: 'ruins', name: 'Ruins', template: 'ruins' },
        { id: 'armory', name: 'Armory', template: 'armory' },
      ],
      shots: [{ ...manifest().shots[0]!, locationId: 'ruins' }],
    });

    const locationBindings = inferExistingProjectLocationBindings(project, input);
    const compiled = compileProduction(input, { locationBindings, presenceProject: project });

    expect(Object.keys(locationBindings)).toEqual(['ruins', 'armory']);
    expect(locationBindings.ruins?.objectIds).toEqual([ruins.id]);
    expect(locationBindings.armory?.objectIds).toEqual([armory.id]);
    expect(compiled.locations.plan.commands).toEqual([]);
    expect(compiled.context.locationOrigins.ruins).toEqual([0, 1.2, 0]);
    expect(compiled.context.locationAnchors.ruins?.platform).toEqual([0, 1.2, -4]);
  });

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

  it('stages all group members with distinct rigid offsets during static shot compile', () => {
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
      && command.visible === true
      && command.transform
    ));
    expect(stagedPropMembers).toHaveLength(2);
    const transforms = stagedPropMembers.map((command) => (
      command.op === 'shot.stageObject' ? command.transform! : null
    ));
    expect(transforms[0]!.position).not.toEqual(transforms[1]!.position);
    const originalDistance = vec3Distance(table.transform.position, tableTop.transform.position);
    const stagedDistance = vec3Distance(transforms[0]!.position, transforms[1]!.position);
    expect(stagedDistance).toBeCloseTo(originalDistance, 4);
  });

  it('preserves rigid group offsets in motion keyframes', () => {
    const { project, table, tableTop } = preparedMultipartProject();
    const bindings = buildProductionCompileEntityBindings(project);
    const cast = compileCastPhase(manifest(), createEmptyCompiledContext(), { entityBindings: bindings });
    const props = compilePropsPhase(manifest(), cast.context, { entityBindings: bindings });
    const motionManifest = manifest({
      shots: [{
        ...manifest().shots[0]!,
        motion: {
          durationSeconds: 2,
          keyframes: [
            { timeSeconds: 0, camera: { position: [0, 2, 6] } },
            {
              timeSeconds: 2,
              camera: { position: [1, 2, 5] },
              staging: [{
                subject: 'prop.table',
                transform: {
                  position: [2, 0, -1],
                  rotation: [0, 45, 0],
                },
              }],
            },
          ],
        },
      }],
    });
    const batch = compileShotBatch(motionManifest, props.context, motionManifest.shots, 0, {
      presenceProject: project,
    });
    const timeline = batch.plan.commands.find((command) => command.op === 'shot.timeline.replace');
    expect(timeline?.op).toBe('shot.timeline.replace');
    const keyframe = timeline?.op === 'shot.timeline.replace'
      ? timeline.keyframes.find((item) => item.timeSeconds === 2)
      : undefined;
    expect(keyframe?.objects?.length).toBeGreaterThanOrEqual(2);
    const memberTransforms = (keyframe?.objects ?? [])
      .filter((entry) => 'id' in entry.object && (entry.object.id === table.id || entry.object.id === tableTop.id))
      .map((entry) => entry.transform)
      .filter((transform): transform is NonNullable<typeof transform> => Boolean(transform));
    expect(memberTransforms).toHaveLength(2);
    expect(memberTransforms[0]!.position).not.toEqual(memberTransforms[1]!.position);
    const originalDistance = vec3Distance(table.transform.position, tableTop.transform.position);
    const keyframedDistance = vec3Distance(memberTransforms[0]!.position, memberTransforms[1]!.position);
    expect(keyframedDistance).toBeCloseTo(originalDistance, 4);
  });

  it('compiles group-only prepared locations without template geometry', () => {
    const { project, table, tableTop } = preparedMultipartProject();
    const entityBindings = buildProductionCompileEntityBindings(project);
    const locationBindings = buildProductionCompileLocationBindings(project);
    expect(locationBindings['location.interior']).toMatchObject({
      locationId: 'location.interior',
      objectIds: [table.id, tableTop.id],
    });
    const result = compileProduction(manifest(), {
      entityBindings,
      locationBindings,
      presenceProject: project,
    });
    expect(result.ok).toBe(true);
    expect(result.locations.plan.commands.filter((command) => command.op === 'object.create')).toHaveLength(0);
    expect(result.context.entities['locations.location.interior']?.objectIds).toEqual(
      expect.arrayContaining([table.id, tableTop.id]),
    );
    const plan = planProductionCanary({
      candidates: [{ shotId: 'shot.001', shotNumber: '001', capabilities: ['location'] }],
    });
    const expectation = buildCanaryMutationExpectation(project, plan, manifest());
    expect(expectation.expectedCreatedEntityIds.size).toBe(0);
    const after = structuredClone(project);
    const scope = verifyProductionMutationScope(project, after, expectation);
    expect(scope.ok).toBe(true);
  });
});
