/**
 * Reliability soak — Gates A–F.
 *
 *   npm run reliability:soak
 *   npm run reliability:soak -- --url http://127.0.0.1:3000
 *
 * Offline (default) runs A and D, and records B/C/E/F as skipped. Skipped
 * required live gates are not reliability evidence. Live `--url` is required
 * for stabilization exit. Do not retry a failed iteration. Do not kill Chromium.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGateA } from './gateA';
import { runGateD } from './gateD';
import { runGateE } from './gateE';
import { runGateF } from './gateF';
import { runGateB, runGateC } from './gateLive';
import { summarizeSoakTiming } from './perf';
import { repoRoot } from '../benchmark/layout';
import type { SoakGateResult, SoakReport } from './types';

function parseArgs(argv: string[]) {
  const args = {
    url: process.env.FORESCENE_URL as string | undefined,
    output: undefined as string | undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--url') args.url = argv[++index];
    else if (token === '--output') args.output = argv[++index];
  }
  return args;
}

function summarize(gates: SoakGateResult[], startedAt: Date, live: boolean): SoakReport {
  const endedAt = new Date();
  const retriesTotal = gates.reduce((sum, gate) => sum + gate.retries, 0);
  const executedFailed = gates.some((gate) => gate.status === 'failed');
  const skippedRequired = gates.some((gate) => gate.requiredLive && gate.status === 'skipped');
  const allPassed = gates.every((gate) => gate.status === 'passed');
  const report: SoakReport = {
    ok: !executedFailed && retriesTotal === 0,
    live,
    stabilizationExit: live && allPassed && retriesTotal === 0 && !skippedRequired,
    retriesTotal,
    policy: {
      retriesMustRemainZero: true,
      doNotKillChromium: true,
      infrastructureStopsTheRun: true,
      skippedLiveGatesAreNotReliabilityEvidence: true,
    },
    gates,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
  };
  report.timing = summarizeSoakTiming(report);
  return report;
}

export async function runReliabilitySoak(input: {
  url?: string;
  output?: string;
}): Promise<SoakReport> {
  const startedAt = new Date();
  const live = Boolean(input.url);
  const profileDir = live ? await mkdtemp(path.join(os.tmpdir(), 'forescene-soak-profile-')) : undefined;

  const gates: SoakGateResult[] = [];
  gates.push(await runGateA());
  gates.push(await runGateB({ url: input.url }));
  gates.push(await runGateC({ url: input.url, profileDir }));
  gates.push(await runGateD({ url: input.url }));
  gates.push(await runGateE({ url: input.url, profileDir }));
  gates.push(await runGateF({ url: input.url, profileDir }));

  const report = summarize(gates, startedAt, live);
  const output = input.output
    ?? path.join(repoRoot(), 'artifacts', 'reliability', `soak-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const report = await runReliabilitySoak(args);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url)
    || entry.replaceAll('\\', '/').endsWith('scripts/reliability/soak.ts');
}

if (isDirectRun()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
