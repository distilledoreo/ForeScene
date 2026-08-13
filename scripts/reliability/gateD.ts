import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareBenchmarkRun } from '../benchmark/engine';
import { repoRoot } from '../benchmark/layout';
import { loadBenchmarkSpec } from '../benchmark/spec';
import { SOAK_GATE_NAMES, type SoakGateResult } from './types';

export async function runGateD(iterations = 3): Promise<SoakGateResult> {
  const started = Date.now();
  const specPath = path.join(repoRoot(), 'benchmarks/three-shot.json');
  const spec = await loadBenchmarkSpec(specPath);
  const runRoots: string[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), `forescene-soak-harness-${index}-`));
    const prepared = await prepareBenchmarkRun({ spec, specPath, runRoot });
    if (prepared.failure) {
      return {
        id: 'D',
        name: SOAK_GATE_NAMES.D,
        status: 'failed',
        requiredLive: false,
        message: prepared.failure.message,
        durationMs: Date.now() - started,
        retries: 0,
      };
    }
    runRoots.push(prepared.layout.runRoot);
  }
  return {
    id: 'D',
    name: SOAK_GATE_NAMES.D,
    status: 'passed',
    requiredLive: false,
    message: `Prepared ${iterations} isolated harness run roots.`,
    durationMs: Date.now() - started,
    retries: 0,
    details: { runRoots },
  };
}
