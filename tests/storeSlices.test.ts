import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultProject } from '../src/domain/defaults';
import {
  HISTORY_SLICE_KEYS,
  PROJECT_SLICE_KEYS,
  SELECTION_SLICE_KEYS,
  SESSION_SLICE_KEYS,
  WORKFLOW_SLICE_KEYS,
  createProjectSlice,
  createSelectionSlice,
  createHistorySlice,
  createWorkflowSlice,
  createSessionSlice,
  useProjectStore,
} from '../src/state/useProjectStore';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('continuity store domain slices', () => {
  it('composes real slice creators in useProjectStore', () => {
    const storeSrc = readFileSync(join(root, 'src/state/useProjectStore.ts'), 'utf8');
    expect(storeSrc).toMatch(/createProjectSlice\(/);
    expect(storeSrc).toMatch(/createSelectionSlice\(/);
    expect(storeSrc).toMatch(/createHistorySlice\(/);
    expect(storeSrc).toMatch(/createWorkflowSlice\(/);
    expect(storeSrc).toMatch(/createSessionSlice\(/);
    expect(typeof createProjectSlice).toBe('function');
    expect(typeof createSelectionSlice).toBe('function');
    expect(typeof createHistorySlice).toBe('function');
    expect(typeof createWorkflowSlice).toBe('function');
    expect(typeof createSessionSlice).toBe('function');
  });

  it('exposes project/selection/history/workflow/session slice keys', () => {
    const state = useProjectStore.getState();
    for (const key of [
      ...PROJECT_SLICE_KEYS,
      ...SELECTION_SLICE_KEYS,
      ...HISTORY_SLICE_KEYS,
      ...WORKFLOW_SLICE_KEYS,
      ...SESSION_SLICE_KEYS,
    ]) {
      expect(state).toHaveProperty(key);
    }
  });

  it('reorders shots and copies staging via project slice actions', () => {
    const store = useProjectStore.getState();
    const first = store.project.shots[0];
    store.addCamera({ navigateToShots: false });
    const afterAdd = useProjectStore.getState();
    expect(afterAdd.project.shots.length).toBeGreaterThanOrEqual(2);
    const second = afterAdd.project.shots[1];
    afterAdd.reorderShots(second.id, 0);
    const reordered = useProjectStore.getState().project.shots;
    expect(reordered[0]?.id).toBe(second.id);

    const objectId = afterAdd.project.scene.objects[0]?.id;
    if (objectId) {
      useProjectStore.getState().updateShot(reordered[0].id, {
        objectOverrides: {
          [objectId]: {
            visible: false,
          },
        },
      });
      useProjectStore.getState().copyStagingToNextShot(reordered[0].id);
      const next = useProjectStore.getState().project.shots[1];
      expect(next?.objectOverrides?.[objectId]?.visible).toBe(false);
    }
    // Keep first shot id selected for other tests that share store.
    useProjectStore.getState().selectShot(first.id);
  });

  it('implements session slice without picking from the monolithic factory', () => {
    const sessionSrc = readFileSync(join(root, 'src/state/slices/sessionSlice.ts'), 'utf8');
    expect(sessionSrc).not.toContain('pickSlice');
    expect(sessionSrc).not.toContain('getSharedContinuityState');
    expect(sessionSrc).toContain('setPanoView:');
    expect(sessionSrc).toContain('landShotFraming:');
    expect(sessionSrc).toContain('setShotCameraFlying:');
  });

  it('implements history slice without picking from the monolithic factory', () => {
    const historySrc = readFileSync(join(root, 'src/state/slices/historySlice.ts'), 'utf8');
    expect(historySrc).not.toContain('pickSlice');
    expect(historySrc).not.toContain('getSharedContinuityState');
    expect(historySrc).toContain('getHistoryRuntime');
    expect(historySrc).toContain('undoBuild:');
    expect(historySrc).toContain('undoShotCamera:');
    expect(historySrc).toContain('beginBuildHistoryBatch:');

    const runtimeSrc = readFileSync(join(root, 'src/state/slices/historyRuntime.ts'), 'utf8');
    expect(runtimeSrc).toContain('WeakMap');
    expect(runtimeSrc).toContain('buildHistoryCoalesceTimer');
    expect(runtimeSrc).toContain('buildHistoryRestoring');
    expect(runtimeSrc).toContain('shotCameraHistoryRestoring');
  });

  it('implements project slice without monolith factory / activeSet globals', () => {
    const projectSrc = readFileSync(join(root, 'src/state/slices/projectSlice.ts'), 'utf8');
    expect(projectSrc).not.toContain('pickSlice');
    expect(projectSrc).not.toContain('getSharedContinuityState');
    expect(projectSrc).not.toContain('activeSet');
    expect(projectSrc).not.toContain('activeGet');
    expect(projectSrc).toContain('setProject:');
    expect(projectSrc).toContain('addObject:');
    expect(projectSrc).toContain('importStyledPano:');
    expect(projectSrc).toContain('updateShot:');

    // Monolith composition path must be gone.
    expect(() => readFileSync(join(root, 'src/state/slices/continuityStoreImpl.ts'), 'utf8')).toThrow();
    expect(() => readFileSync(join(root, 'src/state/slices/sharedStore.ts'), 'utf8')).toThrow();

    const allSliceSources = [
      'projectSlice.ts',
      'selectionSlice.ts',
      'historySlice.ts',
      'historyRuntime.ts',
      'workflowSlice.ts',
      'sessionSlice.ts',
      'useProjectStore.ts',
    ].map((name) => {
      const path = name === 'useProjectStore.ts'
        ? join(root, 'src/state', name)
        : join(root, 'src/state/slices', name);
      return readFileSync(path, 'utf8');
    }).join('\n');
    expect(allSliceSources).not.toMatch(/\bactiveSet\b/);
    expect(allSliceSources).not.toMatch(/\bactiveGet\b/);
    expect(allSliceSources).not.toContain('getSharedContinuityState');
    expect(allSliceSources).not.toContain('pickSlice');
  });

  it('history actions record build undo and isolate per-store runtime flags', () => {
    const project = createDefaultProject();
    useProjectStore.getState().setProject(project);
    useProjectStore.getState().setBuildMode('select');

    const beforeCount = useProjectStore.getState().project.scene.objects.length;
    useProjectStore.getState().addObject('box');
    expect(useProjectStore.getState().project.scene.objects.length).toBe(beforeCount + 1);
    expect(useProjectStore.getState().canUndoBuild()).toBe(true);

    expect(useProjectStore.getState().undoBuild()).toBe(true);
    expect(useProjectStore.getState().project.scene.objects.length).toBe(beforeCount);
    expect(useProjectStore.getState().canRedoBuild()).toBe(true);
    expect(useProjectStore.getState().redoBuild()).toBe(true);
    expect(useProjectStore.getState().project.scene.objects.length).toBe(beforeCount + 1);

    const shotId = useProjectStore.getState().project.shots[0]?.id;
    expect(shotId).toBeTruthy();
    useProjectStore.getState().selectShot(shotId);
    const originalFov = useProjectStore.getState().project.shots.find((s) => s.id === shotId)!.camera.fovDegrees;
    useProjectStore.getState().updateShot(shotId!, {
      camera: {
        ...useProjectStore.getState().project.shots.find((s) => s.id === shotId)!.camera,
        fovDegrees: originalFov + 12,
      },
    });
    expect(useProjectStore.getState().canUndoShotCamera()).toBe(true);
    expect(useProjectStore.getState().undoShotCamera()).toBe(true);
    expect(
      useProjectStore.getState().project.shots.find((s) => s.id === shotId)!.camera.fovDegrees,
    ).toBe(originalFov);
  });

  it('implements selection slice without picking from the monolithic factory', () => {
    const selectionSrc = readFileSync(join(root, 'src/state/slices/selectionSlice.ts'), 'utf8');
    expect(selectionSrc).not.toContain('pickSlice');
    expect(selectionSrc).not.toContain('getSharedContinuityState');
    expect(selectionSrc).toContain('selectObject:');
    expect(selectionSrc).toContain('selectShot:');
    expect(selectionSrc).toContain('setBuildMode:');
    expect(selectionSrc).toContain('setBuildClipboard:');
  });

  it('selection actions own object/shot selection, build mode, and clipboard', () => {
    const project = createDefaultProject();
    useProjectStore.getState().setProject(project);

    const store = useProjectStore.getState();
    const objectIds = store.project.scene.objects.map((object) => object.id);
    expect(objectIds.length).toBeGreaterThan(0);

    // setProject aligns selectedShotId with the loaded document.
    expect(store.selectedShotId).toBe(store.project.shots[0]?.id);

    store.selectObject(objectIds[0]);
    expect(useProjectStore.getState().selectedObjectIds).toEqual([objectIds[0]]);
    useProjectStore.getState().selectObject(objectIds[1], 'toggle');
    expect(useProjectStore.getState().selectedObjectIds).toEqual([objectIds[0], objectIds[1]]);

    useProjectStore.getState().clearObjectSelection();
    expect(useProjectStore.getState().selectedObjectIds).toEqual([]);

    useProjectStore.getState().selectAllObjects();
    expect(useProjectStore.getState().selectedObjectIds.length).toBeGreaterThan(0);

    useProjectStore.getState().setBuildMode('place');
    expect(useProjectStore.getState().buildMode).toBe('place');
    useProjectStore.getState().setActivePrimitive('wall');
    expect(useProjectStore.getState().activePrimitive).toBe('wall');
    expect(useProjectStore.getState().buildMode).toBe('place');
    expect(useProjectStore.getState().selectedObjectIds).toEqual([]);

    useProjectStore.getState().setGridSnap(false);
    expect(useProjectStore.getState().gridSnap).toBe(false);
    useProjectStore.getState().setGridSnap(true);

    const shotId = useProjectStore.getState().project.shots[0]?.id;
    expect(shotId).toBeTruthy();
    useProjectStore.getState().selectShot(shotId);
    const afterShot = useProjectStore.getState();
    expect(afterShot.selectedShotId).toBe(shotId);
    expect(afterShot.shotCameraFlying).toBe(true);

    useProjectStore.getState().setActivePano(undefined);
    expect(useProjectStore.getState().activePanoId).toBeUndefined();

    useProjectStore.getState().setBuildMode('select');
  });

  it('implements workflow slice without picking from the monolithic factory', () => {
    const workflowSrc = readFileSync(join(root, 'src/state/slices/workflowSlice.ts'), 'utf8');
    expect(workflowSrc).not.toContain('pickSlice');
    expect(workflowSrc).not.toContain('getSharedContinuityState');
    expect(workflowSrc).toContain('setWorkspace:');
    expect(workflowSrc).toContain('approveGrayboxForReference:');
    expect(workflowSrc).toContain('acceptReferenceAlignment:');
    expect(workflowSrc).toContain('resetWorkflowSession:');
    expect(workflowSrc).toContain('requestObjectiveModal:');
  });

  it('workflow actions own workspace, objective/alignment prompts, and progression stamps', () => {
    const before = useProjectStore.getState();
    expect(before.workspace).toBeTruthy();

    before.setWorkspace('build');
    expect(useProjectStore.getState().workspace).toBe('build');

    before.setWorkspace('shots');
    const inShots = useProjectStore.getState();
    expect(inShots.workspace).toBe('shots');
    expect(inShots.shotCameraFlying).toBe(true);
    expect(inShots.selectedShotId).toBeTruthy();

    const objectiveBefore = inShots.objectiveModalRequest;
    inShots.requestObjectiveModal();
    expect(useProjectStore.getState().objectiveModalRequest).toBe(objectiveBefore + 1);

    const alignmentBefore = useProjectStore.getState().alignmentIntroRequest;
    useProjectStore.getState().requestAlignmentIntro();
    expect(useProjectStore.getState().alignmentIntroRequest).toBe(alignmentBefore + 1);

    const retryBefore = useProjectStore.getState().alignmentRetryModalRequest;
    useProjectStore.getState().requestAlignmentRetryModal();
    expect(useProjectStore.getState().alignmentRetryModalRequest).toBe(retryBefore + 1);

    useProjectStore.getState().dismissWorkflowAdvance('test-prompt-key');
    expect(useProjectStore.getState().dismissedWorkflowAdvanceKeys).toContain('test-prompt-key');

    useProjectStore.getState().markObjectiveSeen('build');
    expect(useProjectStore.getState().seenObjectiveWorkspaces).toContain('build');

    useProjectStore.getState().approveGrayboxForReference();
    expect(useProjectStore.getState().project.workflow.grayboxApprovedForReferenceAt).toBeTruthy();

    const shotId = useProjectStore.getState().selectedShotId
      ?? useProjectStore.getState().project.shots[0]?.id;
    expect(shotId).toBeTruthy();
    useProjectStore.getState().acceptShotFraming(shotId!);
    expect(
      useProjectStore.getState().project.workflow.shotFramingAcceptedAtByShotId[shotId!],
    ).toBeTruthy();

    useProjectStore.getState().markAiBriefSent(shotId!);
    expect(
      useProjectStore.getState().project.workflow.aiBriefSentAtByShotId[shotId!],
    ).toBeTruthy();

    useProjectStore.getState().markFinalPackageExported(shotId!);
    expect(
      useProjectStore.getState().project.workflow.finalPackageExportedAtByShotId[shotId!],
    ).toBeTruthy();

    useProjectStore.getState().markAlignmentIntroSeen('pano-test');
    expect(useProjectStore.getState().seenAlignmentIntroForPanoId).toBe('pano-test');

    useProjectStore.getState().resetWorkflowSession();
    const afterReset = useProjectStore.getState();
    expect(afterReset.dismissedWorkflowAdvanceKeys).toEqual([]);
    expect(afterReset.seenObjectiveWorkspaces).toEqual([]);
    expect(afterReset.objectiveModalRequest).toBe(0);
    expect(afterReset.alignmentIntroRequest).toBe(0);
    expect(afterReset.alignmentRetryModalRequest).toBe(0);
    expect(afterReset.seenAlignmentIntroForPanoId).toBeUndefined();

    // Restore a stable workspace for other tests that share the store.
    afterReset.setWorkspace('build');
  });

  it('session actions own fly mode, pano view, and land framing acceptance', () => {
    const before = useProjectStore.getState();
    const shotId = before.selectedShotId ?? before.project.shots[0]?.id;
    expect(shotId).toBeTruthy();

    before.setPanoView({ yawDegrees: 42, pitchDegrees: -5 });
    expect(useProjectStore.getState().panoView.yawDegrees).toBe(42);
    expect(useProjectStore.getState().panoView.pitchDegrees).toBe(-5);

    before.setShotCameraFlying(true, { clearFramingAcceptance: false });
    expect(useProjectStore.getState().shotCameraFlying).toBe(true);

    before.setExportingPackage(true);
    expect(useProjectStore.getState().isExportingPackage).toBe(true);
    before.setExportingPackage(false);
    expect(useProjectStore.getState().isExportingPackage).toBe(false);

    const camera = useProjectStore.getState().project.shots.find((s) => s.id === shotId)!.camera;
    useProjectStore.getState().landShotFraming(shotId!, camera, { keepFlying: true });
    const afterLand = useProjectStore.getState();
    expect(afterLand.shotCameraFlying).toBe(true);
    expect(afterLand.project.workflow.shotFramingAcceptedAtByShotId[shotId!]).toBeTruthy();

    afterLand.lockShotCamera();
    expect(useProjectStore.getState().shotCameraFlying).toBe(false);

    const landed = useProjectStore.getState();
    const projectBeforeNoop = landed.project;
    const updatedAtBefore = projectBeforeNoop.updatedAt;
    landed.landShotFraming(shotId!, camera);
    const afterNoop = useProjectStore.getState();
    expect(afterNoop.project).toBe(projectBeforeNoop);
    expect(afterNoop.project.updatedAt).toBe(updatedAtBefore);

    afterNoop.setProjectedOcclusionStatus('ready');
    expect(useProjectStore.getState().projectedOcclusionStatus).toBe('ready');
    afterNoop.setProjectedOcclusionStatus('disabled');
  });
});
