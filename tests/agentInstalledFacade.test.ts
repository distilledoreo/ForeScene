import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type {
  AgentShotMaterializationResult,
  ForeSceneBrowserApi,
} from '../src/engine/agent/protocol';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { applyForeSceneAgentApiFacade } from '../src/hooks/useForeSceneAgentApi';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

describe('installed ForeScene agent facade', () => {
  afterEach(() => {
    resetProjectAssetStoreForTests();
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
});
