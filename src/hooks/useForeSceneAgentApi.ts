/**
 * Registers `window.foreScene` idempotently.
 * Identity check matters under React Strict Mode double-mount.
 *
 * The v1 captureShotThumbnail runtime contract remains a sampled clay render.
 * Prepared-media capture is additive and runs before the requested thumbnail is
 * attached, so existing agents keep their timeSeconds semantics while the shot
 * still gets its configured deterministic references.
 */

import { useEffect } from 'react';
import type { Shot } from '../domain/types';
import { createForeSceneBrowserApi } from '../engine/agent/browserApi';
import { useProjectSafetyStore } from '../state/useProjectSafetyStore';
import { useProjectStore } from '../state/useProjectStore';

function restorePreparedLegacyViewportSlots(shotId: string): void {
  useProjectStore.setState((state) => {
    const shot = state.project.shots.find((item) => item.id === shotId);
    if (!shot?.materializedMedia) return state;

    let assets: Shot['assets'] = { ...shot.assets };
    for (const artifact of Object.values(shot.materializedMedia.stills)) {
      if (artifact.kind === 'clay-viewport') {
        if (artifact.peopleVariant === 'clean_plate') {
          assets.viewportCleanPlateAssetId = artifact.assetId;
        } else {
          assets.viewportRenderAssetId = artifact.assetId;
        }
      } else if (artifact.kind === 'projected-viewport') {
        if (artifact.peopleVariant === 'clean_plate') {
          assets.viewportProjectedCleanPlateAssetId = artifact.assetId;
        } else {
          assets.viewportProjectedAssetId = artifact.assetId;
        }
      }
    }

    return {
      ...state,
      project: {
        ...state.project,
        shots: state.project.shots.map((item) =>
          item.id === shotId ? { ...item, assets } : item
        ),
      },
    };
  });
}

export function useForeSceneAgentApi(): void {
  useEffect(() => {
    const api = createForeSceneBrowserApi();
    const preparedCapture = api.captureShotThumbnail.bind(api);
    const mutableApi = api as unknown as Record<string, unknown> & {
      captureShotThumbnail: (input: { shotId: string; timeSeconds?: number }) => Promise<unknown>;
      captureShotPreparedMedia?: (input: { shotId: string }) => Promise<unknown>;
    };

    const capturePreparedMedia = async (input: { shotId: string }) => {
      const result = await preparedCapture({ shotId: input.shotId });
      restorePreparedLegacyViewportSlots(input.shotId);
      return result;
    };

    // Additive prepared-media API for callers that want the richer materialization result.
    mutableApi.captureShotPreparedMedia = capturePreparedMedia;

    // Compatibility facade: honor the original sampled-render result and timeSeconds.
    mutableApi.captureShotThumbnail = async (input) => {
      const rendered = await api.renderShotFrame({
        shotId: input.shotId,
        timeSeconds: input.timeSeconds,
        appearance: 'clay',
      });
      if (!rendered.ok || !rendered.pngDataUrl) return rendered;

      // Prepare configured references first. Failure here must not change the v1
      // sampled-thumbnail success contract; runtime prepared-media status exposes it.
      try {
        await capturePreparedMedia({ shotId: input.shotId });
      } catch {
        // Best effort — the requested thumbnail is still valid and attachable.
      }

      const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
      if (!runDestructive) {
        return {
          ...rendered,
          ok: false,
          status: 'failed' as const,
          diagnostics: [{
            code: 'busy',
            message: 'Project persistence is not ready.',
          }],
        };
      }

      try {
        await runDestructive('Attach shot thumbnail', () => {
          useProjectStore.getState().attachViewportRenderToShot(input.shotId, {
            name: `shot_${input.shotId}_thumbnail.png`,
            dataUrl: rendered.pngDataUrl!,
            width: rendered.width,
            height: rendered.height,
          });
        });
        return rendered;
      } catch (error) {
        return {
          ...rendered,
          ok: false,
          status: 'failed' as const,
          diagnostics: [{
            code: 'thumbnail_attach_failed',
            message: error instanceof Error ? error.message : 'Could not attach shot thumbnail.',
          }],
        };
      }
    };

    window.foreScene = api;

    return () => {
      if (window.foreScene === api) {
        delete window.foreScene;
      }
    };
  }, []);
}