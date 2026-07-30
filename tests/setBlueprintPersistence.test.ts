import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { compileSetBlueprint } from '../src/engine/setBlueprintCompiler';
import {
  ProjectPersistenceController,
  type ProjectPersistenceState,
} from '../src/engine/projectPersistenceController';
import { listProjectRevisionSummaries, recoverLatestProject } from '../src/engine/projectSafety';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { useProjectStore } from '../src/state/useProjectStore';
import { trainStationBlueprint } from './fixtures/setBlueprints';

async function resetSafetyStorage() {
  resetProjectAssetStoreForTests();
  resetModelAssetStoreForTests();
  await resetProjectRevisionStoreForTests();
}

/**
 * Mirrors useProjectLifecycle.createProjectFromBlueprint without React.
 */
async function createProjectFromBlueprint(
  controller: ProjectPersistenceController,
  compiled: ReturnType<typeof compileSetBlueprint>,
) {
  const current = useProjectStore.getState().project;
  const next = compiled.project;
  await controller.createSnapshot(
    current,
    `Before creating AI-generated set “${next.name}”`,
  );
  await controller.commitProject(next, {
    kind: 'import',
    reason: `Created AI-generated set: ${next.name}`,
  });
  controller.ignoreNextProjectChange(next);
  useProjectStore.getState().setProject(next);
  useProjectStore.getState().clearObjectSelection();
  useProjectStore.getState().setWorkspace('build');
}

describe('createProjectFromBlueprint persistence', () => {
  beforeEach(async () => {
    await resetSafetyStorage();
    useProjectStore.getState().setProject(createDefaultProject());
  });
  afterEach(resetSafetyStorage);

  it('replaces the project once, resets selection, and creates a recovery revision', async () => {
    const states: ProjectPersistenceState[] = [];
    const controller = new ProjectPersistenceController({
      debounceMs: 1,
      onStateChange: (state) => states.push(state),
    });
    const previous = useProjectStore.getState().project;
    previous.name = 'Previous Temple';
    controller.start(previous);
    await controller.flush('Initial local save');

    const compiled = compileSetBlueprint(trainStationBlueprint);
    await createProjectFromBlueprint(controller, compiled);

    const live = useProjectStore.getState();
    expect(live.project.name).toBe(trainStationBlueprint.name);
    expect(live.project.scene.objects).toHaveLength(trainStationBlueprint.objects.length);
    expect(live.selectedObjectIds).toEqual([]);
    expect(live.workspace).toBe('build');
    expect(live.buildMode).toBe('select');

    const previousRevisions = await listProjectRevisionSummaries(previous.id);
    expect(previousRevisions.some((revision) => (
      revision.kind === 'snapshot'
      && revision.reason.includes('Before creating AI-generated set')
    ))).toBe(true);

    const recovered = await recoverLatestProject();
    expect(recovered?.project.name).toBe(trainStationBlueprint.name);
    expect(recovered?.project.scene.objects).toHaveLength(trainStationBlueprint.objects.length);

    const finalState = states[states.length - 1];
    expect(finalState?.status).not.toBe('saving');
  });

  it('does not replace the last verified revision when commit fails', async () => {
    const controller = new ProjectPersistenceController({
      debounceMs: 1,
      onStateChange: () => undefined,
    });
    const previous = useProjectStore.getState().project;
    previous.name = 'Keep Me';
    controller.start(previous);
    await controller.flush('Initial local save');

    const compiled = compileSetBlueprint(trainStationBlueprint);
    const commitSpy = vi.spyOn(controller, 'commitProject').mockRejectedValueOnce(new Error('disk full'));

    await expect(createProjectFromBlueprint(controller, compiled)).rejects.toThrow('disk full');
    expect(useProjectStore.getState().project.name).toBe('Keep Me');

    const recovered = await recoverLatestProject();
    expect(recovered?.project.name).toBe('Keep Me');
    commitSpy.mockRestore();
  });
});
