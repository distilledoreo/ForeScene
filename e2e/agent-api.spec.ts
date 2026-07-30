import { expect, test } from '@playwright/test';
import { dismissOverlays, enterStudio, reloadAndAwaitRecovery, waitForVerifiedSave } from './helpers/app-entry';

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

    const applyBlocked = await page.evaluate(async () => window.foreScene!.applyPlan({
      version: 1,
      commands: [{ op: 'project.updateInfo', name: 'Blocked' }],
    }));
    expect(applyBlocked.ok).toBe(false);
    expect(applyBlocked.diagnostics[0]?.code).toBe('write_access_required');

    const preview = await page.evaluate(async () => window.foreScene!.previewPlan({
      version: 1,
      description: 'Preview create',
      commands: [
        {
          op: 'object.create',
          ref: 'actorA',
          object: { type: 'human_dummy', name: 'Actor A', position: [-1.2, 0, 0] },
        },
        {
          op: 'object.update',
          object: { ref: 'actorA' },
          updates: { visible: true },
        },
      ],
    }));
    expect(preview.ok).toBe(true);
    expect(preview.summary?.createdRefs.actorA?.name).toBe('Actor A');
    expect(preview.diff?.objectsCreated).toHaveLength(1);

    const objectCountAfterPreview = await page.evaluate(() => window.foreScene!.inspectProject().objectCount);
    expect(objectCountAfterPreview).toBe(inspection.project.objectCount);

    // Enable writes and apply for real.
    await page.evaluate(() => window.foreScene!.setControlMode('read-write'));
    await expect(page.locator('[data-agent-control-badge="active"]')).toBeVisible();

    const applied = await page.evaluate(async () => window.foreScene!.applyPlan({
      version: 1,
      description: 'E2E conversation',
      commands: [
        {
          op: 'object.create',
          ref: 'actorA',
          object: { type: 'human_dummy', name: 'Actor A', position: [-1.2, 0, 0] },
        },
        {
          op: 'object.create',
          ref: 'actorB',
          object: { type: 'human_dummy', name: 'Actor B', position: [1.2, 0, 0] },
        },
        { op: 'project.updateInfo', name: 'Agent E2E Set' },
      ],
    }));
    expect(applied.ok).toBe(true);
    expect(applied.verifiedRevisionId).toBeTruthy();
    expect(applied.summary?.affectedObjectIds.length).toBe(2);

    await waitForVerifiedSave(page);

    const afterApply = await page.evaluate(() => {
      const api = window.foreScene!;
      return {
        project: api.inspectProject(),
        actors: api.listObjects({ name: 'Actor', match: 'contains' }),
      };
    });
    expect(afterApply.project.name).toBe('Agent E2E Set');
    expect(afterApply.project.objectCount).toBe(inspection.project.objectCount + 2);
    expect(afterApply.actors).toHaveLength(2);

    await reloadAndAwaitRecovery(page);
    await page.waitForFunction(() => {
      const status = window.foreScene?.getStatus();
      return Boolean(status?.ready && status.projectLoaded && status.persistence?.ready);
    });

    const afterReload = await page.evaluate(() => window.foreScene!.inspectProject());
    expect(afterReload.name).toBe('Agent E2E Set');
    expect(afterReload.objectCount).toBe(inspection.project.objectCount + 2);

    // Write access is session-only unless CLI preference is seeded; re-enable for undo.
    await page.evaluate(() => window.foreScene!.setControlMode('read-write'));
    // After reload the in-memory agent history is gone — undo should report nothing_to_undo.
    const undoAfterReload = await page.evaluate(async () => window.foreScene!.undoLastPlan());
    expect(undoAfterReload.ok).toBe(false);
    expect(undoAfterReload.diagnostics[0]?.code).toBe('nothing_to_undo');

    // Apply + undo in the same session.
    const renamed = await page.evaluate(async () => window.foreScene!.applyPlan({
      version: 1,
      description: 'Rename for undo',
      commands: [{ op: 'project.updateInfo', name: 'Before Undo' }],
    }));
    expect(renamed.ok).toBe(true);
    await waitForVerifiedSave(page);

    const undone = await page.evaluate(async () => window.foreScene!.undoLastPlan());
    expect(undone.ok).toBe(true);
    await waitForVerifiedSave(page);
    const restored = await page.evaluate(() => window.foreScene!.inspectProject().name);
    expect(restored).toBe('Agent E2E Set');

    await page.locator('[data-agent-control-stop]').click();
    await expect(page.locator('[data-agent-control-badge="active"]')).toHaveCount(0);
  });
});
