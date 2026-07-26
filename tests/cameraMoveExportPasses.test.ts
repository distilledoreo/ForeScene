import { describe, expect, it } from 'vitest';
import {
  createCameraMoveExportPasses,
  getCameraMoveExportCompletionMessage,
  runCameraMoveExportPasses,
} from '../src/engine/cameraMoveExportPasses';

describe('camera-move export passes', () => {
  it('continues with clean-plate passes after a projected companion fails', async () => {
    const passes = createCameraMoveExportPasses(['with_people', 'clean_plate'], true);
    const attempted: string[] = [];
    const results = await runCameraMoveExportPasses(
      passes,
      async (pass) => {
        const label = `${pass.appearance}:${pass.peopleVariant}`;
        attempted.push(label);
        if (label === 'projected:clean_plate') throw new Error('projector unavailable');
        return label;
      },
      () => false,
    );

    expect(attempted).toEqual([
      'clay:with_people',
      'projected:with_people',
      'clay:clean_plate',
      'projected:clean_plate',
    ]);
    expect(results.completed).toHaveLength(3);
    expect(results.failures).toHaveLength(1);
    expect(getCameraMoveExportCompletionMessage(
      results.completed.length,
      passes.length,
      results.failures,
    )).toBe('Completed 3 of 4 outputs. Projected clean plate failed.');
  });
});
