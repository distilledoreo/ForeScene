import { describe, expect, it } from 'vitest';
import { createSceneObject } from '../src/domain/defaults';
import {
  rotateSelectedObjects,
  scaleSelectedObjects,
  selectionBounds,
  selectionPivot,
  toggleSelectedId,
  translateSelectedObjects,
} from '../src/engine/buildSelection';

describe('Build multi-selection math', () => {
  it('toggles ordered selection without duplicates', () => {
    expect(toggleSelectedId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelectedId(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('translates a selected set while preserving unselected objects', () => {
    const a = createSceneObject('box', 1);
    const b = createSceneObject('box', 2);
    a.transform.position = [0, 0, 0];
    b.transform.position = [2, 0.5, 0];
    const moved = translateSelectedObjects([a, b], [a.id], [1, 0, -1], false);
    expect(moved[0].transform.position).toEqual([1, 0, -1]);
    expect(moved[1]).toBe(b);
  });

  it('rotates and scales around the shared bounds center', () => {
    const a = createSceneObject('box', 1);
    const b = createSceneObject('box', 2);
    a.transform.position = [-1, 0, 0];
    b.transform.position = [1, 0, 0];
    expect(selectionPivot([a, b])).toEqual([0, 0, 0]);

    const rotated = rotateSelectedObjects([a, b], [a.id, b.id], 'y', 180, [0, 0, 0]);
    expect(rotated[0].transform.position[0]).toBeCloseTo(1);
    expect(rotated[1].transform.position[0]).toBeCloseTo(-1);
    expect(rotated.map((object) => object.transform.rotation[1])).toEqual([180, 180]);

    const scaled = scaleSelectedObjects([a, b], [a.id, b.id], [2, 1, 2], [0, 0, 0]);
    expect(scaled.map((object) => object.transform.position[0])).toEqual([-2, 2]);
    expect(scaled[0].dimensions[0]).toBe(a.dimensions[0] * 2);
  });

  it('keeps the store-safe pivot identical to Three.js transformed bounds', () => {
    const a = createSceneObject('box', 1);
    const b = createSceneObject('arch', 2);
    a.transform.position = [-1.2, 0.4, 2.7];
    a.transform.rotation = [27, -41, 13];
    a.transform.scale = [1.3, 0.7, 1.8];
    b.transform.position = [3.1, -0.6, -1.4];
    b.transform.rotation = [-18, 63, 31];
    b.transform.scale = [0.8, 1.6, 0.9];

    const bounds = selectionBounds([a, b]);
    const expected = [
      (bounds.min.x + bounds.max.x) / 2,
      (bounds.min.y + bounds.max.y) / 2,
      (bounds.min.z + bounds.max.z) / 2,
    ];
    const actual = selectionPivot([a, b]);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 10));
  });
});
