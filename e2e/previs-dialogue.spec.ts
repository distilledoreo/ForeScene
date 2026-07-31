/**
 * Live Chromium E2E for autonomous previs (Agent CLI ↔ hosted ForeScene).
 *
 * Proves the integration boundaries static unit tests cannot:
 * blank profile → reset → locations/cast/shots → distinct PNGs →
 * contact sheet → package → reload → second run without duplicating.
 *
 * @heavy — long WebGL + package path (main/nightly / explicit run)
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { runPrevisCli } from '../scripts/agent/previs';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

test.describe('@heavy autonomous previs dialogue fixture', () => {
  test('four-shot dialogue: reset → frames → package → resume without dupes', async ({
    browserName,
    baseURL,
  }) => {
    test.skip(browserName !== 'chromium', 'Chromium-only Agent CLI orchestration');
    test.setTimeout(600_000);

    const outputDir = path.join(os.tmpdir(), `forescene-previs-e2e-${process.pid}-${Date.now()}`);
    const profileDir = path.join(outputDir, 'browser-profile');
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(profileDir, { recursive: true });

    const manifestPath = path.resolve('examples/previs/minimal-dialogue.json');
    const url = baseURL ?? 'http://127.0.0.1:4173';

    try {
      const first = await runPrevisCli({
        manifestPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: true,
        outputDir,
        profileDir,
      });

      expect(first.ok, first.error ?? 'first previs run failed').toBe(true);
      expect(first.shotsRequested).toBe(4);
      expect(first.shotsCreated).toBe(4);
      expect(first.framesRendered).toBe(4);
      expect(first.failed ?? 0).toBe(0);
      expect(first.package).toBeTruthy();
      expect(first.contactSheet).toBeTruthy();

      const shotNumbers = ['010', '020', '030', '040'];
      const hashes = new Set<string>();
      for (const shotNumber of shotNumbers) {
        const framePath = path.join(outputDir, 'shots', `${shotNumber}.png`);
        expect(await pathExists(framePath), `missing frame ${shotNumber}`).toBe(true);
        const info = await stat(framePath);
        expect(info.size, `empty frame ${shotNumber}`).toBeGreaterThan(512);
        hashes.add(await fileSha256(framePath));
      }
      expect(hashes.size, 'frames must be distinct PNGs').toBe(4);

      expect(await pathExists(path.join(outputDir, 'contact-sheet.html'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'contact-sheet.png'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'validation.json'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'package.zip'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'run-state.json'))).toBe(true);
      expect(await pathExists(path.join(outputDir, 'summary.json'))).toBe(true);

      const validation = JSON.parse(
        await readFile(path.join(outputDir, 'validation.json'), 'utf8'),
      ) as { results: Array<{ shotNumber: string; status: string }> };
      expect(validation.results.map((item) => item.shotNumber).sort()).toEqual(shotNumbers);

      // Second run: same profile + output, no reset — resume must not duplicate.
      const beforeObjects = await readFile(path.join(outputDir, 'run-state.json'), 'utf8');
      const second = await runPrevisCli({
        manifestPath,
        url,
        headless: true,
        writeAccess: true,
        persistWrite: false,
        resetProject: false,
        outputDir,
        profileDir,
      });

      expect(second.ok, second.error ?? 'resume previs run failed').toBe(true);
      expect(second.shotsCreated).toBe(4);
      // Frames already complete — render loop should reuse them.
      expect(second.framesRendered).toBe(4);

      const afterState = JSON.parse(
        await readFile(path.join(outputDir, 'run-state.json'), 'utf8'),
      ) as {
        shots: Record<string, { compile: string; shotId?: string }>;
        entities: Record<string, unknown>;
      };
      expect(Object.keys(afterState.shots).sort()).toEqual(shotNumbers);
      for (const shotNumber of shotNumbers) {
        expect(afterState.shots[shotNumber]?.compile).toBe('complete');
      }

      // Entity map should not balloon from a no-op resume (same keys as before).
      const beforeState = JSON.parse(beforeObjects) as { entities: Record<string, unknown> };
      expect(Object.keys(afterState.entities).sort()).toEqual(
        Object.keys(beforeState.entities).sort(),
      );

      // Frames remain distinct after resume.
      const resumeHashes = new Set<string>();
      for (const shotNumber of shotNumbers) {
        resumeHashes.add(await fileSha256(path.join(outputDir, 'shots', `${shotNumber}.png`)));
      }
      expect(resumeHashes).toEqual(hashes);
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
