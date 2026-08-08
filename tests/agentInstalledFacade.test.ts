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

  it('honors timeSeconds and returns the declared materialization result fields', async () => {
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
      status: 'completed',
      shotId: shot.id,
      width: 64,
      height: 36,
      pngDataUrl: 'data:image/png;base64,AAAA',
      diagnostics: [],
    }));
    const api = {
      getStatus: vi.fn(() => idleStatus()),
      waitForIdle: vi.fn(async () => idleStatus()),
      renderShotFrame,
      captureShotThumbnail: vi.fn(async () => preparedResult),
    } as unknown as ForeSceneBrowserApi;

    const installed = applyForeSceneAgentApiFacade(api);
    const result = await installed.captureShotThumbnail({ shotId: shot.id, timeSeconds: 1.5 });

    expect(renderShotFrame).toHaveBeenCalledWith({
      shotId: shot.id,
      timeSeconds: 1.5,
      appearance: 'clay',
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.revisionId).toBe('revision-test');
    expect(result.primaryStillAssetId).toBeTruthy();
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.key).toBe('sampled-clay-thumbnail@1.5');
    expect(result.warnings).toEqual([]);

    const prepared = await (installed as ForeSceneBrowserApi & {
      captureShotPreparedMedia?: (input: { shotId: string }) => Promise<AgentShotMaterializationResult>;
    }).captureShotPreparedMedia?.({ shotId: shot.id });
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
});
