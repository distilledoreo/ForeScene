import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBenchmarkRunLayout } from '../scripts/benchmark/layout';
import { collectIntentSolutionLeaks, loadV3AgentContract } from '../scripts/benchmark/v3AgentContract';
import { buildV3AgentProductionManifest, validateV3AgentCandidatePlan } from '../scripts/benchmark/v3AgentPlan';
import { runV3AgentDoctor } from '../scripts/benchmark/v3AgentDoctor';
import { isolatedModelEnvironment, prepareV3AgentRun, runV3Agent, v3AgentProductionInvocation } from '../scripts/benchmark/v3AgentRun';
import { compareV3AgentRuns } from '../scripts/benchmark/v3AgentCompare';
import { encodePngRgba } from '../scripts/benchmark/pngRgba';
import { parsePrevisProductionManifest } from '../src/engine/previs/manifestValidation';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repoRoot, 'benchmarks/panorama-triad-v3-agent/contract.json');
const liteContractPath = path.join(repoRoot, 'benchmarks/panorama-triad-v3-lite/contract.json');

async function fixtureInputRoot(options: { missing?: string } = {}): Promise<string> {
  const root = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-agent-input-'));
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'seed'), { recursive: true });
  const fixture = path.join(repoRoot, 'tests/fixtures/ordinary-cube.glb');
  for (const asset of ['Hand_Monster_v3.glb', 'Roman Joseph Amputated.glb', 'Roman Joseph Final.glb']) {
    if (asset !== options.missing) await copyFile(fixture, path.join(root, 'assets', asset));
  }
  for (const rig of ['Roman Joseph Amputated.fsrig', 'Roman Joseph Final.fsrig']) {
    if (rig !== options.missing) await writeFile(path.join(root, 'assets', rig), 'saved-rig-fixture');
  }
  await writeFile(path.join(root, 'seed', 'what_im_fighting_for_panorama_triad_base.fsp'), 'base-package');
  return root;
}

const cleanGit = {
  commit: 'fixture-commit',
  dirty: false,
  porcelain: '',
  expectedCommit: 'fixture-commit',
  expectedCommitIsAncestor: true,
  allowDirty: false,
};

function fakeFetch(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    text: async () => '<html><title>ForeScene</title><div id="root"></div></html>',
  })) as unknown as typeof fetch;
}

function passingDoctor(): typeof runV3AgentDoctor {
  return async (input) => ({
    report: {
      ok: true,
      checkedAt: new Date().toISOString(),
      contractPath: input.contractPath,
      inputRoot: input.inputRoot,
      url: input.url ?? '',
      profileDir: input.layout.profileDir,
      checks: [{ id: 'fixture', ok: true, message: 'fixture doctor pass' }],
    },
  });
}

function colorPng(r: number, g: number, b: number): Buffer {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return encodePngRgba({ width: 16, height: 16, data });
}

async function writeProductionArtifacts(env: NodeJS.ProcessEnv, color: Buffer): Promise<void> {
  const output = env.FORESCENE_OUTPUT!;
  const finalProject = env.FORESCENE_BENCHMARK_FINAL_PROJECT!;
  await mkdir(path.join(output, 'shots'), { recursive: true });
  await writeFile(path.join(output, 'shots', '01.png'), color);
  await writeFile(path.join(output, 'shots', '02-sample-0.png'), color);
  await writeFile(path.join(output, 'shots', '02-sample-1.png'), color);
  await writeFile(path.join(output, 'shots', '02-sample-2.png'), color);
  await writeFile(path.join(output, 'shots', '03.png'), color);
  await writeFile(path.join(output, 'contact-sheet.png'), color);
  const mp4 = Buffer.alloc(32);
  mp4.write('ftyp', 4, 'ascii');
  await writeFile(path.join(output, 'shots', '02.mp4'), mp4);
  await writeFile(finalProject, 'final-project');
}

describe('ForeScene Benchmark V3-Agent', () => {
  it('keeps candidate-facing intent free of solution-like fields', async () => {
    const loaded = await loadV3AgentContract(contractPath);
    expect(collectIntentSolutionLeaks(loaded.intent)).toEqual([]);
    expect(collectIntentSolutionLeaks({
      shots: [{ camera: { template: 'close_up', position: [101.2, 1.6, -2] } }],
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/camera/),
      expect.stringMatching(/template|position|coordinate/),
    ]));
    const task = await readFile(loaded.taskPath, 'utf8');
    expect(task).not.toMatch(/101\.2/);
    expect(task).not.toMatch(/fovDegrees/);
  });

  it('rejects candidate plans that change harness facts or invent extra fields', async () => {
    const loaded = await loadV3AgentContract(contractPath);
    const fakeA = JSON.parse(await readFile(path.join(repoRoot, 'scripts/benchmark/fixtures/v3AgentFakeA.plan.json'), 'utf8')) as {
      version: 1;
      shots: [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    };
    const parsed = validateV3AgentCandidatePlan(fakeA, loaded.contract);
    expect(parsed.ok).toBe(true);

    expect(validateV3AgentCandidatePlan({
      version: 1,
      shots: [
        { ...fakeA.shots[0], asset: 'different-character.glb' },
        fakeA.shots[1],
        fakeA.shots[2],
      ],
    }, loaded.contract).ok).toBe(false);

    expect(validateV3AgentCandidatePlan({
      version: 1,
      shots: [
        { ...fakeA.shots[0], camera: { ...(fakeA.shots[0].camera as object), template: 'not-a-template' } },
        fakeA.shots[1],
        fakeA.shots[2],
      ],
    }, loaded.contract).errors.join(' ')).toMatch(/template/);

    expect(validateV3AgentCandidatePlan({
      version: 1,
      shots: [fakeA.shots[0], { ...fakeA.shots[1], motion: { durationSeconds: 3, keyframes: [
        { timeSeconds: 1, camera: { position: [1, 1, 1] } },
        { timeSeconds: 3, camera: { position: [2, 2, 2] } },
      ] } }, fakeA.shots[2]],
    }, loaded.contract).errors.join(' ')).toMatch(/start at timeSeconds 0/);
  });

  it('builds a product production manifest from contract + intent + candidate plan', async () => {
    const loaded = await loadV3AgentContract(contractPath);
    const fakeA = JSON.parse(await readFile(path.join(repoRoot, 'scripts/benchmark/fixtures/v3AgentFakeA.plan.json'), 'utf8'));
    const plan = validateV3AgentCandidatePlan(fakeA, loaded.contract).plan!;
    const manifest = buildV3AgentProductionManifest(loaded.contract, loaded.intent, plan);
    expect(manifest.shots.map((shot) => shot.locationId)).toEqual(['ruins', 'corridor', 'armory']);
    expect(manifest.cast[0]?.type === 'imported_character' && manifest.cast[0].source).toBe('assets/Roman Joseph Amputated.glb');
    expect(manifest.shots[0]?.camera.template).toBe('close_up');
    expect(manifest.shots[1]?.motion?.durationSeconds).toBe(3);
    expect(manifest.shots[1]?.motion?.keyframes[0]?.timeSeconds).toBe(0);
    expect(manifest.shots[1]?.motion?.keyframes.at(-1)?.timeSeconds).toBe(3);
    const parsed = parsePrevisProductionManifest(manifest);
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest).toBeDefined();
  });

  it('blocks model execution when doctor finds a missing required asset', async () => {
    const inputRoot = await fixtureInputRoot({ missing: 'Hand_Monster_v3.glb' });
    const runRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-agent-doctor-'));
    const layout = await createBenchmarkRunLayout(runRoot);
    const loaded = await loadV3AgentContract(contractPath);
    let cliCalls = 0;
    const result = await runV3AgentDoctor({
      contractPath,
      inputRoot,
      url: 'https://forescene.test',
      layout,
      loaded,
      git: cleanGit,
      fetchImpl: fakeFetch(),
      runCli: async () => {
        cliCalls += 1;
        return { code: 0, stdout: '{}', stderr: '', envelope: { ok: true } as never };
      },
    });
    expect(result.failure).toBeDefined();
    expect(cliCalls).toBe(0);
    expect(result.report.checks.find((check) => check.id === 'asset.assets.hand-monster.source')?.ok).toBe(false);
    expect(result.report.checks.find((check) => check.id === 'manifest.motion')).toBeUndefined();

    let modelLaunches = 0;
    const blocked = await runV3Agent({
      contractPath,
      inputRoot,
      runRoot: path.join(await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-agent-block-')), 'run'),
      candidate: 'fake-a',
      modelRunner: async () => {
        modelLaunches += 1;
        return { code: 0, stdout: '', stderr: '', runtimeMs: 0, timedOut: false };
      },
    });
    expect(blocked.candidate).toBeUndefined();
    expect(modelLaunches).toBe(0);
  });

  it('isolates the model workspace from the Gold/V3-Lite solution and repo root', async () => {
    const inputRoot = await fixtureInputRoot();
    const prepared = await prepareV3AgentRun({
      contractPath,
      inputRoot,
      runRoot: path.join(await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-agent-prep-')), 'run'),
    });
    const env = isolatedModelEnvironment(prepared);
    expect(env.FORESCENE_AGENT_TASK).toBe(prepared.taskPath);
    expect(env.FORESCENE_AGENT_INTENT).toBe(prepared.intentPath);
    expect(env.FORESCENE_AGENT_PLAN).toBe(prepared.planPath);
    expect(env.FORESCENE_REPO_ROOT).toBeUndefined();
    expect(env.FORESCENE_BENCHMARK_MANIFEST).toBeUndefined();
    expect(env.FORESCENE_URL).toBeUndefined();
    const candidateFiles = (await (await import('node:fs/promises')).readdir(prepared.candidateDir)).sort();
    expect(candidateFiles).toEqual(['intent.json', 'plan-schema.json', 'task.md']);
    const intent = await readFile(prepared.intentPath, 'utf8');
    expect(intent).not.toMatch(/production-manifest/);
    expect(await readFile(liteContractPath, 'utf8')).toMatch(/manifestSha256/);
  });

  it('runs Fake A and Fake B through the real V3-Agent path with one model invocation and no auto-repair', async () => {
    const inputRoot = await fixtureInputRoot();
    const productionArgs = v3AgentProductionInvocation().args.join(' ');
    expect(productionArgs).toContain('--no-auto-repair');
    expect(productionArgs).not.toContain('--max-repair-passes');
    expect(await readFile(path.join(repoRoot, 'scripts/benchmark/v3LiteRun.ts'), 'utf8')).toContain("'--max-repair-passes', '2'");
    expect(await readFile(path.join(repoRoot, 'scripts/benchmark/entry.ts'), 'utf8')).not.toContain('v3Agent');

    const run = async (candidate: 'fake-a' | 'fake-b', color: Buffer) => {
      let launches = 0;
      const runRoot = path.join(await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), `forescene-v3-agent-${candidate}-`)), 'run');
      const result = await runV3Agent({
        contractPath,
        inputRoot,
        runRoot,
        url: 'https://forescene.test',
        candidate,
        doctorRunner: passingDoctor(),
        modelRunner: undefined,
        productionRunner: async ({ env }) => {
          expect(env.FORESCENE_BENCHMARK_MANIFEST).toBeDefined();
          expect(env.FORESCENE_BENCHMARK_MANIFEST).toContain('candidate-production-manifest.json');
          const manifest = JSON.parse(await readFile(env.FORESCENE_BENCHMARK_MANIFEST!, 'utf8')) as {
            shots: Array<{ camera: { template: string }; motion?: { keyframes: unknown[] } }>;
          };
          expect(manifest.shots[1]?.motion?.keyframes.length).toBeGreaterThanOrEqual(2);
          await writeProductionArtifacts(env, color);
          return { code: 0, stdout: '{}', stderr: '', runtimeMs: 5, timedOut: false };
        },
      });
      launches = result.candidate?.invocationCount ?? 0;
      return { result, launches, runRoot };
    };

    const red = colorPng(220, 30, 30);
    const blue = colorPng(30, 40, 220);
    const fakeA = await run('fake-a', red);
    const fakeB = await run('fake-b', blue);
    expect(fakeA.launches).toBe(1);
    expect(fakeB.launches).toBe(1);
    expect(fakeA.result.ok).toBe(true);
    expect(fakeB.result.ok).toBe(true);
    expect(fakeA.result.technical?.ok).toBe(true);
    expect(fakeB.result.technical?.ok).toBe(true);
    expect(fakeA.result.candidate?.invocationCount).toBe(1);

    const planA = JSON.parse(await readFile(path.join(fakeA.runRoot, 'candidate', 'candidate-plan.json'), 'utf8')) as { shots: Array<{ camera: { template: string } }> };
    const planB = JSON.parse(await readFile(path.join(fakeB.runRoot, 'candidate', 'candidate-plan.json'), 'utf8')) as { shots: Array<{ camera: { template: string } }> };
    expect(planA.shots[0]?.camera.template).toBe('close_up');
    expect(planB.shots[0]?.camera.template).toBe('wide');
    const manifestA = await readFile(path.join(fakeA.runRoot, 'harness', 'candidate-production-manifest.json'), 'utf8');
    const manifestB = await readFile(path.join(fakeB.runRoot, 'harness', 'candidate-production-manifest.json'), 'utf8');
    expect(manifestA).not.toBe(manifestB);
    expect(await readFile(path.join(fakeA.runRoot, 'artifacts', 'creature-final.png'))).not.toEqual(
      await readFile(path.join(fakeB.runRoot, 'artifacts', 'creature-final.png')),
    );
    expect(await readFile(path.join(fakeA.runRoot, 'artifacts', 'contact-sheet.png'))).not.toEqual(
      await readFile(path.join(fakeB.runRoot, 'artifacts', 'contact-sheet.png')),
    );

    const compared = await compareV3AgentRuns([fakeA.runRoot, fakeB.runRoot]);
    expect(compared.pairs[0]?.candidatePlan).toBe('DIFFERENT');
    expect(compared.pairs[0]?.productionManifest).toBe('DIFFERENT');
    expect(compared.pairs[0]?.requiredFrames).toBe('DIFFERENT');
    expect(compared.pairs[0]?.contactSheet).toBe('DIFFERENT');
    expect(compared.collapse).toBe(false);

    const cloneRoot = path.join(await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-agent-clone-')), 'run');
    await (await import('node:fs/promises')).cp(fakeA.runRoot, cloneRoot, { recursive: true });
    const collapsed = await compareV3AgentRuns([fakeA.runRoot, cloneRoot]);
    expect(collapsed.collapse).toBe(true);
    expect(collapsed.warnings.join('\n')).toMatch(/benchmark-collapse detected/);
    expect(collapsed.pairs[0]?.candidatePlan).toBe('IDENTICAL');
  });
});
