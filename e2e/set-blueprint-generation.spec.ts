import { expect, test } from '@playwright/test';

import {
  dismissOverlays,
  enterStudio,
  reloadAndAwaitRecovery,
  waitForVerifiedSave,
} from './helpers/app-entry';
import { workspaceTab } from './workspace-navigation';

const MINIMAL_BLUEPRINT = {
  schemaVersion: 1,
  name: 'E2E Generated Courtyard',
  description: 'Smoke-test blueprint pasted through the Set Generation dialog.',
  units: 'meters',
  panoOrigin: [0, 1.65, 0],
  objects: [
    {
      key: 'floor_1',
      name: 'Courtyard Floor',
      type: 'floor',
      position: [0, 0, 0],
      dimensions: [10, 0.1, 8],
    },
    {
      key: 'wall_back',
      name: 'Back Wall',
      type: 'wall',
      position: [0, 0, -4],
      dimensions: [10, 3, 0.2],
    },
    {
      key: 'person_1',
      name: 'Scale Person',
      type: 'human_dummy',
      position: [1, 0, 2],
      dimensions: [0.55, 1.75, 0.55],
    },
  ],
  landmarks: [
    {
      key: 'lm_person',
      displayName: 'Scale Person',
      linkedObjectKey: 'person_1',
    },
  ],
};

test.describe('@smoke set blueprint generation', () => {
  test('paste blueprint JSON, apply, and recover after reload', async ({ page }) => {
    test.setTimeout(120_000);
    await enterStudio(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
    await page.locator('[data-build-generate-set]').click();

    const dialog = page.locator('[data-set-generation-dialog]');
    await expect(dialog).toBeVisible();

    await page.locator('[data-set-generation-tab="paste"]').click();
    await page.locator('[data-set-generation-paste-input]').fill(JSON.stringify(MINIMAL_BLUEPRINT, null, 2));
    await page.locator('[data-set-generation-review]').click();

    await expect(page.getByRole('dialog', { name: /Review generated set/i })).toBeVisible();
    await expect(dialog).toContainText('E2E Generated Courtyard');
    await expect(dialog).toContainText('human_dummy');
    await page.locator('[data-set-generation-apply]').click();

    await expect(page.locator('[data-project-import-status="success"]')).toContainText(/E2E Generated Courtyard/, {
      timeout: 15000,
    });
    await expect(page.locator('[data-set-generation-dialog]')).toHaveCount(0);

    await waitForVerifiedSave(page);

    await page.locator('[data-brand-menu-trigger]').click();
    await expect(page.locator('[data-project-name-input]')).toHaveValue('E2E Generated Courtyard', {
      timeout: 10000,
    });
    await page.locator('[data-brand-menu-trigger]').click();

    await reloadAndAwaitRecovery(page);
    await dismissOverlays(page);
    await page.locator('[data-brand-menu-trigger]').click();
    await expect(page.locator('[data-project-name-input]')).toHaveValue('E2E Generated Courtyard', {
      timeout: 15000,
    });
  });
});

test.describe('@responsive set generation dialog', () => {
  test('dialog layout scrolls on a phone viewport', async ({ page }, testInfo) => {
    test.skip(!/phone/i.test(testInfo.project.name), 'Phone project only');

    await enterStudio(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
    await page.locator('[data-build-generate-set]').click();

    const dialog = page.getByRole('dialog', { name: /Generate set/i });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 2);

    await page.locator('[data-set-generation-tab="paste"]').click();
    const paste = page.locator('[data-set-generation-paste-input]');
    await expect(paste).toBeVisible();
    await paste.fill(JSON.stringify(MINIMAL_BLUEPRINT));
    await expect(paste).toBeInViewport();
  });
});
