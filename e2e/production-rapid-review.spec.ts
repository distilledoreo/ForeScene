/**
 * Live Chromium E2E for agent:production rapid-review mode.
 *
 * @heavy — validates one-call production through repair-capable validation.
 */
import { access, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { runProduction } from '../scripts/agent/production';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test.describe('@heavy agent:production rapid-review', () => {
  test('four-shot dialogue completes with review frames and contact sheet', async ({
    browserName,
    baseURL,
  }) => {
    test.skip(browserName !== 'chromium', 'Chromium-only Agent CLI orchestration');
    test.setTimeout(600_000);

    const outputDir = path.join(os.tmpdir(), `forescene-production-e2e-${process.pid}-${Date.now()}`);
    const profileDir = path.join(outputDir, 'browser-profile');
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });

    const manifestPath = path.resolve('examples/previs/minimal-dialogue.json');
    const url = baseURL ?? 'http://127.0.0.1:4173';

    try {
      const result = await runProduction({
        manifestPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: true,
        outputDir,
        profileDir,
        mode: 'rapid-review',
      });

      expect(result.ok).toBe(true);
      expect(result.renderProfileId).toBe('rapid-review');
      expect(result.framesRendered).toBe(result.shotsRequested);
      expect(result.controlVideosRendered).toBe(0);
      expect(result.artifacts.contactSheet).toBeTruthy();
      expect(result.artifacts.package).toBeUndefined();
      expect(result.timing.renderingMs).toBeGreaterThan(0);
      expect(result.timing.totalMs).toBeGreaterThan(0);
      expect(await pathExists(result.artifacts.contactSheet!)).toBe(true);
      expect(await pathExists(path.join(outputDir, 'render-session.json'))).toBe(true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
