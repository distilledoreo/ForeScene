import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultProject,
  defaultCharacterPassExportSettings,
  defaultShotDepthSettings,
} from '../src/domain/defaults';
import { ensureProjectExportConfiguration } from '../src/engine/exportConfiguration';
import { materializeShotStills } from '../src/engine/materializeShotStills';
import { resetPrepareStillArtifactInflightForTests } from '../src/engine/prepareStillArtifact';
import { resetProjectAssetStoreForTests } from '../src/engine/projectAssetStore';
import { renderWorkCoordinator } from '../src/engine/renderWorkCoordinator';
import { stillArtifactKey } from '../src/engine/stillArtifactTypes';
import { getAppStillReconciliationScheduler } from '../src/engine/stillArtifactReconciliation';
import { resolveProjectVideoPerformance } from '../src/engine/videoPerformance';
import { useProjectStore } from '../src/state/useProjectStore';

function renderMock() {
  return vi.fn(async ({ specification }) => ({
    blob: new Blob([`${specification.kind}:${specification.peopleVariant ?? 'none'}`], { type: 'image/png' }),
    width: specification.width,
    height: specification.height,
    mimeType: 'image/png' as const,
  }));
}

function projectWithClayPeopleBoth() {
  const project = createDefaultProject();
  const shot = project.shots[0]!;
  shot.exportSettings = {
    ...shot.exportSettings,
    includeViewport: true,
    includeProjectedViewport: false,
    includeCameraMoveReferenceFrames: false,
    includeProjectedCameraMoveReferenceFrames: false,
    characterPass: { ...defaultCharacterPassExportSettings, enabled: false },
    depth: { ...defaultShotDepthSettings, enabled: false },
    peopleExportMode: 'both',
  };
  return project;
}

describe('prepared media quality regressions', () => {
  beforeEach(() => {
    resetProjectAssetStoreForTests();
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  afterEach(() => {
    resetProjectAssetStoreForTests();
    resetPrepareStillArtifactInflightForTests();
    renderWorkCoordinator.resetForTests();
  });

  it('clears the matching legacy viewport slot when an output variant is pruned', async () => {
    let project = projectWithClayPeopleBoth();
    const shotId = project.shots[0]!.id;
    const render = renderMock();
    const prepared = await materializeShotStills({
      project,
      shotId,
      reason: 'capture',
      scope: 'all-configured',
      render,
    });
    project = prepared.project;

    const cleanKey = stillArtifactKey({
      kind: 'clay-viewport',
      appearance: 'clay',
      peopleVariant: 'clean_plate',
      width: project.shots[0]!.exportSettings.width,
      height: project.shots[0]!.exportSettings.height,
    });
    const cleanArtifact = project.shots[0]!.materializedMedia?.stills[cleanKey];
    expect(cleanArtifact).toBeDefined();
    expect(project.shots[0]!.assets.viewportCleanPlateAssetId).toBe(cleanArtifact?.assetId);

    project = {
      ...project,
      shots: project.shots.map((shot) =>
        shot.id === shotId
          ? {
            ...shot,
            exportSettings: { ...shot.exportSettings, peopleExportMode: 'with_people' },
          }
          : shot
      ),
    };

    const reconciled = await materializeShotStills({
      project,
      shotId,
      reason: 'edit',
      scope: 'all-configured',
      render,
    });
    const shot = reconciled.project.shots.find((item) => item.id === shotId)!;
    expect(shot.materializedMedia?.stills[cleanKey]).toBeUndefined();
    expect(shot.assets.viewportCleanPlateAssetId).toBeUndefined();
    expect(reconciled.project.assets.assets[cleanArtifact!.assetId]).toBeUndefined();
  });

  it('video-performance changes reconcile shots already in the prepared lifecycle', async () => {
    let project = ensureProjectExportConfiguration(createDefaultProject());
    const shotId = project.shots[0]!.id;
    const prepared = await materializeShotStills({
      project,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render: renderMock(),
    });
    project = prepared.project;
    useProjectStore.setState({ project });
    const before = resolveProjectVideoPerformance(project.exportConfiguration).frameRate;

    useProjectStore.getState().setProjectVideoPerformance({ frameRate: before === 24 ? 25 : 24 });

    const pending = getAppStillReconciliationScheduler()?.inspectForTests().pendingShots ?? [];
    expect(pending).toContain(shotId);
  });

  it('package-layout changes do not invalidate prepared media', async () => {
    let project = ensureProjectExportConfiguration(createDefaultProject());
    const shotId = project.shots[0]!.id;
    const prepared = await materializeShotStills({
      project,
      shotId,
      reason: 'capture',
      scope: 'primary',
      render: renderMock(),
    });
    project = prepared.project;
    useProjectStore.setState({ project });

    useProjectStore.getState().setProjectPackageFormat('forescene-v2');

    const pending = getAppStillReconciliationScheduler()?.inspectForTests().pendingShots ?? [];
    expect(pending).not.toContain(shotId);
  });

  it('does not eagerly materialize an uncaptured shot after a video-performance edit', () => {
    const project = ensureProjectExportConfiguration(createDefaultProject());
    const shotId = project.shots[0]!.id;
    useProjectStore.setState({ project });
    const before = resolveProjectVideoPerformance(project.exportConfiguration).frameRate;

    useProjectStore.getState().setProjectVideoPerformance({ frameRate: before === 24 ? 25 : 24 });

    const pending = getAppStillReconciliationScheduler()?.inspectForTests().pendingShots ?? [];
    expect(pending).not.toContain(shotId);
    expect(useProjectStore.getState().project.shots[0]!.materializedMedia).toBeUndefined();
  });
});