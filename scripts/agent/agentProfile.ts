/**
 * Explicit Agent CLI browser-profile resolution.
 *
 * Stateful commands must pass --profile. The default
 * `.forescene-agent/browser-profile` path is refused even when named explicitly.
 */

import path from 'node:path';
import { AgentCliUsageError } from './cliResult';
import { resolveForeSceneRepoRoot } from './repoRoot';

export const DEFAULT_AGENT_PROFILE_RELATIVE = '.forescene-agent/browser-profile';

export const STATELESS_AGENT_CLI_COMMANDS = [
  'capabilities',
  'help',
  'operations',
  'cancel',
  'contact-sheet',
  'verify-package',
] as const;

export function defaultAgentProfilePath(repoRoot: string = resolveForeSceneRepoRoot()): string {
  return path.resolve(repoRoot, DEFAULT_AGENT_PROFILE_RELATIVE);
}

export function agentCliCommandRequiresProfile(command: string): boolean {
  return !(STATELESS_AGENT_CLI_COMMANDS as readonly string[]).includes(command);
}

function normalizePath(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/, '');
}

export function resolveAgentProfilePath(
  explicit: string | undefined,
  repoRoot: string = resolveForeSceneRepoRoot(),
): string | undefined {
  if (explicit === undefined || explicit.trim() === '') return undefined;
  return normalizePath(
    path.isAbsolute(explicit) ? explicit : path.resolve(repoRoot, explicit),
  );
}

export function isDefaultAgentProfilePath(
  candidate: string,
  repoRoot: string = resolveForeSceneRepoRoot(),
): boolean {
  return normalizePath(candidate) === defaultAgentProfilePath(repoRoot);
}

export function requireExplicitAgentProfile(
  explicit: string | undefined,
  repoRoot: string = resolveForeSceneRepoRoot(),
): string {
  const resolved = resolveAgentProfilePath(explicit, repoRoot);
  if (!resolved) {
    throw new AgentCliUsageError(
      'Stateful Agent CLI operations require --profile <dir>. '
      + `The default ${DEFAULT_AGENT_PROFILE_RELATIVE} path is refused.`,
    );
  }
  if (isDefaultAgentProfilePath(resolved, repoRoot)) {
    throw new AgentCliUsageError(
      `Refusing default Agent CLI profile: ${resolved}`,
    );
  }
  return resolved;
}
