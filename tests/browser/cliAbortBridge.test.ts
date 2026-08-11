import { describe, expect, it } from 'vitest';
import { installCliAbortBridge } from '../../scripts/agent/cliAbort';

describe('CLI abort bridge (Playwright exposed-function semantics)', () => {
  it('allows work to proceed while false and aborts after the bridge flips true', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><html><body></body></html>');
      const triggerAbort = await installCliAbortBridge(page);

      const proceed = await page.evaluate(async () => {
        const abortFn = (window as unknown as {
          __foreSceneCliAbortRequested?: () => Promise<boolean>;
        }).__foreSceneCliAbortRequested;
        if (typeof abortFn === 'function' && await abortFn()) {
          const error = new Error('Render batch was cancelled.');
          error.name = 'AbortError';
          throw error;
        }
        return 'ok';
      });
      expect(proceed).toBe('ok');

      triggerAbort();

      const aborted = await page.evaluate(async () => {
        const abortFn = (window as unknown as {
          __foreSceneCliAbortRequested?: () => Promise<boolean>;
        }).__foreSceneCliAbortRequested;
        try {
          if (typeof abortFn === 'function' && await abortFn()) {
            const error = new Error('Render batch was cancelled.');
            error.name = 'AbortError';
            throw error;
          }
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      });

      expect(aborted).toEqual({
        ok: false,
        name: 'AbortError',
        message: 'Render batch was cancelled.',
      });
    } finally {
      await browser.close();
    }
  }, 30_000);
});
