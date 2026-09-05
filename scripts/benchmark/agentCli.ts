/**
 * Invoke the documented Agent CLI from the harness. Candidates must use the
 * same `npm run agent:*` surface; the harness never calls window.foreScene.
 */

import { extractAgentEnvelope, extractAgentEnvelopes, runDocumentedAgentCommand } from '../agent/runDocumentedCli';
import { classifyCliFailure, infrastructureFailure } from './failures';
import type { BenchmarkFailure } from './types';
import type { AgentCliEnvelope } from '../agent/cliResult';

export interface AgentCliInvocation {
  code: number;
  stdout: string;
  stderr: string;
  envelope?: AgentCliEnvelope;
  durationMs?: number;
}

export { extractAgentEnvelope, extractAgentEnvelopes };

export async function invokeAgentCli(input: {
  repoRoot: string;
  args: string[];
  url: string;
  profile: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<AgentCliInvocation> {
  const command = input.args[0];
  if (!command) {
    return {
      code: 2,
      stdout: '',
      stderr: 'Agent CLI command is required.',
    };
  }
  try {
    const invocation = await runDocumentedAgentCommand({
      command,
      args: input.args.slice(1),
      url: input.url,
      profile: input.profile,
      cwd: input.cwd ?? input.repoRoot,
      repoRoot: input.repoRoot,
      env: input.env,
      timeoutMs: input.timeoutMs ?? 180_000,
    });
    return {
      code: invocation.code,
      stdout: invocation.stdout,
      stderr: invocation.stderr,
      envelope: invocation.envelope ?? extractAgentEnvelope(invocation.stdout),
      durationMs: invocation.durationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      stdout: '',
      stderr: message,
    };
  }
}

export function failureFromInvocation(invocation: AgentCliInvocation, fallbackOperation: string): BenchmarkFailure {
  const envelope = invocation.envelope;
  const message = envelope?.error?.message || invocation.stderr.slice(-800) || `Agent CLI exited ${invocation.code}`;
  if (/\btimeout\b/i.test(message) || /exceeded \d+ms/i.test(message)) {
    return infrastructureFailure(envelope?.operation ?? fallbackOperation, message);
  }
  return classifyCliFailure({
    operation: envelope?.operation ?? fallbackOperation,
    message,
    exitCode: invocation.code,
    code: envelope?.error?.code,
  });
}
