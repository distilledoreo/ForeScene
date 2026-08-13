import type { AgentCliEnvelope } from '../agent/cliResult';
import { extractAgentEnvelopes } from '../agent/runDocumentedCli';
import type {
  BenchmarkCacheTiming,
  BenchmarkTimingOwner,
  BenchmarkTimingPhase,
  BenchmarkTimingSummary,
} from './types';

export class BenchmarkClock {
  private readonly phases: BenchmarkTimingPhase[] = [];
  private active = new Map<string, BenchmarkTimingPhase>();

  start(
    id: string,
    owner: BenchmarkTimingOwner = 'harness',
    extra?: Partial<BenchmarkTimingPhase>,
  ): void {
    const phase: BenchmarkTimingPhase = {
      id,
      owner,
      kind: extra?.kind ?? 'span',
      startedAt: extra?.startedAt ?? new Date().toISOString(),
      retries: extra?.retries ?? 0,
      ...extra,
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

  record(phase: BenchmarkTimingPhase): BenchmarkTimingPhase {
    const recorded: BenchmarkTimingPhase = {
      ...phase,
      kind: phase.kind ?? 'operation',
      retries: phase.retries ?? 0,
    };
    if (recorded.endedAt && recorded.durationMs == null) {
      recorded.durationMs = Math.max(0, Date.parse(recorded.endedAt) - Date.parse(recorded.startedAt));
    }
    this.phases.push(recorded);
    return recorded;
  }

  async measure<T>(
    id: string,
    owner: BenchmarkTimingOwner,
    work: () => Promise<T>,
    extra?: Partial<BenchmarkTimingPhase>,
  ): Promise<T> {
    this.start(id, owner, extra);
    try {
      return await work();
    } finally {
      this.stop(id);
    }
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
  'inspect-preflight',
  'model-import',
  'saved-rig-import',
  'panorama-import',
  'scene-authoring',
  'still-render.clay',
  'still-render.projected',
  'still-render.depth',
  'visual-preflight',
  'visual-review',
  'repair-pass-1',
  'repair-pass-2',
  'motion-video',
  'motion-encode',
  'save-package',
  'invoke-candidate',
  'collect-artifacts',
  'forbidden-scan',
  'technical-validation',
  'cold-open',
  'incremental',
  'recovery',
  'visual-grade',
  'reporting',
] as const;

export interface AgentCommandMeta {
  command?: string;
  rigMode?: string;
  appearance?: string;
}

export interface ClassifyState {
  applyCount: number;
  visualPreflightCount: number;
  openCount: number;
  repairCount: number;
}

export function emptyClassifyState(): ClassifyState {
  return { applyCount: 0, visualPreflightCount: 0, openCount: 0, repairCount: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function appearanceOf(value: string | undefined): 'clay' | 'projected' | 'depth' | undefined {
  if (value === 'clay' || value === 'projected' || value === 'depth') return value;
  return undefined;
}

export function parseAgentCommandLine(line: string): AgentCommandMeta | undefined {
  const marker = line.indexOf('[agent] command=');
  if (marker < 0) return undefined;
  const rest = line.slice(marker + '[agent] command='.length).trim();
  const command = rest.split(/\s+/)[0];
  const rigMode = /\brigMode=(\S+)/.exec(rest)?.[1];
  const appearance = /\bappearance=(\S+)/.exec(rest)?.[1];
  return { command, rigMode, appearance };
}

export function countChromiumLaunches(text: string): number {
  return [...text.matchAll(/\[agent\] chromium-launch\b/g)].length;
}

export function classifyCliPhase(
  operation: string,
  meta: AgentCommandMeta | undefined,
  state: ClassifyState,
): { id: string; appearance?: 'clay' | 'projected' | 'depth' } {
  const command = meta?.command ?? '';
  const appearance = appearanceOf(meta?.appearance)
    ?? appearanceOf(operation.split('.').at(-1));

  if (operation.startsWith('render.frame') || command === 'frame') {
    return { id: `still-render.${appearance ?? 'clay'}`, appearance: appearance ?? 'clay' };
  }
  if (operation.startsWith('render.video') || command === 'video') {
    return { id: 'motion-video', appearance: appearance ?? 'clay' };
  }
  if (command === 'import-character' || operation.includes('character.import')) {
    if (meta?.rigMode === 'saved-rig' || operation.toLowerCase().includes('savedrig')) {
      return { id: 'saved-rig-import' };
    }
    return { id: 'model-import' };
  }
  if (command === 'import-model' || operation.includes('model.import')) {
    return { id: 'model-import' };
  }
  if (command === 'import-panorama' || operation.includes('panorama')) {
    return { id: 'panorama-import' };
  }
  if (command === 'apply' || operation.includes('apply')) {
    state.applyCount += 1;
    if (state.visualPreflightCount > 0) {
      state.repairCount += 1;
      return { id: `repair-pass-${Math.min(state.repairCount, 2)}` };
    }
    return { id: 'scene-authoring' };
  }
  if (command === 'visual-preflight' || operation.includes('visualPreflight') || operation.includes('visual-preflight')) {
    state.visualPreflightCount += 1;
    return { id: 'visual-preflight' };
  }
  if (command === 'verify' || operation.startsWith('verify.')) {
    return { id: 'visual-review' };
  }
  if (command === 'open' || operation.includes('project.open')) {
    state.openCount += 1;
    return { id: state.openCount > 1 ? 'cold-reopen' : 'project-open' };
  }
  if (command === 'inspect' || operation.includes('inspect') || command === 'document') {
    return { id: 'inspect-preflight' };
  }
  if (command === 'save' || command === 'package' || operation.includes('save') || operation.includes('package')) {
    return { id: 'save-package' };
  }
  return { id: operation || command || 'cli-operation' };
}

export function extractCacheAndRetries(envelope: AgentCliEnvelope): {
  cache?: BenchmarkCacheTiming;
  retries: number;
  encodeMs?: number;
} {
  const result = asRecord(envelope.result);
  const nested = asRecord(result?.result) ?? result;
  const provenance = asRecord(nested?.provenance) ?? asRecord(result?.provenance);
  const cache = asRecord(provenance?.cache);
  const operations = Array.isArray(cache?.operations) ? cache.operations as Array<{ hit?: boolean }> : [];
  const retriesRaw = provenance?.retries;
  const retries = typeof retriesRaw === 'number' ? retriesRaw : 0;
  const timing = asRecord(nested?.timing) ?? asRecord(result?.timing);
  const encodeRaw = timing?.encodeMs ?? timing?.encodeDurationMs;
  const encodeMs = typeof encodeRaw === 'number' ? encodeRaw : undefined;
  if (operations.length === 0 && !cache) {
    return { retries, encodeMs };
  }
  const hits = operations.filter((op) => op.hit === true).length;
  const misses = operations.filter((op) => op.hit === false).length;
  return {
    cache: { present: true, hits, misses },
    retries,
    encodeMs,
  };
}

export function ingestCliLogs(
  clock: BenchmarkClock,
  input: {
    stdout: string;
    stderr: string;
    owner?: BenchmarkTimingOwner;
    parentId?: string;
    fallbackStartedAt?: string;
  },
): { chromiumLaunches: number; operationCount: number } {
  const owner = input.owner ?? 'forescene';
  const loggedLaunches = countChromiumLaunches(input.stderr);
  const envelopes = extractAgentEnvelopes(input.stdout);
  const commandMetas = input.stderr
    .split(/\r?\n/)
    .map(parseAgentCommandLine)
    .filter((row): row is AgentCommandMeta => Boolean(row));
  const state = emptyClassifyState();
  let cursor = 0;
  for (const envelope of envelopes) {
    const meta = commandMetas[cursor];
    if (meta) cursor += 1;
    const classified = classifyCliPhase(envelope.operation, meta, state);
    const extras = extractCacheAndRetries(envelope);
    const endedAt = new Date().toISOString();
    const durationMs = Math.max(0, envelope.durationMs);
    const startedAt = new Date(Date.parse(endedAt) - durationMs).toISOString();
    clock.record({
      id: classified.id,
      owner,
      kind: 'operation',
      parentId: input.parentId,
      operation: envelope.operation,
      command: meta?.command,
      appearance: classified.appearance,
      startedAt: input.fallbackStartedAt ?? startedAt,
      endedAt,
      durationMs,
      retries: extras.retries,
      cacheHits: extras.cache?.hits,
      cacheMisses: extras.cache?.misses,
      encodeMs: extras.encodeMs,
    });
    if (extras.encodeMs != null && classified.id === 'motion-video') {
      clock.record({
        id: 'motion-encode',
        owner,
        kind: 'operation',
        parentId: input.parentId,
        operation: envelope.operation,
        startedAt,
        endedAt,
        durationMs: extras.encodeMs,
        encodeMs: extras.encodeMs,
        notes: 'Encode duration from envelope timing; not inferred.',
      });
    }
  }
  const inferred = loggedLaunches > 0
    ? loggedLaunches
    : envelopes.filter((envelope) => !['agent.capabilities', 'agent.help', 'operation.list', 'operation.cancel'].includes(envelope.operation)).length;
  if (inferred > 0) {
    clock.record({
      id: 'chromium-launches',
      owner,
      kind: 'operation',
      parentId: input.parentId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      chromiumLaunches: inferred,
      notes: loggedLaunches > 0 ? 'Counted from [agent] chromium-launch.' : 'Inferred from browser-backed CLI envelopes.',
    });
  }
  return { chromiumLaunches: inferred, operationCount: envelopes.length };
}

export function ingestAgentInvocation(
  clock: BenchmarkClock,
  invocation: { stdout?: string; stderr?: string; durationMs?: number; envelope?: AgentCliEnvelope },
  extra: { id?: string; owner?: BenchmarkTimingOwner; parentId?: string; command?: string; rigMode?: string; appearance?: string },
): void {
  const envelope = invocation.envelope;
  const durationMs = invocation.durationMs ?? envelope?.durationMs ?? 0;
  const endedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - Math.max(0, durationMs)).toISOString();
  const launches = countChromiumLaunches(invocation.stderr ?? '');
  if (!envelope) {
    if (launches > 0) {
      clock.record({
        id: extra.id ?? 'chromium-launches',
        owner: extra.owner ?? 'forescene',
        kind: 'operation',
        parentId: extra.parentId,
        startedAt,
        endedAt,
        durationMs: 0,
        chromiumLaunches: launches,
        notes: 'Counted from [agent] chromium-launch.',
      });
    }
    return;
  }
  const state = emptyClassifyState();
  const classified = extra.id
    ? { id: extra.id, appearance: appearanceOf(extra.appearance) }
    : classifyCliPhase(envelope.operation, {
      command: extra.command,
      rigMode: extra.rigMode,
      appearance: extra.appearance,
    }, state);
  const extras = extractCacheAndRetries(envelope);
  clock.record({
    id: classified.id,
    owner: extra.owner ?? 'forescene',
    kind: 'operation',
    parentId: extra.parentId,
    operation: envelope.operation,
    command: extra.command,
    appearance: classified.appearance,
    startedAt,
    endedAt,
    durationMs,
    retries: extras.retries,
    cacheHits: extras.cache?.hits,
    cacheMisses: extras.cache?.misses,
    encodeMs: extras.encodeMs,
    chromiumLaunches: launches,
  });
}

function sumDuration(phases: BenchmarkTimingPhase[], pred: (phase: BenchmarkTimingPhase) => boolean): number {
  return phases.reduce((sum, phase) => sum + (pred(phase) && typeof phase.durationMs === 'number' ? phase.durationMs : 0), 0);
}

export function summarizeBenchmarkTiming(phases: BenchmarkTimingPhase[]): BenchmarkTimingSummary {
  const completed = phases.filter((phase) => typeof phase.durationMs === 'number');
  const run = completed.find((phase) => phase.id === 'run' && phase.kind !== 'operation');
  const wallMs = run?.durationMs
    ?? (completed.length === 0
      ? 0
      : Math.max(0, Math.max(...completed.map((phase) => Date.parse(phase.endedAt ?? phase.startedAt)))
        - Math.min(...completed.map((phase) => Date.parse(phase.startedAt)))));

  const span = (id: string) => completed.find((phase) => phase.id === id && (phase.kind ?? 'span') === 'span');
  const candidateWallMs = span('invoke-candidate')?.durationMs ?? 0;
  const harnessWallMs = sumDuration(completed, (phase) => (
    (phase.kind ?? 'span') === 'span'
    && phase.owner === 'harness'
    && phase.id !== 'run'
    && !phase.parentId
  ));
  const toolOps = completed.filter((phase) => (
    phase.kind === 'operation'
    && phase.id !== 'chromium-launches'
    && phase.id !== 'motion-encode'
  ));
  const foresceneToolMs = sumDuration(toolOps, () => true);
  const candidateToolMs = sumDuration(toolOps, (phase) => phase.parentId === 'invoke-candidate');
  const loggedLaunches = completed.reduce((sum, phase) => sum + (phase.chromiumLaunches ?? 0), 0);
  const retries = completed.reduce((sum, phase) => sum + (phase.retries ?? 0), 0);
  const cacheOps = completed.filter((phase) => phase.cacheHits != null || phase.cacheMisses != null);
  const cache: BenchmarkCacheTiming = cacheOps.length === 0
    ? { present: false, hits: 0, misses: 0 }
    : {
      present: true,
      hits: cacheOps.reduce((sum, phase) => sum + (phase.cacheHits ?? 0), 0),
      misses: cacheOps.reduce((sum, phase) => sum + (phase.cacheMisses ?? 0), 0),
    };
  const byPhaseId: Record<string, { count: number; durationMs: number }> = {};
  for (const phase of completed) {
    if (phase.id === 'chromium-launches') continue;
    const row = byPhaseId[phase.id] ?? { count: 0, durationMs: 0 };
    row.count += 1;
    row.durationMs += phase.durationMs ?? 0;
    byPhaseId[phase.id] = row;
  }
  const chromiumLaunchPhase = completed.find((phase) => phase.id === 'chromium-launches');
  return {
    wallMs,
    harnessWallMs,
    candidateWallMs,
    foresceneToolMs,
    candidateMinusToolMs: Math.max(0, candidateWallMs - candidateToolMs),
    operationCount: toolOps.length,
    chromiumLaunches: loggedLaunches,
    chromiumLaunchSource: loggedLaunches === 0
      ? 'none'
      : chromiumLaunchPhase?.notes?.includes('Inferred')
        ? 'inferred-cli-ops'
        : 'logged',
    retries,
    cache,
    byPhaseId,
    phases,
    policy: {
      measureBeforeOptimize: true,
      retriesMustRemainZero: true,
      soakGateTotalsAreNotE2EPhases: true,
    },
  };
}
