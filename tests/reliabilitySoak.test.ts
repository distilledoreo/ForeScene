import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runGateA } from '../scripts/reliability/gateA';
import { runGateD } from '../scripts/reliability/gateD';
import { runGateE } from '../scripts/reliability/gateE';
import { runGateF } from '../scripts/reliability/gateF';
import { runGateB, runGateC } from '../scripts/reliability/gateLive';
import { runReliabilitySoak } from '../scripts/reliability/soak';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('reliability soak gates A–F', () => {
  it('passes Gate A CLI completeness without a browser', async () => {
    const result = await runGateA();
    expect(result.status, result.message).toBe('passed');
    expect(result.retries).toBe(0);
  });

  it('skips live Gates B and C without --url', async () => {
    expect((await runGateB({})).status).toBe('skipped');
    expect((await runGateC({})).status).toBe('skipped');
  });

  it('passes Gate D three isolated harness prepares', async () => {
    const result = await runGateD(3);
    expect(result.status, result.message).toBe('passed');
    expect((result.details as { runRoots: string[] }).runRoots).toHaveLength(3);
  }, 30_000);

  it('passes Gate E ten stale lock recoveries', async () => {
    const result = await runGateE({ iterations: 10 });
    expect(result.status, result.message).toBe('passed');
    expect(result.retries).toBe(0);
  });

  it('passes Gate F visual baseline without camera coordinates', async () => {
    const result = await runGateF({});
    expect(result.status, result.message).toBe('passed');
    expect(JSON.stringify(result)).not.toMatch(/cameraMustBe|cameraPosition/);
  });

  it('offline soak CLI exits 0 with B/C skipped and retries at zero', () => {
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const outputDir = path.join(os.tmpdir(), `forescene-soak-cli-${Date.now()}`);
    const output = path.join(outputDir, 'report.json');
    const stdout = execFileSync(process.execPath, [
      tsxCli,
      'scripts/reliability/soak.ts',
      '--output',
      output,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const report = JSON.parse(stdout.slice(stdout.indexOf('{'))) as Awaited<ReturnType<typeof runReliabilitySoak>>;
    expect(report.ok).toBe(true);
    expect(report.live).toBe(false);
    expect(report.retriesTotal).toBe(0);
    expect(report.policy.retriesMustRemainZero).toBe(true);
    expect(report.gates.map((gate) => gate.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(report.gates.find((gate) => gate.id === 'B')?.status).toBe('skipped');
    expect(report.gates.find((gate) => gate.id === 'C')?.status).toBe('skipped');
    expect(report.gates.filter((gate) => gate.status === 'failed')).toEqual([]);
  }, 60_000);
});
