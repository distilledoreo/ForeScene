import { describe, expect, it, vi } from 'vitest';
import {
  BrowserLaunchTimeoutError,
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
