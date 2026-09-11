import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium } from 'playwright';

describe('source-preserving imports in WebGL', () => {
  it('renders real textures, preserves them through fresh reopen, and exports depth/projection for skins and instances', async () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const bundled = await build({
        entryPoints: [path.resolve('tests/fixtures/source-model-browser-entry.ts')],
        bundle: true, write: false, format: 'iife', globalName: 'SourceImportGate',
        platform: 'browser', target: ['chrome120'], logLevel: 'silent',
        define: { 'import.meta.env': '{}' },
      });
      browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error' && /shader|compile|INVALID_|GL_INVALID|WebGLProgram/.test(message.text())) errors.push(message.text());
      });
      // IndexedDB requires an origin; about:blank/setContent is an opaque context.
      await page.route('http://127.0.0.1:4179/**', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
      }));
      await page.goto('http://127.0.0.1:4179/');
      await page.addScriptTag({ content: bundled.outputFiles[0].text });
      const result = await page.evaluate(() => (window as unknown as {
        SourceImportGate: { runSourceModelBrowserGate: () => Promise<{ passed: string[]; texturePixels: { red: number; green: number; blue: number }; screenshot: string }> }
      }).SourceImportGate.runSourceModelBrowserGate());
      const output = path.resolve('test-results/source-model'); await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'textured-source.png'), Buffer.from(result.screenshot.split(',')[1], 'base64'));
      await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...result, screenshot: 'textured-source.png', errors }, null, 2));
      expect(result.passed).toHaveLength(7);
      expect(result.texturePixels.red).toBeGreaterThan(50);
      expect(errors).toEqual([]);
    } finally { await browser?.close(); }
  }, 120_000);
});
