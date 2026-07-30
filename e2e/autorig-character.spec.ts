import { expect, test, type Page } from '@playwright/test';

import { workspaceTab } from './workspace-navigation';

// Tag taxonomy: @smoke — essential workflow on desktop Chromium PRs.
// Full-regression is owned by the main/nightly workflows (see AGENTS.md).

async function enterStudio(page: Page) {
  // Skip splash video so it never blocks pointer events mid-test.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('forescene-splash-seen', '1');
    } catch {
      // ignore
    }
  });
  await page.goto('/');
  const modeChooser = page.locator('[data-mode-chooser]');
  const studio = page.getByRole('button', { name: /Open ForeScene/i });
  if (await modeChooser.isVisible().catch(() => false)) {
    await studio.click();
  } else {
    try {
      await modeChooser.waitFor({ state: 'visible', timeout: 3000 });
      await studio.click();
    } catch {
      // Already in a mode from a previous session.
    }
  }
  const splash = page.getByRole('dialog', { name: 'ForeScene splash' });
  if (await splash.isVisible().catch(() => false)) {
    await splash.click({ force: true });
    await expect(splash).toBeHidden({ timeout: 5000 });
  }
  await expect(workspaceTab(page, 'Build')).toBeVisible({ timeout: 15000 });
  await expect(modeChooser).toBeHidden({ timeout: 5000 }).catch(() => undefined);
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
 * Minimal GLB with an embedded-binary (data URI) buffer of 6 vertices. Imported
 * as a poseable character and rigged through the marker wizard end to end.
 */
function humanoidProxyGlb(): Buffer {
  const positions = Buffer.alloc(72);
  [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],
    [5, 0, 0], [6, 0, 0], [5, 1, 0],
  ].flat().forEach((value, index) => positions.writeFloatLE(value, index * 4));

  const json = JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 72, uri: `data:application/octet-stream;base64,${positions.toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 72 }],
    accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 6, type: 'VEC3', min: [0, 0, 0], max: [6, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0, name: 'ProxyHumanoid' }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  });
  const jsonBytes = Buffer.from(json, 'utf8');
  // Pad JSON chunk to 4-byte alignment with spaces (glTF spec).
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const chunkJsonLen = jsonPadded.length;
  const totalLength = 12 + 8 + chunkJsonLen;

  const glb = Buffer.alloc(totalLength);
  let offset = 0;
  glb.write('glTF', offset, 4, 'ascii'); offset += 4;          // magic
  glb.writeUInt32LE(2, offset); offset += 4;                   // version
  glb.writeUInt32LE(totalLength, offset); offset += 4;         // length
  glb.writeUInt32LE(chunkJsonLen, offset); offset += 4;        // chunk length
  glb.writeUInt32LE(0x4e4f534a, offset); offset += 4;          // chunk type "JSON"
  jsonPadded.copy(glb, offset); offset += chunkJsonLen;
  return glb;
}

test.describe('@smoke autorig character workflow', () => {
  test('imports a GLB, opens the marker wizard, applies the rig, and poses it', async ({ page }) => {
    await enterStudio(page);
    await dismissOverlays(page);
    await workspaceTab(page, 'Build').click();
    await dismissOverlays(page);

    // Open the poseable-character import dialog via the object tray overflow menu.
    await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
    await page.locator('[data-build-import-poseable-character]').click();

    const importDialog = page.getByRole('dialog', { name: /Import poseable character/i });
    await expect(importDialog).toBeVisible();
    // Set files on the dialog's mesh input directly (same pattern as graybox import).
    // Avoid page-wide `input[type="file"]` + choose-button click races that leave confirm disabled.
    await importDialog.locator('[data-poseable-import-mesh-input]').setInputFiles({
      name: 'proxy.glb',
      mimeType: 'model/gltf-binary',
      buffer: humanoidProxyGlb(),
    });
    await expect(importDialog.locator('[data-poseable-import-preview-summary]')).toBeVisible({ timeout: 10000 });
    await expect(importDialog.locator('[data-poseable-import-confirm]')).toBeEnabled({ timeout: 10000 });
    await importDialog.locator('[data-poseable-import-confirm]').click();

    // Import opens the marker wizard automatically.
    const wizard = page.getByRole('dialog', { name: /Rig character/i });
    await expect(wizard).toBeVisible({ timeout: 10000 });

    // Guided wizard: Joints → Pose & Fix → Apply.
    await expect(wizard.locator('[data-autorig-continue-joints]')).toBeEnabled({ timeout: 10000 });
    await wizard.locator('[data-autorig-continue-joints]').click();
    await expect(wizard.locator('[data-autorig-pose-fix-step]')).toBeVisible({ timeout: 10000 });
    await expect(wizard.locator('[data-autorig-apply-skeleton]')).toBeEnabled({ timeout: 20000 });
    await wizard.locator('[data-autorig-apply-skeleton]').click();
    await expect(wizard).toBeHidden({ timeout: 10000 });

    // The imported character is selected and exposes the pose panel.
    await page.locator('[data-character-mode-pose]').click();
    await expect(page.locator('[data-build-character-pose]')).toBeVisible();
    // Arms-raised preset changes the skinned character without crashing.
    await page.getByRole('button', { name: /Arms raised/i }).click();
  });
});
