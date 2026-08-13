import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isPidAlive,
  recoverChromiumProfileLocks,
  writeChromiumSingletonLock,
} from '../agent/browserProfile';
import { createBenchmarkRunLayout } from '../benchmark/layout';
import { runLiveLifecycle } from '../benchmark/lifecycle';
import { SOAK_GATE_NAMES, type SoakGateResult } from './types';

const DEAD_PID = 2_147_483_646;

export async function runGateE(input: {
  url?: string;
  profileDir?: string;
  iterations?: number;
}): Promise<SoakGateResult> {
  const started = Date.now();
  const iterations = input.iterations ?? 10;
  if (isPidAlive(DEAD_PID)) {
    return {
      id: 'E',
      name: SOAK_GATE_NAMES.E,
      status: 'failed',
      requiredLive: false,
      message: `Fixture dead pid ${DEAD_PID} is unexpectedly alive.`,
      durationMs: Date.now() - started,
      retries: 0,
    };
  }

  for (let index = 0; index < iterations; index += 1) {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), `forescene-soak-lock-${index}-`));
    try {
      await writeChromiumSingletonLock(profileDir, { hostname: 'testhost', pid: DEAD_PID });
      const recovery = await recoverChromiumProfileLocks(profileDir);
      if (!recovery.recovered || recovery.blocked || recovery.status !== 'stale') {
        return {
          id: 'E',
          name: SOAK_GATE_NAMES.E,
          status: 'failed',
          requiredLive: false,
          message: `Stale lock recovery failed on iteration ${index + 1}: ${recovery.message}`,
          durationMs: Date.now() - started,
          retries: 0,
        };
      }
      await lstat(path.join(profileDir, 'SingletonLock')).then(
        () => {
          throw new Error('SingletonLock still present after stale recovery.');
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  }

  if (!input.url || !input.profileDir) {
    return {
      id: 'E',
      name: SOAK_GATE_NAMES.E,
      status: 'skipped',
      requiredLive: true,
      message: `Stale-lock recovery (${iterations}×) is additional coverage only. Live mutate/save/reopen/recovery requires --url.`,
      durationMs: Date.now() - started,
      retries: 0,
      details: { lockIterations: iterations, inspectIterations: 0 },
    };
  }

  const cycles = Math.min(3, iterations);
  for (let index = 0; index < cycles; index += 1) {
    const layout = await createBenchmarkRunLayout(await mkdtemp(path.join(os.tmpdir(), `forescene-soak-life-${index}-`)));
    const live = await runLiveLifecycle({
      layout,
      url: input.url,
    });
    if (live.failure || live.records.some((record) => record.status !== 'passed')) {
      return {
        id: 'E',
        name: SOAK_GATE_NAMES.E,
        status: 'failed',
        requiredLive: true,
        message: live.failure?.message ?? `Lifecycle cycle ${index + 1} failed.`,
        durationMs: Date.now() - started,
        retries: 0,
      };
    }
  }

  return {
    id: 'E',
    name: SOAK_GATE_NAMES.E,
    status: 'passed',
    requiredLive: true,
    message: `Recovered ${iterations} stale locks and completed ${cycles} mutate/save/reopen/recovery cycles.`,
    durationMs: Date.now() - started,
    retries: 0,
    details: { lockIterations: iterations, lifecycleCycles: cycles },
  };
}
