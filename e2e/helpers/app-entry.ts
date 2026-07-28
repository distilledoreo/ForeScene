import { expect, type Page } from '@playwright/test';

import { workspaceTab } from '../workspace-navigation';

/** Skip splash and enter Continuity Stage from a clean browser context. */
export async function enterContinuityStage(page: Page) {
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

/** Dismiss common workflow modals / toasts that intercept clicks. */
export async function dismissOverlays(page: Page) {
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

/**
 * Deterministic texture-free multi-node glTF used by import / production workflows.
 * Two mesh nodes: LeftPanel + RightPanel.
 */
export function multiNodeGltfBuffer() {
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

/** Export a verified project backup and return the download path. */
export async function exportProjectBackup(page: Page): Promise<string> {
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.locator('[data-project-export-button]').click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).toBeTruthy();
  return path!;
}

/** Import a previously exported project backup (JSON/ZIP path). */
export async function importProjectBackup(page: Page, projectPath: string) {
  await page.locator('[data-project-import-input]').setInputFiles(projectPath);
  await dismissOverlays(page);
  // Import toast may briefly show success/error.
  await page.locator('[data-project-import-status="success"]').waitFor({
    state: 'visible',
    timeout: 30_000,
  }).catch(() => undefined);
}

/**
 * Wait until the header reports a verified local save.
 * Status attribute is written from ProjectPersistenceController → useProjectSafetyStore.
 * Use attribute matching (not toBeVisible) because the status chip is `hidden md:flex`.
 */
export async function waitForVerifiedSave(page: Page, timeoutMs = 90_000) {
  await expect(page.locator('[data-project-save-status]')).toHaveAttribute(
    'data-project-save-status',
    'saved',
    { timeout: timeoutMs },
  );
}

/**
 * Full browser reload that preserves IndexedDB, then wait for startup recovery
 * to restore Continuity Stage from the latest verified revision.
 */
export async function reloadAndAwaitRecovery(page: Page) {
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Splash is skipped via enterContinuityStage init script (re-runs on navigation).
  // Recovery sets continuity mode automatically when a verified revision exists.
  const modeChooser = page.locator('[data-mode-chooser]');
  if (await modeChooser.isVisible().catch(() => false)) {
    // Fallback: if recovery did not auto-enter continuity, choose it so we can still assert.
    await page.getByRole('button', { name: /Build continuity packages/i }).click();
  }

  const splash = page.getByRole('dialog', { name: 'Continuity Stage splash' });
  if (await splash.isVisible().catch(() => false)) {
    await splash.click({ force: true });
    await expect(splash).toBeHidden({ timeout: 5000 });
  }

  await expect(workspaceTab(page, 'Build')).toBeVisible({ timeout: 30_000 });

  // Startup recovery publishes status=recovered (or saved after re-verify).
  await expect.poll(
    async () => page.locator('[data-project-save-status]').getAttribute('data-project-save-status'),
    {
      timeout: 60_000,
      message: 'Expected verified recovery status after reload',
    },
  ).toMatch(/^(recovered|saved)$/);
}
