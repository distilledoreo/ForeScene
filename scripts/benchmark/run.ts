/**
 * ForeScene Benchmark Harness V3 CLI.
 *
 *   npm run benchmark:run -- --spec benchmarks/three-shot.json --skip-live --skip-candidate --prepare-only
 *   npm run benchmark:run -- --spec benchmarks/three-shot.json --candidate '<candidate command>'
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractAgentEnvelope, failureFromInvocation } from './agentCli';
import { collectBenchmarkRun, prepareBenchmarkRun } from './engine';
import { isStopTheRun } from './failures';
import { runLiveLifecycle, skippedLiveLifecycle, writeLifecycleRecords } from './lifecycle';
import { runLiveVisualGrade, skippedVisualGrade } from './visualGrade';
import { defaultRunRoot, repoRoot } from './layout';
import { loadBenchmarkSpec } from './spec';
import { BenchmarkClock, ingestAgentInvocation, ingestCliLogs, summarizeBenchmarkTiming } from './timing';
import type { BenchmarkFailure, BenchmarkCandidateBrief, BenchmarkSpecV1 } from './types';
import type { BenchmarkRunLayout } from './layout';

function parseArgs(argv: string[]) {
  const args = {
    spec: 'benchmarks/three-shot.json',
    runRoot: undefined as string | undefined,
    url: process.env.FORESCENE_URL,
    candidate: undefined as string | undefined,
    skipLive: false,
    skipCandidate: false,
    prepareOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--spec') args.spec = argv[++index]!;
    else if (token === '--run-root') args.runRoot = argv[++index];
    else if (token === '--url') args.url = argv[++index];
    else if (token === '--candidate') args.candidate = argv[++index];
    else if (token === '--skip-live') args.skipLive = true;
    else if (token === '--skip-candidate') args.skipCandidate = true;
    else if (token === '--prepare-only') args.prepareOnly = true;
  }
  return args;
}

function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true });
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs
      ? setTimeout(() => {
        child.kill('SIGINT');
        stderr += `\nCandidate exceeded ${timeoutMs}ms`;
      }, timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function candidateWorkingDirectory(): string {
  return repoRoot();
}

async function writeReport(
  layout: BenchmarkRunLayout,
  spec: BenchmarkSpecV1,
  clock: BenchmarkClock,
  failure?: BenchmarkFailure,
  extra?: { visualPath?: string },
) {
  const phases = clock.snapshot();
  const summary = summarizeBenchmarkTiming(phases);
  const report = {
    ok: !failure,
    specId: spec.id,
    runRoot: layout.runRoot,
    failure,
    stopTheRun: failure ? isStopTheRun(failure) : false,
    timing: phases,
    timingSummary: summary,
    brief: layout.briefPath,
    validation: layout.validationPath,
    visual: extra?.visualPath ?? layout.visualPath,
  };
  await writeFile(layout.timingPath, `${JSON.stringify({ phases, summary }, null, 2)}\n`, 'utf8');
  await writeFile(layout.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const clock = new BenchmarkClock();
  clock.start('run');
  clock.start('prepare');
  const specPath = path.resolve(repoRoot(), args.spec);
  const spec = await loadBenchmarkSpec(specPath);
  const runRoot = args.runRoot ? path.resolve(args.runRoot) : defaultRunRoot(spec.id);
  const prepared = await prepareBenchmarkRun({
    spec,
    specPath,
    runRoot,
    url: args.url,
    clock,
  });
  clock.stop('prepare');
  if (prepared.failure) {
    clock.stop('run');
    await writeReport(prepared.layout, spec, clock, prepared.failure);
    return 1;
  }

  if (args.prepareOnly) {
    await writeLifecycleRecords(
      prepared.layout,
      skippedLiveLifecycle('Prepare-only run; live lifecycle not executed.'),
    );
    clock.stop('run');
    await writeReport(prepared.layout, spec, clock);
    return 0;
  }

  if (!args.skipCandidate && args.candidate) {
    clock.start('invoke-candidate', 'candidate');
    const result = await runCommand(args.candidate, candidateWorkingDirectory(), {
      ...process.env,
      FORESCENE_BENCHMARK: '1',
      FORESCENE_BENCHMARK_BRIEF: prepared.layout.briefPath,
      FORESCENE_REPO_ROOT: repoRoot(),
      FORESCENE_URL: args.url ?? process.env.FORESCENE_URL ?? '',
      FORESCENE_PROFILE: prepared.layout.profileDir,
      FORESCENE_OUTPUT: prepared.layout.artifactDir,
    }, Number(process.env.FORESCENE_BENCHMARK_CANDIDATE_TIMEOUT_MS) || 60 * 60_000);
    await writeFile(path.join(prepared.layout.logsDir, 'candidate.stdout.log'), result.stdout);
    await writeFile(path.join(prepared.layout.logsDir, 'candidate.stderr.log'), result.stderr);
    ingestCliLogs(clock, {
      stdout: result.stdout,
      stderr: result.stderr,
      owner: 'forescene',
      parentId: 'invoke-candidate',
    });
    clock.stop('invoke-candidate');
    if (result.code !== 0) {
      const envelope = extractAgentEnvelope(result.stdout);
      const failure = failureFromInvocation({
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        envelope,
      }, envelope?.operation ?? 'candidate');
      clock.stop('run');
      await writeReport(prepared.layout, spec, clock, failure);
      return 1;
    }
  }

  clock.start('collect-artifacts');
  const collected = await collectBenchmarkRun({ spec, layout: prepared.layout, clock });
  clock.stop('collect-artifacts');

  const brief = JSON.parse(await readFile(prepared.layout.briefPath, 'utf8')) as BenchmarkCandidateBrief;
  const liveUrl = args.url ?? brief.url;
  if (args.skipLive || !liveUrl) {
    clock.start('cold-open');
    await writeLifecycleRecords(
      prepared.layout,
      skippedLiveLifecycle(
        args.skipLive
          ? 'Live lifecycle skipped (--skip-live).'
          : 'Live lifecycle skipped (pass --url and omit --skip-live).',
      ),
    );
    clock.stop('cold-open');
  } else {
    clock.start('cold-open', 'forescene');
    const live = await runLiveLifecycle({
      layout: prepared.layout,
      url: liveUrl,
      projectPackage: brief.projectPackage,
      clock,
    });
    await writeLifecycleRecords(prepared.layout, live.records);
    clock.stop('cold-open');
    if (live.failure) {
      clock.stop('run');
      await writeReport(prepared.layout, spec, clock, live.failure);
      return 1;
    }
  }

  clock.start('visual-grade', 'forescene');
  let visualFailure: BenchmarkFailure | undefined;
  if (args.skipLive || !liveUrl) {
    await writeFile(
      prepared.layout.visualPath,
      `${JSON.stringify(skippedVisualGrade('Live visual-preflight skipped.'), null, 2)}\n`,
      'utf8',
    );
  } else {
    const visual = await runLiveVisualGrade({
      spec,
      layout: prepared.layout,
      url: liveUrl,
    });
    if (visual.invocation) {
      ingestAgentInvocation(clock, visual.invocation, {
        id: 'visual-preflight',
        command: 'visual-preflight',
        parentId: 'visual-grade',
        owner: 'forescene',
      });
    }
    visualFailure = visual.failure;
  }
  clock.stop('visual-grade');

  const failure = collected.failure ?? visualFailure;
  clock.start('reporting');
  clock.stop('reporting');
  clock.stop('run');
  await writeReport(prepared.layout, spec, clock, failure);
  return failure ? 1 : 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url)
    || entry.replaceAll('\\', '/').endsWith('scripts/benchmark/run.ts');
}

if (isDirectRun()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
