import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');

describe('Agent CLI passive evidence', () => {
  it('captures a direct documented CLI invocation at the stdout boundary', async () => {
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-cli-evidence-'));
    const runId = 'test-run-id';
    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', path.join(repoRoot, 'scripts', 'agent', 'cli.ts'), 'capabilities'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FORESCENE_EVIDENCE_DIR: evidenceDir,
          FORESCENE_EVIDENCE_RUN_ID: runId,
        },
      },
    );
    const files = await readdir(evidenceDir);
    expect(files).toHaveLength(1);
    const record = JSON.parse(await readFile(path.join(evidenceDir, files[0]!), 'utf8'));
    expect(record).toMatchObject({
      version: 1,
      runId,
      command: 'capabilities',
      rawArgs: ['capabilities'],
      exitCode: 0,
      envelope: { ok: true, operation: 'agent.capabilities' },
    });
    expect(record.envelopeSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
