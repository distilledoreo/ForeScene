import { expect, test, type Page } from '@playwright/test';

import { enterStudioWorkspace } from './helpers/app-entry';
import { goToWorkspace } from './workspace-navigation';

/** Workspace entry: Studio + launcher dismissed so chrome is clickable. */
async function enterStudio(page: Page) {
  await enterStudioWorkspace(page);
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

async function assertInViewport(box: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }, label: string) {
  expect(box.width, `${label} width`).toBeGreaterThan(0);
  expect(box.height, `${label} height`).toBeGreaterThan(0);
  expect(box.x, `${label} left`).toBeGreaterThanOrEqual(-4);
  expect(box.y, `${label} top`).toBeGreaterThanOrEqual(-4);
  expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(viewport.width + 4);
  expect(box.y + box.height, `${label} bottom`).toBeLessThanOrEqual(viewport.height + 4);
}

test.describe('@responsive layout visibility and overflow', () => {
  test('Build workspace: primary controls visible, no horizontal overflow', async ({ page }) => {
    await enterStudio(page);
    await dismissOverlays(page);
    const build = page.locator('header nav button').filter({ hasText: /^\s*Build\s*$/ }).locator('visible=true').first();
    const shots = page.locator('header nav button').filter({ hasText: /^\s*Shots\s*$/ }).locator('visible=true').first();
    await expect(build).toBeVisible();
    await expect(shots).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  // Linux SW WebKit flakes on Shots/WebGL mount — same canary policy as @webkit-gpu smoke.
  test('@webkit-gpu Shots workspace: primary capture chrome required and on-screen', async ({ page }) => {
    await enterStudio(page);
    await dismissOverlays(page);
    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);

    const chrome = page.locator('[data-shots-capture-chrome], [data-shots-camera-chrome]').first();
    await expect(chrome, 'capture chrome must mount').toBeVisible({ timeout: 10000 });

    const shutter = page.locator('[data-shots-shutter], [data-capture-shutter]').first();
    await expect(shutter, 'primary shutter must be visible').toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport).toBeTruthy();
    const shutterBox = await shutter.boundingBox();
    expect(shutterBox, 'shutter bounding box').toBeTruthy();
    if (shutterBox && viewport) {
      assertInViewport(shutterBox, viewport, 'shutter');
    }

    // Mode switcher must remain visible (not covered by drawers).
    const modeSwitcher = page.locator('[data-shots-mode-switcher]').first();
    await expect(modeSwitcher).toBeVisible();
    const modeBox = await modeSwitcher.boundingBox();
    if (modeBox && viewport) {
      assertInViewport(modeBox, viewport, 'mode switcher');
    }

    await assertNoHorizontalOverflow(page);
  });

  test('@webkit-gpu settings drawer opens and fits onscreen without covering shutter', async ({ page }) => {
    await enterStudio(page);
    await dismissOverlays(page);
    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);

    const shutter = page.locator('[data-shots-shutter], [data-capture-shutter]').first();
    await expect(shutter).toBeVisible();

    const settingsBtn = page.locator('[data-shots-settings-trigger]').first();
    await expect(settingsBtn, 'settings gear must be visible').toBeVisible();
    await settingsBtn.click();

    // Content marker proves ShotSettings mounted; dialog is the on-screen shell.
    await expect(page.locator('[data-shot-settings], [data-shots-advanced-settings]').first())
      .toBeVisible({ timeout: 8000 });
    const dialog = page.getByRole('dialog', { name: /Camera Settings|Shot settings/i }).first();
    await expect(dialog, 'settings dialog must open').toBeVisible({ timeout: 8000 });

    const viewport = page.viewportSize();
    expect(viewport).toBeTruthy();
    const box = await dialog.boundingBox();
    expect(box, 'settings dialog box').toBeTruthy();
    if (box && viewport) {
      expect(box.width, 'dialog width fits').toBeLessThanOrEqual(viewport.width + 2);
      expect(box.height, 'dialog height fits').toBeLessThanOrEqual(viewport.height + 2);
      expect(box.x).toBeGreaterThanOrEqual(-4);
      expect(box.y).toBeGreaterThanOrEqual(-4);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 4);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 4);
    }

    // Desktop/side drawers must not cover the primary shutter.
    // On phone/tablet the drawer is intentionally full-bleed; required control
    // must return after close (cannot leave shutter permanently covered).
    const viewportWidth = viewport?.width ?? 1440;
    const shutterBox = await shutter.boundingBox();
    expect(shutterBox).toBeTruthy();
    if (box && shutterBox && viewportWidth >= 1024) {
      const shutterCenter = {
        x: shutterBox.x + shutterBox.width / 2,
        y: shutterBox.y + shutterBox.height / 2,
      };
      const coversShutterCenter = (
        shutterCenter.x >= box.x
        && shutterCenter.x <= box.x + box.width
        && shutterCenter.y >= box.y
        && shutterCenter.y <= box.y + box.height
      );
      expect(coversShutterCenter, 'desktop settings drawer should not cover shutter center').toBe(false);
    }

    // Close drawer and require shutter still visible (drawer must not trap the chrome).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5000 });
    await expect(shutter, 'shutter must remain after settings close').toBeVisible();

    await assertNoHorizontalOverflow(page);
  });
});
