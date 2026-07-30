import { expect, test } from '@playwright/test';
import { dismissOverlays, enterStudio } from './helpers/app-entry';

test.describe('Agent API @smoke', () => {
  test('exposes window.foreScene inspection and blocks writes by default', async ({ page }) => {
    await enterStudio(page);
    await dismissOverlays(page);

    await page.waitForFunction(() => {
      const status = window.foreScene?.getStatus();
      return Boolean(status?.ready && status.projectLoaded && status.persistence?.ready);
    });

    const status = await page.evaluate(() => window.foreScene!.getStatus());
    expect(status.ready).toBe(true);
    expect(status.projectLoaded).toBe(true);
    expect(status.writeAccess).toBe(false);
    expect(status.controlMode).toBe('read-only');
    expect(status.apiVersion).toBe(1);

    const inspection = await page.evaluate(() => {
      const api = window.foreScene!;
      return {
        project: api.inspectProject(),
        objects: api.listObjects(),
        shots: api.listShots(),
        capabilities: api.getCapabilities(),
        exportPlan: api.createExportPlan(),
      };
    });

    expect(inspection.project.objectCount).toBeGreaterThan(0);
    expect(inspection.objects.length).toBe(inspection.project.objectCount);
    expect(inspection.shots.length).toBe(inspection.project.shotCount);
    expect(inspection.capabilities.inspection).toBe(true);
    expect(inspection.capabilities.mutations).toBe(false);
    expect(inspection.exportPlan.ok).toBe(true);
    expect(inspection.exportPlan.summary?.shotCount).toBe(inspection.shots.length);

    const apply = await page.evaluate(async () => window.foreScene!.applyPlan({
      version: 1,
      commands: [],
    }));
    expect(apply.ok).toBe(false);
    expect(apply.diagnostics[0]?.code).toBe('write_access_required');

    // Strict Mode remount must not leave a stale API object: identity stays callable.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await enterStudio(page);
    await page.waitForFunction(() => Boolean(
      window.foreScene?.getStatus()?.ready
      && window.foreScene?.getStatus()?.persistence?.ready,
    ));
    const afterReload = await page.evaluate(() => window.foreScene!.getStatus());
    expect(afterReload.ready).toBe(true);
    expect(afterReload.projectLoaded).toBe(true);
  });
});
