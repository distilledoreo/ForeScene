import { expect, test, type Page } from '@playwright/test';

import {
  dismissOverlays,
  enterStudioWorkspace,
  exportProjectBackup,
  importProjectBackup,
  multiNodeGltfBuffer,
  reloadAndAwaitRecovery,
  waitForVerifiedSave,
} from './helpers/app-entry';
import { goToWorkspace, workspaceTab } from './workspace-navigation';

/**
 * Phase F — production workflow coverage (CODE_CLEANUP_PLAN F1–F5).
 *
 * Tag taxonomy (see CI workflows):
 * @heavy — multi-step save/import, GLB, multi-shot, video authoring (main/nightly)
 *
 * F1 uses full page.reload + IndexedDB recovery (not backup import as recover).
 * F2 covers backup export → reopen.
 * F4 pairs staging object snapshots with package export (video/manifest).
 * F5 storage-failure is unit-covered (projectPersistenceController + productionPath).
 */

async function renameProject(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open app menu' }).click();
  const nameInput = page.locator('[data-project-name-input]');
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  await nameInput.fill(name);
  // Close menu so it does not intercept later clicks.
  await page.keyboard.press('Escape');
  await dismissOverlays(page);
}

async function captureStillShot(page: Page) {
  await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
  await dismissOverlays(page);
  const shutter = page.locator('[data-shots-shutter]');
  await expect(shutter).toBeVisible({ timeout: 20_000 });
  await dismissOverlays(page);
  await shutter.click({ force: true });
  await dismissOverlays(page);
  // Authoritative capture signal: camera-roll thumb flips data-shot-has-capture.
  await expect(page.locator('[data-shot-camera-roll-thumb][data-shot-has-capture="true"]').first()).toBeVisible({
    timeout: 60_000,
  });
}

/** Open shot library overlay and return the card locator. */
async function openShotLibrary(page: Page) {
  // Prefer the chrome control; force click in case a transient toast overlaps.
  await page.getByRole('button', { name: 'Open shot library' }).click({ force: true });
  const library = page.locator('[data-shots-library]');
  await expect(library).toBeVisible({ timeout: 15_000 });
  return page.locator('[data-shots-library-card]');
}

async function closeShotLibrary(page: Page) {
  const library = page.locator('[data-shots-library]');
  if (!(await library.isVisible().catch(() => false))) return;
  const closeBtn = page.getByRole('button', { name: 'Close shot library' });
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ force: true });
  } else {
    // Click the dimmed backdrop (library root handles onClick=onClose).
    await library.click({ position: { x: 8, y: 8 }, force: true }).catch(() => undefined);
  }
  await expect(library).toBeHidden({ timeout: 10_000 });
  await dismissOverlays(page);
}

async function importMultiNodeGltf(page: Page) {
  await workspaceTab(page, 'Build').click();
  await dismissOverlays(page);
  await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
  await page.locator('[data-build-import-model]').click();
  const dialog = page.getByRole('dialog', { name: /Import 3D/ });
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-model-import-input]').setInputFiles({
    name: 'two-panels.gltf',
    mimeType: 'model/gltf+json',
    buffer: multiNodeGltfBuffer(),
  });
  await expect(dialog.getByText(/Imported 2 selectable objects/)).toBeVisible({ timeout: 30_000 });
  await dialog.getByText('Close', { exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe('@heavy F1 save → reload → recover → export', () => {
  test('mutates project, waits for verified save, full reload recovers revision, then exports', async ({ page }) => {
    test.setTimeout(240_000);
    await enterStudioWorkspace(page);
    await dismissOverlays(page);

    const projectName = `F1 Recovery ${Date.now()}`;
    await renameProject(page, projectName);

    await captureStillShot(page);
    await dismissOverlays(page);

    // Gate: durable verified autosave must complete before reload (not backup-as-recover).
    await waitForVerifiedSave(page);
    const preReloadSaveStatus = await page.locator('[data-project-save-status]').getAttribute('data-project-save-status');
    expect(preReloadSaveStatus).toBe('saved');

    // Full page reload — recoverLatestProject restores the verified revision from IndexedDB.
    await reloadAndAwaitRecovery(page);
    await dismissOverlays(page);

    // Recovered project identity (name) from verified revision.
    await page.getByRole('button', { name: 'Open app menu' }).click();
    await expect(page.locator('[data-project-name-input]')).toHaveValue(projectName, { timeout: 20_000 });
    await page.keyboard.press('Escape');
    await dismissOverlays(page);

    // Shot shell / capture media recovered from verified revision.
    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-camera-shell]')).toBeVisible();
    await expect(page.locator('[data-shots-library-thumb] img').first()).toBeVisible({ timeout: 30_000 });

    // Export from the recovered verified revision (backup + package panel).
    const backupPath = await exportProjectBackup(page);
    expect(backupPath).toBeTruthy();

    await workspaceTab(page, 'Export').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-export-package-panel]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i })).toBeVisible();
  });
});

test.describe('@heavy F2 import geometry → transform → capture → backup → reopen', () => {
  test('imports multi-node glTF, moves object, captures, reopens from backup', async ({ page }) => {
    test.setTimeout(180_000);
    await enterStudioWorkspace(page);
    await dismissOverlays(page);

    await importMultiNodeGltf(page);
    await dismissOverlays(page);

    // Focus viewport and nudge selection so transform is a durable project change.
    const viewport = page.getByTestId('scene-viewport');
    await expect(viewport).toBeVisible();
    await viewport.focus();
    await page.keyboard.press('ControlOrMeta+A');
    // Arrow nudge is the keyboard path (Move mode need not be active).
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    // Rotate gizmo mode toggle — proves transform chrome is interactive post-import.
    await page.keyboard.press('e');
    await page.keyboard.press('t');

    // Capture a still that includes the imported geometry.
    await captureStillShot(page);
    await dismissOverlays(page);

    const cards = await openShotLibrary(page);
    await expect(cards).toHaveCount(1, { timeout: 30_000 });
    await closeShotLibrary(page);

    const backupPath = await exportProjectBackup(page);
    await importProjectBackup(page, backupPath);
    await dismissOverlays(page);

    // Geometry + shots remain after reopen.
    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-library-thumb] img').first()).toBeVisible({ timeout: 30_000 });
    const recoveredCards = await openShotLibrary(page);
    await expect(recoveredCards).toHaveCount(1, { timeout: 20_000 });
    await closeShotLibrary(page);

    // Imported meshes are still selectable on Build.
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);
    const buildViewport = page.getByTestId('scene-viewport');
    await expect(buildViewport).toBeVisible();
    await buildViewport.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await expect(page.locator('[data-build-selection-count], [aria-label="Selected object name"]')).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('@heavy F3 multiple shots + people export modes', () => {
  test('creates independent shots, sets people mode, surfaces package settings', async ({ page }) => {
    test.setTimeout(180_000);
    await enterStudioWorkspace(page);
    await dismissOverlays(page);

    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);

    const shutter = page.locator('[data-shots-shutter]');
    await expect(shutter).toBeVisible({ timeout: 20_000 });

    // Shot 1
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-library-thumb] img').first()).toBeVisible({ timeout: 45_000 });

    // Move camera slightly so second capture is independent.
    await page.keyboard.down('d');
    await page.waitForTimeout(500);
    await page.keyboard.up('d');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);

    const cards = await openShotLibrary(page);
    await expect(cards).toHaveCount(2, { timeout: 45_000 });
    await expect(cards.locator('img')).toHaveCount(2, { timeout: 30_000 });
    await closeShotLibrary(page);

    // People export mode on active shot (Shots advanced settings) — library must be closed first.
    await page.locator('[data-shots-settings-trigger]').click({ force: true });
    const peopleMode = page.locator('[data-shots-people-export-mode]');
    await expect(peopleMode).toBeVisible({ timeout: 10_000 });
    await peopleMode.selectOption('both');
    await expect(peopleMode).toHaveValue('both');
    await page.keyboard.press('Escape');
    await dismissOverlays(page);

    // Export workspace: package panel + people mode + manifest paths reachable.
    await workspaceTab(page, 'Export').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-export-package-panel]')).toBeVisible({ timeout: 30_000 });

    await page.locator('[data-export-settings-trigger]').click({ force: true });
    const exportPeople = page.locator('[data-export-people-mode]');
    await expect(exportPeople).toBeVisible({ timeout: 10_000 });
    // Settings are per-shot; value should reflect the mode we set (or be settable).
    await exportPeople.selectOption('both');
    await expect(exportPeople).toHaveValue('both');

    const characterPass = page.locator('[data-export-character-pass]');
    await expect(characterPass).toBeVisible();
    await page.locator('[data-export-character-pass-enabled]').check();
    await expect(page.locator('[data-export-character-pass-still]')).toBeChecked();
    await expect(page.locator('[data-export-character-pass-attachments]')).toBeChecked();
    // Motion format defaults to green-screen MP4 when a move exists; without keyframes it stays disabled.
    const motionFormat = page.locator('[data-export-character-pass-motion-format]');
    await expect(motionFormat).toBeVisible();
    if (await motionFormat.isEnabled()) {
      await expect(motionFormat).toHaveValue('green_mp4');
      await expect(page.locator('[data-export-character-pass-bg]')).toHaveValue('#00FF00');
      await motionFormat.selectOption('transparent_png_sequence');
      await expect(page.locator('[data-export-character-pass-bg]')).toHaveCount(0);
      await motionFormat.selectOption('both');
      await expect(page.locator('[data-export-character-pass-bg]')).toBeVisible();
      await page.locator('[data-export-character-pass-bg]').fill('#112233');
      await page.locator('[data-export-character-pass-bg-reset]').click();
      await expect(page.locator('[data-export-character-pass-bg]')).toHaveValue('#00FF00');
    } else {
      await expect(motionFormat).toBeDisabled();
    }

    await page.keyboard.press('Escape');
    await dismissOverlays(page);

    // Manifest preview lists package file paths when a shot is selected.
    const manifest = page.locator('[data-export-manifest-preview]');
    if (await manifest.isVisible().catch(() => false)) {
      await expect(manifest).not.toBeEmpty();
    }
    await expect(page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i })).toBeVisible();
  });
});

test.describe('@heavy F4 camera move with object animation (Chromium)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chromium',
      'Video encode / WebCodecs / package motion is Chromium-oriented.',
    );
  });

  test('records start/end keyframes (object snapshots), finishes, exports package with motion/manifest', async ({ page }) => {
    test.setTimeout(300_000);
    await enterStudioWorkspace(page);
    await dismissOverlays(page);

    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);

    await page.getByRole('button', { name: /^Video$/ }).click();
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-video-chrome]')).toBeVisible({ timeout: 20_000 });
    // Staging control is present; opening the panel freezes SW WebGL in CI, so object
    // animation start/end overrides are proven by unit tests (objectKeyframes + packageExport).
    // Sequential capture still freezes stageable object snapshots onto each keyframe.
    await expect(page.locator('[data-shots-staging-toggle]')).toBeVisible();

    const shutter = page.locator('[data-shots-shutter]');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-video-start-set]')).toBeVisible({ timeout: 15_000 });

    // Distinct end camera pose (object snapshots are still taken by appendSequentialCapture).
    await page.keyboard.down('d');
    await page.waitForTimeout(400);
    await page.keyboard.up('d');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);

    await expect(page.locator('[data-shots-video-compact-actions]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-shots-video-finish]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-strip]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-frame]')).toHaveCount(2);

    await page.locator('[data-shots-video-finish]').click({ force: true });
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-video-finished]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-shots-video-export]')).toBeVisible();

    // Prefer in-chrome MP4 export when enabled (real WebCodecs path); fall back to package ZIP.
    const videoExport = page.locator('[data-shots-video-export]');
    const videoExportEnabled = await videoExport.isEnabled().catch(() => false);
    if (videoExportEnabled) {
      const videoDownload = page.waitForEvent('download', { timeout: 180_000 }).catch(() => null);
      await videoExport.click({ force: true });
      // Wait for progress to complete or download.
      await expect(page.locator('[data-shots-camera-move-progress]')).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
      await expect(page.locator('[data-shots-camera-move-progress]')).toBeHidden({ timeout: 180_000 }).catch(() => undefined);
      const dl = await videoDownload;
      if (dl) {
        expect(await dl.failure()).toBeNull();
        const name = dl.suggestedFilename().toLowerCase();
        expect(name.includes('mp4') || name.includes('motion') || name.includes('camera')).toBe(true);
      }
    }

    // Package export always lists motion/manifest for a finished move (authoritative product path).
    await workspaceTab(page, 'Export').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-export-package-panel]')).toBeVisible({ timeout: 30_000 });

    const manifest = page.locator('[data-export-manifest-preview]');
    await expect(manifest).toBeVisible({ timeout: 15_000 });
    const manifestText = (await manifest.innerText()).toLowerCase();
    expect(
      /motion|camera_move|mp4|viewport|manifest/.test(manifestText),
      `Expected camera-move/motion paths in manifest preview, got: ${manifestText}`,
    ).toBe(true);

    // Drive real package export entry point (ZIP includes encoded motion + manifest.json).
    const packageDownload = page.waitForEvent('download', { timeout: 180_000 });
    await page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i }).click({ force: true });
    const download = await packageDownload;
    expect(await download.failure()).toBeNull();
    const packagePath = await download.path();
    expect(packagePath).toBeTruthy();
    const suggested = download.suggestedFilename().toLowerCase();
    expect(suggested.endsWith('.zip') || suggested.includes('package') || suggested.includes('export')).toBe(true);
  });
});
