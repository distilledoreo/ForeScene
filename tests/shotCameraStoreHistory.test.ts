import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { CameraData } from '../src/domain/types';
import {
  getShotCameraHistoryStacks,
  shouldApplyShotCameraHistoryRestore,
} from '../src/engine/shotCameraHistory';
import {
  beginShotFovWheelBatch,
  buildShotFovWheelBatchCommit,
  applyLiveShotFovWheelBatchCommit,
  shouldFinalizeShotFovWheelBatchOnShotChange,
} from '../src/engine/shotFovWheelBatch';
import { focalLengthToVerticalFov, verticalFovToFocalLength } from '../src/engine/focalLength';
import { useProjectStore } from '../src/state/useProjectStore';

function cameraWithFov(fovDegrees: number): CameraData {
  return {
    position: [0, 1.6, 0],
    target: [0, 1.6, 1],
    fovDegrees,
    aspectRatio: 16 / 9,
    near: 0.1,
    far: 100,
  };
}

describe('shot fov wheel batch', () => {
  it('finalizes when the selected shot changes during an active batch', () => {
    const batch = beginShotFovWheelBatch('shot-a');
    expect(shouldFinalizeShotFovWheelBatchOnShotChange(batch, 'shot-b')).toBe(true);
    expect(shouldFinalizeShotFovWheelBatchOnShotChange(batch, 'shot-a')).toBe(false);
  });

  it('commits only the originating shot FOV from stored camera data', () => {
    const stored = cameraWithFov(35);
    const live = { ...stored, fovDegrees: 40, position: [1, 2, 3] as CameraData['position'] };
    const committed = buildShotFovWheelBatchCommit(stored, live);
    expect(committed.fovDegrees).toBe(40);
    expect(committed.position).toEqual(stored.position);
  });

  it('preserves the live draft pose when a wheel batch commits FOV while flying', () => {
    const stored = cameraWithFov(35);
    const live = {
      ...stored,
      fovDegrees: 40,
      position: [1, 2, 3] as CameraData['position'],
      target: [1, 2, 4] as CameraData['target'],
    };
    const committed = buildShotFovWheelBatchCommit(stored, live);
    const framingAfter = applyLiveShotFovWheelBatchCommit(live, committed);

    expect(committed.position).toEqual(stored.position);
    expect(committed.target).toEqual(stored.target);
    expect(framingAfter.position).toEqual(live.position);
    expect(framingAfter.target).toEqual(live.target);
    expect(framingAfter.fovDegrees).toBe(40);
  });

  it('preserves live pose after undo, live move, and a second lens batch', () => {
    let handledRestoreGeneration = 0;
    let restoreGeneration = 0;
    let storedCamera = cameraWithFov(35);
    let framingCamera = { ...storedCamera };

    const applyRestoreIfNewGeneration = () => {
      if (!shouldApplyShotCameraHistoryRestore(restoreGeneration, handledRestoreGeneration)) {
        return;
      }
      handledRestoreGeneration = restoreGeneration;
      framingCamera = {
        ...storedCamera,
        position: [...storedCamera.position] as CameraData['position'],
        target: [...storedCamera.target] as CameraData['target'],
      };
    };

    const finishWheelBatch = (liveCamera: CameraData) => {
      storedCamera = buildShotFovWheelBatchCommit(storedCamera, liveCamera);
      applyRestoreIfNewGeneration();
      framingCamera = applyLiveShotFovWheelBatchCommit(liveCamera, storedCamera);
    };

    finishWheelBatch({ ...framingCamera, fovDegrees: 40 });

    restoreGeneration += 1;
    storedCamera = cameraWithFov(35);
    applyRestoreIfNewGeneration();

    const movedLive = {
      ...framingCamera,
      position: [1, 2, 3] as CameraData['position'],
      target: [1, 2, 4] as CameraData['target'],
    };
    framingCamera = movedLive;

    finishWheelBatch({ ...movedLive, fovDegrees: 45 });

    expect(framingCamera.position).toEqual(movedLive.position);
    expect(framingCamera.target).toEqual(movedLive.target);
    expect(framingCamera.fovDegrees).toBe(45);
    expect(storedCamera.position).toEqual(cameraWithFov(35).position);
  });
});

describe('shot camera store history', () => {
  it('clears per-shot camera history when loading another project', () => {
    const project = createDefaultProject();
    const shotA = project.shots[0].id;
    useProjectStore.setState({
      project,
      selectedShotId: shotA,
      shotCameraHistoryByShotId: {
        [shotA]: {
          past: [{ camera: cameraWithFov(10), cameraKeyframes: [] }],
          future: [],
        },
      },
    });

    const replacement = createDefaultProject();
    replacement.name = 'Replacement Project';
    useProjectStore.getState().setProject(replacement);

    expect(useProjectStore.getState().shotCameraHistoryByShotId).toEqual({});
  });

  it('undoes only the currently selected shot camera', () => {
    useProjectStore.setState({
      project: createDefaultProject(),
      selectedShotId: undefined,
      shotCameraHistoryByShotId: {},
    });
    const shotA = useProjectStore.getState().project.shots[0].id;
    const originalShotAFov = useProjectStore.getState().project.shots[0].camera.fovDegrees;
    const shotB = useProjectStore.getState().addCamera({ navigateToShots: false }).id;

    useProjectStore.getState().selectShot(shotA);
    useProjectStore.getState().updateShot(shotA, { camera: cameraWithFov(55) });
    useProjectStore.getState().selectShot(shotB);

    expect(useProjectStore.getState().undoShotCamera()).toBe(false);

    useProjectStore.getState().selectShot(shotA);
    expect(useProjectStore.getState().undoShotCamera()).toBe(true);
    expect(
      useProjectStore.getState().project.shots.find((shot) => shot.id === shotA)?.camera.fovDegrees,
    ).toBe(originalShotAFov);
    expect(getShotCameraHistoryStacks(useProjectStore.getState().shotCameraHistoryByShotId, shotB).past).toHaveLength(0);
  });

  it('restores the undone focal length when undo follows a finalized active wheel batch', () => {
    useProjectStore.setState({
      project: createDefaultProject(),
      selectedShotId: undefined,
      shotCameraHistoryByShotId: {},
      shotCameraHistoryBatchDepth: 0,
      shotCameraHistoryBatchCaptured: false,
    });
    const shotId = useProjectStore.getState().project.shots[0].id;
    const originalFov = 54.4;
    const zoomedFov = focalLengthToVerticalFov(25, 16 / 9);

    useProjectStore.getState().selectShot(shotId);
    useProjectStore.getState().updateShot(shotId, { camera: cameraWithFov(originalFov) });

    useProjectStore.getState().beginShotCameraHistoryBatch();
    const stored = useProjectStore.getState().project.shots.find((shot) => shot.id === shotId)!.camera;
    const committed = buildShotFovWheelBatchCommit(
      stored,
      { ...stored, fovDegrees: zoomedFov },
    );
    useProjectStore.getState().updateShot(shotId, { camera: committed }, { cameraHistory: 'batch' });
    useProjectStore.getState().endShotCameraHistoryBatch();

    expect(useProjectStore.getState().undoShotCamera()).toBe(true);
    const restored = useProjectStore.getState().project.shots.find((shot) => shot.id === shotId)!.camera;
    expect(restored.fovDegrees).toBeCloseTo(originalFov, 5);
    expect(Math.round(verticalFovToFocalLength(restored.fovDegrees, restored.aspectRatio))).toBe(20);
  });

  it('undoes camera keyframe sequence edits independently of the live fly pose', () => {
    useProjectStore.setState({
      project: createDefaultProject(),
      selectedShotId: undefined,
      shotCameraHistoryByShotId: {},
    });
    const shotId = useProjectStore.getState().project.shots[0].id;
    const baseCamera = useProjectStore.getState().project.shots[0].camera;
    useProjectStore.getState().selectShot(shotId);

    const start = {
      id: 'kf-start',
      label: 'Start',
      timeSeconds: 0,
      camera: { ...baseCamera, position: [0, 1.6, 0] as [number, number, number] },
    };
    const end = {
      id: 'kf-end',
      label: 'End',
      timeSeconds: 4,
      camera: { ...baseCamera, position: [4, 1.6, 0] as [number, number, number] },
    };
    const mid = {
      id: 'kf-mid',
      label: 'Keyframe 1',
      timeSeconds: 2,
      camera: { ...baseCamera, position: [2, 1.6, 0] as [number, number, number] },
    };

    useProjectStore.getState().updateShot(shotId, {
      cameraKeyframes: [start, end],
    });
    useProjectStore.getState().updateShot(shotId, {
      cameraKeyframes: [start, mid, end],
    });

    expect(useProjectStore.getState().project.shots.find((s) => s.id === shotId)?.cameraKeyframes).toHaveLength(3);
    expect(useProjectStore.getState().undoShotCamera()).toBe(true);
    const afterUndo = useProjectStore.getState().project.shots.find((s) => s.id === shotId)!;
    expect(afterUndo.cameraKeyframes.map((k) => k.id)).toEqual(['kf-start', 'kf-end']);
    expect(useProjectStore.getState().redoShotCamera()).toBe(true);
    const afterRedo = useProjectStore.getState().project.shots.find((s) => s.id === shotId)!;
    expect(afterRedo.cameraKeyframes.map((k) => k.id)).toEqual(['kf-start', 'kf-mid', 'kf-end']);
  });
});

