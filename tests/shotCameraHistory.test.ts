import { describe, expect, it } from 'vitest';
import { CameraData, CameraKeyframe } from '../src/domain/types';
import {
  clearShotCameraHistory,
  clearAllShotCameraHistory,
  getShotCameraHistoryStacks,
  pushShotCameraHistoryPast,
  redoShotCameraHistory,
  undoShotCameraHistory,
  withShotCameraHistoryStacks,
  type ShotCameraHistoryEntry,
} from '../src/engine/shotCameraHistory';

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

function entry(
  fovDegrees: number,
  keyframes: CameraKeyframe[] = [],
): ShotCameraHistoryEntry {
  return {
    camera: cameraWithFov(fovDegrees),
    cameraKeyframes: keyframes,
  };
}

function keyframe(id: string, timeSeconds: number, fov: number): CameraKeyframe {
  return {
    id,
    label: id,
    timeSeconds,
    camera: cameraWithFov(fov),
  };
}

describe('shot camera history ordering', () => {
  it('restores B then C after undoing twice from A → B → C', () => {
    let stacks = clearShotCameraHistory();
    let current = entry(10);

    stacks = pushShotCameraHistoryPast(stacks, current);
    current = entry(20);
    stacks = pushShotCameraHistoryPast(stacks, current);
    current = entry(30);

    let undo = undoShotCameraHistory(stacks, current);
    expect(undo?.restored.camera.fovDegrees).toBe(20);
    stacks = undo!.stacks;
    current = undo!.restored;

    undo = undoShotCameraHistory(stacks, current);
    expect(undo?.restored.camera.fovDegrees).toBe(10);
    stacks = undo!.stacks;
    current = undo!.restored;

    let redo = redoShotCameraHistory(stacks, current);
    expect(redo?.restored.camera.fovDegrees).toBe(20);
    stacks = redo!.stacks;
    current = redo!.restored;

    redo = redoShotCameraHistory(stacks, current);
    expect(redo?.restored.camera.fovDegrees).toBe(30);
  });

  it('restores camera keyframe sequences with the camera pose', () => {
    let stacks = clearShotCameraHistory();
    const start = entry(40, [keyframe('s', 0, 40)]);
    stacks = pushShotCameraHistoryPast(stacks, start);
    const withEnd = entry(50, [
      keyframe('s', 0, 40),
      keyframe('e', 3, 50),
    ]);
    stacks = pushShotCameraHistoryPast(stacks, withEnd);
    const withMid = entry(55, [
      keyframe('s', 0, 40),
      keyframe('m', 1.5, 45),
      keyframe('e', 3, 55),
    ]);

    const undo = undoShotCameraHistory(stacks, withMid);
    expect(undo?.restored.camera.fovDegrees).toBe(50);
    expect(undo?.restored.cameraKeyframes.map((k) => k.id)).toEqual(['s', 'e']);
    expect(undo?.restored.cameraKeyframes.map((k) => k.timeSeconds)).toEqual([0, 3]);

    const redo = redoShotCameraHistory(undo!.stacks, undo!.restored);
    expect(redo?.restored.cameraKeyframes.map((k) => k.id)).toEqual(['s', 'm', 'e']);
    expect(redo?.restored.camera.fovDegrees).toBe(55);
  });
});

describe('shot camera history scoping', () => {
  it('keeps independent stacks per shot id', () => {
    let byShotId = clearAllShotCameraHistory();
    const shotAStacks = pushShotCameraHistoryPast(
      getShotCameraHistoryStacks(byShotId, 'shot-a'),
      entry(10),
    );
    byShotId = withShotCameraHistoryStacks(byShotId, 'shot-a', shotAStacks);

    expect(getShotCameraHistoryStacks(byShotId, 'shot-a').past).toHaveLength(1);
    expect(getShotCameraHistoryStacks(byShotId, 'shot-b').past).toHaveLength(0);
  });

  it('does not apply shot A history when undoing on shot B', () => {
    let byShotId = clearAllShotCameraHistory();
    byShotId = withShotCameraHistoryStacks(
      byShotId,
      'shot-a',
      pushShotCameraHistoryPast(getShotCameraHistoryStacks(byShotId, 'shot-a'), entry(10)),
    );

    const shotBStacks = getShotCameraHistoryStacks(byShotId, 'shot-b');
    expect(undoShotCameraHistory(shotBStacks, entry(99))).toBeUndefined();
  });
});
