import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { createForeSceneBrowserApi } from '../src/engine/agent/browserApi';
import type {
  AgentShotMaterializationResult,
  ForeSceneBrowserApi,
} from '../src/engine/agent/protocol';
import { resetBackgroundVideoServiceForTests } from '../src/engine/backgroundVideoService';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

const shotStillActionMocks = vi.hoisted(() => ({
  captureShotStillPreparation: vi.fn(),
}));

vi.mock('../src/engine/shotStillActions', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/shotStillActions')>(
    '../src/engine/shotStillActions',
  );
  return { ...actual, captureShotStillPreparation: shotStillActionMocks.captureShotStillPreparation };
});

function materializationResult(
  project: ReturnType<typeof createDefaultProject>,
  status: AgentShotMaterializationResult['status'],
  warnings: string[] = [],
): AgentShotMaterializationResult {
  const shotId = project.shots[0]!.id;
  return {
    ok: status !== 'failed',
    shotId,
    revisionId: 'revision-prepared',
    status,
    primaryStillAssetId: status === 'failed' ? undefined : 'prepared-primary',
    artifacts: status === 'failed'
      ? [{ key: 'prepared', status: 'failed' }]
      : [{ key: 'prepared', status: 'rendered', assetId: 'prepared-primary' }],
    warnings,
    width: 64,
    height: 36,
    diagnostics: [],
  };
}

describe('agent capture materialization contract', () => {
  beforeEach(() => {
    const project = createDefaultProject();
    useProjectStore.setState({ project, selectedShotId: project.shots[0]!.id });
    useAgentControlStore.setState({ controlMode: 'read-write' });
    useProjectSafetyStore.setState({
      status: 'saved',
      activeRevisionId: 'revision-test',
      criticalWrite: false,
      flushProject: vi.fn(async () => undefined),
      runDestructiveProjectMutation: undefined,
    });
    shotStillActionMocks.captureShotStillPreparation.mockReset();
  });

  afterEach(() => {
    resetBackgroundVideoServiceForTests();
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.setState({
      status: 'unsaved',
      activeRevisionId: undefined,
      criticalWrite: false,
      flushProject: undefined,
      runDestructiveProjectMutation: undefined,
    });
  });

  it('drives captureShotPreparedMedia and preserves the declared await-all result shape', async () => {
    const project = useProjectStore.getState().project;
    const prepared = materializationResult(project, 'ready');
    shotStillActionMocks.captureShotStillPreparation.mockResolvedValue(prepared);

    const api: ForeSceneBrowserApi = createForeSceneBrowserApi();
    const result = await api.captureShotPreparedMedia({
      shotId: project.shots[0]!.id,
    });

    expect(shotStillActionMocks.captureShotStillPreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        shotId: project.shots[0]!.id,
        mode: 'await-all',
      }),
    );
    expect(shotStillActionMocks.captureShotStillPreparation).not.toHaveBeenCalledWith(
      expect.objectContaining({ timeSeconds: expect.anything() }),
    );
    expect(useProjectSafetyStore.getState().flushProject).toHaveBeenCalledWith(
      'Persist materialized shot stills',
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      primaryStillAssetId: 'prepared-primary',
      artifacts: [{ key: 'prepared', status: 'rendered', assetId: 'prepared-primary' }],
      warnings: [],
    });
  });

  it('never reports ready when primary materialization fails', async () => {
    const project = useProjectStore.getState().project;
    shotStillActionMocks.captureShotStillPreparation.mockResolvedValue(
      materializationResult(project, 'failed', ['Primary render failed.']),
    );

    const result = await createForeSceneBrowserApi().captureShotPreparedMedia({
      shotId: project.shots[0]!.id,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'prepared_media_failed', severity: 'error' }),
    ]);
  });
});
