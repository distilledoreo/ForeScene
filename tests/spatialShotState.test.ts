import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  effectiveObjectWorldAabb,
  identifyFloorY,
  objectFloorContactPosition,
} from '../src/engine/agent/spatialShotState';

describe('Agent subject floor contact', () => {
  it('uses a centered person’s feet rather than its center height', () => {
    const person = createSceneObject('human_dummy');
    person.transform.position = [2, 0.875, 1];
    expect(objectFloorContactPosition(person)).toEqual([2, 0, 1]);
  });

  it('uses transformed bounds for a rotated and scaled object', () => {
    const box = createSceneObject('box');
    box.transform.position = [3, 2, -1];
    box.transform.rotation = [0, 0, 45];
    box.transform.scale = [1, 1.5, 1];
    const bounds = effectiveObjectWorldAabb(box);
    const anchor = objectFloorContactPosition(box);
    expect(anchor[1]).toBeCloseTo(bounds.min[1]);
    expect(anchor[1]).toBeLessThan(box.transform.position[1]);
  });

  it('selects the supporting story at the object feet, not the highest overlapping floor', () => {
    const lower = createSceneObject('floor', 1);
    lower.dimensions = [8, 0.2, 8];
    lower.transform.position = [0, -0.1, 0];
    const upper = createSceneObject('floor', 2);
    upper.dimensions = [8, 0.2, 8];
    upper.transform.position = [0, 2.9, 0];
    const person = createSceneObject('human_dummy');
    const project = createDefaultProject();
    project.scene.objects = [lower, upper, person];

    person.transform.position = [0, 0.875, 0];
    expect(identifyFloorY(project, objectFloorContactPosition(person))).toBeCloseTo(0);
    person.transform.position = [0, 3.875, 0];
    expect(identifyFloorY(project, objectFloorContactPosition(person))).toBeCloseTo(3);
    upper.visible = false;
    expect(identifyFloorY(project, objectFloorContactPosition(person))).toBeCloseTo(0);
  });
});
