/**
 * Reliability soak gate results. Retries must remain zero — do not wrap
 * failures in extra attempts to make a gate pass.
 */

export const SOAK_GATE_IDS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type SoakGateId = (typeof SOAK_GATE_IDS)[number];

export type SoakGateStatus = 'passed' | 'failed' | 'skipped';

export interface SoakGateResult {
  id: SoakGateId;
  name: string;
  status: SoakGateStatus;
  requiredLive: boolean;
  message: string;
  durationMs: number;
  retries: number;
  details?: unknown;
}

export interface SoakReport {
  ok: boolean;
  live: boolean;
  stabilizationExit: boolean;
  retriesTotal: number;
  policy: {
    retriesMustRemainZero: true;
    doNotKillChromium: true;
    infrastructureStopsTheRun: true;
    skippedLiveGatesAreNotReliabilityEvidence: true;
  };
  gates: SoakGateResult[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export const SOAK_GATE_NAMES: Record<SoakGateId, string> = {
  A: 'CLI completeness',
  B: 'Saved-rig import 20/20',
  C: 'Clay + projected (+ depth/video) render reliability',
  D: 'Complete benchmark harness 3×',
  E: 'Lifecycle save/reopen/recovery',
  F: 'Visual baseline (fail-closed)',
};
