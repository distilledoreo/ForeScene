import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

it('failed CLI navigation closes Chromium and exits without leaving its profile in use', async () => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-navigation-exit-'));
  const server = createServer((_request, response) => response.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture HTTP server did not listen.');
  try {
    const result = await execFileAsync(process.execPath, [
      '--import', path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs'),
      'scripts/agent/cli.ts', 'inspect', '--headless',
      '--url', `http://127.0.0.1:${address.port}`,
      '--profile', profileDir,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NO_PROXY: '*', no_proxy: '*' },
    }).then(
      (value) => ({ ...value, code: 0, killed: false }),
      (error: { code: number; killed?: boolean; stdout: string; stderr: string }) => error,
    );
    expect(result.killed, result.stderr).not.toBe(true);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toContain('ERR_EMPTY_RESPONSE');

    const { chromium } = await import('@playwright/test');
    const context = await chromium.launchPersistentContext(profileDir, { headless: true, timeout: 5000 });
    await context.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(profileDir, { recursive: true, force: true });
  }
}, 30_000);
