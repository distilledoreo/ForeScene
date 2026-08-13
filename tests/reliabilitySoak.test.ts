import { readFileSync } from 'node:fs';
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
  it('passes Gate A CLI completeness including the CLI-only E2E spec', async () => {
    const result = await runGateA();
    expect(result.status, result.message).toBe('passed');
    expect(result.retries).toBe(0);
    expect(result.message).toMatch(/CLI-only E2E/);
  });

  it('skips required live Gates B and C without --url', async () => {
    expect((await runGateB({})).status).toBe('skipped');
    expect((await runGateC({})).requiredLive).toBe(true);
    expect((await runGateC({})).status).toBe('skipped');
  });

  it('passes Gate D three isolated complete harness runs', async () => {
    const result = await runGateD(3);
    expect(result.status, result.message).toBe('passed');
    expect((result.details as { runRoots: string[] }).runRoots).toHaveLength(3);
  }, 60_000);

  it('treats stale-lock recovery as additional coverage, not Gate E itself', async () => {
    const result = await runGateE({ iterations: 10 });
    expect(result.status, result.message).toBe('skipped');
    expect(result.requiredLive).toBe(true);
    expect(result.retries).toBe(0);
  });

  it('does not treat an offline visual fixture as Gate F evidence', async () => {
    const result = await runGateF({});
    expect(result.status, result.message).toBe('skipped');
    expect(result.requiredLive).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/cameraMustBe|cameraPosition/);
  });

  it('offline soak CLI reports skipped live gates and does not claim stabilization', () => {
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const outputDir = path.join(os.tmpdir(), `forescene-soak-cli-${Date.now()}`);
    const output = path.join(outputDir, 'report.json');
    execFileSync(process.execPath, [
      tsxCli,
      'scripts/reliability/soak.ts',
      '--output',
      output,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...process.env,
        FORESCENE_BENCHMARK_ALLOW_DIRTY: '1',
      },
    });
    const report = JSON.parse(readFileSync(output, 'utf8')) as Awaited<ReturnType<typeof runReliabilitySoak>>;
    expect(report.ok).toBe(true);
    expect(report.live).toBe(false);
    expect(report.stabilizationExit).toBe(false);
    expect(report.retriesTotal).toBe(0);
    expect(report.policy.retriesMustRemainZero).toBe(true);
    expect(report.policy.skippedLiveGatesAreNotReliabilityEvidence).toBe(true);
    expect(report.gates.map((gate) => gate.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(report.gates.find((gate) => gate.id === 'B')?.status).toBe('skipped');
    expect(report.gates.find((gate) => gate.id === 'C')?.status).toBe('skipped');
    expect(report.gates.find((gate) => gate.id === 'E')?.status).toBe('skipped');
    expect(report.gates.find((gate) => gate.id === 'F')?.status).toBe('skipped');
    expect(report.gates.find((gate) => gate.id === 'A')?.status).toBe('passed');
    expect(report.gates.find((gate) => gate.id === 'D')?.status).toBe('passed');
    expect(report.gates.filter((gate) => gate.status === 'failed')).toEqual([]);
  }, 90_000);
});
