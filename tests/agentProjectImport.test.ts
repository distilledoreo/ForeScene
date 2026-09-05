import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { ProjectAsset } from '../src/domain/types';
import { openAgentProjectPackage } from '../src/engine/agent/projectImportControl';
import { createProjectPackage } from '../src/engine/projectIO';
import { ProjectPersistenceController } from '../src/engine/projectPersistenceController';
import {
  getProjectAssetBlob,
  resetProjectAssetStoreForTests,
  storeProjectAssetBlobDurable,
} from '../src/engine/projectAssetStore';
import { resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { resetProjectRevisionStoreForTests } from '../src/engine/projectRevisionStore';
import { listProjectRevisionSummaries, loadProjectRevision } from '../src/engine/projectSafety';
import { useAgentControlStore } from '../src/state/useAgentControlStore';
import { useProjectSafetyStore } from '../src/state/useProjectSafetyStore';
import { useProjectStore } from '../src/state/useProjectStore';

describe('agent project package import with real persistence', () => {
  let controller: ProjectPersistenceController | undefined;

  beforeEach(async () => {
    resetProjectAssetStoreForTests();
    resetModelAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
    useAgentControlStore.setState({ controlMode: 'read-write' });
    useProjectSafetyStore.setState({
      criticalWrite: false, activeRevisionId: undefined,
      runDestructiveProjectMutation: undefined, flushProject: undefined,
    });
  });

  afterEach(async () => {
    controller?.dispose();
    useAgentControlStore.setState({ controlMode: 'read-only' });
    useProjectSafetyStore.setState({
      runDestructiveProjectMutation: undefined, flushProject: undefined,
      criticalWrite: false,
    });
    resetProjectAssetStoreForTests();
    resetModelAssetStoreForTests();
    await resetProjectRevisionStoreForTests();
  });

  async function prepareCurrentProject() {
    const project = createDefaultProject();
    project.name = 'Current project before reopening backup';
    const asset = await storeProjectAssetBlobDurable<ProjectAsset>(project.id, {
      id: 'retained-image', type: 'image', name: 'retained.png', uri: '',
      mimeType: 'image/png', createdAt: new Date().toISOString(),
      metadata: { retainInProject: true },
    }, new Blob(['retained image bytes'], { type: 'image/png' }));
    project.assets.assets[asset.id] = asset;
    useProjectStore.getState().setProject(project);
    controller = new ProjectPersistenceController({
      onStateChange: (state) => useProjectSafetyStore.getState().setPersistenceState(state),
    });
    controller.start(useProjectStore.getState().project);
    const initial = await controller.flush('Initial project save');
    useProjectSafetyStore.getState().setRunDestructiveProjectMutation((reason, mutation) => (
      controller!.runDestructiveMutation(
        useProjectStore.getState().project,
        reason,
        mutation,
        () => useProjectStore.getState().project,
      )
    ));
    useProjectSafetyStore.getState().setFlushProject((reason) => (
      controller!.flushCurrentProject(useProjectStore.getState().project, reason)
    ));
    return { project, asset, initial: initial! };
  }

  it.each([undefined, false])('reopens same-ID backup bytes through recovery and verified save (preserveCurrentAsRecovery=%s)', async (preserveCurrentAsRecovery) => {
    const { project, asset, initial } = await prepareCurrentProject();
    const backupProject = structuredClone(project);
    backupProject.name = 'Reopened backup';
    const file = new File([await createProjectPackage(backupProject)], 'fixture.fsp');

    const result = await openAgentProjectPackage({ file, preserveCurrentAsRecovery });

    expect(result).toMatchObject({
      ok: true, persistenceConfirmed: true, projectId: project.id,
      projectName: backupProject.name, missingAssetCount: 0,
    });
    const importedAsset = useProjectStore.getState().project.assets.assets[asset.id]!;
    expect(importedAsset.storageKey).not.toBe(asset.storageKey);
    expect(await (await getProjectAssetBlob(importedAsset.storageKey!))?.text()).toBe('retained image bytes');
    const reopenedRevision = await loadProjectRevision(result.revisionId!);
    const savedAsset = reopenedRevision.project.assets.assets[asset.id]!;
    expect(await (await getProjectAssetBlob(savedAsset.storageKey!))?.text()).toBe('retained image bytes');
    expect((await loadProjectRevision(initial.revision.id)).project.name).toBe(project.name);
    const snapshots = (await listProjectRevisionSummaries(project.id)).filter((revision) => revision.kind === 'snapshot');
    expect(snapshots.length).toBeGreaterThan(0);
    expect((await loadProjectRevision(snapshots[0]!.id)).project.name).toBe(project.name);
  });

  it('keeps the current project and its verified media when the package is invalid', async () => {
    const { project, asset, initial } = await prepareCurrentProject();
    const result = await openAgentProjectPackage({ file: new File(['invalid zip'], 'invalid.fsp') });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('import_failed');
    expect(useProjectStore.getState().project.name).toBe(project.name);
    expect(await (await getProjectAssetBlob(asset.storageKey!))?.text()).toBe('retained image bytes');
    expect((await loadProjectRevision(initial.revision.id)).project.name).toBe(project.name);
  });
});
