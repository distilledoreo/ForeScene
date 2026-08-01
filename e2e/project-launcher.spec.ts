import { expect, test, type Page } from '@playwright/test';

import {
  dismissOverlays,
  enterStudioExpectingLauncher,
} from './helpers/app-entry';
import { goToWorkspace, workspaceTab } from './workspace-navigation';

/** Project name lives inside the brand menu — open it first. */
async function openProjectMenu(page: Page) {
  await dismissOverlays(page);

  const trigger = page.locator('[data-brand-menu-trigger]');
  await expect(trigger).toBeVisible();
  // Menu may already be open from a prior step.
  if (!(await page.locator('[data-project-name-input]').isVisible().catch(() => false))) {
    await trigger.click();
  }
  await expect(page.locator('[data-project-name-input]')).toBeVisible({ timeout: 10_000 });
}

async function expectProjectName(page: Page, pattern: RegExp) {
  await openProjectMenu(page);
  await expect(page.locator('[data-project-name-input]')).toHaveValue(pattern, {
    timeout: 15_000,
  });
}

test.describe('@smoke first-project launcher', () => {
  test('opens Dialogue Demo sample and reaches Reference + Export', async ({ page }) => {
    await enterStudioExpectingLauncher(page);

    // Wait for persistence readiness — sample open is disabled until lifecycle is ready.
    const openSample = page.locator('[data-sample-open]');
    await expect(openSample).toBeEnabled({ timeout: 30_000 });
    await openSample.click();
    await expect(page.locator('[data-project-launcher]')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('[data-project-import-status="success"]')).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
    // Workflow guidance / objective modals often appear after a project swap.
    await dismissOverlays(page);

    await expectProjectName(page, /Dialogue Demo/i);
    // Close menu so workspace nav is unobstructed.
    await page.keyboard.press('Escape');
    await dismissOverlays(page);

    // Prove the sample project is live via the Agent API surface (same as product path).
    await expect.poll(async () => {
      return page.evaluate(() => {
        const api = window.foreScene;
        if (!api?.listShots) return null;
        return api.listShots().map((shot) => ({
          shotNumber: shot.shotNumber,
          name: shot.name,
        }));
      });
    }, { timeout: 15_000 }).toEqual([
      { shotNumber: '010', name: 'Wide two-shot' },
      { shotNumber: '020', name: 'Alex medium' },
      { shotNumber: '030', name: 'Blair OTS' },
      { shotNumber: '040', name: 'Alex close-up' },
    ]);

    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await expect(page.locator('[data-shots-camera-shell]')).toBeVisible();
    await dismissOverlays(page);

    await goToWorkspace(page, 'Reference', '[data-panoramas-card], [data-reference-bottom-chrome]');
    await expect(workspaceTab(page, 'Reference')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-styled-pano-count]')).toBeVisible();
    // Styled count should be at least 1 for the sample.
    await expect(page.locator('[data-styled-pano-count]')).not.toHaveAttribute('data-styled-pano-count', '0');
    await dismissOverlays(page);

    await goToWorkspace(page, 'Export', '[data-export-package-panel], [data-export-settings-trigger]');
    await expect(workspaceTab(page, 'Export')).toHaveAttribute('aria-current', 'page');

    // Sample should not surface hard missing-graybox selection blocks.
    const grayboxBlock = page.getByText(/no graybox 360 has been rendered/i);
    await expect(grayboxBlock).toHaveCount(0);
  });

  test('canceling Open Existing keeps the launcher visible', async ({ page }) => {
    await enterStudioExpectingLauncher(page);

    // Choosing open-existing must not dismiss before a successful import.
    // Native file chooser cancel is not fully controllable in all browsers;
    // we assert that invoking the option does not immediately hide the launcher
    // and that dismiss is still available.
    await page.locator('[data-launcher-option="open-existing"]').click();
    await expect(page.locator('[data-project-launcher]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-project-launcher-dismiss]')).toBeVisible();
  });

  test('reset sample restores baseline after edits', async ({ page }) => {
    await enterStudioExpectingLauncher(page);
    const openSample = page.locator('[data-sample-open]');
    await expect(openSample).toBeEnabled({ timeout: 30_000 });
    await openSample.click();
    await expect(page.locator('[data-project-launcher]')).toBeHidden({ timeout: 30_000 });
    await dismissOverlays(page);
    await expectProjectName(page, /Dialogue Demo/i);

    // Rename the project so we can detect reset.
    const nameInput = page.locator('[data-project-name-input]');
    await nameInput.fill('Edited Sample Name');
    await expect(nameInput).toHaveValue('Edited Sample Name');

    // Reset Sample stays in the open menu (marker-based; available after rename).
    const resetItem = page.locator('[data-project-reset-sample]');
    await expect(resetItem).toBeVisible({ timeout: 10_000 });
    await resetItem.click();
    await dismissOverlays(page);

    await expectProjectName(page, /Dialogue Demo/i);
    await dismissOverlays(page);
  });
});
