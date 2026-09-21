import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { prepareAgentPlan } from '../src/engine/agent/planCompiler';
import {
  AGENT_SPATIAL_AUTHORING_REFERENCE,
  inspectSceneSpatially,
  validateSpatialAuthoring,
} from '../src/engine/agent/spatialAuthoring';
import { compileAgentScript } from '../scripts/agent/agentScript';

describe('spatial authoring', () => {
  it('documents the Y-up XYZ contract and centered authoring path', () => {
    expect(AGENT_SPATIAL_AUTHORING_REFERENCE.world.worldUp).toBe('+Y');
    expect(AGENT_SPATIAL_AUTHORING_REFERENCE.world.dimensions).toContain('height along Y');
    expect(AGENT_SPATIAL_AUTHORING_REFERENCE.scripting.creation[0]).toContain('scene.createCentered');
    expect(AGENT_SPATIAL_AUTHORING_REFERENCE.scripting.architecture.wall).toContain('architecture.wall');
  });

  it('catches the floor-axis mistake that turns a slab into a tall vertical volume', () => {
    const project = createDefaultProject();
    const bad = createSceneObject('box', 1);
    bad.name = 'Ground floor slab';
    bad.dimensions = [10, 8, 0.2];
    bad.transform.position = [0, -4, 0];

    const legitimateWall = createSceneObject('wall', 1);
    legitimateWall.name = 'Second floor north wall';
    legitimateWall.dimensions = [10, 3, 0.18];
    legitimateWall.transform.position = [0, 4.7, -4];

    project.scene.objects = [bad, legitimateWall];

    const report = validateSpatialAuthoring(project);
    expect(report.ok).toBe(false);
    const axisIssues = report.issues.filter((issue) => issue.code === 'dimension_axis_mismatch');
    expect(axisIssues).toEqual([
      expect.objectContaining({
        severity: 'error',
        objectIds: [bad.id],
      }),
    ]);
  });

  it('returns dimensions, bounds, support, intersections, and architecture metadata', () => {
    const project = createDefaultProject();
    project.scene.objects = [];

    const slab = createSceneObject('box', 1);
    slab.name = 'Upper floor slab';
    slab.dimensions = [8, 0.2, 6];
    slab.transform.position = [0, 3.1, 0];
    slab.metadata = {
      architecture: {
        kind: 'slab',
        slabRole: 'floor',
        levelId: 'upper',
        levelName: 'Upper',
        elevation: 3.2,
        levelHeight: 3,
      },
    };

    const prop = createSceneObject('box', 2);
    prop.name = 'Desk';
    prop.stagingRole = 'prop';
    prop.dimensions = [1.4, 0.75, 0.7];
    prop.transform.position = [0, 3.575, 0];
    prop.metadata = {
      architecture: {
        kind: 'level_member',
        levelId: 'upper',
        levelName: 'Upper',
        elevation: 3.2,
        levelHeight: 3,
      },
    };

    project.scene.objects = [slab, prop];
    const inspected = inspectSceneSpatially(project, { name: 'Desk', match: 'exact' });
    expect(inspected).toHaveLength(1);
    expect(inspected[0]?.dimensions).toEqual([1.4, 0.75, 0.7]);
    expect(inspected[0]?.worldBounds.min[1]).toBeCloseTo(3.2, 6);
    expect(inspected[0]?.supportedByObjectIds).toContain(slab.id);
    expect(inspected[0]?.architecture?.levelId).toBe('upper');
  });

  it('compiles free-form levels, slabs, rooms, and hosted openings to ordinary validated plans', () => {
    const project = createDefaultProject();
    project.scene.objects = [];

    const compiled = compileAgentScript(`
      plan.description('Free-form two-story shell');

      const ground = architecture.level({
        id: 'ground',
        name: 'Ground',
        elevation: 0,
        height: 3,
      });
      const upper = architecture.level({
        id: 'upper',
        name: 'Upper',
        elevation: 3.2,
        height: 3,
      });

      architecture.slab({
        level: ground,
        name: 'Ground floor slab',
        width: 10,
        depth: 8,
        thickness: 0.2,
      });
      architecture.slab({
        level: upper,
        name: 'Upper floor slab',
        width: 10,
        depth: 8,
        thickness: 0.2,
      });

      const frontDoor = architecture.opening({
        kind: 'door',
        offset: 5,
        width: 1,
        height: 2.1,
        name: 'Front door',
      });

      architecture.room({
        level: ground,
        name: 'Ground shell',
        boundary: [[-5,-4], [5,-4], [5,4], [-5,4]],
        openingsByEdge: { 0: [frontDoor] },
      });

      architecture.room({
        level: upper,
        name: 'Upper shell',
        boundary: [[-5,-4], [5,-4], [5,4], [-5,4]],
      });

      const person = scene.createCentered('human_dummy', {
        name: 'Upper office person',
        position: [2, 4.075, 1],
      });
      architecture.placeOnLevel(person, upper, { x: 2, z: 1 });
    `, project);

    const prepared = prepareAgentPlan(compiled.plan, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
      gridSnap: false,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const next = prepared.prepared.nextProject;
    const groundSlab = next.scene.objects.find((object) => object.name === 'Ground floor slab');
    const upperSlab = next.scene.objects.find((object) => object.name === 'Upper floor slab');
    const door = next.scene.objects.find((object) => object.name === 'Front door');
    const person = next.scene.objects.find((object) => object.name === 'Upper office person');

    expect(groundSlab?.dimensions).toEqual([10, 0.2, 8]);
    expect(groundSlab?.transform.position[1]).toBeCloseTo(-0.1, 6);
    expect(upperSlab?.transform.position[1]).toBeCloseTo(3.1, 6);
    expect(person?.transform.position[1]).toBeCloseTo(4.075, 6);

    const frontDoorInspection = inspectSceneSpatially(next, { name: 'Front door', match: 'exact' })[0];
    expect(frontDoorInspection?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'portal_host',
        status: 'resolved',
        targetId: expect.any(String),
      }),
    ]));

    const groundShellWalls = next.scene.objects.filter((object) => (
      object.type === 'wall' && object.name.startsWith('Ground shell wall')
    ));
    expect(groundShellWalls).toHaveLength(4);
    expect(groundShellWalls.some((object) => object.name.includes('segment'))).toBe(false);

    const report = validateSpatialAuthoring(next);
    expect(report.issues.some((issue) => issue.code === 'dimension_axis_mismatch')).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'level_misalignment')).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'unhosted_opening')).toBe(false);
  });
});
