/**
 * Spawn documented `npm run agent:*` commands. Candidates and E2E tests must
 * use this surface — not `window.foreScene`, not `tsx scripts/agent/cli.ts`
 * as the public contract, and not custom glue scripts.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
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
}

export function extractAgentEnvelope(stdout: string): AgentCliEnvelope | undefined {
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as unknown;
    return isAgentCliEnvelope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function documentedAgentNpmScript(command: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(command)) {
    throw new Error(`Invalid Agent CLI command name: ${command}`);
  }
  return `agent:${command}`;
}

export async function runDocumentedAgentCommand(input: {
  command: string;
  args?: string[];
  url?: string;
  profile?: string;
  cwd?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<DocumentedCliInvocation> {
  const repoRoot = resolveForeSceneRepoRoot(input.repoRoot);
  const npmScript = documentedAgentNpmScript(input.command);
  const extra = [...(input.args ?? [])];
  if (input.url && !extra.includes('--url')) extra.push('--url', input.url);
  if (input.profile && !extra.includes('--profile')) extra.push('--profile', input.profile);
  if (!extra.includes('--headless')) extra.push('--headless');

  const argv = ['--prefix', repoRoot, 'run', npmScript, '--', ...extra];
  const started = Date.now();
  const npmExecPath = process.env.npm_execpath;
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = npmExecPath
      ? spawn(process.execPath, [npmExecPath, ...argv], {
        cwd: input.cwd ?? repoRoot,
        env: {
          ...process.env,
          FORESCENE_REPO_ROOT: repoRoot,
          ...(input.url ? { FORESCENE_URL: input.url } : {}),
          ...(input.profile ? { FORESCENE_PROFILE: input.profile } : {}),
          ...input.env,
        },
      })
      : spawn('npm', argv, {
        cwd: input.cwd ?? repoRoot,
        env: {
          ...process.env,
          FORESCENE_REPO_ROOT: repoRoot,
          ...(input.url ? { FORESCENE_URL: input.url } : {}),
          ...(input.profile ? { FORESCENE_PROFILE: input.profile } : {}),
          ...input.env,
        },
      });
    let stdout = '';
    let stderr = '';
    const timeout = input.timeoutMs
      ? setTimeout(() => {
        child.kill('SIGINT');
        reject(new Error(`npm run ${npmScript} exceeded ${input.timeoutMs}ms`));
      }, input.timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

  return {
    command: input.command,
    npmScript,
    argv,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    envelope: extractAgentEnvelope(result.stdout),
    durationMs: Date.now() - started,
  };
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
