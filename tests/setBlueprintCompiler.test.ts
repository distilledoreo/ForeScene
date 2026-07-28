import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_HEIGHT_METERS } from '../src/domain/defaults';
import { compileSetBlueprint } from '../src/engine/setBlueprintCompiler';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import { parseSetBlueprint } from '../src/engine/setBlueprintValidation';
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
