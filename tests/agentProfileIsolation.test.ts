import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentCliCommandRequiresProfile,
  defaultAgentProfilePath,
  isDefaultAgentProfilePath,
  requireExplicitAgentProfile,
  resolveAgentProfilePath,
} from '../scripts/agent/agentProfile';
import { AgentCliUsageError, wrapAgentCliStdout } from '../scripts/agent/cliResult';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Agent CLI profile isolation', () => {
  it('requires an explicit profile on stateful commands and records the resolved path', () => {
    expect(agentCliCommandRequiresProfile('inspect')).toBe(true);
    expect(agentCliCommandRequiresProfile('save')).toBe(true);
    expect(agentCliCommandRequiresProfile('open')).toBe(true);
    expect(agentCliCommandRequiresProfile('apply')).toBe(true);
    expect(agentCliCommandRequiresProfile('help')).toBe(false);
    expect(agentCliCommandRequiresProfile('capabilities')).toBe(false);

    expect(() => requireExplicitAgentProfile(undefined, repoRoot)).toThrow(AgentCliUsageError);
    expect(() => requireExplicitAgentProfile('', repoRoot)).toThrow(/require --profile/);

    const isolated = path.join(repoRoot, 'artifacts', 'tmp-isolated-profile');
    const resolved = requireExplicitAgentProfile(isolated, repoRoot);
    expect(resolved).toBe(path.normalize(isolated));
    expect(isDefaultAgentProfilePath(resolved, repoRoot)).toBe(false);

    const envelope = wrapAgentCliStdout({
      operation: 'project.inspect',
      startedAt: Date.now() - 5,
      profile: resolved,
    }, { ok: true });
    expect(envelope.profile).toBe(resolved);
  });

  it('refuses the default agent profile and aliases that resolve to it', () => {
    const defaultPath = defaultAgentProfilePath(repoRoot);
    expect(() => requireExplicitAgentProfile(defaultPath, repoRoot)).toThrow(/Refusing default/);
    expect(() => requireExplicitAgentProfile('.forescene-agent/browser-profile', repoRoot)).toThrow(/Refusing default/);
    expect(() => requireExplicitAgentProfile('./.forescene-agent/browser-profile', repoRoot)).toThrow(/Refusing default/);
    expect(() => requireExplicitAgentProfile(path.join('.forescene-agent', 'browser-profile'), repoRoot)).toThrow(/Refusing default/);
    expect(isDefaultAgentProfilePath(defaultPath, repoRoot)).toBe(true);
    expect(resolveAgentProfilePath(undefined, repoRoot)).toBeUndefined();
  });

  it('live CLI inspect with the default profile path is refused', () => {
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    let stdout = '';
    let code = 0;
    try {
      stdout = execFileSync(process.execPath, [
        tsxCli,
        'scripts/agent/cli.ts',
        'inspect',
        '--profile',
        '.forescene-agent/browser-profile',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
      });
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      code = failed.status ?? 1;
      stdout = failed.stdout ?? '';
    }
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
      ok: boolean;
      error?: { code?: string; message?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('usage_error');
    expect(parsed.error?.message).toMatch(/Refusing default/);
  }, 30_000);

  it('live CLI inspect without --profile is a usage error and does not open the default profile', () => {
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    let stdout = '';
    let code = 0;
    try {
      stdout = execFileSync(process.execPath, [tsxCli, 'scripts/agent/cli.ts', 'inspect'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
      });
    } catch (error) {
      const failed = error as { status?: number; stdout?: string };
      code = failed.status ?? 1;
      stdout = failed.stdout ?? '';
    }
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
      ok: boolean;
      error?: { code?: string; message?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('usage_error');
    expect(parsed.error?.message).toMatch(/--profile/);
  }, 30_000);
});
