import { expect, test } from '@playwright/test';

import { dismissOverlays, enterStudioWorkspace, waitForVerifiedSave } from './helpers/app-entry';

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
});
