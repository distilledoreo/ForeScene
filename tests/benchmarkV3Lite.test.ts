import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createBenchmarkRunLayout } from '../scripts/benchmark/layout';
import { loadV3LiteContract, v3LiteManifestSha256 } from '../scripts/benchmark/v3LiteContract';
import { runV3LiteDoctor } from '../scripts/benchmark/v3LiteDoctor';
import { prepareV3LiteRun, runV3Lite } from '../scripts/benchmark/v3LiteRun';
import { gradeV3LiteQuality } from '../scripts/benchmark/v3LiteQuality';
import { validateV3LiteTechnical } from '../scripts/benchmark/v3LiteValidator';
import { parseAgentCliArgs } from '../scripts/agent/cliArgs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repoRoot, 'benchmarks/panorama-triad-v3-lite/contract.json');

async function fixtureInputRoot(options: { missing?: string } = {}): Promise<string> {
  const root = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-input-'));
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'seed'), { recursive: true });
  const fixture = path.join(repoRoot, 'tests/fixtures/ordinary-cube.glb');
  const assets = [
    'Hand_Monster_v3.glb',
    'Roman Joseph Amputated.glb',
    'Roman Joseph Final.glb',
  ];
  for (const asset of assets) {
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

describe('ForeScene Benchmark V3-Lite', () => {
  it('loads the checked-in production manifest and frozen artifact contract without compiling benchmark input', async () => {
    const loaded = await loadV3LiteContract(contractPath);
    expect(loaded.contract.requiredArtifacts).toContain('final-project.fsp');
    expect(loaded.contract.requiredArtifacts).toContain('validation-report.json');
    expect(loaded.manifest.shots.map((shot) => shot.shotNumber)).toEqual(['01', '02', '03']);
    expect(loaded.manifest.shots[1]?.motion?.keyframes).toHaveLength(3);
    expect(loaded.manifest.assets?.[0]?.source).toBe('assets/Hand_Monster_v3.glb');
  });

  it('uses one manifest identity for LF and CRLF while rejecting semantic edits', async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, 'benchmarks/panorama-triad-v3-lite/production-manifest.json'), 'utf8')) as Record<string, unknown>;
    const contract = JSON.parse(await readFile(contractPath, 'utf8')) as Record<string, unknown>;
    const testRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-hash-'));
    const lfRoot = path.join(testRoot, 'lf');
    const crlfRoot = path.join(testRoot, 'crlf');
    const changedRoot = path.join(testRoot, 'changed');
    await mkdir(lfRoot, { recursive: true });
    await mkdir(crlfRoot, { recursive: true });
    await mkdir(changedRoot, { recursive: true });
    const manifestText = JSON.stringify(manifest, null, 2);
    const writeFixture = async (root: string, text: string) => {
      await writeFile(path.join(root, 'manifest.json'), text, 'utf8');
      await writeFile(path.join(root, 'contract.json'), `${JSON.stringify({ ...contract, manifest: 'manifest.json' }, null, 2)}\n`, 'utf8');
    };
    await writeFixture(lfRoot, `${manifestText}\n`);
    await writeFixture(crlfRoot, `${manifestText.replaceAll('\n', '\r\n')}\r\n`);
    const lfLoaded = await loadV3LiteContract(path.join(lfRoot, 'contract.json'));
    const crlfLoaded = await loadV3LiteContract(path.join(crlfRoot, 'contract.json'));
    expect(lfLoaded.contract.manifestSha256).toBe(v3LiteManifestSha256(manifest));
    expect(crlfLoaded.contract.manifestSha256).toBe(lfLoaded.contract.manifestSha256);

    const changed = JSON.parse(JSON.stringify(manifest)) as { shots: Array<{ description: string }> };
    changed.shots[0]!.description += ' semantic edit';
    await writeFixture(changedRoot, `${JSON.stringify(changed, null, 2).replaceAll('\n', '\r\n')}\r\n`);
    await expect(loadV3LiteContract(path.join(changedRoot, 'contract.json'))).rejects.toThrow(/does not match/);
  });

  it('blocks candidate launch when doctor finds a deterministic required-asset failure', async () => {
    const inputRoot = await fixtureInputRoot({ missing: 'Hand_Monster_v3.glb' });
    const runRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-doctor-'));
    const layout = await createBenchmarkRunLayout(runRoot);
    const loaded = await loadV3LiteContract(contractPath);
    let cliCalls = 0;
    const result = await runV3LiteDoctor({
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
    expect(result.report.ok).toBe(false);
    expect(cliCalls).toBe(0);
    expect(result.report.checks.find((check) => check.id === 'asset.assets.hand-monster.source')?.ok).toBe(false);

    const orchestrationRoot = path.join(await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-blocked-')), 'run');
    let candidateLaunches = 0;
    const blockedRun = await runV3Lite({
      contractPath,
      inputRoot,
      runRoot: orchestrationRoot,
      candidate: 'fixture-candidate',
      candidateRunner: async () => {
        candidateLaunches += 1;
        return { code: 0, stdout: '', stderr: '', runtimeMs: 0, timedOut: false };
      },
    });
    expect(blockedRun.failure).toBeDefined();
    expect(blockedRun.candidate).toBeUndefined();
    expect(candidateLaunches).toBe(0);
  });

  it('passes doctor only after hosted app, manifest/assets, isolated profile, and one non-mutating CLI call pass', async () => {
    const inputRoot = await fixtureInputRoot();
    const runRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-doctor-'));
    const layout = await createBenchmarkRunLayout(runRoot);
    const loaded = await loadV3LiteContract(contractPath);
    let cliCalls = 0;
    const result = await runV3LiteDoctor({
      contractPath,
      inputRoot,
      url: 'https://forescene.test',
      layout,
      loaded,
      git: cleanGit,
      fetchImpl: fakeFetch(),
      runCli: async () => {
        cliCalls += 1;
        return { code: 0, stdout: '{}', stderr: '', envelope: { ok: true, operation: 'project.inspect' } as never };
      },
    });
    expect(result.failure).toBeUndefined();
    expect(result.report.ok).toBe(true);
    expect(cliCalls).toBe(1);
    expect(result.report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'hosted-app.responsive',
      'manifest.schema',
      'assets.preflight',
      'profile.usable',
      'cli.non-mutating-inspect',
    ]));
  });

  it('launches one candidate exactly once and keeps a failed quality grade separate from technical completion', async () => {
    const inputRoot = await fixtureInputRoot();
    const runRoot = path.join(await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-run-')), 'fresh-run');
    let launches = 0;
    const result = await runV3Lite({
      contractPath,
      inputRoot,
      runRoot,
      url: 'https://forescene.test',
      candidate: 'fixture-candidate',
      doctorRunner: async (input) => ({
        report: {
          ok: true,
          checkedAt: new Date().toISOString(),
          contractPath: input.contractPath,
          inputRoot: input.inputRoot,
          url: input.url ?? '',
          profileDir: input.layout.profileDir,
          checks: [{ id: 'fixture', ok: true, message: 'fixture doctor pass' }],
        },
      }),
      candidateRunner: async ({ env }) => {
        launches += 1;
        const output = env.FORESCENE_OUTPUT!;
        const finalProject = env.FORESCENE_BENCHMARK_FINAL_PROJECT!;
        const contract = await loadV3LiteContract(contractPath);
        for (const still of contract.contract.requiredStills) await writeFile(path.join(output, still), 'still');
        const mp4 = Buffer.alloc(32);
        mp4.write('ftyp', 4, 'ascii');
        await writeFile(path.join(output, 'chase-motion.mp4'), mp4);
        await writeFile(finalProject, 'final-project');
        await writeFile(path.join(output, contract.contract.quality.evidenceFile), JSON.stringify({ grade: 'failed' }));
        return { code: 0, stdout: '{}', stderr: '', runtimeMs: 17, timedOut: false };
      },
    });
    expect(launches).toBe(1);
    expect(result.candidate?.invocationCount).toBe(1);
    expect(result.technical?.ok).toBe(true);
    expect(result.quality?.status).toBe('failed');
    expect(result.quality?.technicalPass).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect((await readFile(path.join(result.runRoot, 'run-report.json'), 'utf8')).length).toBeGreaterThan(0);
    expect((await readFile(path.join(result.runRoot, 'validation-report.json'), 'utf8')).length).toBeGreaterThan(0);
  });

  it('fails closed for a pre-existing run workspace and a dirty repository doctor state', async () => {
    const inputRoot = await fixtureInputRoot();
    const existingRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-existing-'));
    await writeFile(path.join(existingRoot, 'old-result.txt'), 'immutable');
    await expect(prepareV3LiteRun({ contractPath, inputRoot, runRoot: existingRoot })).rejects.toThrow(/fresh and empty/);

    const runRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-dirty-'));
    const layout = await createBenchmarkRunLayout(runRoot);
    const loaded = await loadV3LiteContract(contractPath);
    let cliCalls = 0;
    const result = await runV3LiteDoctor({
      contractPath,
      inputRoot,
      url: 'https://forescene.test',
      layout,
      loaded,
      git: { ...cleanGit, dirty: true, porcelain: ' M src/app.ts' },
      fetchImpl: fakeFetch(),
      runCli: async () => {
        cliCalls += 1;
        return { code: 0, stdout: '{}', stderr: '', envelope: { ok: true } as never };
      },
    });
    expect(result.failure).toBeDefined();
    expect(result.report.checks.find((check) => check.id === 'repository.clean')?.ok).toBe(false);
    expect(cliCalls).toBe(0);
  });

  it('routes benchmark URL/profile/output/manifest defaults through normal Agent CLI parsing', () => {
    vi.stubEnv('FORESCENE_URL', 'https://forescene.test');
    vi.stubEnv('FORESCENE_PROFILE', 'C:/fresh/profile');
    vi.stubEnv('FORESCENE_OUTPUT', 'C:/fresh/output');
    vi.stubEnv('FORESCENE_BENCHMARK_MANIFEST', 'C:/fresh/manifest.json');
    vi.stubEnv('FORESCENE_BENCHMARK_FINAL_PROJECT', 'C:/fresh/final-project.fsp');
    vi.stubEnv('FORESCENE_BENCHMARK_PROJECT_PACKAGE', 'C:/fresh/base.fsp');
    const args = parseAgentCliArgs(['production']);
    expect(args.url).toBe('https://forescene.test');
    expect(args.profile).toBe('C:/fresh/profile');
    expect(args.output).toBe('C:/fresh/output');
    expect(args.manifest).toBe('C:/fresh/manifest.json');
    expect(args.finalProject).toBe('C:/fresh/final-project.fsp');
    expect(args.file).toBe('C:/fresh/base.fsp');
    vi.unstubAllEnvs();
  });

  it('reports missing quality evidence as ungraded rather than as technical infrastructure failure', async () => {
    const inputRoot = await fixtureInputRoot();
    const runRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-quality-'));
    const layout = await createBenchmarkRunLayout(runRoot);
    const loaded = await loadV3LiteContract(contractPath);
    const technical = { ok: true, checks: [] };
    const grade = await gradeV3LiteQuality(loaded.contract, layout, technical);
    expect(grade.status).toBe('not-graded');
    expect(grade.hardExecutionFailure).toBe(false);
    expect(grade.technicalPass).toBe(true);
    expect((await readFile(path.join(repoRoot, 'scripts/benchmark/v3LiteRun.ts'), 'utf8')).includes('runLiveLifecycle')).toBe(false);
  });
});
