/**
 * Spawn documented `npm run agent:*` commands. Candidates and E2E tests must
 * use this surface — not `window.foreScene`, not `tsx scripts/agent/cli.ts`
 * as the public contract, and not custom glue scripts.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { isAgentCliEnvelope, type AgentCliEnvelope } from './cliResult';
import { resolveForeSceneRepoRoot } from './repoRoot';

export interface DocumentedCliInvocation {
  command: string;
  npmScript: string;
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
  envelope?: AgentCliEnvelope;
  durationMs: number;
  heartbeats: AgentOpHeartbeat[];
  timedOut: boolean;
}

export interface AgentOpHeartbeat {
  event: 'heartbeat';
  operationId: string;
  type: string;
  state: string;
  progress: number;
  message?: string;
  elapsedMs: number;
  heartbeatCount: number;
}

export interface DocumentedCliRunInput {
  command: string;
  args?: string[];
  url?: string;
  profile?: string;
  cwd?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  headless?: boolean;
}

export interface LiveDocumentedCliProcess {
  command: string;
  npmScript: string;
  argv: string[];
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  heartbeats: () => AgentOpHeartbeat[];
  interrupt: () => void;
  wait: () => Promise<DocumentedCliInvocation>;
}

function endOfJsonValue(text: string, start: number): number {
  let index = start;
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  while (index < text.length) {
    const ch = text[index]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      index += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return index;
      index += 1;
      continue;
    }
    index += 1;
  }
  return -1;
}

export function extractAgentEnvelopes(text: string): AgentCliEnvelope[] {
  const envelopes: AgentCliEnvelope[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('{', index);
    if (start < 0) break;
    const end = endOfJsonValue(text, start);
    if (end < 0) break;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (isAgentCliEnvelope(parsed)) envelopes.push(parsed);
    } catch {
      // Not a complete JSON value; keep scanning.
    }
    index = end + 1;
  }
  return envelopes;
}

export function extractAgentEnvelope(stdout: string): AgentCliEnvelope | undefined {
  return extractAgentEnvelopes(stdout).at(-1);
}

export function parseAgentOpHeartbeatLine(line: string): AgentOpHeartbeat | undefined {
  const marker = line.indexOf('[agent-op]');
  if (marker < 0) return undefined;
  const raw = line.slice(marker + '[agent-op]'.length).trim();
  try {
    const parsed = JSON.parse(raw) as Partial<AgentOpHeartbeat>;
    if (parsed.event !== 'heartbeat') return undefined;
    if (typeof parsed.operationId !== 'string' || typeof parsed.heartbeatCount !== 'number') return undefined;
    return {
      event: 'heartbeat',
      operationId: parsed.operationId,
      type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
      state: typeof parsed.state === 'string' ? parsed.state : 'running',
      progress: typeof parsed.progress === 'number' ? parsed.progress : 0,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      elapsedMs: typeof parsed.elapsedMs === 'number' ? parsed.elapsedMs : 0,
      heartbeatCount: parsed.heartbeatCount,
    };
  } catch {
    return undefined;
  }
}

export function extractAgentOpHeartbeats(stderr: string): AgentOpHeartbeat[] {
  return stderr.split(/\r?\n/).map(parseAgentOpHeartbeatLine).filter((item): item is AgentOpHeartbeat => Boolean(item));
}

export function documentedAgentNpmScript(command: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(command)) {
    throw new Error(`Invalid Agent CLI command name: ${command}`);
  }
  return `agent:${command}`;
}

function buildSpawn(input: DocumentedCliRunInput): {
  repoRoot: string;
  npmScript: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  const repoRoot = resolveForeSceneRepoRoot(input.repoRoot);
  const npmScript = documentedAgentNpmScript(input.command);
  const extra = [...(input.args ?? [])];
  if (input.url && !extra.includes('--url')) extra.push('--url', input.url);
  if (input.profile && !extra.includes('--profile')) extra.push('--profile', input.profile);
  if (input.headless !== false && !extra.includes('--headless')) extra.push('--headless');
  return {
    repoRoot,
    npmScript,
    argv: ['--prefix', repoRoot, 'run', npmScript, '--', ...extra],
    cwd: input.cwd ?? repoRoot,
    env: {
      ...process.env,
      FORESCENE_REPO_ROOT: repoRoot,
      ...(input.url ? { FORESCENE_URL: input.url } : {}),
      ...(input.profile ? { FORESCENE_PROFILE: input.profile } : {}),
      ...input.env,
    },
  };
}

function spawnNpm(argv: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? spawn(process.execPath, [npmExecPath, ...argv], { cwd, env })
    : spawn('npm', argv, { cwd, env });
}

export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid || process.platform !== 'win32') return;
  execFile(
    'taskkill.exe',
    ['/PID', String(child.pid), '/T', '/F'],
    { windowsHide: true },
    () => undefined,
  );
}

export function startDocumentedAgentCommand(input: DocumentedCliRunInput): LiveDocumentedCliProcess {
  const prepared = buildSpawn(input);
  const started = Date.now();
  const child = spawnNpm(prepared.argv, prepared.cwd, prepared.env);
  let stdout = '';
  let stderr = '';
  const heartbeats: AgentOpHeartbeat[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let treeTermination: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let settled: DocumentedCliInvocation | undefined;
  let failure: Error | undefined;
  const waiters: Array<(invocation: DocumentedCliInvocation) => void> = [];
  const failers: Array<(error: Error) => void> = [];

  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk);
    stderr += text;
    for (const line of text.split(/\r?\n/)) {
      const heartbeat = parseAgentOpHeartbeatLine(line);
      if (heartbeat) heartbeats.push(heartbeat);
    }
  });

  const interrupt = () => {
    child.kill('SIGINT');
  };

  if (input.timeoutMs) {
    timeout = setTimeout(() => {
      timedOut = true;
      interrupt();
      // SIGINT reaches only the npm wrapper on Windows. Give the CLI a short
      // chance to close its browser context, then terminate that wrapper's
      // complete process tree so Chromium cannot retain the profile lock.
      treeTermination = setTimeout(() => {
        if (!settled) terminateProcessTree(child);
      }, 2_000);
    }, input.timeoutMs);
  }

  child.on('error', (error) => {
    if (timeout) clearTimeout(timeout);
    failure = error;
    for (const reject of failers) reject(error);
  });
  child.on('close', (code) => {
    if (timeout) clearTimeout(timeout);
    if (treeTermination) clearTimeout(treeTermination);
    settled = {
      command: input.command,
      npmScript: prepared.npmScript,
      argv: prepared.argv,
      code: code ?? 1,
      stdout,
      stderr,
      envelope: extractAgentEnvelope(stdout),
      durationMs: Date.now() - started,
      heartbeats: heartbeats.length > 0 ? [...heartbeats] : extractAgentOpHeartbeats(stderr),
      timedOut,
    };
    for (const resolve of waiters) resolve(settled);
  });

  const wait = () => new Promise<DocumentedCliInvocation>((resolve, reject) => {
    if (failure) {
      reject(failure);
      return;
    }
    if (settled) {
      resolve(settled);
      return;
    }
    waiters.push(resolve);
    failers.push(reject);
  });

  return {
    command: input.command,
    npmScript: prepared.npmScript,
    argv: prepared.argv,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    heartbeats: () => [...heartbeats],
    interrupt,
    wait,
  };
}

export async function runDocumentedAgentCommand(input: DocumentedCliRunInput): Promise<DocumentedCliInvocation> {
  return startDocumentedAgentCommand(input).wait();
}

export function assertSuccessfulEnvelope(invocation: DocumentedCliInvocation): AgentCliEnvelope {
  if (invocation.code !== 0) {
    const detail = invocation.envelope
      ? JSON.stringify({
        ok: invocation.envelope.ok,
        operation: invocation.envelope.operation,
        error: invocation.envelope.error,
        result: invocation.envelope.result,
      }).slice(0, 1_200)
      : invocation.stderr.slice(-600);
    throw new Error(`${invocation.npmScript} exited ${invocation.code}: ${detail}`);
  }
  if (!invocation.envelope) {
    throw new Error(`${invocation.npmScript} did not print a JSON envelope on stdout.`);
  }
  if (invocation.envelope.ok !== true) {
    throw new Error(
      `${invocation.npmScript} envelope ok=false: ${invocation.envelope.error?.message ?? 'unknown error'}`,
    );
  }
  if (typeof invocation.envelope.durationMs !== 'number' || !Array.isArray(invocation.envelope.warnings)) {
    throw new Error(`${invocation.npmScript} envelope is missing durationMs or warnings.`);
  }
  return invocation.envelope;
}
