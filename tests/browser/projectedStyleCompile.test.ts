import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../fixtures/projected-style-compile-entry.ts');
/** Project-local evidence dir (works for Windows node under WSL). */
const EVIDENCE_DIR = path.resolve(here, '../../test-results/projected-style-compile');
/** Plan implementer scratch when running under Linux bash. */
const LINUX_SCRATCH = '/tmp/grok-goal-38c941975045/implementer';

describe('projected style WebGL compile gate', () => {
  it('compiles projected materials under real WebGL with single and dual projector modes', async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    try {
      mkdirSync(LINUX_SCRATCH, { recursive: true });
    } catch {
      // Windows node may not map Linux /tmp; project-local evidence is authoritative.
    }

    const writeEvidence = (name: string, body: string) => {
      writeFileSync(path.join(EVIDENCE_DIR, name), body, 'utf8');
      try {
        writeFileSync(path.join(LINUX_SCRATCH, name), body, 'utf8');
      } catch {
        // ignore Linux scratch write failures under Windows node
      }
    };

    let browser: import('playwright').Browser | undefined;
    try {
      const { chromium } = await import('playwright');
      const bundled = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: ['chrome120'],
        logLevel: 'silent',
      });
      const js = bundled.outputFiles[0]?.text;
      if (!js) throw new Error('esbuild produced no output for compile harness.');

      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>projected compile</title></head>
<body><script>${js}</script></body></html>`;
      writeEvidence('projected-style-compile.html', html);

      browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
      });
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      const pageWarnings: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text());
        if (msg.type() === 'warning') pageWarnings.push(msg.text());
      });

      // setContent avoids file:// path issues between WSL and Windows Chromium.
      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      const result = await page.evaluate(() => (window as unknown as {
        __PROJECTED_COMPILE__?: {
          ok: boolean;
          errors: string[];
          cases: Array<{ label: string; ok: boolean; detail?: string }>;
        };
      }).__PROJECTED_COMPILE__);

      writeEvidence(
        'projected-style-compile.json',
        JSON.stringify({ result, pageErrors, pageWarnings, evidenceDir: EVIDENCE_DIR }, null, 2),
      );

      expect(result, 'compile harness did not set __PROJECTED_COMPILE__').toBeTruthy();
      if (!result?.ok) {
        throw new Error(
          `Projected material WebGL compile failed:\n${[...(result?.errors ?? []), ...pageErrors].join('\n')}`,
        );
      }
      expect(result.cases.length).toBeGreaterThanOrEqual(8);
      expect(result.cases.every((c) => c.ok)).toBe(true);
      expect(pageErrors.filter((e) => /shader|fragment|compile|link/i.test(e))).toEqual([]);
      expect(pageWarnings.filter((e) => /potentially uninitialized variable/i.test(e))).toEqual([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeEvidence('projected-style-compile-skip-or-fail.log', message);
      // If Playwright/Chromium cannot start, fail the gate — projection is unusable without compile proof.
      throw error;
    } finally {
      await browser?.close();
    }
  }, 120_000);
});
