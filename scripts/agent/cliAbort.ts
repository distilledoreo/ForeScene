/**
 * Shared Node-side abort scope for long-running agent CLI sessions.
 */

import type { Page } from '@playwright/test';

export interface CliAbortScope {
  readonly signal: AbortSignal;
  throwIfAborted: () => void;
  abort: () => void;
  dispose: () => void;
}

export interface CliAbortScopeOptions {
  /** Invoked synchronously when the scope aborts (SIGINT/SIGTERM or explicit abort). */
  onAbort?: () => void | Promise<void>;
}

function abortError(): Error {
  const error = new Error('Agent CLI run was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function createCliAbortScope(options: CliAbortScopeOptions = {}): CliAbortScope {
  const controller = new AbortController();
  const handlers: Array<() => void> = [];
  let abortNotified = false;

  const notifyAbort = () => {
    if (abortNotified) return;
    abortNotified = true;
    void options.onAbort?.();
  };

  const cleanup = () => {
    for (const remove of handlers.splice(0)) remove();
  };

  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    notifyAbort();
    cleanup();
  };

  const onSignal = () => abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  handlers.push(() => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  });

  return {
    signal: controller.signal,
    throwIfAborted() {
      if (!controller.signal.aborted) return;
      throw abortError();
    },
    abort,
    dispose: cleanup,
  };
}

/** Install a browser-visible abort flag for in-page render loops. */
export async function installCliAbortBridge(page: Page): Promise<() => void> {
  const state = { aborted: false };
  await page.exposeFunction('__foreSceneCliAbortRequested', () => state.aborted);
  return () => {
    state.aborted = true;
  };
}

export function cancelForeSceneBrowserWorkScript(): string {
  return `(() => {
    const api = window.foreScene;
    if (!api) return;
        api.cancelPackageExport?.();
        api.cancelShotVideoRender?.();
        api.cancelShotStillPreparation?.();
        api.cancelRenderWork?.();
        api.cancelCharacterImport?.();
  })()`;
}
