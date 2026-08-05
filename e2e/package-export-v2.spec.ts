import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

import {
  dismissOverlays,
  enterStudioExpectingLauncher,
  reloadAndAwaitRecovery,
  waitForVerifiedSave,
} from './helpers/app-entry';
import { goToWorkspace } from './workspace-navigation';

async function openDialogueDemoSample(page: Page) {
  await enterStudioExpectingLauncher(page);
  const openSample = page.locator('[data-sample-id="dialogue-demo"] [data-sample-open]');
  await expect(openSample).toBeEnabled({ timeout: 30_000 });
  await openSample.click();
  await expect(page.locator('[data-sample-loading]')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-project-launcher]')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('[data-project-save-status]')).toHaveAttribute('data-project-save-status', 'saved', {
    timeout: 30_000,
  });
  await dismissOverlays(page);
}

async function selectSingleShotForExport(page: Page) {
  const rows = page.locator('[data-export-shot-row]');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const count = await rows.count();
  for (let index = 1; index < count; index += 1) {
    const row = rows.nth(index);
    if ((await row.getAttribute('data-export-shot-row')) === 'selected') {
      await row.locator('input[type="checkbox"]').uncheck();
    }
  }
  await expect(page.locator('[data-export-shot-row="selected"]')).toHaveCount(1);
}

async function openPackageLayoutSection(page: Page) {
  const packageLayout = page.locator('summary', { hasText: 'Package layout' });
  await expect(packageLayout).toBeVisible({ timeout: 10_000 });
  const details = packageLayout.locator('xpath=ancestor::details[1]');
  if ((await details.getAttribute('open')) === null) {
    await packageLayout.click();
  }
}

async function selectForeSceneV2PackageFormat(page: Page) {
  await page.locator('[data-export-settings-trigger]').click({ force: true });
  await openPackageLayoutSection(page);
  await page.locator('[data-export-package-format]').selectOption('forescene-v2');
  await page.keyboard.press('Escape');
  await dismissOverlays(page);
}

async function expectForeSceneV2PackageFormatPersisted(page: Page) {
  await page.locator('[data-export-settings-trigger]').click({ force: true });
  await openPackageLayoutSection(page);
  await expect(page.locator('[data-export-package-format]')).toHaveValue('forescene-v2');
  await page.keyboard.press('Escape');
  await dismissOverlays(page);
}

test.describe('@smoke forescene-v2 package export', () => {
  test('persists v2 format selection and exports a package with v2 layout', async ({ page }) => {
    test.setTimeout(240_000);

    await openDialogueDemoSample(page);
    await goToWorkspace(page, 'Export', '[data-export-package-panel]');
    await dismissOverlays(page);
    await selectSingleShotForExport(page);
    await selectForeSceneV2PackageFormat(page);

    await waitForVerifiedSave(page);

    await reloadAndAwaitRecovery(page);
    await dismissOverlays(page);
    await goToWorkspace(page, 'Export', '[data-export-package-panel]');
    await selectSingleShotForExport(page);
    await expectForeSceneV2PackageFormatPersisted(page);

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
    await page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i }).click();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    const zipPath = await download.path();
    expect(zipPath).toBeTruthy();
    const zip = await JSZip.loadAsync(await readFile(zipPath!));
    const paths = Object.keys(zip.files).filter((path) => !path.endsWith('/'));
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('START_HERE.html');
    expect(paths.some((path) => /^shots\/[^/]+\/manifest\.json$/.test(path))).toBe(true);

    const rootManifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { format: string };
    expect(rootManifest.format).toBe('forescene-v2');
  });
});
