/**
 * Persistent browser render session — one project load per production run.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  buildRenderInputFromProfile,
  type RenderSessionBatchResult,
  type RenderSessionDescriptor,
  type RenderSessionFrameResult,
  type RenderSessionShotJob,
  type RenderSessionStats,
} from '../../src/engine/previs/renderSession';
import {
  type RenderProfile,
  renderProfileFingerprint,
} from '../../src/engine/previs/renderProfiles';
import { waitForAgentIdle } from './browser';
import { captureSceneScreenshot } from './screenshot';

async function writeDataUrlPng(dataUrl: string, filePath: string): Promise<void> {
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
  if (!match?.[1]) {
    throw new Error('renderShotFrame did not return a PNG data URL.');
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(match[1], 'base64'));
}

export class PersistentRenderSession {
  readonly sessionId: string;
  readonly profile: RenderProfile;
  readonly profileFingerprint: string;

  private readonly page: Page;
  private readonly startedAt: string;
  private closed = false;
  private projectLoaded = false;
  private shotsRendered = 0;
  private shotsFailed = 0;
  private shotsSkipped = 0;
  private lastRenderAt?: string;
  private revisionId?: string;
  private projectId?: string;

  constructor(page: Page, profile: RenderProfile, sessionId?: string) {
    this.page = page;
    this.profile = profile;
    this.profileFingerprint = renderProfileFingerprint(profile);
    this.sessionId = sessionId ?? `rs_${Date.now().toString(36)}`;
    this.startedAt = new Date().toISOString();
  }

  getStats(): RenderSessionStats {
    return {
      shotsRendered: this.shotsRendered,
      shotsFailed: this.shotsFailed,
      shotsSkipped: this.shotsSkipped,
      projectLoaded: this.projectLoaded,
      startedAt: this.startedAt,
      lastRenderAt: this.lastRenderAt,
    };
  }

  toDescriptor(): RenderSessionDescriptor {
    return {
      sessionId: this.sessionId,
      renderProfileId: this.profile.id,
      renderProfileFingerprint: this.profileFingerprint,
      revisionId: this.revisionId,
      projectId: this.projectId,
      createdAt: this.startedAt,
      closedAt: this.closed ? new Date().toISOString() : undefined,
    };
  }

  async ensureProjectLoaded(): Promise<void> {
    if (this.projectLoaded) return;
    await waitForAgentIdle(this.page);
    const status = await this.page.evaluate(() => window.foreScene!.getStatus());
    this.projectId = status.projectId;
    this.projectLoaded = true;
  }

  async renderShot(job: RenderSessionShotJob): Promise<RenderSessionFrameResult> {
    if (this.closed) {
      throw new Error('Render session is closed.');
    }
    await this.ensureProjectLoaded();

    const input = buildRenderInputFromProfile(this.profile, job.shotId, job.timeSeconds);

    await this.page.evaluate(async (payload) => {
      await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
      await window.foreScene!.applyPlan({
        version: 1,
        planId: `select-${payload.shotId}`,
        commands: [{ op: 'shot.select', shot: { id: payload.shotId } }],
      });
    }, { shotId: job.shotId });

    await waitForAgentIdle(this.page);

    const ready = await this.page.evaluate(async (payload) => {
      return window.foreScene!.waitForViewportReady({
        workspace: 'shots',
        shotId: payload.shotId,
        timeoutMs: 12_000,
      });
    }, { shotId: job.shotId }).catch((error: unknown) => ({
      ok: false as const,
      diagnostics: [{
        code: 'render_not_ready',
        message: error instanceof Error ? error.message : String(error),
        severity: 'error' as const,
      }],
    }));

    if (!ready.ok && job.debugUiPath) {
      await captureSceneScreenshot(this.page, job.debugUiPath).catch(() => undefined);
    }

    const result = await this.page.evaluate(async (payload) => {
      return window.foreScene!.renderShotFrame(payload);
    }, input);

    this.lastRenderAt = new Date().toISOString();
    if (result.revisionId) this.revisionId = result.revisionId;

    if (!result.ok || !result.pngDataUrl) {
      if (job.debugUiPath) {
        await captureSceneScreenshot(this.page, job.debugUiPath).catch(() => undefined);
      }
      this.shotsFailed += 1;
      return {
        ok: false,
        shotId: job.shotId,
        shotNumber: job.shotNumber,
        framePath: job.framePath,
        width: result.width,
        height: result.height,
        pixelStats: result.pixelStats,
        revisionId: result.revisionId,
        error: result.diagnostics?.[0]?.message ?? 'Clean frame render failed.',
        fromCanonicalRenderer: false,
        renderProfileId: this.profile.id,
      };
    }

    await writeDataUrlPng(result.pngDataUrl, job.framePath);

    if (job.debugUiPath) {
      await captureSceneScreenshot(this.page, job.debugUiPath).catch(() => undefined);
    }

    this.shotsRendered += 1;
    return {
      ok: true,
      shotId: job.shotId,
      shotNumber: job.shotNumber,
      framePath: job.framePath,
      width: result.width,
      height: result.height,
      pixelStats: result.pixelStats,
      revisionId: result.revisionId,
      fromCanonicalRenderer: result.source === 'canonical_clay_renderer'
        || result.source === 'canonical_projected_renderer',
      renderProfileId: this.profile.id,
    };
  }

  async renderBatch(
    jobs: RenderSessionShotJob[],
    options?: { locationOrder?: string[] },
  ): Promise<RenderSessionBatchResult> {
    const locationGroups = new Map<string, RenderSessionShotJob[]>();
    for (const job of jobs) {
      const key = job.shotNumber;
      const list = locationGroups.get(key) ?? [];
      list.push(job);
      locationGroups.set(key, list);
    }

    // Group by location when jobs carry locationId via an extended type.
    const grouped = options?.locationOrder?.length
      ? jobs
      : jobs;

    const results: RenderSessionFrameResult[] = [];
    for (const job of grouped) {
      const result = await this.renderShot(job);
      results.push(result);
    }

    return {
      results,
      renderedCount: results.filter((item) => item.ok).length,
      failedCount: results.filter((item) => !item.ok).length,
      skippedCount: this.shotsSkipped,
    };
  }

  async close(): Promise<RenderSessionDescriptor> {
    this.closed = true;
    return this.toDescriptor();
  }
}

export async function createPersistentRenderSession(
  page: Page,
  profile: RenderProfile,
  sessionId?: string,
): Promise<PersistentRenderSession> {
  const session = new PersistentRenderSession(page, profile, sessionId);
  await session.ensureProjectLoaded();
  return session;
}
