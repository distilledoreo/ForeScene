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
import { analyzeRgbaFrame, requiredSubjectFramingFailure } from '../scripts/benchmark/v3LitePixelGate';
import { encodePngRgba } from '../scripts/benchmark/pngRgba';
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

function variedPng(): Buffer {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const i = (y * 32 + x) * 4;
      data[i] = (x * 17) % 256;
      data[i + 1] = (y * 23) % 256;
      data[i + 2] = 40 + ((x + y) * 7) % 180;
      data[i + 3] = 255;
    }
  }
  return encodePngRgba({ width: 32, height: 32, data });
}

describe('ForeScene Benchmark V3-Lite', () => {
  it('loads the checked-in production manifest and frozen artifact contract without compiling benchmark input', async () => {
    const loaded = await loadV3LiteContract(contractPath);
    expect(loaded.contract.requiredArtifacts).toContain('final-project.fsp');
    expect(loaded.contract.requiredArtifacts).toContain('validation-report.json');
    expect(loaded.manifest.shots.map((shot) => shot.shotNumber)).toEqual(['01', '02', '03']);
    expect(loaded.manifest.shots[1]?.motion?.keyframes).toHaveLength(3);
    expect(loaded.manifest.shots[1]?.motion?.keyframes?.[0]?.camera?.position).toEqual([101.2, 1.6, -2.0]);
    expect(loaded.manifest.assets?.[0]?.source).toBe('assets/Hand_Monster_v3.glb');
    expect(loaded.manifest.locations.map((location) => location.defaultPanoId)).toEqual([
      'pano_ms9pmx85_pgw9px',
      null,
      'pano_ms9pmxdn_xdnia1',
    ]);
    expect(loaded.manifest.shots[0]?.requirements?.notes).toContain(
      'Place the creature near ruins_platform as a hand-sized newborn, not a generic spider.',
    );
    expect(loaded.manifest.shots[1]?.requirements?.notes).toContain(
      'The creature starts about 1–1.5 meters behind and remains visibly in pursuit.',
    );
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
        expect(JSON.parse(await readFile(env.FORESCENE_BENCHMARK_MANIFEST!, 'utf8'))).toMatchObject({
          version: 2,
          shots: expect.any(Array),
        });
        const output = env.FORESCENE_OUTPUT!;
        const finalProject = env.FORESCENE_BENCHMARK_FINAL_PROJECT!;
        const contract = await loadV3LiteContract(contractPath);
        await mkdir(path.join(output, 'shots'), { recursive: true });
        await writeFile(path.join(output, 'shots', '01.png'), 'still');
        await writeFile(path.join(output, 'shots', '02-sample-0.png'), 'still');
        await writeFile(path.join(output, 'shots', '02-sample-1.png'), 'still');
        await writeFile(path.join(output, 'shots', '02-sample-2.png'), 'still');
        await writeFile(path.join(output, 'shots', '03.png'), 'still');
        await writeFile(path.join(output, 'contact-sheet.png'), 'still');
        const mp4 = Buffer.alloc(32);
        mp4.write('ftyp', 4, 'ascii');
        await writeFile(path.join(output, 'shots', '02.mp4'), mp4);
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

  it('does not treat a technically complete gray still as visually controlled', async () => {
    const inputRoot = await fixtureInputRoot();
    const runRoot = path.join(await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-gray-')), 'fresh-run');
    const gray = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < gray.length; i += 4) {
      gray[i] = 148;
      gray[i + 1] = 150;
      gray[i + 2] = 147;
      gray[i + 3] = 255;
    }
    const grayPng = encodePngRgba({ width: 32, height: 32, data: gray });
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
        const output = env.FORESCENE_OUTPUT!;
        const finalProject = env.FORESCENE_BENCHMARK_FINAL_PROJECT!;
        const contract = await loadV3LiteContract(contractPath);
        await mkdir(path.join(output, 'shots'), { recursive: true });
        await writeFile(path.join(output, 'shots', '01.png'), grayPng);
        await writeFile(path.join(output, 'shots', '02-sample-0.png'), grayPng);
        await writeFile(path.join(output, 'shots', '02-sample-1.png'), grayPng);
        await writeFile(path.join(output, 'shots', '02-sample-2.png'), grayPng);
        await writeFile(path.join(output, 'shots', '03.png'), grayPng);
        await writeFile(path.join(output, 'contact-sheet.png'), grayPng);
        await writeFile(path.join(output, 'shots', '01.composition.json'), JSON.stringify({
          shotNumber: '01',
          subjects: { 'hand-monster': { visible: true } },
        }));
        await writeFile(path.join(output, 'shots', '02.composition.json'), JSON.stringify({
          shotNumber: '02',
          subjects: {
            'joseph-amputated': { visible: false },
            'hand-monster': { visible: false },
          },
        }));
        await writeFile(path.join(output, 'shots', '03.composition.json'), JSON.stringify({
          shotNumber: '03',
          subjects: {
            'joseph-final': { visible: true },
            shield: { visible: true },
            'wrist-blade': { visible: true },
          },
        }));
        const mp4 = Buffer.alloc(32);
        mp4.write('ftyp', 4, 'ascii');
        await writeFile(path.join(output, 'shots', '02.mp4'), mp4);
        await writeFile(finalProject, 'final-project');
        await writeFile(path.join(output, contract.contract.quality.evidenceFile), JSON.stringify({ grade: 'passed' }));
        return { code: 0, stdout: '{}', stderr: '', runtimeMs: 11, timedOut: false };
      },
    });
    expect(result.technical?.ok).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.quality?.hardExecutionFailure).toBe(false);
    expect(result.quality?.technicalPass).toBe(true);
    expect(result.quality?.status).toBe('failed');
    expect(result.quality?.ok).toBe(false);
    expect(result.quality?.source).toBe('candidate+pixel-evidence');
    expect(result.quality?.pixel?.ok).toBe(false);
    expect(result.quality?.pixel?.visuallyControlled).toBe(false);
    expect(result.quality?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact: 'creature-final.png',
        status: 'failed',
        code: expect.stringMatching(/frame_mostly_gray|frame_flat/),
      }),
      expect.objectContaining({ code: 'required_subject_not_visible', artifact: 'chase-start.png' }),
    ]));
  });

  it('treats a flat gray buffer as visually uncontrolled even when occupancy would pass', () => {
    const gray = new Uint8Array(48 * 48 * 4);
    for (let i = 0; i < gray.length; i += 4) {
      const level = 128 + ((i / 4) % 3) * 16;
      gray[i] = level;
      gray[i + 1] = level;
      gray[i + 2] = level;
      gray[i + 3] = 255;
    }
    const analysis = analyzeRgbaFrame(gray, 48, 48);
    expect(analysis.mostlyGray).toBe(true);
    expect(analysis.stats.luminanceVariance).toBeGreaterThan(1e-6);
    expect(analysis.stats.sampledUniqueColorCount).toBeGreaterThan(2);

    const varied = new Uint8Array(48 * 48 * 4);
    for (let y = 0; y < 48; y += 1) {
      for (let x = 0; x < 48; x += 1) {
        const i = (y * 48 + x) * 4;
        varied[i] = (x * 5) % 256;
        varied[i + 1] = (y * 7) % 256;
        varied[i + 2] = 40 + ((x + y) % 80);
        varied[i + 3] = 255;
      }
    }
    expect(analyzeRgbaFrame(varied, 48, 48).mostlyGray).toBe(false);
  });

  it('rejects the archived Phase 0 catastrophic crop without rejecting an ordinary accessory crop', () => {
    const phaseZeroShot01 = {
      shotNumber: '01',
      subjects: {
        'hand-monster': {
          visible: true,
          bounds: { clipped: true, behindCamera: false },
          bodyBounds: { clipped: true, behindCamera: false },
          assemblyBounds: {
            clipped: true,
            behindCamera: false,
            unclipped: {
              widthCoverage: 1.6237576511584824,
              heightCoverage: 2.993040133117908,
              areaCoverage: 4.859971816374606,
            },
          },
          completeAssemblyInFrame: false,
        },
      },
      blockers: [
        { objectId: 'ruins-a', projectedArea: 0.36930110074425937, nearCamera: false },
        { objectId: 'ruins-b', projectedArea: 0.08456660165490547, nearCamera: false },
        { objectId: 'ruins-c', projectedArea: 0.07794222670567677, nearCamera: false },
      ],
    };
    const failure = requiredSubjectFramingFailure(phaseZeroShot01, 'hand-monster');
    expect(failure).toMatchObject({
      code: 'required_subject_severely_out_of_frame',
      measured: {
        subject: 'hand-monster',
        bodyClipped: true,
        assemblyClipped: true,
        completeAssemblyInFrame: false,
        blockerCount: 3,
        dominantBlockerArea: 0.36930110074425937,
      },
    });

    const ordinaryAccessoryCrop = {
      subjects: {
        actor: {
          visible: true,
          bodyBounds: { clipped: false, behindCamera: false },
          assemblyBounds: {
            clipped: true,
            behindCamera: false,
            unclipped: { widthCoverage: 0.55, heightCoverage: 1.05, areaCoverage: 0.57 },
          },
          completeAssemblyInFrame: false,
        },
      },
    };
    expect(requiredSubjectFramingFailure(ordinaryAccessoryCrop, 'actor')).toBeUndefined();

    const completeInFrame = {
      subjects: {
        actor: {
          visible: true,
          bodyBounds: { clipped: false, behindCamera: false },
          assemblyBounds: {
            clipped: false,
            behindCamera: false,
            unclipped: { widthCoverage: 0.4, heightCoverage: 0.8, areaCoverage: 0.32 },
          },
          completeAssemblyInFrame: true,
        },
      },
    };
    expect(requiredSubjectFramingFailure(completeInFrame, 'actor')).toBeUndefined();
  });

  it('turns the archived Phase 0 crop into failed quality while preserving technical pass', async () => {
    const runRoot = await (await import('node:fs/promises')).mkdtemp(path.join(os.tmpdir(), 'forescene-v3-lite-phase-zero-crop-'));
    const layout = await createBenchmarkRunLayout(runRoot);
    const loaded = await loadV3LiteContract(contractPath);
    const png = variedPng();
    await mkdir(path.join(layout.artifactDir, 'shots'), { recursive: true });
    await Promise.all(loaded.contract.requiredStills.map((artifact) => (
      writeFile(path.join(layout.artifactDir, artifact), png)
    )));
    await writeFile(path.join(layout.artifactDir, 'shots', '01.composition.json'), JSON.stringify({
      shotNumber: '01',
      subjects: {
        'hand-monster': {
          visible: true,
          bodyBounds: { clipped: true, behindCamera: false },
          assemblyBounds: {
            clipped: true,
            behindCamera: false,
            unclipped: {
              widthCoverage: 1.6237576511584824,
              heightCoverage: 2.993040133117908,
              areaCoverage: 4.859971816374606,
            },
          },
          completeAssemblyInFrame: false,
        },
      },
      blockers: [{ objectId: 'ruins-a', projectedArea: 0.36930110074425937, nearCamera: false }],
    }));
    await writeFile(path.join(layout.artifactDir, 'shots', '02.composition.json'), JSON.stringify({
      shotNumber: '02',
      subjects: {
        'joseph-amputated': { visible: true },
        'hand-monster': { visible: true },
      },
    }));
    await writeFile(path.join(layout.artifactDir, 'shots', '03.composition.json'), JSON.stringify({
      shotNumber: '03',
      subjects: {
        'joseph-final': { visible: true },
        shield: { visible: true },
        'wrist-blade': { visible: true },
      },
    }));

    const grade = await gradeV3LiteQuality(loaded.contract, layout, { ok: true, checks: [] });
    expect(grade).toMatchObject({
      status: 'failed',
      ok: false,
      source: 'pixel-evidence',
      technicalPass: true,
      pixel: { ok: false, visuallyControlled: false },
    });
    expect(grade.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact: 'creature-final.png',
        status: 'failed',
        code: 'required_subject_severely_out_of_frame',
      }),
    ]));
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
