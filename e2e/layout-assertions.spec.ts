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

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });
  expect(overflow.scrollWidth, 'document should not horizontally overflow').toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
}

async function assertPrimaryNavVisible(page: Page) {
  const build = page.locator('header nav button').filter({ hasText: /^\s*Build\s*$/ }).locator('visible=true').first();
  const shots = page.locator('header nav button').filter({ hasText: /^\s*Shots\s*$/ }).locator('visible=true').first();
  await expect(build).toBeVisible();
  await expect(shots).toBeVisible();
  const box = await build.boundingBox();
  expect(box, 'primary Build tab should have a box').toBeTruthy();
  if (box) {
    expect(box.y + box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
  }
}

test.describe('layout visibility and overflow', () => {
  test('Build workspace: primary controls visible, no horizontal overflow', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await assertPrimaryNavVisible(page);
    await assertNoHorizontalOverflow(page);
  });

  test('Shots workspace: primary capture chrome fits viewport', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await page.locator('header nav button').filter({ hasText: /^\s*Shots\s*$/ }).locator('visible=true').first().click();
    await dismissOverlays(page);
    await assertPrimaryNavVisible(page);
    await assertNoHorizontalOverflow(page);

    // Shutter / primary capture control should be on-screen when present.
    const shutter = page.locator('[data-shutter], [data-capture-shutter], button').filter({
      hasText: /Capture|Shutter|Still|Video|Land/i,
    }).first();
    if (await shutter.isVisible().catch(() => false)) {
      const box = await shutter.boundingBox();
      expect(box).toBeTruthy();
      if (box) {
        const viewport = page.viewportSize();
        expect(viewport).toBeTruthy();
        if (viewport) {
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 2);
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 2);
          expect(box.y).toBeGreaterThanOrEqual(-2);
        }
      }
    }
  });

  test('dialogs fit onscreen when opened from brand menu', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    // Open brand / project menu if present.
    const brand = page.getByRole('button', { name: /Continuity Stage|PanoRef|Project menu|Menu/i }).first();
    if (await brand.isVisible().catch(() => false)) {
      await brand.click();
      await page.waitForTimeout(200);
    }
    const dialog = page.getByRole('dialog').first();
    if (await dialog.isVisible().catch(() => false)) {
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      expect(box).toBeTruthy();
      expect(viewport).toBeTruthy();
      if (box && viewport) {
        expect(box.width).toBeLessThanOrEqual(viewport.width + 2);
        expect(box.height).toBeLessThanOrEqual(viewport.height + 2);
        expect(box.x).toBeGreaterThanOrEqual(-4);
        expect(box.y).toBeGreaterThanOrEqual(-4);
      }
    }
    await assertNoHorizontalOverflow(page);
  });
});
