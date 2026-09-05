import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseAgentCliArgs } from '../scripts/agent/cliArgs';
import {
  AGENT_CLI_COMMANDS,
  describeAgentCliCommand,
} from '../scripts/agent/cliCommands';
import { resolveCliShotReferences } from '../scripts/agent/cliShotSelection';
import { buildFrameCliResult } from '../scripts/agent/frameResult';
import {
  deriveRenderStillsOutcome,
  evaluateContactSheetFrames,
} from '../scripts/agent/batchHonesty';
import { selectPrunableShots } from '../scripts/agent/shotPrune';
import type { AgentRenderShotFrameResult } from '../src/engine/agent/protocol';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeFrameResult(): AgentRenderShotFrameResult {
  return {
    ok: true,
    status: 'completed',
    shotId: 'shot_1',
    revisionId: 'rev_1',
    width: 64,
    height: 36,
    artifact: {
      kind: 'inline',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,QUJD',
      byteLength: 3,
    },
    pngDataUrl: 'data:image/png;base64,QUJD',
    pixelStats: {
      width: 64,
      height: 36,
      opaquePixelRatio: 1,
      luminanceMean: 0.5,
      luminanceVariance: 0.1,
      sampledUniqueColorCount: 8,
    },
    diagnostics: [],
  };
}

describe('frame CLI result envelope', () => {
  it('strips inline payloads (artifact.dataUrl and pngDataUrl) and publishes sha256 + byteLength', () => {
    const result = buildFrameCliResult({
      result: fakeFrameResult(),
      output: '/tmp/frame.png',
      appearance: 'clay',
      bytes: Buffer.from('Abc'),
      shotNumber: '010',
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('data:image/png');
    expect('artifact' in result).toBe(false);
    expect('pngDataUrl' in result).toBe(false);
    const expected = `sha256:${createHash('sha256').update(Buffer.from('Abc')).digest('hex')}`;
    expect(result.sha256).toBe(expected);
    expect(result.byteLength).toBe(3);
    expect(result.output).toBe('/tmp/frame.png');
    expect(result.shotNumber).toBe('010');
    expect(result.shotId).toBe('shot_1');
    expect(result.revisionId).toBe('rev_1');
    expect(result.status).toBe('completed');
    expect(result.pixelStats?.width).toBe(64);
  });
});

describe('previs --no-auto-repair is authoritative', () => {
  it('parses --no-auto-repair and --max-repair-passes', () => {
    const args = parseAgentCliArgs(['previs', '--manifest', 'm.json', '--no-auto-repair', '--max-repair-passes', '1']);
    expect(args.autoRepair).toBe(false);
    expect(args.noAutoRepair).toBe(true);
    expect(args.maxRepairPasses).toBe(1);
  });

  it('forwards the parsed repair flags into the previs runner dispatch', () => {
    // Source-wiring guard: parse-level coverage alone proved nothing while the
    // previs dispatch silently dropped the flags. A browser e2e is the full
    // proof; this keeps the dispatch honest in the fast suite.
    const source = readFileSync(path.join(repoRoot, 'scripts/agent/cli.ts'), 'utf8');
    const previsDispatch = source.slice(
      source.indexOf("args.command === 'previs'"),
      source.indexOf("args.command === 'render-stills'"),
    );
    expect(previsDispatch).toContain('autoRepair: args.autoRepair');
    expect(previsDispatch).toContain('maxRepairPasses: args.maxRepairPasses');
    expect(previsDispatch).toContain('pruneNonManifestShots: args.pruneNonManifestShots');
  });

  it('reports repairsDisabled in the previs summary contract', () => {
    const source = readFileSync(path.join(repoRoot, 'scripts/agent/previs.ts'), 'utf8');
    const summaryStart = source.indexOf('const summary: PrevisCliResult');
    const summaryBlock = source.slice(summaryStart, source.indexOf('contactSheet: contactSheetPath', summaryStart));
    expect(summaryBlock).toContain('repairsAttempted: repairsAttemptedTotal');
    expect(summaryBlock).toContain('repairsDisabled: !autoRepair');
  });
});

describe('one CLI shot selector', () => {
  const available = [
    { id: 'shot_a', shotNumber: '010' },
    { id: 'shot_b', shotNumber: '020' },
  ];

  it('resolves padding-normalized shot numbers (010 === 10 === 0010)', () => {
    expect(resolveCliShotReferences(available, ['10'])).toEqual({
      ok: true,
      shots: [{ id: 'shot_a', shotNumber: '010' }],
    });
    const normalized = resolveCliShotReferences(available, ['0010']);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(normalized.shots[0]?.id).toBe('shot_a');
  });

  it('resolves canonical ids exactly', () => {
    const resolved = resolveCliShotReferences(available, ['shot_b']);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.shots[0]?.id).toBe('shot_b');
  });

  it('fails closed on ambiguity with candidate ids', () => {
    const colliding = [
      { id: 'shot_a', shotNumber: '010' },
      { id: 'shot_c', shotNumber: '0010' },
    ];
    const resolved = resolveCliShotReferences(colliding, ['10']);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.ambiguous).toHaveLength(1);
      expect(resolved.ambiguous[0]?.candidates.map((candidate) => candidate.id)).toEqual(['shot_a', 'shot_c']);
      expect(resolved.error).toContain('matched 2 shots');
    }
  });

  it('reports unknown and empty selectors instead of guessing', () => {
    const resolved = resolveCliShotReferences(available, ['999', '  ']);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.unknownSelectors).toEqual(['999', '  ']);
      expect(resolved.ambiguous).toHaveLength(0);
    }
  });

  it('deduplicates selectors that resolve to the same shot', () => {
    const resolved = resolveCliShotReferences(available, ['10', '010', 'shot_a']);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.shots).toHaveLength(1);
      expect(resolved.shots[0]?.id).toBe('shot_a');
    }
  });
});

describe('fail-closed command discovery', () => {
  it('publishes a real descriptor for every public CLI command', () => {
    for (const command of AGENT_CLI_COMMANDS) {
      const descriptor = describeAgentCliCommand(command);
      expect(descriptor, `missing descriptor for ${command}`).toBeDefined();
      expect(descriptor!.usage).toContain(`agent:${command}`);
      expect(descriptor!.result.length).toBeGreaterThan(10);
      // The old generic fallback told agents to consult capabilities; a real
      // descriptor never does.
      expect(descriptor!.notes?.some((note) => note.includes('Consult `agent:capabilities`'))).not.toBe(true);
    }
  });

  it('covers commands that previously fell through to generic help', () => {
    for (const command of ['open', 'apply', 'preview', 'verify', 'world-depth', 'refine', 'shot-panorama', 'replace-proxy', 'render-stills'] as const) {
      const descriptor = describeAgentCliCommand(command);
      expect(descriptor?.required.length ?? 0).toBeGreaterThan(0);
    }
    expect(describeAgentCliCommand('apply')?.optional).toContain('--expected-revision <revision-id>');
    expect(describeAgentCliCommand('contact-sheet')?.optional).toContain('--allow-partial');
    expect(describeAgentCliCommand('previs')?.optional).toContain('--prune-non-manifest-shots');
  });

  it('returns undefined only for unknown commands', () => {
    expect(describeAgentCliCommand('not-a-command')).toBeUndefined();
  });
});

describe('honest contact-sheet inputs', () => {
  it('fails closed on missing, empty, and unrendered frames', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forescene-sheet-'));
    try {
      await writeFile(path.join(dir, '010.png'), Buffer.from('fake-png-bytes'));
      await writeFile(path.join(dir, '030.png'), Buffer.alloc(0));
      await writeFile(path.join(dir, '040.png'), Buffer.from('stale-but-present'));
      const report = await evaluateContactSheetFrames({
        entries: [
          { shotNumber: '010', framePath: path.join(dir, '010.png') },
          { shotNumber: '020', framePath: path.join(dir, '020.png') },
          { shotNumber: '030', framePath: path.join(dir, '030.png') },
          { shotNumber: '040', framePath: path.join(dir, '040.png'), renderStatus: 'pending' },
        ],
        pathExists: async (filePath) => existsSync(filePath),
        readFile: (filePath) => readFile(filePath),
      });
      expect(report.ok).toBe(false);
      expect(report.issues.map((issue) => [issue.shotNumber, issue.kind])).toEqual([
        ['020', 'missing'],
        ['030', 'empty'],
        ['040', 'not_rendered'],
      ]);
      const frame010 = report.frames.find((frame) => frame.shotNumber === '010');
      expect(frame010?.exists).toBe(true);
      expect(frame010?.byteLength).toBe('fake-png-bytes'.length);
      expect(frame010?.sha256).toBe(
        `sha256:${createHash('sha256').update(Buffer.from('fake-png-bytes')).digest('hex')}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes when every frame exists and finished rendering', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forescene-sheet-'));
    try {
      await writeFile(path.join(dir, '010.png'), Buffer.from('frame-a'));
      const report = await evaluateContactSheetFrames({
        entries: [{ shotNumber: '010', framePath: path.join(dir, '010.png'), renderStatus: 'complete' }],
        pathExists: async (filePath) => existsSync(filePath),
        readFile: (filePath) => readFile(filePath),
      });
      expect(report.ok).toBe(true);
      expect(report.issues).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('honest render-stills batch outcome', () => {
  it('ok is a conjunction over every tracked shot', () => {
    const complete = deriveRenderStillsOutcome({
      a: { compile: 'complete', render: 'complete' },
      b: { compile: 'complete', render: 'complete' },
    });
    expect(complete.ok).toBe(true);
    expect(complete.rendered).toBe(2);

    const withFailure = deriveRenderStillsOutcome({
      a: { compile: 'complete', render: 'complete' },
      b: { compile: 'complete', render: 'failed' },
    });
    expect(withFailure.ok).toBe(false);
    expect(withFailure.failedShotNumbers).toEqual(['b']);
    expect(withFailure.rendered).toBe(1);

    const withPending = deriveRenderStillsOutcome({
      a: { compile: 'complete', render: 'complete' },
      b: { compile: 'complete', render: 'pending' },
      c: { compile: 'failed', render: 'pending' },
    });
    expect(withPending.ok).toBe(false);
    expect(withPending.pendingShotNumbers).toEqual(['b', 'c']);
  });
});

describe('scaffold-aware previs prune', () => {
  const liveShots = [
    { id: 'shot_keep', shotNumber: '010', isIntactScaffold: false },
    { id: 'shot_origin', shotNumber: '000', isIntactScaffold: true },
    { id: 'shot_user', shotNumber: '900', isIntactScaffold: false },
  ];

  it('prunes intact scaffold shots and retains non-manifest user shots by default', () => {
    const decision = selectPrunableShots(liveShots, new Set(['010']), { pruneNonManifest: false });
    expect(decision.prune.map((shot) => shot.id)).toEqual(['shot_origin']);
    expect(decision.retainedNonManifest.map((shot) => shot.id)).toEqual(['shot_user']);
  });

  it('prunes non-manifest user shots only with explicit authorization', () => {
    const decision = selectPrunableShots(liveShots, new Set(['010']), { pruneNonManifest: true });
    expect(decision.prune.map((shot) => shot.id)).toEqual(['shot_origin', 'shot_user']);
    expect(decision.retainedNonManifest).toHaveLength(0);
  });

  it('never touches manifest shots', () => {
    const decision = selectPrunableShots(liveShots, new Set(['010', '900']), { pruneNonManifest: false });
    expect(decision.prune.map((shot) => shot.id)).toEqual(['shot_origin']);
    expect(decision.retainedNonManifest).toHaveLength(0);
  });
});



