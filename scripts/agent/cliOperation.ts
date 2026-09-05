/**
 * CLI operation lifecycle, heartbeat, and cooperative cancellation.
 *
 * Heavy commands stay synchronous at the process boundary, but they keep an
 * operation record alive so a harness can tell "still working" from "stuck"
 * and cancel with SIGINT to the CLI pid — never by killing Chromium.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeSync } from 'node:fs';
import path from 'node:path';
import { resolveForeSceneRepoRoot } from './repoRoot';

export const REPO_ROOT = resolveForeSceneRepoRoot();
export const AGENT_OPERATIONS_DIR = path.resolve(REPO_ROOT, '.forescene-agent/operations');

export const CLI_OPERATION_STATES = [
  'requested',
  'accepted',
  'running',
  'progress',
  'completed',
  'failed',
  'cancelled',
] as const;

export type CliOperationState = (typeof CLI_OPERATION_STATES)[number];

export interface CliOperationRecord {
  operationId: string;
  type: string;
  state: CliOperationState;
  progress: number;
  message?: string;
  pid: number;
  profile?: string;
  startedAt: string;
  updatedAt: string;
  heartbeatAt: string;
  heartbeatCount: number;
  cancelRequested: boolean;
}

export interface CliOperationHeartbeat {
  event: 'heartbeat';
  operationId: string;
  type: string;
  state: CliOperationState;
  progress: number;
  message?: string;
  elapsedMs: number;
  heartbeatCount: number;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export function heartbeatIntervalMs(): number {
  const raw = Number(process.env.FORESCENE_AGENT_HEARTBEAT_MS);
  if (Number.isFinite(raw) && raw >= 250) return raw;
  return DEFAULT_HEARTBEAT_INTERVAL_MS;
}

export function createCliOperationId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function operationRecordPath(operationId: string): string {
  return path.join(AGENT_OPERATIONS_DIR, `${operationId}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isTerminalCliOperationState(state: CliOperationState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export async function writeCliOperationRecord(record: CliOperationRecord): Promise<string> {
  await mkdir(AGENT_OPERATIONS_DIR, { recursive: true });
  const target = operationRecordPath(record.operationId);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rm(tmp, { force: true });
  return target;
}

export async function readCliOperationRecord(operationId: string): Promise<CliOperationRecord | undefined> {
  const target = operationRecordPath(operationId);
  if (!existsSync(target)) return undefined;
  try {
    return JSON.parse(await readFile(target, 'utf8')) as CliOperationRecord;
  } catch {
    return undefined;
  }
}

export async function listCliOperationRecords(): Promise<CliOperationRecord[]> {
  if (!existsSync(AGENT_OPERATIONS_DIR)) return [];
  const names = (await readdir(AGENT_OPERATIONS_DIR)).filter((name) => name.endsWith('.json'));
  const records: CliOperationRecord[] = [];
  for (const name of names) {
    const record = await readCliOperationRecord(name.replace(/\.json$/, ''));
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function emitCliHeartbeat(heartbeat: CliOperationHeartbeat): void {
  const line = `${JSON.stringify(heartbeat)}\n`;
  try {
    writeSync(2, `[agent-op] ${line}`);
  } catch {
    process.stderr.write(`[agent-op] ${line}`);
  }
}

export function createCliOperation(input: {
  type: string;
  profile?: string;
  message?: string;
}): CliOperationRecord {
  const timestamp = nowIso();
  return {
    operationId: createCliOperationId(),
    type: input.type,
    state: 'requested',
    progress: 0,
    message: input.message ?? 'Operation requested.',
    pid: process.pid,
    profile: input.profile,
    startedAt: timestamp,
    updatedAt: timestamp,
    heartbeatAt: timestamp,
    heartbeatCount: 0,
    cancelRequested: false,
  };
}

export interface CliOperationHandle {
  record: CliOperationRecord;
  start: (message?: string) => Promise<void>;
  progress: (input: { progress?: number; message?: string; state?: CliOperationState }) => Promise<void>;
  heartbeat: (input?: { progress?: number; message?: string }) => Promise<void>;
  complete: (message?: string) => Promise<void>;
  fail: (message?: string) => Promise<void>;
  cancel: (message?: string) => Promise<void>;
  isCancelRequested: () => Promise<boolean>;
  dispose: () => void;
}

export function beginCliOperation(input: {
  type: string;
  profile?: string;
  message?: string;
  heartbeatMs?: number;
  onCancel?: () => void;
}): CliOperationHandle {
  const record = createCliOperation(input);
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const startedAt = Date.now();

  const persist = async () => {
    record.updatedAt = nowIso();
    await writeCliOperationRecord(record);
  };

  const beat = async (message?: string, progress?: number) => {
    if (disposed || isTerminalCliOperationState(record.state)) return;
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      record.progress = Math.min(1, Math.max(0, progress));
    }
    if (message) record.message = message;
    if (record.state === 'accepted' || record.state === 'requested') record.state = 'running';
    else if (record.state === 'running') record.state = 'progress';
    record.heartbeatCount += 1;
    record.heartbeatAt = nowIso();
    await persist();
    emitCliHeartbeat({
      event: 'heartbeat',
      operationId: record.operationId,
      type: record.type,
      state: record.state,
      progress: record.progress,
      message: record.message,
      elapsedMs: Date.now() - startedAt,
      heartbeatCount: record.heartbeatCount,
    });
  };

  const handle: CliOperationHandle = {
    record,
    async start(message) {
      record.state = 'accepted';
      record.message = message ?? 'Operation accepted.';
      await persist();
      await beat(record.message, record.progress);
      const interval = input.heartbeatMs ?? heartbeatIntervalMs();
      timer = setInterval(() => {
        void (async () => {
          if (await handle.isCancelRequested()) {
            input.onCancel?.();
            return;
          }
          await beat();
        })();
      }, interval);
      timer.unref?.();
    },
    async progress(update) {
      if (update.state) record.state = update.state;
      await beat(update.message, update.progress);
    },
    async heartbeat(update = {}) {
      await beat(update.message, update.progress);
    },
    async complete(message) {
      if (isTerminalCliOperationState(record.state)) return;
      record.state = 'completed';
      record.progress = 1;
      record.message = message ?? 'Operation completed.';
      await persist();
      handle.dispose();
    },
    async fail(message) {
      if (isTerminalCliOperationState(record.state)) return;
      record.state = 'failed';
      record.message = message ?? 'Operation failed.';
      await persist();
      handle.dispose();
    },
    async cancel(message) {
      if (isTerminalCliOperationState(record.state)) return;
      record.state = 'cancelled';
      record.cancelRequested = true;
      record.message = message ?? 'Operation cancelled.';
      await persist();
      handle.dispose();
    },
    async isCancelRequested() {
      const latest = await readCliOperationRecord(record.operationId);
      if (latest?.cancelRequested) {
        record.cancelRequested = true;
        return true;
      }
      return record.cancelRequested;
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = undefined;
      disposed = true;
    },
  };

  return handle;
}

export async function requestCliOperationCancel(operationId: string): Promise<{
  ok: boolean;
  operationId: string;
  signaled: boolean;
  alreadyTerminal: boolean;
  record?: CliOperationRecord;
  message: string;
}> {
  const record = await readCliOperationRecord(operationId);
  if (!record) {
    return {
      ok: false,
      operationId,
      signaled: false,
      alreadyTerminal: false,
      message: `No operation with id "${operationId}".`,
    };
  }
  if (isTerminalCliOperationState(record.state)) {
    return {
      ok: true,
      operationId,
      signaled: false,
      alreadyTerminal: true,
      record,
      message: `Operation is already ${record.state}.`,
    };
  }
  record.cancelRequested = true;
  record.updatedAt = nowIso();
  const sameProcess = record.pid === process.pid;
  const processAlive = sameProcess || isProcessAlive(record.pid);
  if (!sameProcess && !processAlive) {
    record.state = 'cancelled';
    record.message = 'Operation cancelled because its CLI process is no longer running.';
    await writeCliOperationRecord(record);
    return {
      ok: true,
      operationId,
      signaled: false,
      alreadyTerminal: false,
      record,
      message: record.message,
    };
  }
  await writeCliOperationRecord(record);

  let signaled = false;
  if (!sameProcess && processAlive) {
    try {
      process.kill(record.pid, 'SIGINT');
      signaled = true;
    } catch {
      signaled = false;
    }
  }

  return {
    ok: true,
    operationId,
    signaled,
    alreadyTerminal: false,
    record,
    message: signaled
      ? `Requested cancel and sent SIGINT to CLI pid ${record.pid}.`
      : 'Requested cancel. The running CLI will stop at the next heartbeat.',
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function latestActiveCliOperation(): Promise<CliOperationRecord | undefined> {
  const records = await listCliOperationRecords();
  return records.find((record) => !isTerminalCliOperationState(record.state));
}

export function characterImportPhaseProgress(phase?: string): number {
  switch (phase) {
    case 'reading': return 0.12;
    case 'parsing': return 0.24;
    case 'analyzing': return 0.4;
    case 'mapping': return 0.55;
    case 'validating': return 0.68;
    case 'writing': return 0.8;
    case 'registering': return 0.88;
    case 'saving': return 0.95;
    case 'complete': return 1;
    default: return 0.3;
  }
}
