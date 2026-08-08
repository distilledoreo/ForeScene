/**
 * Registers `window.foreScene` idempotently.
 * Identity check matters under React Strict Mode double-mount.
 *
 * captureShotThumbnail keeps the legacy sampled-render behavior (including
 * timeSeconds) but now returns the declared materialization-shaped fields as
 * well. Full await-all prepared-media capture is exposed separately.
 */

import { useEffect } from 'react';
import { createForeSceneBrowserApi } from '../engine/agent/browserApi';
import { useProjectSafetyStore } from '../state/useProjectSafetyStore';
import { useProjectStore } from '../state/useProjectStore';

export function useForeSceneAgentApi(): void {
  useEffect(() => {
    const api = createForeSceneBrowserApi();
    const preparedCapture = api.captureShotThumbnail.bind(api);
    const mutableApi = api as unknown as Record<string, unknown> & {
      captureShotThumbnail: (input: { shotId: string; timeSeconds?: number }) => Promise<unknown>;
      captureShotPreparedMedia?: (input: { shotId: string }) => Promise<unknown>;
    };

    // Explicit await-all prepared-media API. The canonical materializer already
    // maintains legacy clay/projected aliases transactionally; no raw store repair
    // is needed here.
    mutableApi.captureShotPreparedMedia = (input) => preparedCapture({ shotId: input.shotId });

    // Compatibility facade: preserve sampled-frame/timeSeconds semantics while
    // also satisfying the declared AgentShotMaterializationResult shape. Extra
    // render fields remain present for older runtime callers.
    mutableApi.captureShotThumbnail = async (input) => {
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
        artifacts: [] as Array<{
          key: string;
          status: 'current' | 'rendered' | 'failed' | 'skipped';
          assetId?: string;
        }>,
        warnings: [] as string[],
      };

      if (!rendered.ok || !rendered.pngDataUrl) {
        return {
          ...baseResult,
          ok: false,
          status: 'failed' as const,
          warnings: ['Sampled thumbnail render did not produce attachable PNG data.'],
        };
      }

      const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
      if (!runDestructive) {
        return {
          ...baseResult,
          ok: false,
          status: 'failed' as const,
          diagnostics: [{ code: 'busy', message: 'Project persistence is not ready.' }],
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
          status: 'ready' as const,
          revisionId: useProjectSafetyStore.getState().activeRevisionId ?? baseResult.revisionId,
          primaryStillAssetId: attachedAssetId,
          artifacts: attachedAssetId ? [{
            key: `sampled-clay-thumbnail@${input.timeSeconds ?? 0}`,
            status: 'rendered' as const,
            assetId: attachedAssetId,
          }] : [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not attach shot thumbnail.';
        return {
          ...baseResult,
          ok: false,
          status: 'failed' as const,
          diagnostics: [{ code: 'thumbnail_attach_failed', message }],
          warnings: [message],
        };
      }
    };

    window.foreScene = api;

    return () => {
      if (window.foreScene === api) delete window.foreScene;
    };
  }, []);
}
