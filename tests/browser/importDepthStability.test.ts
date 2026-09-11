import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { ImportStabilityResult } from '../fixtures/import-stability-probe';

it('keeps nearby imported GLB surfaces stable during camera motion and final export', async () => {
  const bundled = await build({
    entryPoints: [path.resolve('tests/fixtures/import-stability-probe.ts')], bundle: true,
    write: false, format: 'iife', globalName: 'ImportStability', platform: 'browser',
    target: ['chrome120'], logLevel: 'silent', define: { 'import.meta.env': '{}' },
  });
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage(); const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error' && /shader|compile|INVALID_|GL_INVALID|WebGLProgram/.test(message.text())) errors.push(message.text());
    });
    await page.route('http://127.0.0.1:4180/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('http://127.0.0.1:4180/');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    const result = await page.evaluate(() => (window as unknown as { ImportStability: { probe(): Promise<ImportStabilityResult> } }).ImportStability.probe());
    const output = path.resolve('test-results/import-depth-stability'); await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ result, errors }, null, 2));
    expect(result.meshCount).toBe(2);
    // The control reproduces depth fighting; the production convention must not.
    expect(result.ordinary.some((sample) => sample.blue > 50)).toBe(true);
    expect(result.stable).toEqual(Array.from({ length: 8 }, () => ({ red: 4096, blue: 0 })));
    expect(result.exported).toEqual({ red: 4096, blue: 0 });
    expect(result.metricDepth).toBeGreaterThan(197);
    expect(result.metricDepth).toBeLessThan(203);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 120_000);
