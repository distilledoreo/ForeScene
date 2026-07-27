import { expect, test, type Page } from '@playwright/test';

async function enterContinuityStage(page: Page) {
  // Skip splash video so it never blocks pointer events mid-test.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('panoref-splash-seen', '1');
    } catch {
      // ignore
    }
  });

  await page.goto('/');

  // Mode chooser appears when appMode is null after splash.
  const modeChooser = page.locator('[data-mode-chooser]');
  const continuity = page.getByRole('button', { name: /Build continuity packages/i });
  if (await modeChooser.isVisible().catch(() => false)) {
    await continuity.click();
  } else {
    // Wait briefly in case chooser is still mounting.
    try {
      await modeChooser.waitFor({ state: 'visible', timeout: 3000 });
      await continuity.click();
    } catch {
      // Already in a mode from a previous session (should not happen with clean context).
    }
  }

  // Ensure any residual splash is gone.
  const splash = page.getByRole('dialog', { name: 'Continuity Stage splash' });
  if (await splash.isVisible().catch(() => false)) {
    await splash.click({ force: true });
    await expect(splash).toBeHidden({ timeout: 5000 });
  }

  await expect(workspaceTab(page, 'Build')).toBeVisible({ timeout: 15000 });
  await expect(modeChooser).toBeHidden({ timeout: 5000 }).catch(() => undefined);
}

function workspaceTab(page: Page, label: 'Build' | 'Reference' | 'Shots' | 'Export') {
  // Mobile + desktop both render stage navs; only the visible one is interactive.
  return page
    .locator('header nav button')
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
    .locator('visible=true')
    .first();
}

async function dismissOverlays(page: Page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let dismissed = false;
    for (const label of ['Got it', 'Not right now', 'Start checking', 'Close']) {
      const button = page.getByRole('button', { name: label, exact: true });
      if (await button.isVisible().catch(() => false)) {
        await button.click({ force: true }).catch(() => undefined);
        dismissed = true;
        await page.waitForTimeout(200);
      }
    }
    // Fallback: close any open modal backdrop.
    const backdrop = page.getByRole('button', { name: 'Close dialog backdrop' });
    if (await backdrop.isVisible().catch(() => false)) {
      await backdrop.click({ force: true }).catch(() => undefined);
      dismissed = true;
      await page.waitForTimeout(200);
    }
    if (!dismissed) break;
  }
}

function multiNodeGltfBuffer() {
  const positions = Buffer.alloc(72);
  [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],
    [5, 0, 0], [6, 0, 0], [5, 1, 0],
  ].flat().forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const indices = Buffer.alloc(12);
  [0, 1, 2, 0, 1, 2].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const binary = Buffer.concat([positions, indices]);
  return Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${binary.toString('base64')}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 72 },
      { buffer: 0, byteOffset: 72, byteLength: 6 },
      { buffer: 0, byteOffset: 78, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3', min: [5, 0, 0], max: [6, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, indices: 2 }] },
      { primitives: [{ attributes: { POSITION: 1 }, indices: 3 }] },
    ],
    nodes: [
      { mesh: 0, name: 'LeftPanel' },
      { mesh: 1, name: 'RightPanel' },
    ],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
  }));
}

/**
 * Tag taxonomy (see CI workflows):
 * @smoke      — essential workflow / workspace mount (desktop + WebKit PR)
 * @responsive — layout, overflow, menus, drawers (tablet + phone PR)
 * @visual     — screenshot baselines
 * @heavy      — optimizer, projected, MP4, multi-import, video authoring (main/nightly)
 */
test.describe('@responsive layout and core chrome', () => {
  test('header actions stay in viewport', async ({ page }, testInfo) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);

    const brand = page.locator('[data-brand-menu-trigger]');
    const actions = page.locator('[data-header-actions]');
    await expect(brand).toBeVisible();
    await expect(actions).toBeVisible();

    const brandBox = await brand.boundingBox();
    const actionsBox = await actions.boundingBox();
    expect(brandBox).toBeTruthy();
    expect(actionsBox).toBeTruthy();
    if (!brandBox || !actionsBox) return;

    const viewport = page.viewportSize();
    expect(viewport).toBeTruthy();
    if (!viewport) return;

    expect(brandBox.x).toBeGreaterThanOrEqual(0);
    expect(brandBox.y).toBeGreaterThanOrEqual(0);
    expect(brandBox.x + brandBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(viewport.height);

    if (testInfo.project.name === 'phone-390') {
      const stageNav = page.getByRole('navigation', { name: 'Workspace stages' });
      await expect(stageNav).toBeVisible();
      const navBox = await stageNav.boundingBox();
      expect(navBox).toBeTruthy();
      if (navBox) {
        expect(navBox.y).toBeGreaterThanOrEqual(brandBox.y + brandBox.height - 4);
        expect(navBox.x + navBox.width).toBeLessThanOrEqual(viewport.width + 2);
      }
    } else {
      expect(actionsBox.x).toBeGreaterThan(viewport.width / 2);
      expect(viewport.width - (actionsBox.x + actionsBox.width)).toBeLessThanOrEqual(32);
    }
  });

  test('build tray is reachable without overflowing off-screen', async ({ page }, testInfo) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    const tray = page.locator('[data-build-object-tray]');
    await expect(tray).toBeVisible({ timeout: 15000 });
    const trayBox = await tray.boundingBox();
    expect(trayBox).toBeTruthy();
    if (!trayBox) return;

    const viewport = page.viewportSize();
    if (!viewport) return;
    expect(trayBox.x).toBeGreaterThanOrEqual(-2);
    expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(viewport.height + 2);
    expect(trayBox.x + Math.min(trayBox.width, 40)).toBeLessThanOrEqual(viewport.width + 2);

    const floatingControls = await Promise.all([
      page.locator('[data-build-free-camera-control]').boundingBox(),
      page.locator('[data-build-top-tools]').boundingBox(),
      page.locator('[data-appearance-mode-toggle]').boundingBox(),
    ]);
    expect(floatingControls.every(Boolean)).toBe(true);
    const overlapArea = (a: NonNullable<typeof floatingControls[number]>, b: NonNullable<typeof floatingControls[number]>) => (
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
    );
    const [freeCamera, topTools, appearance] = floatingControls;
    if (freeCamera && topTools && appearance) {
      expect(overlapArea(freeCamera, topTools)).toBeLessThanOrEqual(1);
      expect(overlapArea(freeCamera, appearance)).toBeLessThanOrEqual(1);
      expect(overlapArea(topTools, appearance)).toBeLessThanOrEqual(1);
    }

    if (testInfo.project.name === 'phone-390') {
      // Shortcut badges make accessible names like "3 Box".
      const boxTool = tray.getByRole('button', { name: /Box/i }).first();
      await expect(boxTool).toBeVisible();
      const box = await boxTool.boundingBox();
      expect(box).toBeTruthy();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(-2);
        expect(box.y).toBeGreaterThanOrEqual(0);
      }
    } else if (testInfo.project.name === 'desktop-chromium') {
      // Desktop should keep the tray content-sized instead of spanning the full viewport.
      expect(trayBox.width).toBeLessThan(viewport.width * 0.8);
    } else {
      // Tablet/touch: reachable and fully on-screen, not a desktop width ratio.
      expect(trayBox.x).toBeGreaterThanOrEqual(-2);
      expect(trayBox.x + trayBox.width).toBeLessThanOrEqual(viewport.width + 2);
    }
  });

});

test.describe('@smoke build interactions', () => {
  test('Build editor shortcuts expose multi-selection and clipboard feedback', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    await page.keyboard.press('ControlOrMeta+A');
    await expect(page.locator('[data-build-selection-count]')).toContainText(/objects selected/);
    await page.keyboard.press('ControlOrMeta+C');
    await expect(page.locator('[data-build-command-status]')).toContainText(/Copied/);
    await page.keyboard.press('ControlOrMeta+V');
    await expect(page.locator('[data-build-command-status]')).toContainText(/Pasted/);
    await page.keyboard.type('?');
    await expect(page.locator('[data-build-shortcut-reference]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-build-selection-count]')).toHaveCount(0);
  });

  test('imports a texture-free OBJ through the Build tray', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
    await page.locator('[data-build-import-model]').click();
    const dialog = page.getByRole('dialog', { name: /Import 3D/ });
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-model-import-input]').setInputFiles({
      name: 'triangle.obj',
      mimeType: 'text/plain',
      buffer: Buffer.from([
        'v 0 0 0',
        'v 1 0 0',
        'v 0 1 0',
        'f 1 2 3',
      ].join('\n')),
    });

    await expect(dialog.getByText(/Imported 1 selectable object/)).toBeVisible();
    await dialog.getByText('Close', { exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Selected object name' })).toHaveValue('triangle');
  });

  test('Help documentation is searchable and returns to the active workspace', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    await page.getByRole('button', { name: 'Open app menu' }).click();
    await page.getByRole('menuitem', { name: 'Help & Documentation' }).click();
    await expect(page.locator('[data-help-workspace]')).toBeVisible();
    await expect(page.locator('img[src="/docs/build-workspace.png"]')).toHaveCount(1);
    await expect(page.locator('img[src="/docs/workflow-overview.png"]')).toHaveCount(1);

    const search = page.getByRole('searchbox', { name: 'Search documentation' });
    await search.fill('clipboard');
    await expect(page.locator('[data-help-section="shortcuts"]')).toBeVisible();
    await expect(page.locator('[data-help-section="welcome"]')).toHaveCount(0);
    await search.fill('');

    await page.getByRole('button', { name: 'Back to the app' }).click();
    await expect(page.locator('[data-build-object-tray]')).toBeVisible();
  });
});

test.describe('@heavy model import variants', () => {
  test('imports separate multi-node scenes with one report card per source file', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
    await page.locator('[data-build-import-model]').click();
    const dialog = page.getByRole('dialog', { name: /Import 3D/ });
    await dialog.locator('[data-model-import-input]').setInputFiles({
      name: 'two-panels.gltf',
      mimeType: 'model/gltf+json',
      buffer: multiNodeGltfBuffer(),
    });

    await expect(dialog.getByText(/Imported 2 selectable objects/)).toBeVisible();
    await expect(dialog.locator('[data-model-import-report-item="success"]')).toHaveCount(1);
  });

  test('imports the same multi-node scene in combined mode', async ({ page }) => {
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
    await page.locator('[data-build-import-model]').click();
    const dialog = page.getByRole('dialog', { name: /Import 3D/ });
    await dialog.locator('[data-import-mode="combined"]').check();
    await dialog.locator('[data-model-import-input]').setInputFiles({
      name: 'two-panels.gltf',
      mimeType: 'model/gltf+json',
      buffer: multiNodeGltfBuffer(),
    });

    await expect(dialog.getByText(/Imported 1 combined object from 2 mesh nodes/)).toBeVisible();
    await expect(dialog.locator('[data-model-import-report-item="success"]')).toHaveCount(1);
  });
});

test.describe('@smoke workflow path', () => {
  test('build graybox, approve reference, open shots and export', async ({ page }) => {
    test.setTimeout(180_000);
    await enterContinuityStage(page);
    await dismissOverlays(page);

    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    const renderBtn = page.getByRole('button', { name: /Render 360 Reference/i });
    if (await renderBtn.isVisible().catch(() => false)) {
      await renderBtn.click();
      await expect(
        page.getByRole('button', { name: /Download Graybox|Re-render after scene changes/i }).first(),
      ).toBeVisible({ timeout: 90_000 });
    }

    await dismissOverlays(page);
    const continueRef = page.getByRole('button', { name: /Continue to Reference/i });
    if (await continueRef.isVisible().catch(() => false)) {
      await continueRef.click();
    } else {
      await workspaceTab(page, 'Reference').click();
    }
    await dismissOverlays(page);

    const useAttached = page.getByRole('button', { name: /Use Attached Reference/i });
    if (await useAttached.isVisible().catch(() => false)) {
      await useAttached.click();
      await dismissOverlays(page);
    }

    const looksGood = page.getByRole('button', { name: /Looks good enough/i });
    if (await looksGood.isVisible().catch(() => false)) {
      await looksGood.click();
    }

    await dismissOverlays(page);

    const approve = page.getByRole('button', { name: /Approve as Reference/i });
    await expect(approve).toBeVisible({ timeout: 30_000 });
    await approve.click({ force: true });

    const dialogs = page.locator('[role="dialog"][aria-modal="true"]');
    await expect.poll(() => dialogs.count()).toBeLessThanOrEqual(1);
    await dismissOverlays(page);

    const continueShots = page.getByRole('button', { name: /Continue to Shots/i });
    if (await continueShots.isVisible().catch(() => false)) {
      await continueShots.click();
    } else {
      await workspaceTab(page, 'Shots').click();
    }
    await dismissOverlays(page);

    await expect(page.locator('[data-shots-camera-shell]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-shots-shutter]')).toBeVisible();

    await workspaceTab(page, 'Export').click();
    await dismissOverlays(page);
    await expect(page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i })).toBeVisible();
  });

  test('repeated still captures create distinct persisted shot thumbnails', async ({ page }) => {
    test.setTimeout(120_000);
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Shots').click();
    await dismissOverlays(page);

    const shutter = page.locator('[data-shots-shutter]');
    await expect(shutter).toBeVisible({ timeout: 20_000 });
    await shutter.click();
    // The capture flash is intentionally transient and can be covered immediately by
    // workflow guidance. The persisted cards below are the authoritative capture signal.
    await dismissOverlays(page);
    await page.keyboard.down('d');
    await page.waitForTimeout(500);
    await page.keyboard.up('d');
    await shutter.click();

    await page.locator('[data-shots-library-thumb]').click();
    const cards = page.locator('[data-shots-library-card]');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    await expect(cards.locator('img')).toHaveCount(2, { timeout: 30_000 });
    const thumbnailSources = await cards.locator('img').evaluateAll((images) => images.map((image) => image.getAttribute('src')));

    expect(thumbnailSources).toHaveLength(2);
    // Durable project assets resolve as blob: URLs; legacy fixtures may still use data:image.
    for (const source of thumbnailSources) {
      expect(source).toMatch(/^(blob:|data:image\/)/);
    }
    expect(thumbnailSources[0]).not.toBe(thumbnailSources[1]);
  });
});

test.describe('@heavy video authoring', () => {
  test('video progressive capture finishes two poses then next shot', async ({ page }) => {
    test.setTimeout(120_000);
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Shots').click();
    await dismissOverlays(page);

    await page.getByRole('button', { name: /^Video$/ }).click();
    await dismissOverlays(page);

    await expect(page.locator('[data-shots-video-chrome]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-camera-keyframe-strip]')).toHaveCount(0);

    const shutter = page.locator('[data-shots-shutter]');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-video-start-set]')).toBeVisible({ timeout: 10_000 });

    await page.keyboard.down('d');
    await page.waitForTimeout(400);
    await page.keyboard.up('d');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);

    // Second pose stays capturing with Finish + Capture next (no auto-finish).
    await expect(page.locator('[data-shots-video-compact-actions]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-shots-video-finish]')).toBeVisible();
    await expect(page.locator('[data-shots-video-capture-next]')).toBeVisible();
    await expect(page.locator('[data-camera-keyframe-strip]')).toHaveCount(0);
    // Move preview filmstrip appears once a path exists.
    await expect(page.locator('[data-camera-move-preview-strip]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-play]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-frame]')).toHaveCount(2);

    await page.locator('[data-shots-video-finish]').click({ force: true });
    await dismissOverlays(page);

    await expect(page.locator('[data-shots-video-finished]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-shots-video-next-shot]')).toBeVisible();
    await expect(page.locator('[data-camera-move-preview-play]')).toBeVisible();
    await expect(page.locator('[data-shots-video-export]')).toBeVisible();
    await expect(shutter).toBeEnabled();
    await expect(shutter).toHaveAttribute('data-shots-video-shutter-next', 'true');

    await dismissOverlays(page);
    await page.locator('[data-shots-video-next-shot]').click({ force: true });
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-video-finished]')).toHaveCount(0);
    await expect(page.locator('[data-shots-video-empty-hint]')).toBeVisible({ timeout: 10_000 });
  });

  test('video finish then undo resyncs capture state to start-only', async ({ page }) => {
    test.setTimeout(120_000);
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Shots').click();
    await dismissOverlays(page);

    await page.getByRole('button', { name: /^Video$/ }).click();
    await dismissOverlays(page);

    const shutter = page.locator('[data-shots-shutter]');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-video-start-set]')).toBeVisible({ timeout: 10_000 });

    await page.keyboard.down('d');
    await page.waitForTimeout(400);
    await page.keyboard.up('d');
    await dismissOverlays(page);
    await shutter.click({ force: true });
    await dismissOverlays(page);

    await expect(page.locator('[data-shots-video-compact-actions]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-shots-video-finish]').click({ force: true });
    await dismissOverlays(page);

    // Finished: Next shot shutter semantics.
    await expect(page.locator('[data-shots-video-finished]')).toBeVisible({ timeout: 10_000 });
    await expect(shutter).toHaveAttribute('data-shots-video-shutter-next', 'true');
    await expect(shutter).toHaveAttribute('data-shots-video-capture-state', 'finished');

    // Undo must restore Start-only keyframes AND resync React authoring state.
    await page.locator('body').click({ position: { x: 8, y: 8 } });
    await page.keyboard.press('ControlOrMeta+Z');
    await dismissOverlays(page);

    await expect(page.locator('[data-shots-video-finished]')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('[data-shots-video-compact-actions]')).toHaveCount(0);
    await expect(page.locator('[data-shots-video-start-set]')).toBeVisible({ timeout: 10_000 });
    await expect(shutter).toHaveAttribute('data-shots-video-capture-state', 'capturing');
    await expect(shutter).not.toHaveAttribute('data-shots-video-shutter-next', 'true');
    await expect(shutter).toBeEnabled();
    // Shutter is Capture next again — not Next shot.
    await expect(shutter).toHaveAttribute('aria-label', /Capture next/i);
  });

  test('video timeline opens on third pose, finish, continue, and next shot', async ({ page }) => {
    test.setTimeout(120_000);
    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Shots').click();
    await dismissOverlays(page);

    await page.getByRole('button', { name: /^Video$/ }).click();
    await dismissOverlays(page);

    const shutter = page.locator('[data-shots-shutter]');
    const capturePose = async () => {
      await dismissOverlays(page);
      await shutter.click({ force: true });
      await dismissOverlays(page);
    };

    await capturePose();
    await page.keyboard.down('d');
    await page.waitForTimeout(350);
    await page.keyboard.up('d');
    await capturePose();
    await expect(page.locator('[data-shots-video-compact-actions]')).toBeVisible({ timeout: 10_000 });

    await page.keyboard.down('d');
    await page.waitForTimeout(350);
    await page.keyboard.up('d');
    await capturePose();

    const strip = page.locator('[data-camera-keyframe-strip]');
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-camera-keyframe-node]')).toHaveCount(3, { timeout: 10_000 });
    await expect(page.locator('[data-camera-keyframe-finish]')).toBeVisible();

    await dismissOverlays(page);
    await page.locator('[data-camera-keyframe-finish]').click({ force: true });
    await expect(strip).toHaveAttribute('data-camera-keyframe-capture-state', 'finished');
    await expect(page.locator('[data-shots-video-next-shot]')).toBeVisible();
    await expect(page.locator('[data-shots-video-export]')).toBeVisible();
    await expect(page.locator('[data-camera-keyframe-continue]')).toBeVisible();
    await expect(shutter).toBeEnabled();

    await dismissOverlays(page);
    await page.locator('[data-camera-keyframe-continue]').click({ force: true });
    await expect(strip).toHaveAttribute('data-camera-keyframe-capture-state', 'capturing');
    await page.keyboard.down('a');
    await page.waitForTimeout(350);
    await page.keyboard.up('a');
    await capturePose();
    await expect(page.locator('[data-camera-keyframe-node]')).toHaveCount(4, { timeout: 10_000 });
  });
});

test.describe('@heavy projected optimizer and second capture', () => {
  test('projected occlusion unmounts cleanly into Export without a crash', async ({ page }) => {
    test.setTimeout(180_000);

    // Any uncaught error, window error, or rejected promise fails the test.
    const pageErrors: string[] = [];
    const unhandledRejections: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /Uncaught|Cannot read propert|is not a function/.test(message.text())) {
        pageErrors.push(message.text());
      }
    });
    await page.exposeFunction('__reportRejection', (reason: string) => {
      unhandledRejections.push(reason);
    });
    await page.addInitScript(() => {
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
        // Segment / Bugsnag tracking-prevention noise is ignored.
        if (/prevented|tracking|ad blocker|blocked by/i.test(reason)) return;
        (window as unknown as { __reportRejection?: (r: string) => void }).__reportRejection?.(reason);
      });
    });

    await enterContinuityStage(page);
    await dismissOverlays(page);

    // Build → graybox so a reference set exists.
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);
    const renderBtn = page.getByRole('button', { name: /Render 360 Reference/i });
    if (await renderBtn.isVisible().catch(() => false)) {
      await renderBtn.click();
      await expect(
        page.getByRole('button', { name: /Download Graybox|Re-render after scene changes/i }).first(),
      ).toBeVisible({ timeout: 90_000 });
    }
    await dismissOverlays(page);

    // Reference → attach a styled canonical pano (enables projected appearance + occlusion).
    await workspaceTab(page, 'Reference').click();
    await dismissOverlays(page);
    const useAttached = page.getByRole('button', { name: /Use Attached Reference/i });
    if (await useAttached.isVisible().catch(() => false)) {
      await useAttached.click();
      await dismissOverlays(page);
    }
    const looksGood = page.getByRole('button', { name: /Looks good enough/i });
    if (await looksGood.isVisible().catch(() => false)) {
      await looksGood.click();
    }
    const approve = page.getByRole('button', { name: /Approve as Reference/i });
    await expect(approve).toBeVisible({ timeout: 30_000 });
    await approve.click({ force: true });
    await dismissOverlays(page);

    // Shots → enable Projected appearance so the occlusion engine builds GPU maps.
    await workspaceTab(page, 'Shots').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-camera-shell]')).toBeVisible({ timeout: 20_000 });

    const projectedToggle = page
      .locator('[data-appearance-mode-toggle] button')
      .filter({ hasText: /^Projected$/ });
    await expect(projectedToggle).toBeEnabled({ timeout: 30_000 });
    await projectedToggle.click();

    // Wait specifically for occlusion to reach the GPU-backed "Ready" state.
    const sceneViewport = page.locator('[data-testid="scene-viewport"]');
    await expect(sceneViewport).toHaveAttribute('data-occlusion-status', 'ready', { timeout: 60_000 });

    // Persist a projected shot so Export exercises the off-screen projected
    // renderer and its occlusion render-target cleanup as well as the live view.
    await page.locator('[data-shots-shutter]').click();
    await expect(page.locator('[data-shots-library-thumb] img')).toBeVisible({ timeout: 30_000 });
    await dismissOverlays(page);

    // Navigate to Export. The renderer cleanup must dispose render targets
    // before the renderer; an inverted order throws and blocks this transition.
    await workspaceTab(page, 'Export').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-export-package-panel]')).toBeVisible({ timeout: 30_000 });

    // Package generation creates a second projected renderer. It must follow
    // the same cleanup ordering or the download fails with a Three.js error.
    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i }).click();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    const failureDetail = [
      ...pageErrors.map((message) => `pageerror: ${message}`),
      ...unhandledRejections.map((message) => `unhandledrejection: ${message}`),
    ];
    expect(failureDetail, failureDetail.join('\n')).toHaveLength(0);
  });

  test('coverage optimizer completes without overflowing the Reference drawer', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await enterContinuityStage(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);
    const renderBtn = page.getByRole('button', { name: /Render 360 Reference/i });
    if (await renderBtn.isVisible().catch(() => false)) {
      await renderBtn.click();
      await expect(
        page.getByRole('button', { name: /Download Graybox|Re-render after scene changes/i }).first(),
      ).toBeVisible({ timeout: 90_000 });
    }
    await dismissOverlays(page);

    await workspaceTab(page, 'Reference').click();
    await dismissOverlays(page);
    const useAttached = page.getByRole('button', { name: /Use Attached Reference/i });
    if (await useAttached.isVisible().catch(() => false)) {
      await useAttached.click();
      const startChecking = page.getByRole('button', { name: 'Start checking', exact: true });
      await startChecking.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      if (await startChecking.isVisible().catch(() => false)) await startChecking.click();
      await dismissOverlays(page);
    }
    await page.getByRole('button', { name: /Reference settings|Settings/i }).click();
    const drawer = page.getByRole('dialog', { name: 'Reference Settings' });
    await expect(drawer).toBeVisible();
    await page.locator('[data-coverage-optimizer] summary').click();

    const floorRegionToggle = drawer.getByRole('switch', {
      name: 'Restrict optimizer to an analysis region',
    });
    await floorRegionToggle.click();
    await expect(drawer.locator('[data-coverage-floor-region]')).toBeVisible();
    await expect(drawer.locator('[data-coverage-use-selection-bounds]')).toBeVisible();
    await drawer.locator('[data-coverage-floor-min="y"]').fill('1');
    await drawer.locator('[data-coverage-floor-max="y"]').fill('0');
    await expect(drawer.locator('[data-coverage-floor-region-error]')).toBeVisible();
    await expect(drawer.locator('[data-coverage-analyze]')).toBeDisabled();
    await drawer.locator('[data-coverage-floor-min="y"]').fill('-0.25');
    await drawer.locator('[data-coverage-floor-max="y"]').fill('3.5');
    await expect(drawer.locator('[data-coverage-analyze]')).toBeEnabled();

    const layout = await drawer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

    await page.locator('[data-coverage-analyze]').click();
    await expect(floorRegionToggle).toBeDisabled();
    await expect(drawer.locator('[data-coverage-floor-min="x"]')).toBeDisabled();
    await expect(drawer.locator('[data-coverage-floor-max="z"]')).toBeDisabled();
    const result = page.locator('[data-coverage-result]');
    await expect(result).toBeVisible({ timeout: 90_000 });
    await expect(floorRegionToggle).toBeEnabled();
    await expect(result).toContainText('24,576 fine samples');
    const originB = (await result.getAttribute('data-coverage-origin-b'))
      ?.split(',').map((value) => Number(value));
    expect(originB).toHaveLength(3);
    expect(originB?.every(Number.isFinite)).toBe(true);
    // The default set has an authored ground floor; props/rooftops must not
    // become candidate platforms.
    expect(originB?.[1]).toBeLessThan(2.5);
    await expect(page.locator('[data-coverage-capture-plan]')).toContainText('Existing panorama origins are never rewritten');
    await expect(page.locator('[data-coverage-apply-pair]')).toHaveCount(0);

    await drawer.locator('[data-coverage-floor-min="x"]').fill('-4');
    await expect(result).toHaveCount(0);
    await expect(page.locator('[data-coverage-apply-capture]')).toHaveCount(0);

    if (testInfo.project.name === 'desktop-chromium') {
      await page.locator('[data-coverage-mode]').selectOption('joint-pair');
      await page.locator('[data-coverage-analyze]').click();
      await expect(result).toBeVisible({ timeout: 120_000 });
      const originA = (await result.getAttribute('data-coverage-origin-a'))
        ?.split(',').map((value) => Number(value));
      const jointOriginB = (await result.getAttribute('data-coverage-origin-b'))
        ?.split(',').map((value) => Number(value));
      expect(originA?.every(Number.isFinite)).toBe(true);
      expect(jointOriginB?.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(
        (originA?.[0] ?? 0) - (jointOriginB?.[0] ?? 0),
        (originA?.[1] ?? 0) - (jointOriginB?.[1] ?? 0),
        (originA?.[2] ?? 0) - (jointOriginB?.[2] ?? 0),
      )).toBeGreaterThan(1);
      await expect(page.locator('[data-coverage-apply-capture-a]')).toBeVisible();
    }
    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
  });

  test('second capture: suggest B, freeze pose through undo, keep grayboxes, reopen, and export', async ({ page }) => {
    test.setTimeout(360_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await enterContinuityStage(page);
    await dismissOverlays(page);

    // --- Primary A: graybox + styled reference ---
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);
    const renderBtn = page.getByRole('button', { name: /Render 360 Reference/i });
    await expect(renderBtn).toBeVisible({ timeout: 20_000 });
    await renderBtn.click();
    await expect(
      page.getByRole('button', { name: /Download Graybox|Re-render after scene changes/i }).first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-graybox-count]')).toHaveAttribute('data-graybox-count', '1', { timeout: 10_000 });
    await dismissOverlays(page);

    await workspaceTab(page, 'Reference').click();
    await dismissOverlays(page);
    const useAttached = page.getByRole('button', { name: /Use Attached Reference/i });
    await expect(useAttached).toBeVisible({ timeout: 20_000 });
    await useAttached.click();
    await dismissOverlays(page);
    const looksGood = page.getByRole('button', { name: /Looks good enough/i });
    if (await looksGood.isVisible().catch(() => false)) {
      await looksGood.click();
    }
    await dismissOverlays(page);
    const approve = page.getByRole('button', { name: /Approve as Reference/i });
    await expect(approve).toBeVisible({ timeout: 30_000 });
    await approve.click({ force: true });
    await dismissOverlays(page);

    // --- Suggest B via fill-gaps fork (advance modal or Reference panel) ---
    const fillGapsInModal = page.locator('[data-second-capture-fork] [data-second-capture-fill-gaps]');
    const openFillGaps = page.locator('[data-open-fill-gaps]');
    if (await fillGapsInModal.isVisible().catch(() => false)) {
      await fillGapsInModal.click();
    } else if (await openFillGaps.isVisible().catch(() => false)) {
      await openFillGaps.click();
      await page.locator('[data-second-capture-fill-gaps]').click();
    } else {
      // Advance modal may still be opening; wait briefly then fall back to Fill gaps control.
      await page.locator('[data-second-capture-fork]').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      if (await fillGapsInModal.isVisible().catch(() => false)) {
        await fillGapsInModal.click();
      } else {
        await page.getByRole('button', { name: /Reference settings|Settings/i }).click().catch(() => undefined);
        await openFillGaps.click();
        await page.locator('[data-second-capture-fill-gaps]').click();
      }
    }

    await page.locator('[data-second-capture-suggest]').click();
    const awaiting = page.locator('[data-second-capture-seed-status]');
    await expect(awaiting).toBeVisible({ timeout: 180_000 });
    await expect(awaiting).toHaveAttribute('data-second-capture-optimization', 'succeeded');
    await expect(awaiting).toHaveAttribute('data-second-capture-projected', 'ready');
    // Download may succeed or fail; never claim success when it failed.
    const seedStatus = await awaiting.getAttribute('data-second-capture-seed-status');
    expect(seedStatus === 'succeeded' || seedStatus === 'failed').toBe(true);
    if (seedStatus === 'failed') {
      await expect(page.locator('[data-second-capture-download-seed-again]')).toBeVisible();
      await expect(awaiting).toContainText(/download failed/i);
    } else {
      await expect(awaiting).toContainText(/seed was downloaded/i);
    }

    const planOriginAttr = await awaiting.getAttribute('data-second-capture-plan-origin');
    expect(planOriginAttr).toBeTruthy();
    const planOrigin = planOriginAttr!.split(',').map(Number);
    expect(planOrigin).toHaveLength(3);
    expect(planOrigin.every(Number.isFinite)).toBe(true);

    // Dismiss fork (plan must remain latched) and render graybox at B.
    const dismissFork = page.locator('[data-second-capture-dismiss]');
    if (await dismissFork.isVisible().catch(() => false)) {
      await dismissFork.click();
    }
    await dismissOverlays(page);

    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);
    const reRender = page.getByRole('button', { name: /Re-render after scene changes|Render 360 Reference/i }).first();
    await expect(reRender).toBeVisible({ timeout: 20_000 });
    await reRender.click();
    await expect(page.locator('[data-graybox-count]')).toHaveAttribute('data-graybox-count', '2', { timeout: 90_000 });

    // Move/undo live origin away from frozen B.
    const undo = page.locator('[data-build-undo]');
    await expect(undo).toBeEnabled({ timeout: 10_000 });
    await undo.click();
    await dismissOverlays(page);
    // Grayboxes A and B must both remain after undoing the live origin.
    await expect(page.locator('[data-graybox-count]')).toHaveAttribute('data-graybox-count', '2');

    // Import secondary while live origin is no longer at B.
    await workspaceTab(page, 'Reference').click();
    await dismissOverlays(page);
    const attachedResponse = await page.request.get('/attached-canonical-reference.png');
    expect(attachedResponse.ok()).toBe(true);
    const attachedBytes = await attachedResponse.body();
    const importInput = page.locator('input[type="file"][accept*="image"]').first();
    await importInput.setInputFiles({
      name: 'second-capture.png',
      mimeType: 'image/png',
      buffer: Buffer.from(attachedBytes),
    });
    await expect(page.locator('[data-reference-pano-origins]')).toHaveAttribute('data-styled-pano-count', '2', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-reference-pano-origins]')).toHaveAttribute('data-graybox-count', '2');

    const secondaryOption = page.locator('[data-reference-pano-option]').nth(1);
    await expect(secondaryOption).toBeVisible();
    const secondaryOriginAttr = await secondaryOption.getAttribute('data-pano-origin');
    expect(secondaryOriginAttr).toBeTruthy();
    const secondaryOrigin = secondaryOriginAttr!.split(',').map(Number);
    expect(secondaryOrigin).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      expect(Math.abs(secondaryOrigin[i]! - planOrigin[i]!)).toBeLessThan(0.05);
    }

    // --- Save and reopen ---
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('[data-project-export-button]').click();
    const projectDownload = await downloadPromise;
    expect(await projectDownload.failure()).toBeNull();
    const projectPath = await projectDownload.path();
    expect(projectPath).toBeTruthy();

    await page.locator('[data-project-import-input]').setInputFiles(projectPath!);
    await dismissOverlays(page);
    await workspaceTab(page, 'Reference').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-reference-pano-origins]')).toHaveAttribute('data-styled-pano-count', '2', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-reference-pano-origins]')).toHaveAttribute('data-graybox-count', '2');

    // Enable dual projection blend.
    await page.getByRole('button', { name: /Reference settings|Settings/i }).click();
    const drawer = page.getByRole('dialog', { name: 'Reference Settings' });
    await expect(drawer).toBeVisible();
    const blendToggle = drawer.locator('[data-projected-blend-toggle] button, [data-projected-blend-toggle] [role="switch"]').first();
    if (await blendToggle.isVisible().catch(() => false)) {
      await blendToggle.click();
    }
    await page.keyboard.press('Escape');
    await dismissOverlays(page);

    // Capture projected shot and export.
    await workspaceTab(page, 'Shots').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-shots-camera-shell]')).toBeVisible({ timeout: 20_000 });
    const projectedToggle = page
      .locator('[data-appearance-mode-toggle] button')
      .filter({ hasText: /^Projected$/ });
    if (await projectedToggle.isEnabled().catch(() => false)) {
      await projectedToggle.click();
    }
    await page.locator('[data-shots-shutter]').click();
    await expect(page.locator('[data-shots-library-thumb] img')).toBeVisible({ timeout: 60_000 });
    await dismissOverlays(page);

    await workspaceTab(page, 'Export').click();
    await dismissOverlays(page);
    await expect(page.locator('[data-export-package-panel]')).toBeVisible({ timeout: 30_000 });
    const zipDownloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: /Export Selected Shots|Export \d+ Shots/i }).click();
    const zipDownload = await zipDownloadPromise;
    expect(await zipDownload.failure()).toBeNull();
    expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/);

    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
  });
});
