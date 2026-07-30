import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';
const outputDir = path.resolve('public/docs');
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  localStorage.setItem('forescene-splash-seen', '1');
  localStorage.setItem('forescene-app-mode', 'studio');
});

const dismissGuidance = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const button = page.getByRole('button', { name: /Not right now|Close|Got it|Skip/i }).first();
    if (!(await button.isVisible().catch(() => false))) break;
    await button.click();
    await page.waitForTimeout(150);
  }
};

await page.goto(baseURL, { waitUntil: 'networkidle' });
await dismissGuidance();
await page.getByRole('button', { name: 'Build', exact: true }).first().click();
await dismissGuidance();
await page.locator('[data-build-object-tray]').waitFor({ state: 'visible', timeout: 30_000 });
await page.keyboard.press('Control+A');
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(outputDir, 'build-workspace.png') });

await page.getByRole('button', { name: 'Export', exact: true }).first().click();
await dismissGuidance();
await page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i }).waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outputDir, 'workflow-overview.png') });

await browser.close();
