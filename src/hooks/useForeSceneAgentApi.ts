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
import type {
  AgentShotMaterializationResult,
  ForeSceneBrowserApi,
} from '../engine/agent/protocol';
import { useProjectSafetyStore } from '../state/useProjectSafetyStore';
import { useProjectStore } from '../state/useProjectStore';

/**
 * Apply the exact runtime facade installed on window.foreScene.
 * Exported so protocol/compatibility tests exercise the installed behavior rather
 * than source-grepping the underlying browser API implementation.
 */
export function applyForeSceneAgentApiFacade(api: ForeSceneBrowserApi): ForeSceneBrowserApi {
  const preparedCapture = api.captureShotThumbnail.bind(api);
  const mutableApi = api as ForeSceneBrowserApi & {
    captureShotPreparedMedia?: (input: { shotId: string }) => Promise<AgentShotMaterializationResult>;
  };

  mutableApi.captureShotPreparedMedia = (input) => preparedCapture({ shotId: input.shotId });

  mutableApi.captureShotThumbnail = async (input): Promise<AgentShotMaterializationResult> => {
    const rendered = await api.renderShotFrame({
      shotId: input.shotId,
      timeSeconds: input.timeSeconds,
      appearance: 'clay',
    });
    const baseResult = {
      ...rendered,
      shotId: input.shotId,
      revisionId: useProjectSafetyStore.getState().activeRevisionId ?? '',
      primaryStillAssetId: undefined as string | undefined,
      artifacts: [] as AgentShotMaterializationResult['artifacts'],
      warnings: [] as string[],
    };

    if (!rendered.ok || !rendered.pngDataUrl) {
      return {
        ...baseResult,
        ok: false,
        status: 'failed',
        warnings: ['Sampled thumbnail render did not produce attachable PNG data.'],
      };
    }

    const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
    if (!runDestructive) {
      return {
        ...baseResult,
        ok: false,
        status: 'failed',
        diagnostics: [{ code: 'busy', message: 'Project persistence is not ready.', severity: 'error' }],
        warnings: ['Project persistence is not ready.'],
      };
    }

    let attachedAssetId: string | undefined;
    try {
      await runDestructive('Attach shot thumbnail', () => {
        const asset = useProjectStore.getState().attachViewportRenderToShot(input.shotId, {
          name: `shot_${input.shotId}_thumbnail.png`,
          dataUrl: rendered.pngDataUrl!,
          width: rendered.width,
          height: rendered.height,
        });
        attachedAssetId = asset.id;
      });
      return {
        ...baseResult,
        ok: true,
        status: 'ready',
        revisionId: useProjectSafetyStore.getState().activeRevisionId ?? baseResult.revisionId,
        primaryStillAssetId: attachedAssetId,
        artifacts: attachedAssetId ? [{
          key: `sampled-clay-thumbnail@${input.timeSeconds ?? 0}`,
          status: 'rendered',
          assetId: attachedAssetId,
        }] : [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not attach shot thumbnail.';
      return {
        ...baseResult,
        ok: false,
        status: 'failed',
        diagnostics: [{ code: 'thumbnail_attach_failed', message, severity: 'error' }],
        warnings: [message],
      };
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
