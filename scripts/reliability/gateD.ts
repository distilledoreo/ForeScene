import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main as runBenchmark } from '../benchmark/run';
import { createBenchmarkRunLayout, repoRoot } from '../benchmark/layout';
import { runLiveLifecycle } from '../benchmark/lifecycle';
import { SOAK_GATE_NAMES, type SoakGateResult } from './types';

export async function runGateD(input: { iterations?: number; url?: string } | number = 3): Promise<SoakGateResult> {
  const iterations = typeof input === 'number' ? input : (input.iterations ?? 3);
  const url = typeof input === 'number' ? undefined : input.url;
  const started = Date.now();
  const root = repoRoot();
  const fixture = path.join(root, 'scripts/reliability/fixtureCandidate.mjs');
  const runRoots: string[] = [];
  const previousAllowDirty = process.env.FORESCENE_BENCHMARK_ALLOW_DIRTY;
  process.env.FORESCENE_BENCHMARK_ALLOW_DIRTY = '1';
  try {
    for (let index = 0; index < iterations; index += 1) {
      const runRoot = await mkdtemp(path.join(os.tmpdir(), `forescene-soak-harness-${index}-`));
      const argv = [
        '--spec',
        path.join(root, 'benchmarks/three-shot.json'),
        '--run-root',
        runRoot,
        '--skip-live',
        '--candidate',
        `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`,
      ];
      if (url) argv.push('--url', url);
      const code = await runBenchmark(argv);
      if (code !== 0) {
        return {
          id: 'D',
          name: SOAK_GATE_NAMES.D,
          status: 'failed',
          requiredLive: Boolean(url),
          message: `Complete harness run ${index + 1}/${iterations} exited ${code}.`,
          durationMs: Date.now() - started,
          retries: 0,
          details: { runRoots, failedAt: runRoot },
        };
      }
      const report = JSON.parse(await readFile(path.join(runRoot, 'report.json'), 'utf8')) as { ok?: boolean };
      if (report.ok !== true) {
        return {
          id: 'D',
          name: SOAK_GATE_NAMES.D,
          status: 'failed',
          requiredLive: Boolean(url),
          message: `Harness report ${index + 1} was not ok.`,
          durationMs: Date.now() - started,
          retries: 0,
        };
      }
      if (url) {
        const layout = await createBenchmarkRunLayout(runRoot);
        const live = await runLiveLifecycle({ layout, url });
        if (live.failure || live.records.some((record) => record.status !== 'passed')) {
          return {
            id: 'D',
            name: SOAK_GATE_NAMES.D,
            status: 'failed',
            requiredLive: true,
            message: live.failure?.message ?? 'Live lifecycle did not pass for a harness run.',
            durationMs: Date.now() - started,
            retries: 0,
          };
        }
      }
      runRoots.push(runRoot);
    }
  } finally {
    if (previousAllowDirty === undefined) delete process.env.FORESCENE_BENCHMARK_ALLOW_DIRTY;
    else process.env.FORESCENE_BENCHMARK_ALLOW_DIRTY = previousAllowDirty;
  }

  return {
    id: 'D',
    name: SOAK_GATE_NAMES.D,
    status: 'passed',
    requiredLive: Boolean(url),
    message: url
      ? `Completed ${iterations} isolated harness runs including live lifecycle.`
      : `Completed ${iterations} isolated harness runs with a fixture candidate (live lifecycle skipped; not stabilization evidence).`,
    durationMs: Date.now() - started,
    retries: 0,
    details: { runRoots },
  };
}
