import { it, expect } from 'vitest';
import { build } from 'esbuild';
import { chromium } from 'playwright';
it('renders a posed saved skin at the same pixels as the equivalent rigid rotation', async () => {
  const bundle = await build({ entryPoints: ['tests/fixtures/autorig-runtime-frame-entry.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome120'], logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<script>${bundle.outputFiles[0].text}</script>`);
    const result = await page.evaluate(() => (window as unknown as { __AUTORIG_FRAME__: { mismatches: number; filled: number } }).__AUTORIG_FRAME__);
    expect(result.filled).toBeGreaterThan(100); expect(result.mismatches).toBeLessThan(5);
  } finally { await browser.close(); }
}, 60_000);
