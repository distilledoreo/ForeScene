/**
 * Timing summaries. Measure the real benchmark phases first.
 * Soak gate durationMs is not an end-to-end 30–50 minute breakdown.
 * Do not add retries, extra Chromium launches, or duplicate work to hide latency.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeBenchmarkTiming } from '../benchmark/timing';
import type { BenchmarkTimingPhase, BenchmarkTimingSummary } from '../benchmark/types';
import type { SoakGateId, SoakReport } from './types';

export interface SoakTimingRow {
  id: SoakGateId;
  name: string;
  status: string;
  durationMs: number;
  retries: number;
  owner: 'harness' | 'forescene';
}

export interface SoakTimingSummary {
  ok: boolean;
  retriesTotal: number;
  slowestGate?: SoakGateId;
  rows: SoakTimingRow[];
  policy: {
    measureBeforeOptimize: true;
    retriesMustRemainZero: true;
    doNotOptimizeByRetrying: true;
  };
}

export interface ReliabilityPerfReport {
  ok: boolean;
  soakGates: SoakTimingSummary;
  benchmarkRuns: Array<{ runRoot: string; summary: BenchmarkTimingSummary }>;
  message: string;
  policy: {
    measureBeforeOptimize: true;
    retriesMustRemainZero: true;
    doNotOptimizeByRetrying: true;
    soakGateTotalsAreNotE2EPhases: true;
  };
}

const FORESCENE_GATES = new Set<SoakGateId>(['B', 'C', 'E', 'F']);

export function summarizeSoakTiming(report: SoakReport): SoakTimingSummary {
  const rows: SoakTimingRow[] = report.gates.map((gate) => ({
    id: gate.id,
    name: gate.name,
    status: gate.status,
    durationMs: gate.durationMs,
    retries: gate.retries,
    owner: FORESCENE_GATES.has(gate.id) && gate.status !== 'skipped' ? 'forescene' : 'harness',
  }));
  const executed = rows.filter((row) => row.status !== 'skipped');
  const slowest = executed.reduce<SoakTimingRow | undefined>((current, row) => {
    if (!current || row.durationMs > current.durationMs) return row;
    return current;
  }, undefined);
  return {
    ok: report.retriesTotal === 0 && rows.every((row) => row.retries === 0),
    retriesTotal: report.retriesTotal,
    slowestGate: slowest?.id,
    rows,
    policy: {
      measureBeforeOptimize: true,
      retriesMustRemainZero: true,
      doNotOptimizeByRetrying: true,
    },
  };
}

export function gateDRunRoots(report: SoakReport): string[] {
  const details = report.gates.find((gate) => gate.id === 'D')?.details as { runRoots?: unknown } | undefined;
  return Array.isArray(details?.runRoots)
    ? details.runRoots.filter((value): value is string => typeof value === 'string')
    : [];
}

export async function loadBenchmarkTimingSummary(runRoot: string): Promise<BenchmarkTimingSummary | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(runRoot, 'timing.json'), 'utf8')) as {
      phases?: BenchmarkTimingPhase[];
      summary?: BenchmarkTimingSummary;
    };
    if (raw.summary) return raw.summary;
    if (Array.isArray(raw.phases)) return summarizeBenchmarkTiming(raw.phases);
    return undefined;
  } catch {
    return undefined;
  }
}

export async function summarizeReliabilityPerf(report: SoakReport): Promise<ReliabilityPerfReport> {
  const soakGates = summarizeSoakTiming(report);
  const benchmarkRuns: Array<{ runRoot: string; summary: BenchmarkTimingSummary }> = [];
  for (const runRoot of gateDRunRoots(report)) {
    const summary = await loadBenchmarkTimingSummary(runRoot);
    if (summary) benchmarkRuns.push({ runRoot, summary });
  }
  const retries = soakGates.retriesTotal
    + benchmarkRuns.reduce((sum, row) => sum + row.summary.retries, 0);
  const present = benchmarkRuns.length > 0;
  return {
    ok: soakGates.ok && retries === 0,
    soakGates,
    benchmarkRuns,
    message: present
      ? 'Benchmark phase timings loaded from Gate D timing.json (not soak-gate duration aggregates).'
      : 'No benchmark timing.json found. Soak gate durationMs is not an end-to-end phase breakdown.',
    policy: {
      measureBeforeOptimize: true,
      retriesMustRemainZero: true,
      doNotOptimizeByRetrying: true,
      soakGateTotalsAreNotE2EPhases: true,
    },
  };
}
