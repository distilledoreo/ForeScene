import { describe, expect, it } from 'vitest';
import { SET_BLUEPRINT_OBJECT_TYPES } from '../src/domain/setBlueprint';
import { buildSetBlueprintSystemPrompt, describeSetBlueprintSchema } from '../src/engine/setBlueprintPrompt';
import {
  HttpSetGenerationProvider,
  ManualSetGenerationProvider,
  generateValidatedSet,
} from '../src/engine/setGenerationProvider';
import { parseSetBlueprint } from '../src/engine/setBlueprintValidation';
import { minimalSetBlueprint } from './fixtures/setBlueprints';

describe('set blueprint prompt contract', () => {
  it('mentions every allowlisted primitive in the system prompt and schema description', () => {
    const prompt = buildSetBlueprintSystemPrompt();
    const schema = describeSetBlueprintSchema();
    for (const type of SET_BLUEPRINT_OBJECT_TYPES) {
      expect(prompt).toContain(type);
      expect(schema).toContain(type);
    }
    expect(prompt).toContain('JSON only');
    expect(prompt).toContain('imported_model');
    expect(prompt).toMatch(/Do not escape brackets, underscores/i);
    expect(prompt).not.toMatch(/```/);
  });

  it('keeps validator allowlist and prompt primitives identical', () => {
    const prompt = buildSetBlueprintSystemPrompt();
    for (const type of SET_BLUEPRINT_OBJECT_TYPES) {
      expect(prompt.includes(type)).toBe(true);
      const parsed = parseSetBlueprint({
        schemaVersion: 1,
        name: 'Probe',
        units: 'meters',
        objects: [
          {
            key: type,
            name: type,
            type,
            position: [0, 0, 0],
            dimensions: [1, 1, 1],
          },
        ],
      });
      expect(parsed.errors).toEqual([]);
    }
  });
});

describe('setGenerationProvider', () => {
  it('exposes a manual provider with copyable prompts', () => {
    const provider = new ManualSetGenerationProvider();
    expect(provider.id).toBe('manual');
    expect(provider.getSystemPrompt()).toContain('SetBlueprint');
    expect(provider.getUserPrompt({ description: 'A small room' })).toContain('A small room');
  });

  it('HTTP provider posts to the configured endpoint and unwraps blueprint payloads', async () => {
    const fetchImpl: typeof fetch = async () => new Response(
      JSON.stringify({ blueprint: minimalSetBlueprint }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const provider = new HttpSetGenerationProvider({
      endpoint: 'https://example.test/api/generate-set',
      fetchImpl,
    });
    const payload = await provider.generateSet({ description: 'test' });
    expect(payload).toEqual(minimalSetBlueprint);
  });

  it('validation-repair loop retries once then surfaces remaining errors', async () => {
    let calls = 0;
    const provider = {
      id: 'mock',
      label: 'Mock',
      async generateSet() {
        calls += 1;
        return { schemaVersion: 1, name: 'Bad', units: 'meters', objects: [] };
      },
      async repairSet() {
        calls += 1;
        return {
          schemaVersion: 1,
          name: 'Still Bad',
          units: 'meters',
          objects: [
            {
              key: 'x',
              name: 'X',
              type: 'imported_model',
              position: [0, 0, 0],
              dimensions: [1, 1, 1],
            },
          ],
        };
      },
    };

    const result = await generateValidatedSet({
      provider: provider as never,
      request: { description: 'fix' },
      repairOnce: true,
    });

    expect(calls).toBe(2);
    expect(result.repaired).toBe(true);
    expect(result.blueprint).toBeUndefined();
    expect(result.parse.errors.some((error) => error.code === 'imported_model_forbidden')).toBe(true);
    expect(result.rawOutputs).toHaveLength(2);
  });

  it('accepts a valid first response without repairing', async () => {
    const provider = {
      id: 'mock',
      label: 'Mock',
      async generateSet() {
        return minimalSetBlueprint;
      },
    };
    const result = await generateValidatedSet({
      provider,
      request: { description: 'ok' },
    });
    expect(result.repaired).toBe(false);
    expect(result.blueprint?.name).toBe('Minimal Floor');
  });
});
