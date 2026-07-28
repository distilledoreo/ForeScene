import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../fixtures/projected-receive-entry.ts');
const EVIDENCE_DIR = path.resolve(here, '../../test-results/projected-receive');

describe('receiving projected-style material (real WebGL pixel readback)', () => {
  it('single-projector is not blended 50/50, rears fall back, modes differ', async () => {
    const { chromium } = await import('playwright');
    mkdirSync(EVIDENCE_DIR, { recursive: true });

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
    if (!js) throw new Error('esbuild produced no output for projected receive harness.');

    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${js}</script></body></html>`;
    writeFileSync(path.join(EVIDENCE_DIR, 'projected-receive.html'), html, 'utf8');

    const browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
    });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text());
      });
      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      const result = await page.evaluate(() => (window as unknown as {
        __PROJECTED_RECEIVE__?: import('../fixtures/projected-receive-entry').ProjectedReceiveResult;
      }).__PROJECTED_RECEIVE__);
      writeFileSync(path.join(EVIDENCE_DIR, 'projected-receive.json'), JSON.stringify({ result, pageErrors }, null, 2));

      expect(result, 'harness did not set __PROJECTED_RECEIVE__').toBeTruthy();
      expect(result?.ok, `projected receive gate failed: ${result?.errors?.join('\n')}`).toBe(true);

      const [fr, fg, fb] = result!.frontPixel;
      const [rr, rg, rb] = result!.rearPixel;
      const [pr, pg, pb] = result!.primaryModeFront;

      // Front receiver shows the red panorama (dominant red channel), NOT a
      // 50/50 mix with the blue fallback (which would be ~purple, r≈g-ish).
      expect(fr).toBeGreaterThan(150);
      expect(fb).toBeLessThan(80); // must NOT be strongly blue (would mean fallback mix)

      // Rear receiver (behind occluder) falls back to solid blue.
      expect(rb).toBeGreaterThan(150);
      expect(rr).toBeLessThan(80);

      // Primary-only front mode also shows red panorama (mode honored, no crash).
      expect(pr).toBeGreaterThan(150);
      expect(pb).toBeLessThan(80);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
