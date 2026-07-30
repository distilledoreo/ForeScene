/**
 * Playwright screenshot helper for the Agent CLI.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';

const WORKSPACE_LABELS: Record<string, string> = {
  build: 'Build',
  reference: 'Reference',
  shots: 'Shots',
  export: 'Export',
};

/** Navigate via visible workspace tabs — works without agent write access. */
export async function openWorkspace(page: Page, workspace: string): Promise<void> {
  const label = WORKSPACE_LABELS[workspace] ?? workspace;
  const tab = page
    .locator('header nav button')
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
    .locator('visible=true')
    .first();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await tab.isVisible().catch(() => false)) {
      await tab.click({ force: true }).catch(() => undefined);
    }
    const current = await tab.getAttribute('aria-current').catch(() => null);
    if (current === 'page') return;
    await page.waitForTimeout(250);
  }
}

export async function captureSceneScreenshot(
  page: Page,
  outputPath: string,
): Promise<string> {
  const absolute = path.resolve(outputPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const viewport = page.locator('[data-testid="scene-viewport"]');
  if (await viewport.count() > 0) {
    await viewport.first().screenshot({ path: absolute });
  } else {
    await page.screenshot({ path: absolute, fullPage: false });
  }
  return absolute;
}
