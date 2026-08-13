import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { invokeAgentCli } from '../benchmark/agentCli';
import { repoRoot } from '../benchmark/layout';
import { SOAK_GATE_NAMES, type SoakGateResult } from './types';

function skipped(id: 'B' | 'C', message: string, started: number): SoakGateResult {
  return {
    id,
    name: SOAK_GATE_NAMES[id],
    status: 'skipped',
    requiredLive: true,
    message,
    durationMs: Date.now() - started,
    retries: 0,
  };
}

export async function runGateB(input: {
  url?: string;
  iterations?: number;
}): Promise<SoakGateResult> {
  const started = Date.now();
  if (!input.url) {
    return skipped('B', 'Live 20/20 saved-rig soak requires --url. In-process coverage: tests/agentCharacterImport.test.ts.', started);
  }
  const iterations = input.iterations ?? 20;
  const tsxCli = path.join(repoRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(repoRoot(), 'scripts', 'agent', 'savedRigSoak.ts');
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [tsxCli, script, '--url', input.url!, '--write', '--headless'], {
      cwd: repoRoot(),
      env: {
        ...process.env,
        FORESCENE_SAVED_RIG_SOAK_ITERATIONS: String(iterations),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  if (result.code !== 0) {
    return {
      id: 'B',
      name: SOAK_GATE_NAMES.B,
      status: 'failed',
      requiredLive: true,
      message: result.stderr.slice(-600) || `Saved-rig soak exited ${result.code}.`,
      durationMs: Date.now() - started,
      retries: 0,
    };
  }
  return {
    id: 'B',
    name: SOAK_GATE_NAMES.B,
    status: 'passed',
    requiredLive: true,
    message: `Saved-rig soak completed ${iterations} consecutive imports.`,
    durationMs: Date.now() - started,
    retries: 0,
  };
}

function firstShotId(payload: unknown): string | undefined {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
  const result = record?.result && typeof record.result === 'object' ? record.result as Record<string, unknown> : record;
  const shots = result?.shots;
  if (!Array.isArray(shots) || shots.length === 0) return undefined;
  const first = shots[0] as unknown;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const row = first as Record<string, unknown>;
    if (typeof row.id === 'string') return row.id;
    if (typeof row.shotId === 'string') return row.shotId;
  }
  return undefined;
}

export async function runGateC(input: {
  url?: string;
  profileDir?: string;
  iterations?: number;
}): Promise<SoakGateResult> {
  const started = Date.now();
  if (!input.url || !input.profileDir) {
    return skipped('C', 'Live 10/10 clay-frame soak requires --url.', started);
  }
  const inspect = await invokeAgentCli({
    repoRoot: repoRoot(),
    args: ['inspect'],
    url: input.url,
    profile: input.profileDir,
  });
  const shotId = firstShotId(inspect.envelope);
  if (!shotId) {
    return {
      id: 'C',
      name: SOAK_GATE_NAMES.C,
      status: 'failed',
      requiredLive: true,
      message: 'Inspect returned no shot id to render.',
      durationMs: Date.now() - started,
      retries: 0,
    };
  }

  const iterations = input.iterations ?? 10;
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'forescene-soak-frames-'));
  await mkdir(outputRoot, { recursive: true });
  for (let index = 0; index < iterations; index += 1) {
    const output = path.join(outputRoot, `frame-${index + 1}.png`);
    const frame = await invokeAgentCli({
      repoRoot: repoRoot(),
      args: ['frame', '--shot', shotId, '--mode', 'clay', '--output', output],
      url: input.url,
      profile: input.profileDir,
    });
    if (frame.code !== 0 || frame.envelope?.ok === false) {
      await writeFile(path.join(outputRoot, `frame-${index + 1}.stderr.log`), frame.stderr).catch(() => undefined);
      return {
        id: 'C',
        name: SOAK_GATE_NAMES.C,
        status: 'failed',
        requiredLive: true,
        message: frame.envelope?.error?.message
          ?? `Clay frame ${index + 1}/${iterations} failed for shot ${shotId}.`,
        durationMs: Date.now() - started,
        retries: 0,
      };
    }
  }

  return {
    id: 'C',
    name: SOAK_GATE_NAMES.C,
    status: 'passed',
    requiredLive: true,
    message: `Rendered ${iterations} clay frames for shot ${shotId} without retries.`,
    durationMs: Date.now() - started,
    retries: 0,
    details: { shotId, iterations },
  };
}
