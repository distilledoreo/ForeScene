import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type { LocationProject } from '../src/domain/types';
import {
  applyAgentPlan,
  clearAgentHistory,
  commitPreparedPlanToStore,
  undoLastAgentPlan,
} from '../src/engine/agent/transaction';
import { prepareAgentPlan } from '../src/engine/agent/planCompiler';
import { projectFingerprint } from '../src/engine/agent/planDiff';
import { agentHistorySize } from '../src/engine/agent/history';
import {
  ProjectPersistenceController,
} from '../src/engine/projectPersistenceController';
import { listProjectRevisionSummaries } from '../src/engine/projectSafety';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

async function resetSafetyStorage() {
  resetProjectAssetStoreForTests();
  resetModelAssetStoreForTests();
  await resetProjectRevisionStoreForTests();
}

function installMockDestructiveMutation() {
  useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (_reason, mutation) => {
    await mutation();
    const project = useProjectStore.getState().project;
    return {
      project: structuredClone(project),
      revision: {
        id: `rev_${Date.now().toString(36)}`,
        projectId: project.id,
        kind: 'autosave' as const,
        reason: 'test',
        createdAt: new Date().toISOString(),
        manifest: '{}',
        resources: { projectAssetKeys: [], modelAssetKeys: [] },
      },
    };
  });
}

describe('agent transaction apply/undo', () => {
  beforeEach(() => {
    clearAgentHistory();
    useAgentControlStore.setState({ controlMode: 'read-write' });
    const project = createDefaultProject();
    useProjectStore.setState({
      project,
      workspace: 'build',
      selectedObjectIds: [],
      selectedShotId: project.shots[0]?.id,
      activePanoId: undefined,
      isRenderingGraybox: false,
      isExportingPackage: false,
    });
    useProjectSafetyStore.setState({
      criticalWrite: false,
      status: 'saved',
    });
    installMockDestructiveMutation();
  });

  afterEach(() => {
    clearAgentHistory();
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(undefined);
  });

  it('requires write access', async () => {
    useAgentControlStore.setState({ controlMode: 'read-only' });
    const result = await applyAgentPlan({
      version: 1,
      commands: [{ op: 'project.updateInfo', name: 'Nope' }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('write_access_required');
  });

  it('applies a multi-command plan in one store update', async () => {
    const seen: LocationProject[] = [];
    const unsubscribe = useProjectStore.subscribe((state, previous) => {
      if (state.project !== previous.project) {
        seen.push(state.project);
      }
    });

    const beforeCount = useProjectStore.getState().project.scene.objects.length;
    const result = await applyAgentPlan({
      version: 1,
      description: 'Two actors',
      commands: [
        {
          op: 'object.create',
          ref: 'actorA',
          object: { type: 'human_dummy', name: 'Actor A', position: [-1, 0, 0] },
        },
        {
          op: 'object.create',
          ref: 'actorB',
          object: { type: 'human_dummy', name: 'Actor B', position: [1, 0, 0] },
        },
        { op: 'project.updateInfo', name: 'Conversation Set' },
        { op: 'workspace.open', workspace: 'shots' },
      ],
    });
    unsubscribe();

    expect(result.ok).toBe(true);
    expect(result.verifiedRevisionId).toBeTruthy();
    expect(seen).toHaveLength(1);
    const project = useProjectStore.getState().project;
    expect(project.name).toBe('Conversation Set');
    expect(project.scene.objects.length).toBe(beforeCount + 2);
    expect(useProjectStore.getState().workspace).toBe('shots');
    expect(agentHistorySize()).toBe(1);
  });

  it('applies a 50-command plan as one committed project state', async () => {
    const commands = Array.from({ length: 50 }, (_, index) => ({
      op: 'object.create' as const,
      object: {
        type: 'box' as const,
        name: `Box ${index + 1}`,
        position: [index * 0.5, 0, 0] as [number, number, number],
      },
    }));
    const before = useProjectStore.getState().project.scene.objects.length;
    const result = await applyAgentPlan({ version: 1, commands });
    expect(result.ok).toBe(true);
    expect(useProjectStore.getState().project.scene.objects.length).toBe(before + 50);
    expect(result.summary?.affectedObjectIds).toHaveLength(50);
  });

  it('leaves the project unchanged when preparation fails', async () => {
    const before = structuredClone(useProjectStore.getState().project);
    const result = await applyAgentPlan({
      version: 1,
      commands: [
        { op: 'object.create', object: { type: 'box', name: 'Keep me out' } },
        {
          op: 'object.update',
          object: { id: 'missing' },
          updates: { visible: false },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(useProjectStore.getState().project).toEqual(before);
    expect(agentHistorySize()).toBe(0);
  });

  it('undo restores the preceding project when no manual edits followed', async () => {
    const beforeName = useProjectStore.getState().project.name;
    const apply = await applyAgentPlan({
      version: 1,
      description: 'Rename',
      commands: [{ op: 'project.updateInfo', name: 'After Agent' }],
    });
    expect(apply.ok).toBe(true);
    expect(useProjectStore.getState().project.name).toBe('After Agent');

    const undo = await undoLastAgentPlan();
    expect(undo.ok).toBe(true);
    expect(useProjectStore.getState().project.name).toBe(beforeName);
    expect(agentHistorySize()).toBe(0);
  });

  it('refuses undo after a manual edit changes the fingerprint', async () => {
    await applyAgentPlan({
      version: 1,
      commands: [{ op: 'project.updateInfo', name: 'Agent Edit' }],
    });
    const edited = structuredClone(useProjectStore.getState().project);
    edited.name = 'Manual Edit';
    edited.updatedAt = new Date().toISOString();
    useProjectStore.setState({ project: edited });

    const undo = await undoLastAgentPlan();
    expect(undo.ok).toBe(false);
    expect(undo.diagnostics[0]?.code).toBe('stale_revision');
    expect(useProjectStore.getState().project.name).toBe('Manual Edit');
  });

  it('restores pre-plan state when persistence throws after the live commit', async () => {
    const before = structuredClone(useProjectStore.getState().project);
    const beforeSelection = [...useProjectStore.getState().selectedObjectIds];
    const beforeShot = useProjectStore.getState().selectedShotId;
    const beforeWorkspace = useProjectStore.getState().workspace;

    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(async (_reason, mutation) => {
      await mutation();
      throw new Error('Simulated persistence failure after commit');
    });

    const result = await applyAgentPlan({
      version: 1,
      description: 'Should roll back',
      commands: [
        {
          op: 'object.create',
          object: { type: 'box', name: 'Transient Crate', position: [2, 0, 0] },
        },
        { op: 'project.updateInfo', name: 'Should Not Stick' },
        { op: 'workspace.open', workspace: 'shots' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('apply_failed');
    expect(agentHistorySize()).toBe(0);
    expect(useProjectStore.getState().project).toEqual(before);
    expect(useProjectStore.getState().selectedObjectIds).toEqual(beforeSelection);
    expect(useProjectStore.getState().selectedShotId).toBe(beforeShot);
    expect(useProjectStore.getState().workspace).toBe(beforeWorkspace);
  });

  it('commitPreparedPlanToStore replaces selection in one setState', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    actor.name = 'Prepared Actor';
    const next = structuredClone(project);
    next.scene.objects.push(actor);
    next.name = 'Prepared';
    next.updatedAt = new Date().toISOString();

    const prepared = prepareAgentPlan({
      version: 1,
      commands: [{ op: 'project.updateInfo', name: 'unused' }],
    }, {
      project,
      workspace: 'build',
      selectedObjectIds: [],
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // Override with a hand-built prepared payload for store commit shape.
    prepared.prepared.nextProject = next;
    prepared.prepared.nextSelection = {
      selectedObjectIds: [actor.id],
      workspace: 'build',
    };
    commitPreparedPlanToStore(prepared.prepared);
    expect(useProjectStore.getState().project.name).toBe('Prepared');
    expect(useProjectStore.getState().selectedObjectIds).toEqual([actor.id]);
  });
});

describe('agent transaction with real persistence', () => {
  beforeEach(async () => {
    await resetSafetyStorage();
    clearAgentHistory();
    useAgentControlStore.setState({ controlMode: 'read-write' });
  });

  afterEach(async () => {
    clearAgentHistory();
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation(undefined);
    await resetSafetyStorage();
  });

  it('delete plans produce a verified recovery snapshot', async () => {
    const controller = new ProjectPersistenceController({
      debounceMs: 1,
      onStateChange: (state) => useProjectSafetyStore.getState().setPersistenceState(state),
    });
    const project = createDefaultProject();
    const doomed = createSceneObject('box', 1);
    doomed.name = 'Doomed Crate';
    project.scene.objects.push(doomed);
    useProjectStore.setState({
      project,
      workspace: 'build',
      selectedObjectIds: [doomed.id],
      selectedShotId: project.shots[0]?.id,
    });
    controller.start(project);
    await controller.flushAndLoadActiveRevision('Initial');

    useProjectSafetyStore.getState().setRunDestructiveProjectMutation((reason, mutation) => (
      controller.runDestructiveMutation(
        useProjectStore.getState().project,
        reason,
        mutation,
        () => useProjectStore.getState().project,
      )
    ));

    const result = await applyAgentPlan({
      version: 1,
      description: 'Delete crate',
      commands: [
        { op: 'object.delete', object: { id: doomed.id } },
      ],
    });
    expect(result.ok).toBe(true);
    expect(useProjectStore.getState().project.scene.objects.some((object) => object.id === doomed.id)).toBe(false);

    const revisions = await listProjectRevisionSummaries(project.id);
    expect(revisions.some((revision) => (
      revision.kind === 'snapshot' && revision.reason.includes('Delete crate')
    ))).toBe(true);
    expect(projectFingerprint(useProjectStore.getState().project)).not.toBe(projectFingerprint(project));
  });
});
