import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { projectFingerprint } from '../src/engine/agent/planDiff';
import {
  projectStateFingerprint,
  runVerifiedAgentMutation,
  verifyProjectMutationScope,
} from '../src/engine/agent/verifiedMutation';
import { restoreAgentProjectRevision } from '../src/engine/agent/projectHealthControl';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

vi.mock('../src/engine/agent/projectHealthControl', () => ({
  restoreAgentProjectRevision: vi.fn(),
}));

function revision(id: string) {
  const project = useProjectStore.getState().project;
  return {
    project: structuredClone(project),
    revision: {
      id,
      projectId: project.id,
      kind: 'autosave' as const,
      reason: 'test',
      createdAt: new Date().toISOString(),
      manifest: JSON.stringify(project),
      resources: { projectAssetKeys: [], modelAssetKeys: [] },
    },
  };
}

function installPersistenceMocks() {
  useProjectSafetyStore.setState({
    flushProject: vi.fn(async () => revision('checkpoint')),
    runDestructiveProjectMutation: vi.fn(async (_reason, mutation) => {
      await mutation();
      return revision('applied');
    }),
  });
}

describe('verified agent mutations', () => {
  beforeEach(() => {
    useAgentControlStore.getState().setControlMode('read-write');
    useProjectStore.getState().setProject(createDefaultProject());
    installPersistenceMocks();
    vi.mocked(restoreAgentProjectRevision).mockReset();
  });

  afterEach(() => {
    useAgentControlStore.getState().setControlMode('off');
    useProjectSafetyStore.setState({ flushProject: undefined, runDestructiveProjectMutation: undefined });
  });

  it('returns completed only after the postcondition succeeds', async () => {
    const project = useProjectStore.getState().project;
    const result = await runVerifiedAgentMutation({
      description: 'Rename verified project',
      plan: {
        version: 1,
        expectedFingerprint: projectFingerprint(project),
        commands: [{ op: 'project.updateInfo', name: 'Verified name' }],
      },
      failurePolicy: 'rollback',
      verify: async ({ after }) => ({ ok: after.name === 'Verified name' }),
      isVerificationSuccessful: (verification) => verification.ok,
    });

    expect(result).toMatchObject({ ok: true, status: 'completed', checkpointRevisionId: 'checkpoint' });
    expect(result.apply.ok).toBe(true);
    expect(useProjectStore.getState().project.name).toBe('Verified name');
  });

  it('automatically restores the exact starting project after a failed postcondition', async () => {
    const starting = structuredClone(useProjectStore.getState().project);
    vi.mocked(restoreAgentProjectRevision).mockImplementation(async () => {
      useProjectStore.setState({ project: structuredClone(starting) });
      return { ok: true, revisionId: 'rollback-revision', diagnostics: [] };
    });

    const result = await runVerifiedAgentMutation({
      description: 'Mutation with a bad postcondition',
      plan: {
        version: 1,
        commands: [{ op: 'project.updateInfo', name: 'Invalid result' }],
      },
      failurePolicy: 'rollback',
      verify: async () => ({ ok: false }),
      isVerificationSuccessful: (verification) => verification.ok,
    });

    expect(result).toMatchObject({ ok: false, status: 'rolled_back' });
    expect(result.rollback).toMatchObject({ ok: true, projectStateRestored: true });
    expect(vi.mocked(restoreAgentProjectRevision)).toHaveBeenCalledWith({ revisionId: 'checkpoint' });
    expect(projectFingerprint(useProjectStore.getState().project)).toBe(projectFingerprint(starting));
    expect(projectStateFingerprint(useProjectStore.getState().project)).toBe(projectStateFingerprint(starting));
  });

  it('detects changes outside the declared mutation scope', () => {
    const before = createDefaultProject();
    const after = structuredClone(before);
    after.shots[0]!.camera.fovDegrees += 3;

    expect(verifyProjectMutationScope(before, after, { allowedShotIds: [after.shots[0]!.id] })).toMatchObject({
      ok: false,
      errors: [`Camera changed for shot ${after.shots[0]!.shotNumber}.`],
    });

    after.shots[0]!.camera.fovDegrees -= 3;
    after.scene.objects[0]!.name = 'unrelated mutation';
    expect(verifyProjectMutationScope(before, after, { allowedShotIds: [after.shots[0]!.id] }).ok).toBe(false);
  });
});
