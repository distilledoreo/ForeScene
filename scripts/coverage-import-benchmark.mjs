import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const modelPath = process.env.PANOREF_COVERAGE_BENCHMARK_MODEL;
const baseUrl = process.env.PANOREF_COVERAGE_BENCHMARK_URL ?? 'http://127.0.0.1:4173';
const outputDir = path.resolve(process.env.PANOREF_COVERAGE_BENCHMARK_OUTPUT ?? 'artifacts/coverage-import-benchmark');
if (!modelPath) throw new Error('Set PANOREF_COVERAGE_BENCHMARK_MODEL to a real GLB/FBX/OBJ/STL/PLY set.');

const model = await stat(modelPath);
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
});

const dismissOverlays = async () => {
  for (const label of ['Got it', 'Not right now', 'Start checking']) {
    const button = page.getByRole('button', { name: label, exact: true });
    if (await button.isVisible().catch(() => false)) await button.click({ force: true });
  }
};
const workspaceTab = (label) => page.locator('header nav button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).locator('visible=true').first();

const startedAt = Date.now();
let importStartedAt;
let optimizationStartedAt;
try {
  await page.addInitScript(() => localStorage.setItem('forescene-splash-seen', '1'));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const chooser = page.locator('[data-mode-chooser]');
  if (await chooser.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /Open ForeScene studio/i }).click();
  }
  await dismissOverlays();
  await workspaceTab('Build').click();
  await dismissOverlays();

  // Benchmark the imported set itself, not the starter primitives or authored floor.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);

  await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
  await page.locator('[data-build-import-model]').click();
  const dialog = page.getByRole('dialog', { name: /Import 3D/ });
  await dialog.locator('[data-import-mode="combined"]').check();
  await dialog.locator('[data-allow-heavy-imports]').check();
  importStartedAt = Date.now();
  await dialog.locator('[data-model-import-input]').setInputFiles(modelPath, { timeout: 120_000 });

  const success = dialog.locator('[data-model-import-report-item="success"]').last();
  const analysis = dialog.locator('[data-model-import-analysis]');
  await Promise.race([
    success.waitFor({ state: 'visible', timeout: 900_000 }),
    analysis.waitFor({ state: 'visible', timeout: 900_000 }),
  ]);
  if (await analysis.isVisible().catch(() => false)) {
    const extreme = dialog.locator('[data-extreme-import-confirmation]');
    if (await extreme.isVisible().catch(() => false)) await extreme.fill('IMPORT');
    await dialog.getByRole('button', { name: /Import (heavy|extreme) scene/i }).click();
    await success.waitFor({ state: 'visible', timeout: 1_800_000 });
  }
  const importFinishedAt = Date.now();
  const importReport = await success.innerText();
  const analysisText = await analysis.isVisible().catch(() => false) ? await analysis.innerText() : undefined;
  await dialog.getByText('Close', { exact: true }).last().click();

  const renderReference = page.getByRole('button', { name: /Render 360 Reference/i });
  await renderReference.click();
  await page.getByRole('button', { name: /Download Graybox|Re-render after scene changes/i }).first()
    .waitFor({ state: 'visible', timeout: 900_000 });
  await dismissOverlays();

  await workspaceTab('Reference').click();
  await page.waitForTimeout(1_000);
  await dismissOverlays();
  const useAttached = page.getByRole('button', { name: /Use Attached Reference/i });
  if (await useAttached.isVisible().catch(() => false)) {
    await useAttached.click();
    const startChecking = page.getByRole('button', { name: 'Start checking', exact: true });
    await startChecking.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    if (await startChecking.isVisible().catch(() => false)) await startChecking.click();
    await dismissOverlays();
  }
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Reference Settings' });
  await drawer.locator('[data-coverage-optimizer] summary').click();
  optimizationStartedAt = Date.now();
  await drawer.locator('[data-coverage-analyze]').click();
  const result = drawer.locator('[data-coverage-result]');
  const failed = drawer.locator('[data-coverage-status="failed"]');
  await Promise.race([
    result.waitFor({ state: 'visible', timeout: 1_800_000 }),
    failed.waitFor({ state: 'visible', timeout: 1_800_000 }),
  ]);
  if (await failed.isVisible().catch(() => false)) throw new Error(`Coverage optimizer failed: ${await failed.innerText()}`);
  const optimizationFinishedAt = Date.now();
  const heap = await page.evaluate(() => {
    const memory = performance.memory;
    return memory ? {
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
    } : undefined;
  });
  const report = {
    ok: pageErrors.length === 0,
    model: { path: path.resolve(modelPath), bytes: model.size },
    importMilliseconds: importFinishedAt - importStartedAt,
    optimizationMilliseconds: optimizationFinishedAt - optimizationStartedAt,
    totalMilliseconds: Date.now() - startedAt,
    importReport,
    analysisText,
    originA: (await result.getAttribute('data-coverage-origin-a'))?.split(',').map(Number),
    originB: (await result.getAttribute('data-coverage-origin-b'))?.split(',').map(Number),
    resultText: await result.innerText(),
    heap,
    pageErrors,
  };
  await page.screenshot({ path: path.join(outputDir, 'coverage-import-benchmark.png'), fullPage: true });
  await writeFile(path.join(outputDir, 'coverage-import-benchmark.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const report = {
    ok: false,
    model: { path: path.resolve(modelPath), bytes: model.size },
    importElapsedMilliseconds: importStartedAt ? Date.now() - importStartedAt : undefined,
    optimizationElapsedMilliseconds: optimizationStartedAt ? Date.now() - optimizationStartedAt : undefined,
    totalMilliseconds: Date.now() - startedAt,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    pageErrors,
  };
  await page.screenshot({ path: path.join(outputDir, 'coverage-import-benchmark-failure.png'), fullPage: true }).catch(() => undefined);
  await writeFile(path.join(outputDir, 'coverage-import-benchmark.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
