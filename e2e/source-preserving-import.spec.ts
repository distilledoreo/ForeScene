import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { sourceFixture, sourceFixtureGlb } from '../tests/fixtures/source-model-fixture';
import { dismissOverlays, enterStudioWorkspace, exportProjectBackup, reloadAndAwaitRecovery, waitForVerifiedSave } from './helpers/app-entry';

async function enableWrites(page: import('@playwright/test').Page) {
  await page.locator('[data-brand-menu-trigger]').click();
  await page.locator('[data-agent-control-enable]').click();
  await expect(page.locator('[data-agent-control-badge="active"]')).toBeVisible();
}

test.describe('Source-preserving model import @source-import', () => {
  test('manual import, material override, verified recovery and fresh-context portable reopen', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await enterStudioWorkspace(page); await dismissOverlays(page);
    await page.locator('[data-build-object-tray]').getByRole('button', { name: 'More' }).click();
    await page.locator('[data-build-import-model]').click();
    const dialog = page.getByRole('dialog', { name: /Import 3D/ });
    await expect(dialog.locator('[data-import-preservation="preserve"]')).toBeChecked();
    const bytes = Buffer.from(sourceFixtureGlb({ texture: true }));
    await dialog.locator('[data-model-import-input]').setInputFiles({ name:'painted.glb', mimeType:'model/gltf-binary', buffer:bytes });
    await expect(dialog.locator('[data-model-import-report-item="success"]')).toHaveCount(1, { timeout: 60_000 });
    await dialog.getByText('Close', { exact:true }).click(); await expect(dialog).toBeHidden();
    const snapshot = await page.evaluate(() => {
      const project = window.foreScene!.getProjectDocument();
      const objects = project.scene.objects.filter((object) => object.importedModel?.sourcePreserved);
      return { objects, asset: project.assets.assets[objects[0].modelAssetId!] };
    });
    expect(snapshot.objects).toHaveLength(2);
    expect(new Set(snapshot.objects.map((object) => object.modelAssetId)).size).toBe(1);
    expect(snapshot.asset.metadata?.sourceModel?.sourceHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(snapshot.asset.metadata?.sourceModel?.textureCount).toBe(1);
    await enableWrites(page);
    const selected = await page.evaluate(async (id) => window.foreScene!.applyPlan({ version:1, commands:[{ op:'selection.set', objectIds:[id] }] }), snapshot.objects[0].id);
    expect(selected.ok).toBe(true);
    await page.getByTitle('Precision drawer (I)', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Precision', exact: true })).toBeVisible();
    const surface = page.locator('[data-object-surface-style]');
    await expect(surface).toHaveValue('source');
    await surface.selectOption('solid'); await expect(surface).toHaveValue('solid');
    await surface.selectOption('source');
    await page.getByRole('dialog', { name: 'Precision', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('textbox', { name:'Selected object name' }).fill('Retained painted panel');
    await page.getByRole('textbox', { name:'Selected object name' }).blur();
    await waitForVerifiedSave(page);
    const download = await exportProjectBackup(page);
    await reloadAndAwaitRecovery(page);
    const recovered = await page.evaluate((id) => window.foreScene!.getProjectDocument().scene.objects.find((object) => object.id === id), snapshot.objects[0].id);
    expect(recovered?.name).toBe('Retained painted panel'); expect(recovered?.surfaceStyle).toBe('source');
    const fresh = await browser.newContext({ baseURL:new URL(page.url()).origin });
    try {
      const other = await fresh.newPage(); await enterStudioWorkspace(other); await dismissOverlays(other);
      await other.locator('[data-project-import-input]').setInputFiles({ name:'source-roundtrip.fsp', mimeType:'application/zip', buffer:await readFile(download) });
      await expect.poll(async () => other.evaluate(() => window.foreScene?.getProjectDocument().scene.objects.filter((object) => object.importedModel?.sourcePreserved).length), { timeout:60_000 }).toBe(2);
      const restored = await other.evaluate((id) => {
        const project = window.foreScene!.getProjectDocument(); const object = project.scene.objects.find((entry) => entry.id === id)!;
        return { object, source:project.assets.assets[object.modelAssetId!].metadata?.sourceModel };
      }, snapshot.objects[0].id);
      expect(restored.object.name).toBe('Retained painted panel'); expect(restored.object.surfaceStyle).toBe('source');
      expect(restored.source?.sourceHash).toBe(snapshot.asset.metadata?.sourceModel?.sourceHash);
      expect(restored.source?.textureCount).toBe(1);
      await other.screenshot({ path:test.info().outputPath('restored-textured-project.png') });
    } finally { await fresh.close(); }
  });

  test('Agent API accepts companion resources and reuses the complete source selection', async ({ page }) => {
    test.setTimeout(120_000);
    await enterStudioWorkspace(page); await dismissOverlays(page); await enableWrites(page);
    const fixture = sourceFixture({ external:true });
    await page.locator('[data-agent-model-import-input]').setInputFiles([
      { name:'scene.gltf', mimeType:'model/gltf+json', buffer:Buffer.from(fixture.text) },
      { name:'mesh.bin', mimeType:'application/octet-stream', buffer:Buffer.from(fixture.buffer) },
    ]);
    const result = await page.evaluate(async () => {
      const files = Array.from((document.querySelector('[data-agent-model-import-input]') as HTMLInputElement).files!);
      const input = { file:files[0], resources:files.slice(1), mode:'separate' as const, preservation:'preserve' as const };
      const first = await window.foreScene!.importModel(input); const second = await window.foreScene!.importModel(input);
      return { first, second, document:window.foreScene!.getProjectDocument() };
    });
    expect(result.first.ok, JSON.stringify(result.first.diagnostics)).toBe(true); expect(result.second.ok).toBe(true);
    expect(result.second.objectRefs?.map((object) => object.id)).toEqual(result.first.objectRefs?.map((object) => object.id));
    expect(result.second.objectRefs).toHaveLength(2);
    const sources = Object.values(result.document.assets.assets).filter((asset) => asset.metadata?.modelEncoding === 'source');
    expect(sources).toHaveLength(1); expect(sources[0].metadata?.sourceModel?.container).toBe('zip');
    await waitForVerifiedSave(page);
  });
});
