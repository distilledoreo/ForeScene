import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import {
  BrowserLaunchTimeoutError,
  openAgentBrowser,
  waitForAgentReady,
  withBrowserLaunchDeadline,
} from '../scripts/agent/browser';

describe('agent browser launch deadline', () => {
  it('returns a browser context established before the deadline', async () => {
    const value = await withBrowserLaunchDeadline(
      async () => ({ ready: true }),
      100,
      async () => undefined,
    );
    expect(value).toEqual({ ready: true });
  });

  it('cleans up and fails explicitly when launch never settles', async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(withBrowserLaunchDeadline(
      () => new Promise<never>(() => undefined),
      10,
      cleanup,
    )).rejects.toBeInstanceOf(BrowserLaunchTimeoutError);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not return a context that arrives after cleanup has begun', async () => {
    let releaseCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const attempt = withBrowserLaunchDeadline(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('late context'), 15)),
      10,
      () => cleanupGate,
    );
    const rejection = expect(attempt).rejects.toBeInstanceOf(BrowserLaunchTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseCleanup();
    await rejection;
  });
});

describe('agent browser initialization failure', () => {
  it.each(['navigation', 'readiness'] as const)('closes its context when %s fails before returning a session', async (stage) => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), 'forescene-browser-failure-'));
    const failure = new Error(`fixture ${stage} failed`);
    const page = {
      goto: vi.fn(async () => { if (stage === 'navigation') throw failure; }),
      locator: vi.fn(() => ({ isVisible: async () => true })),
      getByRole: vi.fn(() => ({ click: async () => undefined, isVisible: async () => false })),
      waitForFunction: vi.fn(async () => { throw failure; }),
    } as unknown as Page;
    const close = vi.fn(async () => undefined);
    const context = {
      addInitScript: async () => undefined,
      pages: () => [page],
      close,
    } as unknown as BrowserContext;
    const launch = vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValue(context);
    try {
      await expect(openAgentBrowser({ url: 'http://127.0.0.1:3000', profileDir, headless: true }))
        .rejects.toBe(failure);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      launch.mockRestore();
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  it('passes the requested readiness timeout as Playwright options', async () => {
    const waitForFunction = vi.fn(async () => undefined);
    await waitForAgentReady({ waitForFunction } as unknown as Page, 1234);
    expect(waitForFunction).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 1234 });
  });
});
