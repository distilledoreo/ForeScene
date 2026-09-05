/**
 * Explicit Agent CLI browser-profile resolution.
 *
 * Stateful commands must pass --profile. The default
 * `.forescene-agent/browser-profile` path is refused even when named explicitly,
 * including descendants and filesystem aliases that resolve to it.
 */

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { AgentCliUsageError } from './cliResult';
import { resolveForeSceneRepoRoot } from './repoRoot';

export const DEFAULT_AGENT_PROFILE_RELATIVE = '.forescene-agent/browser-profile';

export const STATELESS_AGENT_CLI_COMMANDS = [
  'capabilities',
  'describe',
  'schema',
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

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isSameOrInside(candidate: string, root: string): boolean {
  if (pathsEqual(candidate, root)) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return process.platform === 'win32'
    ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate.startsWith(prefix);
}

function realpathIfExists(value: string): string {
  try {
    if (existsSync(value)) return normalizePath(realpathSync(value));
  } catch {
    // Fall through to the lexical path when the filesystem cannot resolve it.
  }
  return normalizePath(value);
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
  const forbidden = defaultAgentProfilePath(repoRoot);
  const lexical = normalizePath(candidate);
  if (isSameOrInside(lexical, forbidden)) return true;
  return isSameOrInside(realpathIfExists(candidate), realpathIfExists(forbidden));
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
