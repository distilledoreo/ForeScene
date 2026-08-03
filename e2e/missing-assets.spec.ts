import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

import { unriggedHumanoidGlb } from '../tests/fixtures/unriggedHumanoidGlb';
import { dismissOverlays, enterStudio, enterStudioWorkspace, waitForVerifiedSave } from './helpers/app-entry';

async function startFreshBlankProject(page: Page) {
  await enterStudio(page);
  await dismissOverlays(page);
  await page.locator('[data-launcher-option="build-manually"]').click();
  await page.locator('[data-manual-option="blank-graybox"]').click();
  await expect(page.locator('[data-project-launcher]')).toBeHidden({ timeout: 30_000 });
}

async function openInCleanBrowser(page: Page, packageBytes: Buffer) {
  const browser = page.context().browser();
  if (!browser) throw new Error('The browser fixture is unavailable for a clean-context check.');
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const cleanPage = await context.newPage();
  await enterStudio(cleanPage);
  await cleanPage.locator('[data-project-import-input]').setInputFiles({
    name: 'round-trip.fsp',
    mimeType: 'application/zip',
    buffer: packageBytes,
  });
  return { context, page: cleanPage };
}

test.describe('@smoke missing asset recovery', () => {
  test('opens a project with a missing model as an editable placeholder', async ({ page }) => {
    await enterStudioWorkspace(page);
    await dismissOverlays(page);
    await waitForVerifiedSave(page);

    const projectJson = await page.evaluate(() => {
      const project = window.foreScene?.getProjectDocument();
      if (!project) throw new Error('ForeScene Agent API is not ready.');
      const assetId = 'e2e-missing-model';
      project.name = 'Missing Asset Recovery';
      project.assets.assets[assetId] = {
        id: assetId,
        type: 'model',
        name: 'Missing Character.panoref-mesh',
        originalFileName: 'Missing Character.glb',
        mimeType: 'model/gltf-binary',
        byteSize: 1024,
        uri: 'panoref-idb:e2e-missing-model',
        createdAt: new Date(0).toISOString(),
      };
      project.scene.objects.push({
        id: 'e2e-missing-instance',
        name: 'Missing Character',
        type: 'imported_model',
        transform: {
          position: [2, 0, 1],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        dimensions: [1.2, 2, 0.8],
        category: 'environment',
        locked: false,
        visible: true,
        modelAssetId: assetId,
      });
      return JSON.stringify(project);
    });

    await page.locator('[data-project-import-input]').setInputFiles({
      name: 'missing-asset-recovery.json',
      mimeType: 'application/json',
      buffer: Buffer.from(projectJson),
    });

    await expect(page.locator('[data-project-import-status="warning"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-missing-assets-panel]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-missing-asset-id="e2e-missing-model"]')).toContainText('Missing Character.glb');
    await expect(page.locator('[data-missing-assets-panel]')).toContainText('Keep Placeholder');

    const inspection = await page.evaluate(() => window.foreScene?.inspectProject());
    expect(inspection?.missingAssetCount).toBe(1);
    expect(inspection?.missingAssets[0]).toMatchObject({
      assetId: 'e2e-missing-model',
      originalFileName: 'Missing Character.glb',
      status: 'missing',
      instanceObjectIds: ['e2e-missing-instance'],
    });
  });

  test('round-trips a real GLB package in a clean browser and keeps a missing binary as a placeholder', async ({ page }) => {
    test.setTimeout(180_000);
    await startFreshBlankProject(page);
    await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
    await page.locator('[data-build-import-model]').click();
    const dialog = page.getByRole('dialog', { name: /Import 3D/ });
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-model-import-input]').setInputFiles({
      name: 'recovery.glb',
      mimeType: 'model/gltf-binary',
      buffer: Buffer.from(unriggedHumanoidGlb()),
    });
    await expect(dialog.locator('[data-model-import-report-item="success"]')).toHaveCount(1, { timeout: 30_000 });
    await dialog.getByText('Close', { exact: true }).click();
    await expect(dialog).toBeHidden();

    const imported = await page.evaluate(() => {
      const project = window.foreScene?.getProjectDocument();
      if (!project) throw new Error('ForeScene Agent API is not ready.');
      const object = project.scene.objects.find((candidate) => candidate.type === 'imported_model');
      const asset = object?.modelAssetId ? project.assets.assets[object.modelAssetId] : undefined;
      return { objectId: object?.id, assetId: asset?.id, assetName: asset?.originalFileName, status: asset?.resolutionStatus };
    });
    expect(imported.objectId).toBeTruthy();
    expect(imported.assetName).toBe('recovery.glb');
    expect(imported.status).toBe('available');

    await waitForVerifiedSave(page);
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.locator('[data-project-export-button]').click();
    const download = await downloadPromise;
    const packagePath = await download.path();
    expect(packagePath).toBeTruthy();
    const packageBytes = await readFile(packagePath!);
    const zip = await JSZip.loadAsync(packageBytes);
    const manifest = JSON.parse(await zip.file('project.json')!.async('text')) as {
      assets: { assets: Record<string, { type: string; uri: string; resolutionStatus?: string }> };
    };
    const modelAsset = Object.values(manifest.assets.assets).find((asset) => asset.type === 'model');
    expect(modelAsset).toBeTruthy();
    expect(modelAsset!.resolutionStatus).toBe('available');
    expect(modelAsset!.uri).toMatch(/^panoref-idb:/);
    const modelKey = modelAsset!.uri.slice('panoref-idb:'.length);
    const modelPath = `model-assets/${encodeURIComponent(modelKey)}.bin`;
    expect(zip.file(modelPath)).toBeTruthy();

    const cleanRoundTrip = await openInCleanBrowser(page, packageBytes);
    try {
      await expect(cleanRoundTrip.page.locator('[data-project-import-status="success"]')).toBeVisible({ timeout: 30_000 });
      const reopened = await cleanRoundTrip.page.evaluate(() => {
        const project = window.foreScene?.getProjectDocument();
        if (!project) throw new Error('ForeScene Agent API is not ready after package open.');
        const object = project.scene.objects.find((candidate) => candidate.type === 'imported_model');
        const asset = object?.modelAssetId ? project.assets.assets[object.modelAssetId] : undefined;
        return { objectId: object?.id, assetId: asset?.id, status: asset?.resolutionStatus };
      });
      expect(reopened.objectId).toBeTruthy();
      expect(reopened.assetId).toBeTruthy();
      expect(reopened.status).toBe('available');
    } finally {
      await cleanRoundTrip.context.close();
    }

    const brokenZip = await JSZip.loadAsync(packageBytes);
    brokenZip.remove(modelPath);
    const brokenBytes = Buffer.from(await brokenZip.generateAsync({ type: 'uint8array' }));
    const cleanMissing = await openInCleanBrowser(page, brokenBytes);
    try {
      await expect(cleanMissing.page.locator('[data-project-import-status="warning"]')).toBeVisible({ timeout: 30_000 });
      await expect(cleanMissing.page.locator('[data-missing-assets-panel]')).toBeVisible({ timeout: 30_000 });
      await expect(cleanMissing.page.locator('[data-missing-assets-panel]')).toContainText('Keep Placeholder');
      const missing = await cleanMissing.page.evaluate(() => {
        const project = window.foreScene?.getProjectDocument();
        const inspection = window.foreScene?.inspectProject();
        if (!project || !inspection) throw new Error('ForeScene Agent API is not ready after missing package open.');
        const object = project.scene.objects.find((candidate) => candidate.type === 'imported_model');
        const asset = object?.modelAssetId ? project.assets.assets[object.modelAssetId] : undefined;
        return { objectId: object?.id, status: asset?.resolutionStatus, missingCount: inspection.missingAssetCount };
      });
      expect(missing.objectId).toBeTruthy();
      expect(missing.status).toBe('missing');
      expect(missing.missingCount).toBe(1);
    } finally {
      await cleanMissing.context.close();
    }
  });
});
