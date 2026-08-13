import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractAgentEnvelope, failureFromInvocation } from '../scripts/benchmark/agentCli';
import { buildCandidateBrief } from '../scripts/benchmark/brief';
import { collectBenchmarkRun, prepareBenchmarkRun } from '../scripts/benchmark/engine';
import { classifyCliFailure, isStopTheRun } from '../scripts/benchmark/failures';
import { findForbiddenCandidateFiles } from '../scripts/benchmark/forbidden';
import { enforceGitIdentity, unauthorizedRepoModifications } from '../scripts/benchmark/git';
import { incrementalMutationPlan, skippedLiveLifecycle } from '../scripts/benchmark/lifecycle';
import { parseBenchmarkSpec, loadBenchmarkSpec } from '../scripts/benchmark/spec';
import { BenchmarkClock } from '../scripts/benchmark/timing';
import { gradeVisualDiagnostics } from '../scripts/benchmark/visualGrade';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('benchmark harness v3', () => {
  it('loads the three-shot spec without hard-coded camera coordinates', async () => {
    const spec = await loadBenchmarkSpec(path.join(repoRoot, 'benchmarks/three-shot.json'));
    expect(spec.id).toBe('three-shot');
    expect(spec.shots).toHaveLength(3);
    expect(spec.shots[1]?.requiredSubjects).toEqual(['lead', 'partner']);
    expect(spec.shots[2]?.intent).toBe('motion-required');
    expect(JSON.stringify(spec)).not.toMatch(/cameraMustBe|cameraPosition/);
  });

  it('rejects specs that encode a benchmark camera solution', () => {
    expect(() => parseBenchmarkSpec({
      version: 1,
      id: 'bad',
      name: 'Bad',
      qualityMode: 'rapid-previs',
      operatingMode: 'greenfield',
      writeAuthorized: true,
      resetAuthorized: true,
      repairBudget: 0,
      requiredCliCapabilities: [],
      shots: [{
        id: 's020',
        shotNumber: '020',
        name: 'Cheat',
        description: 'Do not do this',
        intent: 'still',
        requiredSubjects: ['lead'],
        stillArtifacts: ['020.png'],
        cameraMustBe: [0.55, 0.48, -3.15],
      }],
    })).toThrow(/must not hard-code camera coordinates/);
  });

  it('classifies ForeScene timeouts as infrastructure failures that stop the run', () => {
    const failure = classifyCliFailure({
      operation: 'character.importSavedRig',
      message: 'character.import → timeout',
    });
    expect(failure.class).toBe('INFRASTRUCTURE_FAILURE');
    expect(failure.operation).toBe('character.importSavedRig');
    expect(isStopTheRun(failure)).toBe(true);
  });

  it('flags candidate-created glue scripts and window.foreScene helpers', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-bench-forbidden-'));
    await writeFile(path.join(workDir, 'open-package.ts'), 'export const x = 1;\n');
    await mkdir(path.join(workDir, 'helpers'), { recursive: true });
    await writeFile(path.join(workDir, 'helpers', 'render.ts'), 'window.foreScene.renderShotFrame({ shotId: "x" });\n');
    const hits = await findForbiddenCandidateFiles(workDir);
    expect(hits.map((hit) => hit.relativePath).sort()).toEqual(['helpers/render.ts', 'open-package.ts']);
  });

  it('writes a benchmark brief and technically validates required artifacts', async () => {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-bench-run-'));
    const spec = await loadBenchmarkSpec(path.join(repoRoot, 'benchmarks/three-shot.json'));
    const prepared = await prepareBenchmarkRun({
      spec,
      specPath: path.join(repoRoot, 'benchmarks/three-shot.json'),
      runRoot,
      url: 'http://127.0.0.1:3000',
      enforceRepositoryState: false,
    });
    expect(prepared.failure).toBeUndefined();
    const brief = JSON.parse(await readFile(prepared.layout.briefPath, 'utf8')) as ReturnType<typeof buildCandidateBrief>;
    expect(brief.mode).toBe('benchmark');
    expect(brief.writeAuthorized).toBe(true);
    expect(brief.resetAuthorized).toBe(true);
    expect(brief.repairBudget).toBe(2);
    expect(brief.cliOnly).toBe(true);
    expect(brief.forbidWindowForeScene).toBe(true);
    expect(brief.repoRoot).toBe(repoRoot);
    expect(prepared.layout.recoveryProfileDir).toContain('profile-recovery');

    await writeFile(path.join(prepared.layout.artifactDir, '010.png'), 'png');
    await writeFile(path.join(prepared.layout.artifactDir, '020.png'), 'png');
    await writeFile(path.join(prepared.layout.artifactDir, '030-start.png'), 'png');
    await writeFile(path.join(prepared.layout.artifactDir, '030-mid.png'), 'png');
    await writeFile(path.join(prepared.layout.artifactDir, '030-end.png'), 'png');
    const mp4 = Buffer.alloc(32);
    mp4.write('ftyp', 4, 'ascii');
    await writeFile(path.join(prepared.layout.artifactDir, '030.mp4'), mp4);

    const collected = await collectBenchmarkRun({ spec, layout: prepared.layout, enforceRepositoryState: false });
    expect(collected.failure).toBeUndefined();
    expect(collected.validation.ok).toBe(true);
  });

  it('treats missing stills as a model failure, not a harness failure', async () => {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-bench-missing-'));
    const spec = await loadBenchmarkSpec(path.join(repoRoot, 'benchmarks/three-shot.json'));
    const prepared = await prepareBenchmarkRun({
      spec,
      specPath: path.join(repoRoot, 'benchmarks/three-shot.json'),
      runRoot,
      enforceRepositoryState: false,
    });
    const collected = await collectBenchmarkRun({ spec, layout: prepared.layout, enforceRepositoryState: false });
    expect(collected.validation.ok).toBe(false);
    expect(collected.failure?.class).toBe('MODEL_FAILURE');
  });

  it('records skipped live lifecycle without opening a browser', () => {
    const records = skippedLiveLifecycle('unit test');
    expect(records.map((record) => record.id)).toEqual(['cold-open', 'incremental', 'recovery']);
    expect(records.every((record) => record.status === 'skipped')).toBe(true);
  });

  it('parses Agent CLI envelopes from pretty-printed stdout', () => {
    const envelope = extractAgentEnvelope(`noise\n${JSON.stringify({
      ok: true,
      operation: 'project.inspect',
      durationMs: 12,
      warnings: [],
      result: { ok: true },
    }, null, 2)}\n`);
    expect(envelope?.operation).toBe('project.inspect');
    expect(envelope?.ok).toBe(true);
  });

  it('records harness timing phases', () => {
    const clock = new BenchmarkClock();
    clock.start('prepare');
    clock.stop('prepare');
    const phases = clock.snapshot();
    expect(phases[0]?.id).toBe('prepare');
    expect(phases[0]?.owner).toBe('harness');
    expect(typeof phases[0]?.durationMs).toBe('number');
  });

  it('prepare-only CLI finishes clean from an external cwd via FORESCENE_REPO_ROOT', () => {
    const runRoot = path.join(os.tmpdir(), `forescene-bench-cli-${Date.now()}`);
    const npmExec = process.env.npm_execpath;
    const output = execFileSync(
      npmExec ? process.execPath : 'npm',
      npmExec
        ? [npmExec, '--prefix', repoRoot, 'run', 'benchmark:run', '--', '--spec', 'benchmarks/three-shot.json', '--run-root', runRoot, '--prepare-only']
        : ['--prefix', repoRoot, 'run', 'benchmark:run', '--', '--spec', 'benchmarks/three-shot.json', '--run-root', runRoot, '--prepare-only'],
      {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          FORESCENE_REPO_ROOT: repoRoot,
          FORESCENE_BENCHMARK_ALLOW_DIRTY: '1',
        },
      },
    );
    const parsed = JSON.parse(output.slice(output.indexOf('{'))) as {
      ok: boolean;
      specId: string;
      runRoot: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.specId).toBe('three-shot');
    expect(parsed.runRoot).toBe(runRoot);
  }, 30_000);

  it('grades visual-preflight metrics without requiring camera coordinates', async () => {
    const spec = await loadBenchmarkSpec(path.join(repoRoot, 'benchmarks/three-shot.json'));
    const passing = gradeVisualDiagnostics(spec, {
      result: {
        visualPreflight: [
          {
            shotId: 's010',
            ok: true,
            subjects: [{ objectId: 'obj_lead_1', name: 'Lead' }],
            presentSubjectIds: ['obj_lead_1'],
            missingSubjectIds: [],
            checks: [
              { id: 'camera_direction', status: 'passed' },
              { id: 'subject_visibility', status: 'passed' },
              { id: 'framing_coverage', status: 'passed' },
            ],
          },
          {
            shotId: 's020',
            ok: true,
            subjects: [
              { objectId: 'obj_lead_1', name: 'Lead' },
              { objectId: 'obj_partner_1', name: 'Partner' },
            ],
            presentSubjectIds: ['obj_lead_1', 'obj_partner_1'],
            missingSubjectIds: [],
            checks: [
              { id: 'camera_direction', status: 'passed' },
              { id: 'subject_visibility', status: 'passed' },
              { id: 'framing_coverage', status: 'passed' },
            ],
          },
          {
            shotId: 's030',
            ok: true,
            subjects: [{ objectId: 'obj_lead_1', name: 'Lead' }],
            presentSubjectIds: ['obj_lead_1'],
            missingSubjectIds: [],
            checks: [
              { id: 'camera_direction', status: 'passed' },
              { id: 'subject_visibility', status: 'passed' },
              { id: 'framing_coverage', status: 'passed' },
              { id: 'motion_continuity', status: 'passed' },
            ],
            samples: [{ timeSeconds: 0, label: 'start' }, { timeSeconds: 1, label: 'mid' }, { timeSeconds: 2, label: 'end' }],
          },
        ],
      },
    });
    expect(passing.ok).toBe(true);
    expect(JSON.stringify(passing)).not.toMatch(/cameraMustBe|cameraPosition/);

    const implicit = gradeVisualDiagnostics(spec, {
      result: {
        visualPreflight: [{
          shotId: 's010',
          missingSubjectIds: [],
          checks: [],
        }],
      },
    });
    expect(implicit.ok).toBe(false);
    expect(implicit.checks.some((check) => check.status === 'not_verified')).toBe(true);

    const failing = gradeVisualDiagnostics(spec, {
      result: {
        visualPreflight: [{
          shotId: 's020',
          environmentOnly: true,
          requestedSubjectIds: [],
          missingSubjectIds: ['lead', 'partner'],
          checks: [{ id: 'camera_direction', status: 'failed', message: 'not aimed at subjects' }],
        }],
      },
    });
    expect(failing.ok).toBe(false);
    expect(failing.checks.some((check) => check.layer === 'subject' && !check.ok)).toBe(true);
  });

  it('fails closed on an unexpected commit or dirty tree', () => {
    expect(enforceGitIdentity({
      commit: 'aaa',
      expectedCommit: 'bbb',
      dirty: false,
      porcelain: '',
      allowDirty: false,
    })?.class).toBe('ENVIRONMENT_FAILURE');
    expect(enforceGitIdentity({
      commit: 'aaa',
      expectedCommit: 'aaa',
      dirty: true,
      porcelain: ' M src/App.tsx',
      allowDirty: false,
    })?.message).toMatch(/dirty/);
    expect(enforceGitIdentity({
      commit: 'aaa',
      expectedCommit: 'aaa',
      dirty: true,
      porcelain: ' M src/App.tsx',
      allowDirty: true,
    })).toBeUndefined();
  });

  it('reports unauthorized source edits after the candidate', () => {
    const before = {
      commit: 'aaa',
      expectedCommit: 'aaa',
      dirty: false,
      porcelain: '',
      allowDirty: false,
    };
    expect(unauthorizedRepoModifications(before, {
      ...before,
      dirty: true,
      porcelain: ' M scripts/benchmark/run.ts',
    })?.message).toMatch(/Unauthorized/);
  });

  it('requires incremental lifecycle to be a real mutate/save plan', () => {
    const plan = incrementalMutationPlan();
    expect(plan.commands[0]?.op).toBe('project.updateInfo');
  });

  it('classifies CLI timeouts as infrastructure failures', () => {
    const failure = failureFromInvocation({
      code: 1,
      stdout: '',
      stderr: 'npm run agent:video exceeded 180000ms',
    }, 'render.video');
    expect(failure.class).toBe('INFRASTRUCTURE_FAILURE');
    expect(isStopTheRun(failure)).toBe(true);
  });
});
