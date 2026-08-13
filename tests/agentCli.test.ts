import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseAgentCliArgs } from '../scripts/agent/cliArgs';
import {
  AGENT_CLI_COMMANDS,
  buildAgentCliHelpDocument,
  isAgentCliCommand,
} from '../scripts/agent/cliCommands';
import {
  collectVerifyVisualPreflight,
  resolveCliCommandShotUsage,
  toVisualCollectionInput,
} from '../scripts/agent/cliShotSelection';
import { collectVisualPreflightResults } from '../src/engine/agent/visualValidation';
import type { AgentVisualPreflightResult } from '../src/engine/agent/protocol';
import {
  renderCapabilityMatrixMarkdown,
  resolveAgentRenderAppearance,
} from '../scripts/agent/cliCapabilities';
import { AgentCliUsageError, envelopeFromError, wrapAgentCliStdout } from '../scripts/agent/cliResult';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakePreflight(shotId: string): AgentVisualPreflightResult {
  return {
    shotId,
    ok: true,
    gateStatus: 'passed',
    score: 1,
    checks: [],
    diagnostics: [],
    subjects: [],
  };
}

describe('agent CLI discovery', () => {
  it('advertises visual-preflight, asset-contract, and verify checks', () => {
    const help = buildAgentCliHelpDocument();
    expect(help.commands).toEqual(expect.arrayContaining([
      'verify',
      'visual-preflight',
      'asset-contract',
      'previs',
      'package',
      'open',
      'save',
      'capabilities',
    ]));
    expect(help.checks.visualPreflight).toMatch(/visual-preflight/);
    expect(help.checks.assetPoseContract).toMatch(/asset-contract/);
    expect(help.checks.repairCandidates).toMatch(/previs/);
    expect(help.checks.provenance).toMatch(/provenance/);
    expect(help.checks.recoveryResources).toMatch(/package/);
    expect(help.shotSelection.verify).toMatch(/collectVisualPreflightValidation/);
    expect(help.shotSelection.frame).toMatch(/exactly one/i);
    expect(isAgentCliCommand('visual-preflight')).toBe(true);
    expect(isAgentCliCommand('not-a-command')).toBe(false);
  });

  it('keeps package.json scripts for the new CLI commands', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['agent:visual-preflight']).toContain('visual-preflight');
    expect(packageJson.scripts?.['agent:asset-contract']).toContain('asset-contract');
    expect(packageJson.scripts?.['agent:verify']).toContain('verify');
    expect(packageJson.scripts?.['agent:help']).toContain('help');
    expect(packageJson.scripts?.['agent:capabilities']).toContain('capabilities');
    expect(packageJson.scripts?.['agent:open']).toContain('open');
    expect(packageJson.scripts?.['agent:save']).toContain('save');
    expect(packageJson.scripts?.['agent:frame']).toContain('frame');
  });

  it('prints machine-readable help from the live CLI', () => {
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const output = execFileSync(process.execPath, [tsxCli, 'scripts/agent/cli.ts', 'help', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const start = output.indexOf('{');
    expect(start).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(output.slice(start)) as {
      ok: boolean;
      operation: string;
      result: {
        commands: string[];
        checks: Record<string, string>;
        runIdentity: { runId: string };
        shotSelection: Record<string, string>;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe('agent.help');
    expect(parsed.result.commands).toEqual([...AGENT_CLI_COMMANDS]);
    expect(parsed.result.checks.visualPreflight).toMatch(/omitted --shots/i);
    expect(parsed.result.checks.visualPreflight).toMatch(/explicit/i);
    expect(parsed.result.checks.assetPoseContract).toMatch(/optional --shot/i);
    expect(parsed.result.runIdentity.runId).toMatch(/runId/);
    expect(parsed.result.shotSelection.verify).toMatch(/collectVisualPreflightValidation/);
    expect(parsed.result.shotSelection.frame).toMatch(/exactly one/i);
    expect(parsed.result.shotSelection.video).toMatch(/exactly one/i);
    expect(parsed.result.shotSelection.assetContract).toMatch(/shotId/);
  }, 30_000);
});

describe('agent CLI shot-selection contract', () => {
  it('passes explicit verify --shots into collectVisualPreflightValidation', () => {
    const args = parseAgentCliArgs(['verify', '--shots', 'shot_a,shot_b']);
    const usage = resolveCliCommandShotUsage(args.command, args.shotSelection);
    expect(usage.visualCollectionInput).toEqual({ shotIds: ['shot_a', 'shot_b'] });
    expect(toVisualCollectionInput(args.shotSelection)).toEqual({ shotIds: ['shot_a', 'shot_b'] });

    const seen: Array<{ shotIds?: string[] } | undefined> = [];
    collectVerifyVisualPreflight((input) => {
      seen.push(input);
      return input;
    }, args.shotSelection);
    expect(seen).toEqual([{ shotIds: ['shot_a', 'shot_b'] }]);
  });

  it('omits shotIds when verify has no --shots so empty projects can skip the gate', () => {
    const args = parseAgentCliArgs(['verify']);
    const usage = resolveCliCommandShotUsage(args.command, args.shotSelection);
    expect(args.shotSelection.explicit).toBe(false);
    expect(usage.requestedShotIds).toBeUndefined();
    expect(usage.visualCollectionInput).toEqual({});

    const seen: Array<{ shotIds?: string[] } | undefined> = [];
    collectVerifyVisualPreflight((input) => {
      seen.push(input);
      return input;
    }, args.shotSelection);
    expect(seen).toEqual([undefined]);
  });

  it('fails unknown verify --shots through the collection path with unmatched ids', () => {
    const args = parseAgentCliArgs(['verify', '--shots', 'shot_missing,99']);
    const usage = resolveCliCommandShotUsage(args.command, args.shotSelection);
    expect(usage.visualCollectionInput.shotIds).toEqual(['shot_missing', '99']);

    const collected = collectVisualPreflightResults({
      shots: [{ id: 'shot_1', shotNumber: '01' }],
      requestedShotIds: usage.visualCollectionInput.shotIds,
      inspect: (shotId) => fakePreflight(shotId),
    });
    expect(collected.ok).toBe(false);
    expect(collected.visualPreflight).toEqual([]);
    expect(collected.selection.explicitSelection).toBe(true);
    expect(collected.selection.unmatchedShotIds).toEqual(['shot_missing', '99']);
    expect(collected.selection.diagnostic).toMatch(/shot_missing/);
  });

  it('fails an explicit empty verify --shots selection instead of validating every shot', () => {
    const args = parseAgentCliArgs(['verify', '--shots', ',']);
    expect(args.shotSelection.explicit).toBe(true);
    expect(args.shotSelection.shotIds).toEqual([]);
    const usage = resolveCliCommandShotUsage(args.command, args.shotSelection);
    expect(usage.visualCollectionInput).toEqual({ shotIds: [] });

    const collected = collectVisualPreflightResults({
      shots: [{ id: 'shot_1', shotNumber: '01' }],
      requestedShotIds: usage.visualCollectionInput.shotIds,
      inspect: (shotId) => fakePreflight(shotId),
    });
    expect(collected.ok).toBe(false);
    expect(collected.visualPreflight).toEqual([]);
    expect(collected.selection.explicitSelection).toBe(true);
    expect(collected.selection.selectedShotIds).toEqual([]);
  });

  it('rejects a second id for single-shot frame and video before any browser work', () => {
    const frame = parseAgentCliArgs(['frame', '--shots', '01,02', '--output', 'out.png']);
    expect(() => resolveCliCommandShotUsage(frame.command, frame.shotSelection)).toThrow(/exactly one shot id/i);
    expect(() => resolveCliCommandShotUsage(frame.command, frame.shotSelection)).toThrow(/01, 02/);

    const video = parseAgentCliArgs(['video', '--shot', 'shot_a', '--shot', 'shot_b', '--write']);
    expect(() => resolveCliCommandShotUsage(video.command, video.shotSelection)).toThrow(/exactly one shot id/i);
    expect(() => resolveCliCommandShotUsage(video.command, video.shotSelection)).toThrow(/shot_a, shot_b/);
  });

  it('keeps documented single-shot frame and video forms working', () => {
    const frame = parseAgentCliArgs(['frame', '--shot', 'shot_a', '--output', 'out.png']);
    expect(resolveCliCommandShotUsage(frame.command, frame.shotSelection).shotId).toBe('shot_a');

    const video = parseAgentCliArgs(['video', '--shots', '01', '--write']);
    expect(resolveCliCommandShotUsage(video.command, video.shotSelection).shotId).toBe('01');
  });

  it('rejects extra asset-contract ids instead of silently using the first', () => {
    const args = parseAgentCliArgs(['asset-contract', '--shots', 'shot_a,shot_b']);
    expect(() => resolveCliCommandShotUsage(args.command, args.shotSelection)).toThrow(/at most one --shot/i);
    expect(() => resolveCliCommandShotUsage(args.command, args.shotSelection)).toThrow(/shot_a, shot_b/);
  });

  it('keeps optional single-shot asset-contract and project-wide default working', () => {
    const projectWide = parseAgentCliArgs(['asset-contract']);
    expect(resolveCliCommandShotUsage(projectWide.command, projectWide.shotSelection).shotId).toBeUndefined();

    const single = parseAgentCliArgs(['asset-contract', '--shot', 'shot_a']);
    expect(resolveCliCommandShotUsage(single.command, single.shotSelection).shotId).toBe('shot_a');
  });
});

describe('agent CLI public surface', () => {
  it('parses project open, save, inspect --document, and projected frame modes', () => {
    const open = parseAgentCliArgs(['open', '--file', 'show.fsp', '--write']);
    expect(open.command).toBe('open');
    expect(open.file).toBe('show.fsp');
    expect(open.writeAccess).toBe(true);

    const save = parseAgentCliArgs(['save', '--output', 'show.fsp', '--write']);
    expect(save.command).toBe('save');
    expect(save.output).toBe('show.fsp');

    const inspect = parseAgentCliArgs(['inspect', '--document']);
    expect(inspect.document).toBe(true);

    const frame = parseAgentCliArgs(['frame', '--shot', '02', '--mode', 'projected', '--output', '02.png']);
    expect(frame.mode).toBe('projected');
    expect(resolveAgentRenderAppearance({
      command: frame.command,
      appearance: frame.appearance,
      mode: frame.mode,
    })).toBe('projected');

    const alias = parseAgentCliArgs(['frame', '--shot', '02', '--appearance', 'depth', '--output', '02.png']);
    expect(resolveAgentRenderAppearance({
      command: alias.command,
      appearance: alias.appearance,
      mode: alias.mode,
    })).toBe('depth');
  });

  it('rejects invalid render modes before treating them as clay', () => {
    expect(() => resolveAgentRenderAppearance({
      command: 'frame',
      mode: 'rapid-review',
    })).toThrow(/clay, projected, or depth/);
  });

  it('prints a browser-free capability catalog with the Phase 1 gaps closed', () => {
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const output = execFileSync(process.execPath, [tsxCli, 'scripts/agent/cli.ts', 'capabilities'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const parsed = JSON.parse(output.slice(output.indexOf('{'))) as {
      ok: boolean;
      operation: string;
      result: {
        capabilities: Record<string, boolean>;
        jsonContract: { exitCodes: Record<string, number> };
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe('agent.capabilities');
    expect(parsed.result.capabilities['project.open']).toBe(true);
    expect(parsed.result.capabilities['project.save']).toBe(true);
    expect(parsed.result.capabilities['character.importSavedRig']).toBe(true);
    expect(parsed.result.capabilities['render.frame.projected']).toBe(true);
    expect(parsed.result.capabilities['render.video.projected']).toBe(true);
    expect(parsed.result.jsonContract.exitCodes).toEqual({ success: 0, failure: 1, usage: 2 });
  }, 30_000);

  it('keeps docs/agent-capability-matrix.md generated from the CLI catalog', () => {
    const onDisk = readFileSync(path.join(repoRoot, 'docs/agent-capability-matrix.md'), 'utf8');
    expect(onDisk).toBe(renderCapabilityMatrixMarkdown());
  });

  it('wraps command payloads in a stable JSON envelope', () => {
    const envelope = wrapAgentCliStdout(
      { operation: 'project.open', startedAt: Date.now() - 12 },
      {
        ok: true,
        projectId: 'proj_1',
        revisionId: 'rev_1',
        diagnostics: [{ code: 'import_warning', message: 'legacy package', severity: 'warning' }],
      },
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.operation).toBe('project.open');
    expect(envelope.projectId).toBe('proj_1');
    expect(envelope.revisionId).toBe('rev_1');
    expect(envelope.warnings).toEqual([{ code: 'import_warning', message: 'legacy package' }]);
    expect(envelope.durationMs).toBeGreaterThanOrEqual(12);
  });

  it('uses exit code 2 for usage errors', () => {
    const { envelope, exitCode } = envelopeFromError(
      { operation: 'project.open', startedAt: Date.now() },
      new AgentCliUsageError('open requires --file <path.fsp>.'),
    );
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toEqual({
      code: 'usage_error',
      message: 'open requires --file <path.fsp>.',
    });
  });
});
