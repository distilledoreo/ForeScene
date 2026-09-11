import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { parseAgentCliArgs } from '../scripts/agent/cliArgs';
import { sourceFixture, sourceFixtureGlb } from './fixtures/source-model-fixture';
import { createDefaultProject } from '../src/domain/defaults';
import { importModelIntoProject } from '../src/engine/modelImportService';
import { ensureSourceModelsForProject, resetSourceModelRuntimeForTests } from '../src/engine/sourceModelRuntime';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';

beforeAll(() => {
  if (typeof ProgressEvent === 'undefined') vi.stubGlobal('ProgressEvent', class extends Event { constructor(type: string) { super(type); } });
});
beforeEach(() => {
  const project = createDefaultProject(); project.scene.objects = [];
  useProjectStore.getState().setProject(project);
  useProjectSafetyStore.setState({ runDestructiveProjectMutation: async (_reason, mutation) => { await mutation(); return undefined; } });
});
afterEach(() => {
  useProjectSafetyStore.setState({ runDestructiveProjectMutation: undefined });
  resetSourceModelRuntimeForTests(); resetModelAssetStoreForTests();
});

describe('preserved-source project commit boundary', () => {
  it('reuses every original selection, not only the first object', async () => {
    const job = { kind: 'file' as const, file: new File([sourceFixtureGlb()], 'scene.glb') };
    const first = await importModelIntoProject(job, { mode: 'separate' });
    const second = await importModelIntoProject(job, { mode: 'separate' });
    expect(second.reused).toBe(true);
    expect(second.items.map((item) => item.object.id)).toEqual(first.items.map((item) => item.object.id));
    expect(second.items).toHaveLength(2);
    expect(useProjectStore.getState().project.scene.objects).toHaveLength(2);
    expect(useProjectStore.getState().selectedObjectIds).toHaveLength(2);
  });
  it('does not mistake a combined import or partial deletion for a complete separate import', async () => {
    const job = { kind: 'file' as const, file: new File([sourceFixtureGlb()], 'scene.glb') };
    await importModelIntoProject(job, { mode: 'combined' });
    const separate = await importModelIntoProject(job, { mode: 'separate' });
    expect(separate.reused).not.toBe(true); expect(separate.items).toHaveLength(2);
    useProjectStore.setState((state) => ({ project: { ...state.project, scene: { ...state.project.scene,
      objects: state.project.scene.objects.filter((object) => object.id !== separate.items[1].object.id) } } }));
    const complete = await importModelIntoProject(job, { mode: 'separate' });
    expect(complete.reused).not.toBe(true); expect(complete.items).toHaveLength(2);
  });
  it('reuses identical source-and-companion packages and retains all their selections', async () => {
    const fixture = sourceFixture({ external: true });
    const job = { kind: 'file' as const, file: new File([fixture.text], 'scene.gltf'), resources: [new File([fixture.buffer], 'mesh.bin')] };
    const first = await importModelIntoProject(job, { mode: 'separate' });
    const second = await importModelIntoProject(job, { mode: 'separate' });
    expect(second.reused).toBe(true);
    expect(second.items.map((item) => item.object.id)).toEqual(first.items.map((item) => item.object.id));
    await ensureSourceModelsForProject(useProjectStore.getState().project);
  });
  it('restores the document if persistence fails after the import mutation', async () => {
    const before = structuredClone(useProjectStore.getState().project);
    useProjectSafetyStore.setState({ runDestructiveProjectMutation: async (_reason, mutation) => { await mutation(); throw new Error('Simulated storage failure'); } });
    await expect(importModelIntoProject({ kind: 'file', file: new File([sourceFixtureGlb()], 'scene.glb') }, { mode: 'separate' })).rejects.toThrow('storage failure');
    expect(useProjectStore.getState().project).toEqual(before);
  });
  it('does not reuse a destructive graybox conversion when preservation is requested', async () => {
    const job = { kind: 'file' as const, file: new File([sourceFixtureGlb()], 'scene.glb') };
    await importModelIntoProject(job, { mode: 'combined', preservation: 'graybox' });
    const source = await importModelIntoProject(job, { mode: 'combined' });
    expect(source.reused).not.toBe(true);
    expect(source.items[0].asset.metadata?.modelEncoding).toBe('source');
  });
});

describe('source import CLI options', () => {
  it('accepts repeated companion files, preservation and grouping choices', () => {
    const args = parseAgentCliArgs(['import-model', '--file', 'scene.gltf', '--resource', 'scene.bin', '--resource', 'paint.png', '--preservation', 'preserve', '--mode', 'combined']);
    expect(args.resources).toEqual(['scene.bin', 'paint.png']); expect(args.preservation).toBe('preserve'); expect(args.mode).toBe('combined');
  });
  it('rejects invalid preservation and missing companion paths', () => {
    expect(() => parseAgentCliArgs(['import-model', '--preservation', 'discard'])).toThrow(/preservation/);
    expect(() => parseAgentCliArgs(['import-model', '--resource', '--write'])).toThrow(/resource/);
    expect(() => parseAgentCliArgs(['frame', '--resource', 'data.bin'])).toThrow(/only by import-model/);
  });
});
