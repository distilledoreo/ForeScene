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
  useContinuityStore,
} from '../src/state/useContinuityStore';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('continuity store domain slices', () => {
  it('composes real slice creators in useContinuityStore', () => {
    const storeSrc = readFileSync(join(root, 'src/state/useContinuityStore.ts'), 'utf8');
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
    const state = useContinuityStore.getState();
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
    const store = useContinuityStore.getState();
    const first = store.project.shots[0];
    store.addCamera({ navigateToShots: false });
    const afterAdd = useContinuityStore.getState();
    expect(afterAdd.project.shots.length).toBeGreaterThanOrEqual(2);
    const second = afterAdd.project.shots[1];
    afterAdd.reorderShots(second.id, 0);
    const reordered = useContinuityStore.getState().project.shots;
    expect(reordered[0]?.id).toBe(second.id);

    const objectId = afterAdd.project.scene.objects[0]?.id;
    if (objectId) {
      useContinuityStore.getState().updateShot(reordered[0].id, {
        objectOverrides: {
          [objectId]: {
            visible: false,
          },
        },
      });
      useContinuityStore.getState().copyStagingToNextShot(reordered[0].id);
      const next = useContinuityStore.getState().project.shots[1];
      expect(next?.objectOverrides?.[objectId]?.visible).toBe(false);
    }
    // Keep first shot id selected for other tests that share store.
    useContinuityStore.getState().selectShot(first.id);
  });

  it('implements session slice without picking from the monolithic factory', () => {
    const sessionSrc = readFileSync(join(root, 'src/state/slices/sessionSlice.ts'), 'utf8');
    expect(sessionSrc).not.toContain('pickSlice');
    expect(sessionSrc).not.toContain('getSharedContinuityState');
    expect(sessionSrc).toContain('setPanoView:');
    expect(sessionSrc).toContain('landShotFraming:');
    expect(sessionSrc).toContain('setShotCameraFlying:');
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
    useContinuityStore.getState().setProject(project);

    const store = useContinuityStore.getState();
    const objectIds = store.project.scene.objects.map((object) => object.id);
    expect(objectIds.length).toBeGreaterThan(0);

    // setProject aligns selectedShotId with the loaded document.
    expect(store.selectedShotId).toBe(store.project.shots[0]?.id);

    store.selectObject(objectIds[0]);
    expect(useContinuityStore.getState().selectedObjectIds).toEqual([objectIds[0]]);
    useContinuityStore.getState().selectObject(objectIds[1], 'toggle');
    expect(useContinuityStore.getState().selectedObjectIds).toEqual([objectIds[0], objectIds[1]]);

    useContinuityStore.getState().clearObjectSelection();
    expect(useContinuityStore.getState().selectedObjectIds).toEqual([]);

    useContinuityStore.getState().selectAllObjects();
    expect(useContinuityStore.getState().selectedObjectIds.length).toBeGreaterThan(0);

    useContinuityStore.getState().setBuildMode('place');
    expect(useContinuityStore.getState().buildMode).toBe('place');
    useContinuityStore.getState().setActivePrimitive('wall');
    expect(useContinuityStore.getState().activePrimitive).toBe('wall');
    expect(useContinuityStore.getState().buildMode).toBe('place');
    expect(useContinuityStore.getState().selectedObjectIds).toEqual([]);

    useContinuityStore.getState().setGridSnap(false);
    expect(useContinuityStore.getState().gridSnap).toBe(false);
    useContinuityStore.getState().setGridSnap(true);

    const shotId = useContinuityStore.getState().project.shots[0]?.id;
    expect(shotId).toBeTruthy();
    useContinuityStore.getState().selectShot(shotId);
    const afterShot = useContinuityStore.getState();
    expect(afterShot.selectedShotId).toBe(shotId);
    expect(afterShot.shotCameraFlying).toBe(true);

    useContinuityStore.getState().setActivePano(undefined);
    expect(useContinuityStore.getState().activePanoId).toBeUndefined();

    useContinuityStore.getState().setBuildMode('select');
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
    const before = useContinuityStore.getState();
    expect(before.workspace).toBeTruthy();

    before.setWorkspace('build');
    expect(useContinuityStore.getState().workspace).toBe('build');

    before.setWorkspace('shots');
    const inShots = useContinuityStore.getState();
    expect(inShots.workspace).toBe('shots');
    expect(inShots.shotCameraFlying).toBe(true);
    expect(inShots.selectedShotId).toBeTruthy();

    const objectiveBefore = inShots.objectiveModalRequest;
    inShots.requestObjectiveModal();
    expect(useContinuityStore.getState().objectiveModalRequest).toBe(objectiveBefore + 1);

    const alignmentBefore = useContinuityStore.getState().alignmentIntroRequest;
    useContinuityStore.getState().requestAlignmentIntro();
    expect(useContinuityStore.getState().alignmentIntroRequest).toBe(alignmentBefore + 1);

    const retryBefore = useContinuityStore.getState().alignmentRetryModalRequest;
    useContinuityStore.getState().requestAlignmentRetryModal();
    expect(useContinuityStore.getState().alignmentRetryModalRequest).toBe(retryBefore + 1);

    useContinuityStore.getState().dismissWorkflowAdvance('test-prompt-key');
    expect(useContinuityStore.getState().dismissedWorkflowAdvanceKeys).toContain('test-prompt-key');

    useContinuityStore.getState().markObjectiveSeen('build');
    expect(useContinuityStore.getState().seenObjectiveWorkspaces).toContain('build');

    useContinuityStore.getState().approveGrayboxForReference();
    expect(useContinuityStore.getState().project.workflow.grayboxApprovedForReferenceAt).toBeTruthy();

    const shotId = useContinuityStore.getState().selectedShotId
      ?? useContinuityStore.getState().project.shots[0]?.id;
    expect(shotId).toBeTruthy();
    useContinuityStore.getState().acceptShotFraming(shotId!);
    expect(
      useContinuityStore.getState().project.workflow.shotFramingAcceptedAtByShotId[shotId!],
    ).toBeTruthy();

    useContinuityStore.getState().markAiBriefSent(shotId!);
    expect(
      useContinuityStore.getState().project.workflow.aiBriefSentAtByShotId[shotId!],
    ).toBeTruthy();

    useContinuityStore.getState().markFinalPackageExported(shotId!);
    expect(
      useContinuityStore.getState().project.workflow.finalPackageExportedAtByShotId[shotId!],
    ).toBeTruthy();

    useContinuityStore.getState().markAlignmentIntroSeen('pano-test');
    expect(useContinuityStore.getState().seenAlignmentIntroForPanoId).toBe('pano-test');

    useContinuityStore.getState().resetWorkflowSession();
    const afterReset = useContinuityStore.getState();
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
    const before = useContinuityStore.getState();
    const shotId = before.selectedShotId ?? before.project.shots[0]?.id;
    expect(shotId).toBeTruthy();

    before.setPanoView({ yawDegrees: 42, pitchDegrees: -5 });
    expect(useContinuityStore.getState().panoView.yawDegrees).toBe(42);
    expect(useContinuityStore.getState().panoView.pitchDegrees).toBe(-5);

    before.setShotCameraFlying(true, { clearFramingAcceptance: false });
    expect(useContinuityStore.getState().shotCameraFlying).toBe(true);

    before.setExportingPackage(true);
    expect(useContinuityStore.getState().isExportingPackage).toBe(true);
    before.setExportingPackage(false);
    expect(useContinuityStore.getState().isExportingPackage).toBe(false);

    const camera = useContinuityStore.getState().project.shots.find((s) => s.id === shotId)!.camera;
    useContinuityStore.getState().landShotFraming(shotId!, camera, { keepFlying: true });
    const afterLand = useContinuityStore.getState();
    expect(afterLand.shotCameraFlying).toBe(true);
    expect(afterLand.project.workflow.shotFramingAcceptedAtByShotId[shotId!]).toBeTruthy();

    afterLand.lockShotCamera();
    expect(useContinuityStore.getState().shotCameraFlying).toBe(false);

    afterLand.setProjectedOcclusionStatus('ready');
    expect(useContinuityStore.getState().projectedOcclusionStatus).toBe('ready');
    afterLand.setProjectedOcclusionStatus('disabled');
  });
});
