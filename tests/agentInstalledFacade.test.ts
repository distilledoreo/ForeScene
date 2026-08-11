import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type {
  AgentShotMaterializationResult,
  ForeSceneBrowserApi,
} from '../src/engine/agent/protocol';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { applyForeSceneAgentApiFacade } from '../src/hooks/useForeSceneAgentApi';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

function idleStatus() {
  return {
    ready: true,
    apiVersion: '1',
    controlMode: 'read-write',
    writeAccess: true,
    projectLoaded: true,
    busy: {
      criticalWrite: false,
      grayboxRender: false,
      packageExport: false,
      videoRender: false,
      characterImport: false,
    },
    persistence: { ready: true, status: 'saved' },
  };
}

describe('installed ForeScene agent facade', () => {
  afterEach(() => {
    resetProjectAssetStoreForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('routes captureShotThumbnail through renderShotFrame and captureShotPreparedMedia separately', async () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    useProjectStore.setState({ project, selectedShotId: shot.id });

    const previousSafety = useProjectSafetyStore.getState();
    useProjectSafetyStore.setState({
      activeRevisionId: 'revision-test',
      runDestructiveProjectMutation: (async (_reason: string, mutate: () => void | Promise<void>) => {
        await mutate();
        return undefined;
      }) as typeof previousSafety.runDestructiveProjectMutation,
    });

    const preparedResult: AgentShotMaterializationResult = {
      ok: true,
      shotId: shot.id,
      revisionId: 'revision-prepared',
      status: 'ready',
      primaryStillAssetId: 'prepared-primary',
      artifacts: [{ key: 'prepared', status: 'rendered', assetId: 'prepared-primary' }],
      warnings: [],
      width: 64,
      height: 36,
      diagnostics: [],
    };
    const renderShotFrame = vi.fn(async () => ({
      ok: true,
      status: 'ready' as const,
      shotId: shot.id,
      revisionId: 'revision-test',
      width: 64,
      height: 36,
      pngDataUrl: 'data:image/png;base64,Y2xheQ==',
      diagnostics: [],
    }));
    const captureShotPreparedMedia = vi.fn(async () => preparedResult);
    const api = {
      getStatus: vi.fn(() => idleStatus()),
      waitForIdle: vi.fn(async () => idleStatus()),
      renderShotFrame,
      captureShotThumbnail: vi.fn(async (input: { shotId: string; timeSeconds?: number }) => {
        const rendered = await renderShotFrame({
          shotId: input.shotId,
          timeSeconds: input.timeSeconds,
          appearance: 'clay',
        });
        if (!rendered.ok || !rendered.pngDataUrl) {
          return {
            ...rendered,
            shotId: input.shotId,
            revisionId: 'revision-test',
            primaryStillAssetId: undefined,
            artifacts: [],
            warnings: ['Sampled thumbnail render did not produce attachable PNG data.'],
          };
        }
        let attachedAssetId: string | undefined;
        await useProjectSafetyStore.getState().runDestructiveProjectMutation?.('Attach shot thumbnail', () => {
          const asset = useProjectStore.getState().attachViewportRenderToShot(input.shotId, {
            name: `shot_${input.shotId}_thumbnail.png`,
            dataUrl: rendered.pngDataUrl!,
            width: rendered.width,
            height: rendered.height,
          });
          attachedAssetId = asset.id;
        });
        return {
          ...rendered,
          ok: true,
          status: 'ready' as const,
          shotId: input.shotId,
          revisionId: 'revision-test',
          primaryStillAssetId: attachedAssetId,
          artifacts: attachedAssetId ? [{
            key: `sampled-clay-thumbnail@${input.timeSeconds ?? 0}`,
            status: 'rendered' as const,
            assetId: attachedAssetId,
          }] : [],
          warnings: [],
        };
      }),
      captureShotPreparedMedia,
    } as unknown as ForeSceneBrowserApi;

    const installed = applyForeSceneAgentApiFacade(api);
    const result = await installed.captureShotThumbnail({ shotId: shot.id, timeSeconds: 1.5 });

    expect(renderShotFrame).toHaveBeenCalledWith({
      shotId: shot.id,
      timeSeconds: 1.5,
      appearance: 'clay',
    });
    expect(captureShotPreparedMedia).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.primaryStillAssetId).toBeTruthy();
    expect(result.artifacts[0]!.key).toBe('sampled-clay-thumbnail@1.5');

    const prepared = await installed.captureShotPreparedMedia({ shotId: shot.id });
    expect(captureShotPreparedMedia).toHaveBeenCalledWith({ shotId: shot.id });
    expect(prepared).toEqual(preparedResult);

    useProjectSafetyStore.setState({
      activeRevisionId: previousSafety.activeRevisionId,
      runDestructiveProjectMutation: previousSafety.runDestructiveProjectMutation,
    });
  });

  it('does not report idle while prepared-media coordinator work is active', async () => {
    const api = {
      getStatus: vi.fn(() => idleStatus()),
      waitForIdle: vi.fn(async () => idleStatus()),
      captureShotThumbnail: vi.fn(),
      renderShotFrame: vi.fn(),
    } as unknown as ForeSceneBrowserApi;
    const installed = applyForeSceneAgentApiFacade(api);

    let release!: () => void;
    const active = renderWorkCoordinator.schedule(
      'background-video',
      () => new Promise<void>((resolve) => { release = resolve; }),
      { ownerId: 'shot-busy' },
    );
    await Promise.resolve();

    expect(installed.getStatus().busy.videoRender).toBe(true);
    let settled = false;
    const waiting = installed.waitForIdle({ timeoutMs: 1_000 }).then((status) => {
      settled = true;
      return status;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    release();
    await active;
    const finalStatus = await waiting;
    expect(finalStatus.busy.videoRender).toBe(false);
  });

  it('does not report idle while prepared-media work is queued', async () => {
    const api = {
      getStatus: vi.fn(() => idleStatus()),
      waitForIdle: vi.fn(async () => idleStatus()),
      captureShotThumbnail: vi.fn(),
      renderShotFrame: vi.fn(),
    } as unknown as ForeSceneBrowserApi;
    const installed = applyForeSceneAgentApiFacade(api);

    let release!: () => void;
    const active = renderWorkCoordinator.schedule(
      'background-video',
      () => new Promise<void>((resolve) => { release = resolve; }),
      { ownerId: 'shot-active' },
    );
    await Promise.resolve();
    const queued = renderWorkCoordinator.schedule(
      'capture-primary-still',
      async () => undefined,
      { ownerId: 'shot-queued' },
    );

    expect(installed.getStatus().busy.videoRender).toBe(true);
    release();
    await active;
    await queued;
  });
});
