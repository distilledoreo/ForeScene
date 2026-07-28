import { expect, test } from '@playwright/test';
import { dismissOverlays, enterContinuityStage } from './helpers/app-entry';

async function openHelpCenter(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Open app menu' }).click();
  await page.getByRole('menuitem', { name: 'Help & Documentation' }).click();
  await expect(page.locator('[data-help-workspace]')).toBeVisible({ timeout: 20_000 });
}

test.describe('@smoke comprehensive Help Center', () => {
  test('searches an exact visible control label and returns to a workspace', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await openHelpCenter(page);

    const search = page.locator('[data-help-search]');
    await search.fill('near clip');

    const nearClip = page.locator('[data-help-control="Near Clip"]');
    await expect(nearClip).toBeVisible();
    await expect(nearClip).toContainText('Hides geometry closer than this distance');
    await expect(page.locator('[data-help-section="shots"]')).toBeVisible();
    await expect(page.locator('[data-help-section="build"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.locator('[data-help-section="build"]')).toBeVisible();

    await page.locator('[data-help-section="build"]').getByRole('button', { name: 'Open Build' }).click();
    await expect(page.getByTestId('scene-viewport')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('@responsive Help Center navigation', () => {
  test('offers a mobile section picker without exposing the desktop navigation', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('phone') && !testInfo.project.name.includes('tablet'), 'Responsive projects only.');

    await enterContinuityStage(page);
    await dismissOverlays(page);
    await openHelpCenter(page);

    const picker = page.getByRole('combobox', { name: 'Documentation section' });
    await expect(picker).toBeVisible();
    await picker.selectOption('shots');
    await expect(page.locator('[data-help-section="shots"]')).toBeVisible();
  });
});
