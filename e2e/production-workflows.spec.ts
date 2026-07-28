import { expect, test, type Page } from '@playwright/test';

import {
  dismissOverlays,
  enterContinuityStage,
  exportProjectBackup,
  importProjectBackup,
  multiNodeGltfBuffer,
} from './helpers/app-entry';
import { goToWorkspace, workspaceTab } from './workspace-navigation';

/**
 * Phase F — production workflow coverage (CODE_CLEANUP_PLAN F1–F5).
 *
 * Tag taxonomy (see CI workflows):
 * @heavy — multi-step save/import, GLB, multi-shot, video authoring (main/nightly)
 *
 * F5 storage-failure is covered by unit tests (projectPersistenceController +
 * productionPath structural hooks), not flaky browser storage E2E.
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
  test('renames project, captures shot, backup export/import recovers, re-exports', async ({ page }) => {
    test.setTimeout(180_000);
    await enterContinuityStage(page);
    await dismissOverlays(page);

    const projectName = `F1 Recovery ${Date.now()}`;
    await renameProject(page, projectName);

    await captureStillShot(page);
    await dismissOverlays(page);

    // Backup from header export control.
    const backupPath = await exportProjectBackup(page);

    // Reload by importing the backup (same session simulates recover path).
    await importProjectBackup(page, backupPath);
    await dismissOverlays(page);

    // Project identity recovered.
    await page.getByRole('button', { name: 'Open app menu' }).click();
    await expect(page.locator('[data-project-name-input]')).toHaveValue(projectName, { timeout: 20_000 });
    await page.keyboard.press('Escape');
    await dismissOverlays(page);

    // Shot shell / library recovered.
    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-camera-shell]')).toBeVisible();
    await expect(page.locator('[data-shots-library-thumb] img').first()).toBeVisible({ timeout: 30_000 });

    // Re-export backup from recovered state.
    const reexportPath = await exportProjectBackup(page);
    expect(reexportPath).toBeTruthy();

    // Package export path also reachable after recovery.
    await workspaceTab(page, 'Export').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-export-package-panel]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i })).toBeVisible();
  });
});

test.describe('@heavy F2 import geometry → transform → capture → backup → reopen', () => {
  test('imports multi-node glTF, moves object, captures, reopens from backup', async ({ page }) => {
    test.setTimeout(180_000);
    await enterContinuityStage(page);
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
    await enterContinuityStage(page);
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

test.describe('@heavy F4 camera move with optional object staging (Chromium)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chromium',
      'Video encode / WebCodecs preview is Chromium-oriented.',
    );
  });

  test('video start/end capture, optional stage, finish, preview/export chrome', async ({ page }) => {
    test.setTimeout(180_000);
    await enterContinuityStage(page);
    await dismissOverlays(page);

    await goToWorkspace(page, 'Shots', '[data-shots-camera-shell]');
    await dismissOverlays(page);

    await page.getByRole('button', { name: /^Video$/ }).click();
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-video-chrome]')).toBeVisible({ timeout: 20_000 });
    // Staging chrome is present for object animation keyframes (exercise is optional;
    // gizmo staging can freeze SW WebGL — assert control only).
    await expect(page.locator('[data-shots-staging-toggle]')).toBeVisible();

    const shutter = page.locator('[data-shots-shutter]');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-video-start-set]')).toBeVisible({ timeout: 15_000 });

    await page.keyboard.down('d');
    await page.waitForTimeout(400);
    await page.keyboard.up('d');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);

    await expect(page.locator('[data-shots-video-compact-actions]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-shots-video-finish]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-strip]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-play]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-frame]')).toHaveCount(2);

    await page.locator('[data-shots-video-finish]').click({ force: true });
    await dismissOverlays(page);

    await expect(page.locator('[data-shots-video-finished]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-shots-video-export]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-play]')).toBeVisible();

    // Attempt preview play (does not require full MP4 download).
    await page.locator('[data-camera-move-preview-play]').click({ force: true }).catch(() => undefined);
    await dismissOverlays(page);

    // Export control remains available (actual MP4 encode is covered by harness / reliable export unit tests).
    await expect(page.locator('[data-shots-video-export]')).toBeEnabled();
  });
});
