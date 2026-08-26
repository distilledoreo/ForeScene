import { describe, expect, it } from 'vitest';
import { centerTransformForFootPlant } from '../src/engine/groundPivot';

describe('centerTransformForFootPlant', () => {
  it('drops a center-staged root by the lean-induced foot rise', () => {
    const planted = centerTransformForFootPlant([0, 0.875, -5.3], [34, 0, 0], 1.75);
    expect(planted[0]).toBe(0);
    expect(planted[2]).toBe(-5.3);
    expect(planted[1]).toBeLessThan(0.875);
    expect(planted[1]).toBeGreaterThan(0.7);
  });

  it('leaves upright subjects at their authored origin', () => {
    expect(centerTransformForFootPlant([0, 0.875, 0], [0, 25, 0], 1.75)).toEqual([0, 0.875, 0]);
  });
});
