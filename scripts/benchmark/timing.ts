import type { BenchmarkTimingPhase } from './types';

export class BenchmarkClock {
  private readonly phases: BenchmarkTimingPhase[] = [];
  private active = new Map<string, BenchmarkTimingPhase>();

  start(id: string, owner: BenchmarkTimingPhase['owner'] = 'harness'): void {
    const phase: BenchmarkTimingPhase = {
      id,
      owner,
      startedAt: new Date().toISOString(),
      retries: 0,
    };
    this.active.set(id, phase);
  }

  stop(id: string): BenchmarkTimingPhase | undefined {
    const phase = this.active.get(id);
    if (!phase) return undefined;
    phase.endedAt = new Date().toISOString();
    phase.durationMs = Math.max(0, Date.parse(phase.endedAt) - Date.parse(phase.startedAt));
    this.active.delete(id);
    this.phases.push(phase);
    return phase;
  }

  noteRetry(id: string): void {
    const phase = this.active.get(id);
    if (phase) phase.retries = (phase.retries ?? 0) + 1;
  }

  snapshot(): BenchmarkTimingPhase[] {
    return [
      ...this.phases,
      ...[...this.active.values()].map((phase) => ({ ...phase })),
    ];
  }
}

export const HARNESS_TIMING_PHASES = [
  'prepare',
  'git-verify',
  'profile',
  'project-open',
  'invoke-candidate',
  'collect-artifacts',
  'forbidden-scan',
  'cold-open',
  'incremental',
  'recovery',
  'hashes',
  'validation',
  'reporting',
] as const;
