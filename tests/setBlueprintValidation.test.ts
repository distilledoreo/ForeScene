import { describe, expect, it } from 'vitest';
import {
  SET_BLUEPRINT_LIMITS,
  SET_BLUEPRINT_OBJECT_TYPES,
} from '../src/domain/setBlueprint';
import { parseSetBlueprint } from '../src/engine/setBlueprintValidation';
import {
  complexSetBlueprint,
  minimalSetBlueprint,
  trainStationBlueprint,
} from './fixtures/setBlueprints';

describe('parseSetBlueprint', () => {
  it('parses a valid minimal blueprint without mutating the input', () => {
    const frozen = structuredClone(minimalSetBlueprint);
    const result = parseSetBlueprint(frozen);
    expect(result.errors).toEqual([]);
    expect(result.blueprint).toBeDefined();
    expect(result.blueprint?.name).toBe('Minimal Floor');
    expect(result.blueprint?.objects).toHaveLength(1);
    expect(frozen).toEqual(minimalSetBlueprint);
  });

  it('parses a valid complex blueprint', () => {
    const result = parseSetBlueprint(complexSetBlueprint);
    expect(result.errors).toEqual([]);
    expect(result.blueprint?.objects.length).toBe(complexSetBlueprint.objects.length);
    expect(result.blueprint?.landmarks?.length).toBe(3);
    expect(result.blueprint?.assumptions).toHaveLength(2);
  });

  it('parses the train-station definition-of-done fixture', () => {
    const result = parseSetBlueprint(trainStationBlueprint);
    expect(result.errors).toEqual([]);
    expect(result.blueprint?.objects.some((object) => object.type === 'human_dummy')).toBe(true);
  });

  it('rejects unknown primitive types', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        {
          key: 'weird',
          name: 'Weird',
          type: 'spaceship',
          position: [0, 0, 0],
          dimensions: [1, 1, 1],
        },
      ],
    });
    expect(result.blueprint).toBeUndefined();
    expect(result.errors.some((error) => error.code === 'object_type_unknown')).toBe(true);
    expect(result.errors[0]?.path).toContain('objects[0].type');
  });

  it('rejects imported_model', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        {
          key: 'mesh',
          name: 'Mesh',
          type: 'imported_model',
          position: [0, 0, 0],
          dimensions: [1, 1, 1],
        },
      ],
    });
    expect(result.errors.some((error) => error.code === 'imported_model_forbidden')).toBe(true);
  });

  it('rejects duplicate object keys', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        { key: 'a', name: 'One', type: 'box', position: [0, 0, 0], dimensions: [1, 1, 1] },
        { key: 'a', name: 'Two', type: 'box', position: [1, 0, 0], dimensions: [1, 1, 1] },
      ],
    });
    expect(result.errors.some((error) => error.code === 'duplicate_object_key')).toBe(true);
  });

  it('rejects landmarks that link to missing objects', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      landmarks: [
        { key: 'lm', displayName: 'Ghost', linkedObjectKey: 'missing' },
      ],
    });
    expect(result.errors.some((error) => error.code === 'landmark_link')).toBe(true);
  });

  it('rejects NaN and infinite values', () => {
    const nanResult = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        {
          key: 'bad',
          name: 'Bad',
          type: 'box',
          position: [Number.NaN, 0, 0],
          dimensions: [1, 1, 1],
        },
      ],
    });
    expect(nanResult.errors.some((error) => error.code === 'vec3_finite')).toBe(true);

    const infResult = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        {
          key: 'bad',
          name: 'Bad',
          type: 'box',
          position: [0, 0, 0],
          dimensions: [1, Number.POSITIVE_INFINITY, 1],
        },
      ],
    });
    expect(infResult.errors.some((error) => error.code === 'vec3_finite')).toBe(true);
  });

  it('rejects negative and out-of-range dimensions', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        {
          key: 'bad',
          name: 'Bad',
          type: 'box',
          position: [0, 0, 0],
          dimensions: [1, -2, 1],
        },
      ],
    });
    expect(result.errors.some((error) => error.code === 'dimension_range')).toBe(true);
  });

  it('rejects excessive object counts', () => {
    const objects = Array.from({ length: SET_BLUEPRINT_LIMITS.maxObjects + 1 }, (_, index) => ({
      key: `obj_${index}`,
      name: `Object ${index}`,
      type: 'box' as const,
      position: [0, 0, 0] as [number, number, number],
      dimensions: [1, 1, 1] as [number, number, number],
    }));
    const result = parseSetBlueprint({
      schemaVersion: 1,
      name: 'Too Many',
      units: 'meters',
      objects,
    });
    expect(result.errors.some((error) => error.code === 'objects_limit')).toBe(true);
  });

  it('rejects malformed colors', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        {
          key: 'colored',
          name: 'Colored',
          type: 'box',
          position: [0, 0, 0],
          dimensions: [1, 1, 1],
          surface: { style: 'solid', color: 'red' },
        },
      ],
    });
    expect(result.errors.some((error) => error.code === 'color_format')).toBe(true);
  });

  it('rejects missing schema version', () => {
    const { schemaVersion: _ignored, ...withoutVersion } = minimalSetBlueprint;
    const result = parseSetBlueprint(withoutVersion);
    expect(result.errors.some((error) => error.code === 'schema_version')).toBe(true);
  });

  it('extracts JSON surrounded by model prose and markdown fences', () => {
    const fenced = `Sure! Here is the set:\n\`\`\`json\n${JSON.stringify(minimalSetBlueprint)}\n\`\`\`\nHope that helps.`;
    const result = parseSetBlueprint(fenced);
    expect(result.errors).toEqual([]);
    expect(result.blueprint?.name).toBe('Minimal Floor');
  });

  it('auto-repairs Markdown-style escapes like \\[ and \\_ with a warning', () => {
    const mangled = [
      '{',
      '  "schemaVersion": 1,',
      '  "name": "Hall",',
      '  "units": "meters",',
      '  "panoOrigin": \\[0, 1.65, 0],',
      '  "objects": [',
      '    {',
      '      "key": "hall\\_floor",',
      '      "name": "Hall Floor",',
      '      "type": "floor",',
      '      "position": \\[0, 0, 0],',
      '      "dimensions": \\[8, 0.08, 6]',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    const result = parseSetBlueprint(mangled);
    expect(result.errors).toEqual([]);
    expect(result.blueprint?.name).toBe('Hall');
    expect(result.blueprint?.objects[0].key).toBe('hall_floor');
    expect(result.blueprint?.panoOrigin).toEqual([0, 1.65, 0]);
    expect(result.warnings.some((warning) => warning.code === 'json_markdown_escapes_repaired')).toBe(true);
  });

  it('reports line and column for unrepaired invalid escapes', () => {
    const mangled = [
      '{',
      '  "schemaVersion": 1,',
      '  "name": "Broken",',
      '  "units": "meters",',
      '  "objects": [',
      '    {',
      '      "key": "x",',
      '      "name": "X",',
      '      "type": "box",',
      '      "position": [0, 0, 0],',
      '      "dimensions": [1, 1, 1],',
      '      "surface": { "style": "solid", "color": "\\qffffff" }',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    const result = parseSetBlueprint(mangled);
    expect(result.blueprint).toBeUndefined();
    const diagnostic = result.errors.find((error) => error.code === 'json_markdown_escape');
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.message).toMatch(/Invalid JSON escape \\q at line \d+, column \d+/);
  });

  it('applies documented defaults by omitting optional fields rather than inventing them', () => {
    const result = parseSetBlueprint(minimalSetBlueprint);
    expect(result.blueprint?.objects[0].rotation).toBeUndefined();
    expect(result.blueprint?.objects[0].scale).toBeUndefined();
    expect(result.blueprint?.landmarks).toBeUndefined();
    expect(result.blueprint?.panoOrigin).toBeUndefined();
  });

  it('warns about extreme scale without rejecting', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        {
          key: 'huge',
          name: 'Huge',
          type: 'box',
          position: [0, 0, 0],
          scale: [50, 1, 1],
          dimensions: [1, 1, 1],
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((warning) => warning.code === 'scale_extreme')).toBe(true);
  });

  it('rejects positions outside the coordinate range', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      objects: [
        {
          key: 'far',
          name: 'Far',
          type: 'box',
          position: [SET_BLUEPRINT_LIMITS.maxPositionMeters + 1, 0, 0],
          dimensions: [1, 1, 1],
        },
      ],
    });
    expect(result.errors.some((error) => error.code === 'position_range')).toBe(true);
  });

  it('rejects empty project and object names', () => {
    const result = parseSetBlueprint({
      ...minimalSetBlueprint,
      name: '   ',
      objects: [
        {
          key: 'a',
          name: '',
          type: 'box',
          position: [0, 0, 0],
          dimensions: [1, 1, 1],
        },
      ],
    });
    expect(result.errors.some((error) => error.path === 'name')).toBe(true);
    expect(result.errors.some((error) => error.path === 'objects[0].name')).toBe(true);
  });

  it('keeps every allowlisted primitive type parseable', () => {
    const objects = SET_BLUEPRINT_OBJECT_TYPES.map((type, index) => ({
      key: `t_${type}`,
      name: type,
      type,
      position: [index, 0, 0] as [number, number, number],
      dimensions: [1, 1, 1] as [number, number, number],
    }));
    const result = parseSetBlueprint({
      schemaVersion: 1,
      name: 'All Types',
      units: 'meters',
      objects,
    });
    expect(result.errors).toEqual([]);
    expect(result.blueprint?.objects).toHaveLength(SET_BLUEPRINT_OBJECT_TYPES.length);
  });
});
