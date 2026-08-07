/**
 * Registers `window.foreScene` idempotently.
 * Identity check matters under React Strict Mode double-mount.
 *
 * The v1 captureShotThumbnail runtime contract remains a sampled clay render.
 * Prepared-media capture is exposed as an additive API so legacy calls keep the
 * same timing, persistence, and busy-state semantics.
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

    // Additive prepared-media API for callers that want await-all materialization.
    mutableApi.captureShotPreparedMedia = async (input) => {
      const result = await preparedCapture({ shotId: input.shotId });
      // The internal materialization implementation historically wrote the selected
      // primary into the clay legacy slot. Restore canonical clay/projected aliases.
      restorePreparedLegacyViewportSlots(input.shotId);
      return result;
    };

    // Compatibility facade: preserve the original sampled-render result/timeSeconds
    // and do not silently launch background prepared-media work.
    mutableApi.captureShotThumbnail = async (input) => {
      const rendered = await api.renderShotFrame({
        shotId: input.shotId,
        timeSeconds: input.timeSeconds,
        appearance: 'clay',
      });
      if (!rendered.ok || !rendered.pngDataUrl) return rendered;

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