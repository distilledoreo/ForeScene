/**
 * Invoke the documented Agent CLI from the harness. Candidates must use the
 * same commands; the harness never calls window.foreScene.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { isAgentCliEnvelope, type AgentCliEnvelope } from '../agent/cliResult';
import { classifyCliFailure } from './failures';
import type { BenchmarkFailure } from './types';

export interface AgentCliInvocation {
  code: number;
  stdout: string;
  stderr: string;
  envelope?: AgentCliEnvelope;
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

export function invokeAgentCli(input: {
  repoRoot: string;
  args: string[];
  url: string;
  profile: string;
}): Promise<AgentCliInvocation> {
  const tsxCli = path.join(input.repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(input.repoRoot, 'scripts', 'agent', 'cli.ts');
  const argv = [
    tsxCli,
    script,
    ...input.args,
    '--url',
    input.url,
    '--profile',
    input.profile,
    '--headless',
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      cwd: input.repoRoot,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        envelope: extractAgentEnvelope(stdout),
      });
    });
  });
}

export function failureFromInvocation(invocation: AgentCliInvocation, fallbackOperation: string): BenchmarkFailure {
  const envelope = invocation.envelope;
  const failure = classifyCliFailure({
    operation: envelope?.operation ?? fallbackOperation,
    message: envelope?.error?.message || invocation.stderr.slice(-800) || `Agent CLI exited ${invocation.code}`,
    exitCode: invocation.code,
  });
  if (/\btimeout\b/i.test(failure.message)) {
    failure.class = 'INFRASTRUCTURE_FAILURE';
  }
  return failure;
}
