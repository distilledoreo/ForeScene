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

async function expectRetainedContactSheetResolves(page: Page) {
  await expect.poll(async () => page.evaluate(async () => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(`Could not open ${name}.`));
    });
    const read = <T>(database: IDBDatabase, storeName: string, key: IDBValidKey) => new Promise<T | undefined>((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error ?? new Error(`Could not read ${storeName}.`));
    });

    const revisions = await open('panoref-project-revisions');
    const heads = await new Promise<Array<{ activeRevisionId: string }>>((resolve, reject) => {
      const request = revisions.transaction('heads', 'readonly').objectStore('heads').getAll();
      request.onsuccess = () => resolve(request.result as Array<{ activeRevisionId: string }>);
      request.onerror = () => reject(request.error ?? new Error('Could not list project heads.'));
    });
    const revisionRecords = await new Promise<Array<{ id: string; manifest: string }>>((resolve, reject) => {
      const request = revisions.transaction('revisions', 'readonly').objectStore('revisions').getAll();
      request.onsuccess = () => resolve(request.result as Array<{ id: string; manifest: string }>);
      request.onerror = () => reject(request.error ?? new Error('Could not list project revisions.'));
    });
    revisions.close();
    const activeRevisionIds = new Set(heads.map((head) => head.activeRevisionId));
    const manifests = revisionRecords
      .filter((revision) => activeRevisionIds.has(revision.id))
      .map((revision) => JSON.parse(revision.manifest) as {
      assets?: { assets?: Record<string, { storageKey?: string; uri?: string; metadata?: Record<string, unknown> }> };
      });
    const manifest = manifests.find((candidate) => Object.values(candidate.assets?.assets ?? {}).some((asset) =>
      asset.metadata?.role === 'contact-sheet' && asset.metadata?.retainInProject === true
    ));
    const contactSheet = Object.values(manifest?.assets?.assets ?? {}).find((asset) => (
      asset.metadata?.role === 'contact-sheet' && asset.metadata?.retainInProject === true
    ));
    const key = contactSheet?.storageKey ?? contactSheet?.uri?.replace('panoref-asset:', '');
    if (!key) return false;

    const assets = await open('panoref-project-assets');
    const stored = await read<Blob | { bytes: ArrayBuffer; type: string }>(assets, 'binary-assets', key);
    assets.close();
    const blob = stored instanceof Blob
      ? stored
      : stored && stored.bytes instanceof ArrayBuffer
        ? new Blob([stored.bytes], { type: stored.type })
        : undefined;
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    try {
      const response = await fetch(url);
      return response.ok && (await response.blob()).size > 0;
    } finally {
      URL.revokeObjectURL(url);
    }
  }).catch(() => false), { timeout: 30_000 }).toBe(true);
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
    await expect(page.locator('[data-project-save-status]')).toHaveAttribute('data-project-save-status', 'saved', { timeout: 30_000 });
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
    await expectRetainedContactSheetResolves(page);

    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    // goToWorkspace already waits for the shell. Dismiss guidance before the
    // next navigation instead of racing a duplicate assertion against its modal.
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
    await expectRetainedContactSheetResolves(page);
    await dismissOverlays(page);
  });
});
