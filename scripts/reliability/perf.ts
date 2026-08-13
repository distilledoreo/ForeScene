/**
 * Soak timing summary. Measure first. Do not add retries, extra Chromium
 * launches, or duplicate work to hide latency.
 */

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

const FORESCENE_GATES = new Set<SoakGateId>(['B', 'C']);

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
