/**
 * Persistent browser render session — one project load per production run.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  buildRenderInputFromProfile,
  groupJobsByLocation,
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

type BrowserRenderResult = {
  ok: boolean;
  pngDataUrl?: string;
  width: number;
  height: number;
  pixelStats?: RenderSessionFrameResult['pixelStats'];
  revisionId?: string;
  source?: string;
  diagnostics?: Array<{ code?: string; message?: string }>;
};

async function writeDataUrlPng(dataUrl: string, filePath: string): Promise<void> {
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
  if (!match?.[1]) {
    throw new Error('renderShotFrame did not return a PNG data URL.');
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(match[1], 'base64'));
}

function isCanonicalSource(source: string | undefined): boolean {
  return source === 'canonical_clay_renderer' || source === 'canonical_projected_renderer';
}

function needsViewportFallback(result: BrowserRenderResult): boolean {
  if (result.ok) return false;
  const code = result.diagnostics?.[0]?.code ?? '';
  return code === 'render_not_ready'
    || code === 'viewport_not_ready'
    || code === 'busy';
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
    this.revisionId = status.revisionId;
    this.projectLoaded = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Render session is closed.');
    }
  }

  private frameResultFromBrowser(
    job: RenderSessionShotJob,
    result: BrowserRenderResult,
  ): RenderSessionFrameResult {
    return {
      ok: result.ok && Boolean(result.pngDataUrl),
      shotId: job.shotId,
      shotNumber: job.shotNumber,
      framePath: job.framePath,
      width: result.width,
      height: result.height,
      pixelStats: result.pixelStats,
      revisionId: result.revisionId,
      error: result.ok ? undefined : (result.diagnostics?.[0]?.message ?? 'Clean frame render failed.'),
      fromCanonicalRenderer: isCanonicalSource(result.source),
      renderProfileId: this.profile.id,
    };
  }

  private async tryDirectRender(job: RenderSessionShotJob): Promise<BrowserRenderResult> {
    const input = buildRenderInputFromProfile(this.profile, job.shotId, job.timeSeconds);
    const result = await this.page.evaluate(async (payload) => {
      await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
      return window.foreScene!.renderShotFrame(payload);
    }, input);
    if (result.revisionId) this.revisionId = result.revisionId;
    this.lastRenderAt = new Date().toISOString();
    return result;
  }

  private async renderWithViewport(job: RenderSessionShotJob): Promise<BrowserRenderResult> {
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

    return this.tryDirectRender(job);
  }

  async renderShot(job: RenderSessionShotJob): Promise<RenderSessionFrameResult> {
    this.assertOpen();
    await this.ensureProjectLoaded();

    let browserResult = await this.tryDirectRender(job);
    if (!browserResult.ok && needsViewportFallback(browserResult)) {
      browserResult = await this.renderWithViewport(job);
    }

    const frame = this.frameResultFromBrowser(job, browserResult);
    if (!frame.ok || !browserResult.pngDataUrl) {
      if (job.debugUiPath) {
        await captureSceneScreenshot(this.page, job.debugUiPath).catch(() => undefined);
      }
      this.shotsFailed += 1;
      return frame;
    }

    await writeDataUrlPng(browserResult.pngDataUrl, job.framePath);

    this.shotsRendered += 1;
    return frame;
  }

  private async renderLocationGroup(jobs: RenderSessionShotJob[]): Promise<RenderSessionFrameResult[]> {
    if (jobs.length === 0) return [];
    if (jobs.length === 1) {
      return [await this.renderShot(jobs[0]!)];
    }

    const inputs = jobs.map((job) => buildRenderInputFromProfile(this.profile, job.shotId, job.timeSeconds));
    const batch = await this.page.evaluate(async (payload) => {
      await window.foreScene!.waitForIdle({ timeoutMs: 60_000 });
      return window.foreScene!.renderShotBatch({ jobs: payload.inputs });
    }, { inputs });

    const results: RenderSessionFrameResult[] = [];
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]!;
      const browserResult = batch[index] as BrowserRenderResult | undefined;
      if (!browserResult) {
        results.push(await this.renderShot(job));
        continue;
      }

      if (browserResult.revisionId) this.revisionId = browserResult.revisionId;
      this.lastRenderAt = new Date().toISOString();

      let frame = this.frameResultFromBrowser(job, browserResult);
      if (!frame.ok && needsViewportFallback(browserResult)) {
        frame = await this.renderShot(job);
        results.push(frame);
        continue;
      }

      if (!frame.ok || !browserResult.pngDataUrl) {
        if (job.debugUiPath) {
          await captureSceneScreenshot(this.page, job.debugUiPath).catch(() => undefined);
        }
        this.shotsFailed += 1;
        results.push(frame);
        continue;
      }

      await writeDataUrlPng(browserResult.pngDataUrl, job.framePath);
      this.shotsRendered += 1;
      results.push(frame);
    }

    return results;
  }

  async renderBatch(
    jobs: RenderSessionShotJob[],
    options?: { locationOrder?: string[] },
  ): Promise<RenderSessionBatchResult> {
    this.assertOpen();
    await this.ensureProjectLoaded();

    const groups = groupJobsByLocation(jobs, options?.locationOrder);
    const results: RenderSessionFrameResult[] = [];
    for (const group of groups) {
      results.push(...await this.renderLocationGroup(group.jobs));
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
