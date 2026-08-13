/**
 * Collect a compact inspection payload from window.foreScene.
 */

import type { Page } from '@playwright/test';

export interface AgentInspectPayload {
  ok: true;
  status: unknown;
  capabilities: unknown;
  project: unknown;
  objects: unknown;
  shots: unknown;
  landmarks: unknown;
  exportPlan: unknown;
  document?: unknown;
}

export async function inspectViaBrowser(
  page: Page,
  options: { includeDocument?: boolean } = {},
): Promise<AgentInspectPayload> {
  return page.evaluate((includeDocument) => {
    const api = window.foreScene;
    if (!api) {
      throw new Error('window.foreScene is not available');
    }
    const status = api.getStatus();
    const capabilities = api.getCapabilities();
    const project = api.inspectProject();
    const objects = api.listObjects();
    const shots = api.listShots();
    const landmarks = api.listLandmarks();
    const exportPlan = api.createExportPlan();
    return {
      ok: true as const,
      status,
      capabilities,
      project,
      objects,
      shots,
      landmarks,
      exportPlan: exportPlan.ok
        ? {
            ok: true,
            summary: exportPlan.summary,
            packageType: exportPlan.plan?.packageType,
            archiveFileName: exportPlan.plan?.archiveFileName,
            shotCount: exportPlan.plan?.shots.length,
            issueCount: exportPlan.plan?.issues.length,
            estimatedFileCount: exportPlan.plan?.estimatedFileCount,
          }
        : exportPlan,
      ...(includeDocument ? { document: api.getProjectDocument() } : {}),
    };
  }, options.includeDocument === true);
}
