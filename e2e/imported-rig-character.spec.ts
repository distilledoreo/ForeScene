import { expect, test, type Page } from '@playwright/test';

import { enterStudioWorkspace } from './helpers/app-entry';
import { workspaceTab } from './workspace-navigation';
import { preservedRigGlb } from '../tests/fixtures/preservedRigGlb';

function dismissOverlays(page: Page) {
  return (async () => {
    for (const label of ['Got it', 'Not right now', 'Start checking', 'Close']) {
      const button = page.getByRole('button', { name: label, exact: true });
      if (await button.isVisible().catch(() => false)) await button.click({ force: true }).catch(() => undefined);
    }
  })();
}

test('preserves a Mixamo-style rig and applies a semantic pose', async ({ page }) => {
  await enterStudioWorkspace(page);
  await dismissOverlays(page);
  await workspaceTab(page, 'Build').click();
  await dismissOverlays(page);
  await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
  await page.locator('[data-build-import-poseable-character]').click();

  const dialog = page.getByRole('dialog', { name: /Import poseable character/i });
  await dialog.locator('[data-poseable-import-mesh-input]').setInputFiles({
    name: 'preserved-mixamo.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from(preservedRigGlb()),
  });
  await expect(dialog.locator('[data-poseable-import-rig-summary]')).toBeVisible({ timeout: 15000 });
  await expect(dialog.locator('[data-poseable-import-preserve-rig]')).toBeEnabled();
  await expect(dialog.getByText('Use existing rig', { exact: true })).toBeVisible();
  await dialog.locator('[data-poseable-import-confirm]').click();
  await expect(dialog).toBeHidden({ timeout: 15000 });

  await page.locator('[data-character-mode-pose]').click();
  await expect(page.locator('[data-build-character-pose]')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Arms raised/i }).click();
  await expect(page.locator('[data-build-character-pose]')).toBeVisible();
});
