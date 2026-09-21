import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  resolveSceneRelationships,
  resolvedLocalBoxFragments,
  resolvedObjectWorldAabbs,
} from '../src/engine/sceneRelationships';
import { validateSpatialAuthoring } from '../src/engine/agent/spatialAuthoring';
import { createResolvedObject3D } from '../src/engine/sceneObjects';

describe('semantic scene relationships', () => {
  it('automatically hosts an overlapping doorway in one compatible wall and cuts a bounded opening', () => {
    const project = createDefaultProject();
    const wall = createSceneObject('wall', 1);
    wall.name = 'Continuous wall';
    wall.dimensions = [6, 3, 0.18];
    wall.transform.position = [0, 1.5, 0];

    const doorway = createSceneObject('doorway', 2);
    doorway.name = 'Door';
    doorway.dimensions = [1, 2.1, 0.3];
    doorway.transform.position = [0, 1.05, 0];

    project.scene.objects = [wall, doorway];

    const resolution = resolveSceneRelationships(project);
    expect(resolution.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'portal_host',
        sourceId: doorway.id,
        targetId: wall.id,
        status: 'resolved',
      }),
    ]));

    const fragments = resolvedLocalBoxFragments(wall, resolution);
    expect(fragments).toHaveLength(3);

    const root = createResolvedObject3D(project, wall, false, 'light', resolution);
    expect(root.children).toHaveLength(3);

    const effective = resolvedObjectWorldAabbs(wall, resolution);
    const openingCenter = [0, 1, 0] as const;
    const centerStillSolid = effective.some((box) => (
      openingCenter[0] > box.min[0] && openingCenter[0] < box.max[0]
      && openingCenter[1] > box.min[1] && openingCenter[1] < box.max[1]
      && openingCenter[2] > box.min[2] && openingCenter[2] < box.max[2]
    ));
    expect(centerStillSolid).toBe(false);
  });

  it('does not guess when a doorway ambiguously overlaps multiple compatible walls', () => {
    const project = createDefaultProject();

    const wallA = createSceneObject('wall', 1);
    wallA.dimensions = [6, 3, 0.18];
    wallA.transform.position = [0, 1.5, 0];

    const wallB = createSceneObject('wall', 2);
    wallB.dimensions = [6, 3, 0.18];
    wallB.transform.position = [0, 1.5, 0.05];

    const doorway = createSceneObject('doorway', 3);
    doorway.dimensions = [1, 2.1, 0.3];
    doorway.transform.position = [0, 1.05, 0.025];

    project.scene.objects = [wallA, wallB, doorway];
    const resolution = resolveSceneRelationships(project);
    const relationship = resolution.relationships.find((entry) => entry.sourceId === doorway.id);

    expect(relationship?.status).toBe('ambiguous');
    expect(relationship?.candidateIds).toEqual(expect.arrayContaining([wallA.id, wallB.id]));
    expect(resolution.cutsByHostId.size).toBe(0);
  });

  it('cuts the nearest upper slab inside the stair clearance footprint but not unrelated higher slabs', () => {
    const project = createDefaultProject();

    const stairs = createSceneObject('stairs', 1);
    stairs.dimensions = [2, 3, 3];
    stairs.transform.position = [0, 1.5, 0];

    const upper = createSceneObject('box', 2);
    upper.name = 'Upper floor slab';
    upper.dimensions = [8, 0.2, 8];
    upper.transform.position = [0, 2.9, 0];
    upper.metadata = {
      architecture: {
        kind: 'slab',
        levelId: 'upper',
        levelName: 'Upper',
        elevation: 3,
        levelHeight: 3,
      },
    };

    const roof = createSceneObject('box', 3);
    roof.name = 'Roof slab';
    roof.dimensions = [8, 0.2, 8];
    roof.transform.position = [0, 5, 0];
    roof.metadata = {
      architecture: {
        kind: 'slab',
        levelId: 'roof',
        levelName: 'Roof',
        elevation: 5.1,
        levelHeight: 2,
      },
    };

    project.scene.objects = [stairs, upper, roof];
    const resolution = resolveSceneRelationships(project);
    const stairTargets = resolution.relationships
      .filter((entry) => entry.kind === 'stair_clearance' && entry.status === 'resolved')
      .map((entry) => entry.targetId);

    expect(stairTargets).toContain(upper.id);
    expect(stairTargets).not.toContain(roof.id);
    expect(resolvedLocalBoxFragments(upper, resolution).length).toBeGreaterThan(1);
    expect(resolvedLocalBoxFragments(roof, resolution)).toHaveLength(1);
  });

  it('warns when a hosted doorway has support on only one side of its threshold', () => {
    const project = createDefaultProject();

    const wall = createSceneObject('wall', 1);
    wall.dimensions = [6, 3, 0.18];
    wall.transform.position = [0, 1.5, 0];

    const doorway = createSceneObject('doorway', 2);
    doorway.dimensions = [1, 2.1, 0.3];
    doorway.transform.position = [0, 1.05, 0];

    const insideFloor = createSceneObject('floor', 3);
    insideFloor.name = 'Interior floor';
    insideFloor.dimensions = [6, 0.1, 3];
    insideFloor.transform.position = [0, -0.05, 1.5];

    project.scene.objects = [wall, doorway, insideFloor];
    const report = validateSpatialAuthoring(project);

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'portal_missing_support',
        severity: 'warning',
        objectIds: [doorway.id],
      }),
    ]));
  });

  it('classifies duplicate support geometry and stair-wall intersections without treating every intersection as fatal', () => {
    const project = createDefaultProject();

    const floorA = createSceneObject('floor', 1);
    floorA.name = 'Ground floor';
    floorA.dimensions = [8, 0.1, 8];
    floorA.transform.position = [0, -0.05, 0];

    const floorB = createSceneObject('box', 2);
    floorB.name = 'Ground slab';
    floorB.dimensions = [8, 0.12, 8];
    floorB.transform.position = [0, -0.06, 0];

    const stairs = createSceneObject('stairs', 3);
    stairs.dimensions = [2, 2.5, 3];
    stairs.transform.position = [0, 1.25, 0];

    const wall = createSceneObject('wall', 4);
    wall.dimensions = [3, 3, 0.4];
    wall.transform.position = [0, 1.5, 0];
    wall.transform.rotation = [0, 90, 0];

    project.scene.objects = [floorA, floorB, stairs, wall];
    const report = validateSpatialAuthoring(project);

    expect(report.issues.some((issue) => issue.code === 'duplicate_support_overlap')).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'stair_wall_intrusion')).toBe(true);
    expect(report.errorCount).toBe(0);
  });
});
