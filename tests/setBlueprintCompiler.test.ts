import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_HEIGHT_METERS } from '../src/domain/defaults';
import { compileSetBlueprint } from '../src/engine/setBlueprintCompiler';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import { parseSetBlueprint } from '../src/engine/setBlueprintValidation';
import { resolveSceneRelationships, resolvedLocalBoxFragments } from '../src/engine/sceneRelationships';
import {
  complexSetBlueprint,
  minimalSetBlueprint,
  trainStationBlueprint,
} from './fixtures/setBlueprints';

describe('compileSetBlueprint', () => {
  it('creates one scene object per blueprint object', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    expect(compiled.project.scene.objects).toHaveLength(complexSetBlueprint.objects.length);
    expect(Object.keys(compiled.objectIdByBlueprintKey)).toHaveLength(complexSetBlueprint.objects.length);
  });

  it('preserves dimensions and applies transform defaults', () => {
    const compiled = compileSetBlueprint(minimalSetBlueprint);
    const floor = compiled.project.scene.objects[0];
    expect(floor.dimensions).toEqual([8, 0.08, 6]);
    expect(floor.transform.rotation).toEqual([0, 0, 0]);
    expect(floor.transform.scale).toEqual([1, 1, 1]);
    // Floor top at Y=0 → center at -height/2
    expect(floor.transform.position[1]).toBeCloseTo(-0.04);
    expect(floor.transform.position[0]).toBe(0);
    expect(floor.transform.position[2]).toBe(0);
  });

  it('places upright walls with bottoms on the floor', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    const wall = compiled.project.scene.objects.find((object) => object.name === 'Back Wall');
    expect(wall).toBeDefined();
    expect(wall!.transform.position[1]).toBeCloseTo(3.2 / 2);
  });

  it('uses uniform center coordinates for every v2 primitive', () => {
    const compiled = compileSetBlueprint({
      ...minimalSetBlueprint,
      schemaVersion: 2,
      objects: [
        { key: 'floor', name: 'Ground Floor', type: 'floor', position: [0, -0.1, 0], dimensions: [8, 0.2, 8] },
        { key: 'wall', name: 'Wall', type: 'wall', position: [0, 1.5, -4], dimensions: [8, 3, 0.2] },
        { key: 'person', name: 'Person', type: 'human_dummy', position: [1, 0.875, 1], dimensions: [0.55, 1.75, 0.55] },
        { key: 'box', name: 'Box', type: 'box', position: [2, 0.5, 2], dimensions: [1, 1, 1] },
      ],
    });
    expect(compiled.project.scene.objects.map((object) => object.transform.position)).toEqual([
      [0, -0.1, 0], [0, 1.5, -4], [1, 0.875, 1], [2, 0.5, 2],
    ]);
    expect(compiled.spatialErrors).toEqual([]);
  });

  it('uses object Y elevations for upper floors and upright objects, and cuts stair clearance', () => {
    const compiled = compileSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        { key: 'upper', name: 'Upper Floor', type: 'floor', position: [0, 3, 0], dimensions: [8, 0.2, 8] },
        { key: 'upper_wall', name: 'Upper Wall', type: 'wall', position: [0, 3, -4], dimensions: [8, 3, 0.2] },
        { key: 'stairs', name: 'Stairs', type: 'stairs', position: [0, 0, 0], dimensions: [2, 3, 3], clearanceAboveMeters: 2.5 },
      ],
    });
    const [upper, wall, stairs] = compiled.project.scene.objects;
    expect(upper.transform.position[1]).toBeCloseTo(2.9);
    expect(wall.transform.position[1]).toBeCloseTo(4.5);
    expect(stairs.transform.position[1]).toBeCloseTo(1.5);
    expect(stairs.metadata?.architecture).toEqual({ kind: 'level_member', clearanceAboveMeters: 2.5 });
    expect(compiled.spatialRelationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'stair_clearance', sourceId: stairs.id, targetId: upper.id, status: 'resolved' }),
    ]));
    expect(resolvedLocalBoxFragments(upper, resolveSceneRelationships(compiled.project)).length).toBeGreaterThan(1);
  });

  it('resolves a doorway host key to one wall and keeps the other wall intact', () => {
    const compiled = compileSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        { key: 'door', name: 'Door', type: 'doorway', position: [0, 0, 0], dimensions: [1, 2.1, 0.3], hostWallKey: 'wall_a' },
        { key: 'wall_a', name: 'Wall A', type: 'wall', position: [0, 0, 0], dimensions: [6, 3, 0.2] },
        { key: 'wall_b', name: 'Wall B', type: 'wall', position: [0, 0, 0.05], dimensions: [6, 3, 0.2] },
      ],
    });
    const [door, wallA, wallB] = compiled.project.scene.objects;
    expect(door.metadata?.architecture).toEqual({
      kind: 'opening', openingKind: 'door', hostWallId: wallA.id,
    });
    expect(compiled.spatialRelationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'portal_host', sourceId: door.id, targetId: wallA.id, status: 'resolved' }),
    ]));
    const resolution = resolveSceneRelationships(compiled.project);
    expect(resolvedLocalBoxFragments(wallA, resolution).length).toBeGreaterThan(1);
    expect(resolvedLocalBoxFragments(wallB, resolution)).toHaveLength(1);
  });

  it('reports unresolved cutter relationships and bounds rotated objects correctly', () => {
    const compiled = compileSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        { key: 'door', name: 'Unhosted Door', type: 'doorway', position: [10, 0, 0], dimensions: [1, 2, 0.3] },
        { key: 'stairs', name: 'Stairs', type: 'stairs', position: [0, 0, 0], dimensions: [2, 2, 3] },
        { key: 'rotated', name: 'Rotated Box', type: 'box', position: [0, 0, 0], rotation: [0, 90, 0], dimensions: [4, 1, 1] },
      ],
    });
    expect(compiled.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      'doorway_unhosted', 'stair_clearance_unhosted',
    ]));
    expect(compiled.bounds.min[2]).toBeLessThanOrEqual(-2);
    expect(compiled.bounds.max[2]).toBeGreaterThanOrEqual(2);
  });

  it('surfaces spatial authoring errors before a generated project can be applied', () => {
    const compiled = compileSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        { key: 'slab', name: 'Upper Floor Slab', type: 'floor', position: [0, 3, 0], dimensions: [8, 3, 0.2] },
      ],
    });
    expect(compiled.spatialErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dimension_axis_mismatch', path: 'objects[0]', key: 'slab' }),
    ]));
  });

  it('sets human_dummy staging role to person and architecture to set', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    const person = compiled.project.scene.objects.find((object) => object.type === 'human_dummy');
    const wall = compiled.project.scene.objects.find((object) => object.type === 'wall');
    expect(person?.stagingRole).toBe('person');
    expect(wall?.stagingRole).toBe('set');
  });

  it('applies explicit staging roles and surface settings', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    const bench = compiled.project.scene.objects.find((object) => object.name === 'Stone Bench');
    expect(bench?.stagingRole).toBe('prop');
    expect(bench?.surfaceStyle).toBe('solid');
    expect(bench?.color).toBe('#c8cdc8');
  });

  it('resolves landmark linkedObjectKey to native object IDs', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    const archLandmark = compiled.project.landmarks.find((landmark) => landmark.name === 'lm_arch');
    const archId = compiled.objectIdByBlueprintKey.arch_center;
    expect(archLandmark?.linkedObjectId).toBe(archId);
    expect(archLandmark?.position).toEqual(
      compiled.project.scene.objects.find((object) => object.id === archId)?.transform.position,
    );
  });

  it('infers landmark position from the linked object when omitted', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    const personLandmark = compiled.project.landmarks.find((landmark) => landmark.name === 'lm_person');
    const personId = compiled.objectIdByBlueprintKey.person_scale;
    const person = compiled.project.scene.objects.find((object) => object.id === personId);
    expect(personLandmark?.position).toEqual(person?.transform.position);
  });

  it('creates exactly one origin shot at the blueprint pano origin', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    expect(compiled.project.shots).toHaveLength(1);
    expect(compiled.project.scene.panoOrigin).toEqual([0, 1.65, 0]);
    expect(compiled.project.shots[0].camera.position).toEqual([0, 1.65, 0]);
  });

  it('defaults pano origin when omitted', () => {
    const compiled = compileSetBlueprint(minimalSetBlueprint);
    expect(compiled.project.scene.panoOrigin[1]).toBe(DEFAULT_CAMERA_HEIGHT_METERS);
  });

  it('leaves panoRefs and assets empty and resets workflow', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    expect(compiled.project.panoRefs).toEqual([]);
    expect(compiled.project.assets.assets).toEqual({});
    expect(compiled.project.workflow.shotFramingAcceptedAtByShotId).toEqual({});
    expect(compiled.project.settings.projectedStyle?.panoId).toBeUndefined();
  });

  it('sets the project description from the blueprint', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    expect(compiled.project.description).toBe(complexSetBlueprint.description);
  });

  it('removes the starter temple scene', () => {
    const compiled = compileSetBlueprint(minimalSetBlueprint);
    expect(compiled.project.scene.objects.some((object) => object.name === 'Ground Slab')).toBe(false);
    expect(compiled.project.scene.objects.some((object) => object.name === 'Main Temple Gate')).toBe(false);
    expect(compiled.project.landmarks.some((landmark) => landmark.name === 'main_temple_gate')).toBe(false);
  });

  it('is geometrically deterministic aside from IDs and timestamps', () => {
    const a = compileSetBlueprint(trainStationBlueprint);
    const b = compileSetBlueprint(trainStationBlueprint);
    expect(a.project.scene.objects.map((object) => ({
      name: object.name,
      type: object.type,
      position: object.transform.position,
      rotation: object.transform.rotation,
      scale: object.transform.scale,
      dimensions: object.dimensions,
      stagingRole: object.stagingRole,
    }))).toEqual(b.project.scene.objects.map((object) => ({
      name: object.name,
      type: object.type,
      position: object.transform.position,
      rotation: object.transform.rotation,
      scale: object.transform.scale,
      dimensions: object.dimensions,
      stagingRole: object.stagingRole,
    })));
    expect(a.project.id).not.toBe(b.project.id);
  });

  it('produces a project that passes native parse/serialize round-trip', () => {
    const compiled = compileSetBlueprint(complexSetBlueprint);
    const json = serializeProject(compiled.project);
    const reparsed = parseProject(json);
    expect(reparsed.scene.objects).toHaveLength(compiled.project.scene.objects.length);
    expect(reparsed.shots).toHaveLength(1);
    expect(reparsed.landmarks).toHaveLength(compiled.project.landmarks.length);
    expect(Object.keys(reparsed.assets.assets)).toHaveLength(0);
    expect(reparsed.panoRefs).toHaveLength(0);
  });

  it('does not carry projectedStyle pano IDs from preference settings', () => {
    const compiled = compileSetBlueprint(minimalSetBlueprint, {
      preferenceSettings: {
        defaultShotWidth: 1920,
        defaultShotHeight: 1080,
      },
    });
    expect(compiled.project.settings.defaultShotWidth).toBe(1920);
    expect(compiled.project.settings.projectedStyle?.panoId).toBeUndefined();
    expect(compiled.project.settings.projectedStyle?.secondaryPanoId).toBeUndefined();
  });

  it('returns scene bounds covering generated objects', () => {
    const compiled = compileSetBlueprint(minimalSetBlueprint);
    expect(compiled.bounds.min[0]).toBeLessThan(0);
    expect(compiled.bounds.max[0]).toBeGreaterThan(0);
    expect(compiled.bounds.max[1]).toBeCloseTo(0);
  });

  it('compiles validated parse output end-to-end', () => {
    const parsed = parseSetBlueprint(trainStationBlueprint);
    expect(parsed.blueprint).toBeDefined();
    const compiled = compileSetBlueprint(parsed.blueprint!);
    expect(compiled.project.name).toContain('Train Station');
    expect(compiled.project.scene.objects.filter((object) => object.type === 'column')).toHaveLength(4);
  });
});
