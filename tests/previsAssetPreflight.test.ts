import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { expectedObjectTypeForAsset, preflightProductionAssets } from '../src/engine/previs/assetPreflight';
import { parsePrevisProductionManifest } from '../src/engine/previs/manifestValidation';
import { compileAndPreflightBenchmarkInput } from '../scripts/benchmark/compileProductionInput';
import type { BenchmarkSpecV1 } from '../scripts/benchmark/types';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function baseManifest(assets: unknown[]) {
  return {
    version: 2 as const,
    project: { name: 'Asset preflight', aspectRatio: '16:9' as const },
    locations: [{ id: 'stage', name: 'Stage', template: 'empty_stage' as const }],
    cast: [],
    assets,
    shots: [{
      id: 's1',
      shotNumber: '01',
      name: 'Subject',
      description: 'Ordinary model as subject.',
      locationId: 'stage',
      subjects: ['hand-monster'],
      camera: { template: 'medium' as const, subjects: ['hand-monster'] },
    }],
  };
}

describe('production asset preflight', () => {
  it('keeps a nonhumanoid GLB subject as imported_model and hashes the source', async () => {
    const source = path.join(repoRoot, 'tests/fixtures/ordinary-cube.glb');
    const parsed = parsePrevisProductionManifest(baseManifest([{
      id: 'hand-monster',
      type: 'imported_model',
      source,
      importMode: 'ordinary_model',
      semanticRole: 'subject',
      required: true,
    }]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.assets?.[0]).toMatchObject({
      type: 'imported_model',
      semanticRole: 'subject',
      importMode: 'ordinary_model',
    });
    expect(expectedObjectTypeForAsset(parsed.manifest!.assets![0]!)).toBe('imported_model');

    const preflight = await preflightProductionAssets(parsed.manifest!, source);
    expect(preflight.ok).toBe(true);
    expect(preflight.assets[0]?.expectedObjectType).toBe('imported_model');
    expect(preflight.assets[0]?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a missing required source before mutation and does not invent a character', async () => {
    const parsed = parsePrevisProductionManifest(baseManifest([{
      id: 'hand-monster',
      type: 'imported_model',
      source: './missing-monster.glb',
      importMode: 'ordinary_model',
      semanticRole: 'subject',
      required: true,
    }]));
    expect(parsed.errors).toEqual([]);
    const preflight = await preflightProductionAssets(parsed.manifest!, path.join(repoRoot, 'examples/previs/minimal-dialogue.json'));
    expect(preflight.ok).toBe(false);
    expect(preflight.errors.some((error) => error.code === 'missing_asset_source')).toBe(true);
    expect(preflight.assets[0]?.expectedObjectType).toBe('imported_model');
  });

  it('rejects a missing rig only for declared characters, not ordinary models', async () => {
    const character = parsePrevisProductionManifest(baseManifest([{
      id: 'hand-monster',
      type: 'imported_character',
      source: './characters/lead.glb',
      importMode: 'saved_rig',
      semanticRole: 'character',
      required: true,
    }]));
    expect(character.errors.some((error) => error.code === 'missing_saved_rig_package')).toBe(true);

    const modelWithRig = parsePrevisProductionManifest(baseManifest([{
      id: 'hand-monster',
      type: 'imported_model',
      source: './models/monster.glb',
      semanticRole: 'subject',
      rigPackage: './models/monster.fsrig',
    }]));
    expect(modelWithRig.errors.some((error) => error.code === 'unexpected_character_rig')).toBe(true);
  });

  it('compiles a benchmark spec into a preflighted production manifest the candidate does not author', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'forescene-bench-manifest-'));
    const glb = path.join(work, 'Hand_Monster.glb');
    await writeFile(glb, await (await import('node:fs/promises')).readFile(path.join(repoRoot, 'tests/fixtures/ordinary-cube.glb')));
    const specPath = path.join(work, 'spec.json');
    const spec: BenchmarkSpecV1 = {
      version: 1,
      id: 'monster',
      name: 'Monster subject',
      description: 'Ordinary GLB as subject',
      qualityMode: 'rapid-previs',
      operatingMode: 'greenfield',
      writeAuthorized: true,
      resetAuthorized: true,
      repairBudget: 0,
      requiredCliCapabilities: ['project.inspect'],
      semanticSubjectBindings: [{ semanticId: 'hand-monster', name: 'Hand Monster', stagingRole: 'subject' }],
      assets: [{ id: 'hand-monster', path: 'Hand_Monster.glb', kind: 'glb' }],
      shots: [{
        id: 's010',
        shotNumber: '010',
        name: 'Monster',
        description: 'Readable subject.',
        intent: 'still',
        requiredSubjects: ['hand-monster'],
        stillArtifacts: ['010.png'],
      }],
    };
    const outputManifestPath = path.join(work, 'harness', 'production-manifest.json');
    const compiled = await compileAndPreflightBenchmarkInput({ spec, specPath, outputManifestPath });
    expect(compiled.parsedOk).toBe(true);
    expect(compiled.preflight.ok).toBe(true);
    expect(path.isAbsolute(compiled.manifest.assets?.[0]?.source ?? '')).toBe(true);
    expect(compiled.manifest.assets?.[0]?.source).toBe(glb);
    expect(compiled.manifest.assets?.[0]).toMatchObject({
      id: 'hand-monster',
      type: 'imported_model',
      importMode: 'ordinary_model',
      semanticRole: 'subject',
    });
    expect(compiled.preflight.assets[0]?.expectedObjectType).toBe('imported_model');

    const written = JSON.parse(await readFile(outputManifestPath, 'utf8')) as typeof compiled.manifest;
    const writtenPreflight = await preflightProductionAssets(written, outputManifestPath);
    expect(writtenPreflight.ok, writtenPreflight.errors.map((error) => error.message).join('; ')).toBe(true);
    expect(writtenPreflight.assets[0]?.sourcePath).toBe(glb);
  });

  it('preflights a written saved-rig manifest that only has a rig package', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'forescene-bench-fsrig-'));
    const rig = path.join(work, 'lead.fsrig');
    await writeFile(rig, 'fsrig-fixture');
    const specPath = path.join(work, 'spec.json');
    const spec: BenchmarkSpecV1 = {
      version: 1,
      id: 'saved-rig',
      name: 'Saved rig character',
      description: 'Character-role spec with only an .fsrig package',
      qualityMode: 'rapid-previs',
      operatingMode: 'greenfield',
      writeAuthorized: true,
      resetAuthorized: true,
      repairBudget: 0,
      requiredCliCapabilities: ['character.importSavedRig'],
      semanticSubjectBindings: [{ semanticId: 'lead', name: 'Lead', stagingRole: 'character' }],
      assets: [{ id: 'lead', path: 'lead.fsrig', kind: 'fsrig' }],
      shots: [{
        id: 's010',
        shotNumber: '010',
        name: 'Lead',
        description: 'Character.',
        intent: 'still',
        requiredSubjects: ['lead'],
        stillArtifacts: ['010.png'],
      }],
    };
    const outputManifestPath = path.join(work, 'harness', 'production-manifest.json');
    const compiled = await compileAndPreflightBenchmarkInput({ spec, specPath, outputManifestPath });
    expect(compiled.parsedOk).toBe(true);
    expect(compiled.preflight.ok, compiled.preflight.errors.map((error) => error.message).join('; ')).toBe(true);
    expect(compiled.manifest.assets?.[0]).toMatchObject({
      id: 'lead',
      type: 'saved_rig',
      rigPackage: rig,
    });
    expect(compiled.manifest.assets?.[0]?.source).toBeUndefined();
    const written = JSON.parse(await readFile(outputManifestPath, 'utf8')) as typeof compiled.manifest;
    const writtenPreflight = await preflightProductionAssets(written, outputManifestPath);
    expect(writtenPreflight.ok, writtenPreflight.errors.map((error) => error.message).join('; ')).toBe(true);
    expect(writtenPreflight.assets[0]?.rigPackagePath).toBe(rig);
  });
});
