import { expect, test } from '@playwright/test';

import {
  dismissOverlays,
  enterStudioExpectingLauncher,
  enterStudioWorkspace,
} from './helpers/app-entry';
import { goToWorkspace } from './workspace-navigation';

test.describe('@visual screenshot baselines', () => {
  test('launcher baseline', async ({ page }, testInfo) => {
    await enterStudioExpectingLauncher(page);
    await dismissOverlays(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`launcher-${testInfo.project.name}.png`, {
      fullPage: false,
    });
  });

  test('build workspace baseline', async ({ page }, testInfo) => {
    // Dismiss launcher so this captures Build, not the onboarding modal.
    await enterStudioWorkspace(page);
    await dismissOverlays(page);
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`build-${testInfo.project.name}.png`, {
      fullPage: false,
    });
  });

  test('shots workspace baseline', async ({ page }, testInfo) => {
    await enterStudioWorkspace(page);
    await dismissOverlays(page);
    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);
    // Let the viewfinder finish settling so the screenshot matches the baseline.
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`shots-${testInfo.project.name}.png`, {
      fullPage: false,
    });
  });
});
