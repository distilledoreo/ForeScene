import { describe, expect, it } from 'vitest';
import { validateAgentSetBlueprint } from '../src/engine/agent/setBlueprintControl';
import { minimalSetBlueprint } from './fixtures/setBlueprints';

describe('Agent SetBlueprint validation', () => {
  it('reports parser and spatial warnings without marking a valid blueprint as failed', () => {
    const result = validateAgentSetBlueprint({
      blueprint: {
        ...minimalSetBlueprint,
        description: ' ',
        objects: [
          { key: 'door', name: 'Unhosted Door', type: 'doorway', position: [0, 0, 0], dimensions: [1, 2, 0.3] },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.objectCount).toBe(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'string_blank', severity: 'warning', path: 'description' }),
      expect.objectContaining({ code: 'doorway_unhosted', severity: 'warning', path: 'objects[0].position' }),
    ]));
  });

  it('keeps invalid host references as errors with field paths', () => {
    const result = validateAgentSetBlueprint({
      blueprint: {
        ...minimalSetBlueprint,
        objects: [
          { key: 'door', name: 'Door', type: 'doorway', position: [0, 0, 0], dimensions: [1, 2, 0.3], hostWallKey: 'missing' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'host_wall_key', severity: 'error', path: 'objects[0].hostWallKey' }),
    ]));
  });

  it('rejects a structurally valid blueprint with a spatial error', () => {
    const result = validateAgentSetBlueprint({
      blueprint: {
        ...minimalSetBlueprint,
        objects: [
          { key: 'slab', name: 'Upper Floor Slab', type: 'floor', position: [0, 3, 0], dimensions: [8, 3, 0.2] },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dimension_axis_mismatch', severity: 'error', path: 'objects[0]' }),
    ]));
  });

  it('preserves informational severity for unexplained intersections', () => {
    const result = validateAgentSetBlueprint({
      blueprint: {
        ...minimalSetBlueprint,
        objects: [
          { key: 'a', name: 'Box A', type: 'box', position: [0, 0, 0], dimensions: [2, 2, 2] },
          { key: 'b', name: 'Box B', type: 'box', position: [0.5, 0, 0], dimensions: [2, 2, 2] },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unexplained_solid_intersection', severity: 'info', path: 'objects[0]' }),
    ]));
  });
});
