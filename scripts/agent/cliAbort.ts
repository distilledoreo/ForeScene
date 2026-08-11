/**
 * Shared Node-side abort scope for long-running agent CLI sessions.
 */

export interface CliAbortScope {
  readonly signal: AbortSignal;
  throwIfAborted: () => void;
  cancelBrowserWork: (evaluate: (fn: () => void) => Promise<void>) => Promise<void>;
  dispose: () => void;
}

export function createCliAbortScope(): CliAbortScope {
  const controller = new AbortController();
  const handlers: Array<() => void> = [];

  const dispose = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const remove of handlers.splice(0)) remove();
  };

  const onSignal = () => dispose();
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
      const error = new Error('Agent CLI run was cancelled.');
      error.name = 'AbortError';
      throw error;
    },
    async cancelBrowserWork(evaluate) {
      if (!controller.signal.aborted) return;
      await evaluate(() => {
        const api = window.foreScene;
        if (!api) return;
        api.cancelPackageExport?.();
        api.cancelShotVideoRender?.();
        api.cancelShotStillPreparation?.();
        api.cancelRenderWork?.();
      }).catch(() => undefined);
    },
    dispose,
  };
}
