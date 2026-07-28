import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../fixtures/occlusion-pixel-entry.ts');
const EVIDENCE_DIR = path.resolve(here, '../../test-results/occlusion-pixel');

describe('radial-depth occlusion cubemap (real WebGL pixel readback)', () => {
  it('generates a valid depth cubemap: front hit, opposite no-hit clear, depth packed', async () => {
    const { chromium } = await import('playwright');
    const mkdirSync = (await import('node:fs')).mkdirSync;
    const writeFileSync = (await import('node:fs')).writeFileSync;
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
    if (!js) throw new Error('esbuild produced no output for occlusion pixel harness.');

    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${js}</script></body></html>`;
    writeFileSync(path.join(EVIDENCE_DIR, 'occlusion-pixel.html'), html, 'utf8');

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
        __OCCLUSION_PIXEL__?: import('../fixtures/occlusion-pixel-entry').OcclusionPixelResult;
      }).__OCCLUSION_PIXEL__);
      writeFileSync(path.join(EVIDENCE_DIR, 'occlusion-pixel.json'), JSON.stringify({ result, pageErrors }, null, 2));

      expect(result, 'harness did not set __OCCLUSION_PIXEL__').toBeTruthy();
      expect(result?.ok, `occlusion pixel gate failed: ${result?.errors?.join('\n')}`).toBe(true);

      // 1) Front box (+X) must record a valid hit (blue flag = 1).
      expect(result?.frontHitBlue).toBeCloseTo(1, 2);
      // 2) Depth must be packed in the red/green channels (front box is close).
      expect(result?.frontHitDepthNormalized).toBeGreaterThan(0);
      expect(result?.frontHitDepthNormalized).toBeLessThan(0.5);
      // 3) Opposite (-X) empty ray must read the cleared no-hit color R=1,G=1,B=0.
      expect(result?.oppositeBlue).toBeCloseTo(0, 2);
      expect(result?.oppositeClearRed).toBeCloseTo(1, 2);
      expect(result?.oppositeClearGreen).toBeCloseTo(1, 2);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
