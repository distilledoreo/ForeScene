import { describe, expect, it, beforeEach } from 'vitest';
import { createForeSceneBrowserApi } from '../src/engine/agent/browserApi';
import { AGENT_RESET_AUTHORIZATION, resetAgentProject } from '../src/engine/agent/projectReset';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { createDefaultProject } from '../src/domain/defaults';
import { clearAgentHistory } from '../src/engine/agent/history';

describe('agent resetProject', () => {
  beforeEach(() => {
    clearAgentHistory();
    useProjectStore.getState().setProject(createDefaultProject());
    useAgentControlStore.getState().setControlMode('read-only');
    useProjectSafetyStore.setState({
      runDestructiveProjectMutation: undefined,
      flushProject: undefined,
      criticalWrite: false,
      activeRevisionId: 'rev-test',
    });
  });

  it('requires write access', async () => {
    const result = await resetAgentProject({
      name: 'New',
      resetAuthorization: AGENT_RESET_AUTHORIZATION,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('write_access_required');
  });

  it('requires explicit reset authorization even with write access', async () => {
    useAgentControlStore.getState().setControlMode('read-write');
    useProjectSafetyStore.setState({
      runDestructiveProjectMutation: async (_reason, mutate) => {
        await mutate();
        return { revision: { id: 'rev-after' } } as never;
      },
    });
    const result = await resetAgentProject({ name: 'New' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('reset_authorization_required');
  });

  it('replaces the project when authorized', async () => {
    useAgentControlStore.getState().setControlMode('read-write');
    const beforeId = useProjectStore.getState().project.id;
    useProjectSafetyStore.setState({
      runDestructiveProjectMutation: async (_reason, mutate) => {
        await mutate();
        return { revision: { id: 'rev-after' } } as never;
      },
    });
    const result = await resetAgentProject({
      name: 'Graybox Music Video',
      description: 'test',
      aspectRatio: '16:9',
      resetAuthorization: AGENT_RESET_AUTHORIZATION,
    });
    expect(result.ok).toBe(true);
    expect(result.projectId).toBeTruthy();
    expect(result.projectId).not.toBe(beforeId);
    expect(useProjectStore.getState().project.name).toBe('Graybox Music Video');
    expect(useProjectStore.getState().project.scene.objects.some((object) => object.name.includes('Temple'))).toBe(false);
  });

  it('exposes resetProject on the browser API and capabilities', async () => {
    useAgentControlStore.getState().setControlMode('read-write');
    useProjectSafetyStore.setState({
      runDestructiveProjectMutation: async (_reason, mutate) => {
        await mutate();
        return { revision: { id: 'rev-after' } } as never;
      },
    });
    const api = createForeSceneBrowserApi();
    expect(api.getCapabilities().projectReplacement).toBe(true);
    expect(api.getCapabilities().commands.mutate).toContain('project.reset');
    const result = await api.resetProject({
      name: 'Via API',
      resetAuthorization: 'reset-project',
    });
    expect(result.ok).toBe(true);
    const doc = api.getProjectDocument();
    expect(doc.name).toBe('Via API');
  });

  it('rolls back when persistence throws after mutate', async () => {
    useAgentControlStore.getState().setControlMode('read-write');
    const before = structuredClone(useProjectStore.getState().project);
    useProjectSafetyStore.setState({
      runDestructiveProjectMutation: async (_reason, mutate) => {
        await mutate();
        throw new Error('persist boom');
      },
    });
    const result = await resetAgentProject({
      name: 'Should Rollback',
      resetAuthorization: AGENT_RESET_AUTHORIZATION,
    });
    expect(result.ok).toBe(false);
    expect(useProjectStore.getState().project.id).toBe(before.id);
    expect(useProjectStore.getState().project.name).toBe(before.name);
  });
});
