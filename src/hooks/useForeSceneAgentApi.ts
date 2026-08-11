/**
 * Registers `window.foreScene` idempotently.
 * Identity check matters under React Strict Mode double-mount.
 *
 * captureShotThumbnail keeps the legacy sampled-render behavior (including
 * timeSeconds) but returns the declared materialization-shaped fields as well.
 * Full await-all prepared-media capture is exposed separately.
 */

import { useEffect } from 'react';
import { createForeSceneBrowserApi } from '../engine/agent/browserApi';
import type { ForeSceneAgentStatus, ForeSceneBrowserApi } from '../engine/agent/protocol';
import { renderWorkCoordinator } from '../engine/renderWorkCoordinator';

function statusIsBusy(status: ForeSceneAgentStatus): boolean {
  return status.busy.criticalWrite
    || status.busy.grayboxRender
    || status.busy.packageExport
    || status.busy.videoRender
    || status.busy.characterImport;
}

/**
 * Apply the exact runtime facade installed on window.foreScene.
 * Exported so protocol/compatibility tests exercise installed behavior.
 */
export function applyForeSceneAgentApiFacade(api: ForeSceneBrowserApi): ForeSceneBrowserApi {
  const baseGetStatus = api.getStatus.bind(api);
  const mutableApi = api as ForeSceneBrowserApi;

  // The v1 busy schema has no separate prepared-media field. Fold coordinator
  // activity into the existing render-busy bit on the installed surface so CLI
  // getStatus/waitForIdle cannot report idle while a still/video GPU job is live.
  mutableApi.getStatus = () => {
    const status = baseGetStatus();
    const renderStatus = renderWorkCoordinator.getStatus();
    const preparedBusy = renderStatus.activeCount > 0 || renderStatus.queueLength > 0;
    if (!preparedBusy || status.busy.videoRender) return status;
    return {
      ...status,
      busy: { ...status.busy, videoRender: true },
    };
  };

  mutableApi.waitForIdle = async (options = {}) => {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const startedAt = Date.now();
    while (true) {
      const status = mutableApi.getStatus();
      if (!statusIsBusy(status)) return status;
      if (Date.now() - startedAt >= timeoutMs) return status;
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
  };

  return mutableApi;
}

export function useForeSceneAgentApi(): void {
  useEffect(() => {
    const api = applyForeSceneAgentApiFacade(createForeSceneBrowserApi());
    window.foreScene = api;

    return () => {
      if (window.foreScene === api) delete window.foreScene;
    };
  }, []);
}
