import { expect, test, type Page } from '@playwright/test';

async function enterContinuityStage(page: Page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('panoref-splash-seen', '1');
    } catch {
      // ignore
    }
  });
  await page.goto('/');
  const modeChooser = page.locator('[data-mode-chooser]');
  const continuity = page.getByRole('button', { name: /Build continuity packages/i });
  if (await modeChooser.isVisible().catch(() => false)) {
    await continuity.click();
  } else {
    try {
      await modeChooser.waitFor({ state: 'visible', timeout: 3000 });
      await continuity.click();
    } catch {
      // Already in mode.
    }
  }
  const splash = page.getByRole('dialog', { name: 'Continuity Stage splash' });
  if (await splash.isVisible().catch(() => false)) {
    await splash.click({ force: true });
    await expect(splash).toBeHidden({ timeout: 5000 });
  }
  await expect(page.locator('header nav button').filter({ hasText: /^\s*Build\s*$/ }).locator('visible=true').first())
    .toBeVisible({ timeout: 15000 });
}

async function dismissOverlays(page: Page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let dismissed = false;
    for (const label of ['Got it', 'Not right now', 'Start checking', 'Close']) {
      const button = page.getByRole('button', { name: label, exact: true });
      if (await button.isVisible().catch(() => false)) {
        await button.click({ force: true }).catch(() => undefined);
        dismissed = true;
        await page.waitForTimeout(150);
      }
    }
    if (!dismissed) break;
  }
}

test.describe('@visual screenshot baselines', () => {
  test('build workspace baseline', async ({ page }, testInfo) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`build-${testInfo.project.name}.png`, {
      fullPage: false,
    });
  });

  test('shots workspace baseline', async ({ page }, testInfo) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await page.locator('header nav button').filter({ hasText: /^\s*Shots\s*$/ }).locator('visible=true').first().click();
    await dismissOverlays(page);
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`shots-${testInfo.project.name}.png`, {
      fullPage: false,
    });
  });
});
