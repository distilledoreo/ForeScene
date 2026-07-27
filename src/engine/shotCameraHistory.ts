import type { CameraData, CameraKeyframe } from '../domain/types';

export const MAX_SHOT_CAMERA_HISTORY = 50;

/** Authored camera pose + keyframe sequence restored together by undo/redo. */
export interface ShotCameraHistoryEntry {
  camera: CameraData;
  cameraKeyframes: CameraKeyframe[];
}

export interface ShotCameraHistoryStacks {
  past: ShotCameraHistoryEntry[];
  future: ShotCameraHistoryEntry[];
}

export type ShotCameraHistoryByShotId = Record<string, ShotCameraHistoryStacks>;

export function cloneCameraData(camera: CameraData): CameraData {
  return {
    ...camera,
    position: [...camera.position] as CameraData['position'],
    target: [...camera.target] as CameraData['target'],
  };
}

export function cloneCameraKeyframes(
  keyframes: readonly CameraKeyframe[] = [],
): CameraKeyframe[] {
  return structuredClone(keyframes) as CameraKeyframe[];
}

export function cloneShotCameraHistoryEntry(
  entry: ShotCameraHistoryEntry,
): ShotCameraHistoryEntry {
  return {
    camera: cloneCameraData(entry.camera),
    cameraKeyframes: cloneCameraKeyframes(entry.cameraKeyframes),
  };
}

export function cameraDataEqual(a: CameraData, b: CameraData): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function cameraKeyframesEqual(
  a: readonly CameraKeyframe[] = [],
  b: readonly CameraKeyframe[] = [],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function shotCameraHistoryEntryEqual(
  a: ShotCameraHistoryEntry,
  b: ShotCameraHistoryEntry,
): boolean {
  return cameraDataEqual(a.camera, b.camera)
    && cameraKeyframesEqual(a.cameraKeyframes, b.cameraKeyframes);
}

export function clearShotCameraHistory(): ShotCameraHistoryStacks {
  return { past: [], future: [] };
}

export function clearAllShotCameraHistory(): ShotCameraHistoryByShotId {
  return {};
}

export function getShotCameraHistoryStacks(
  byShotId: ShotCameraHistoryByShotId,
  shotId: string,
): ShotCameraHistoryStacks {
  return byShotId[shotId] ?? clearShotCameraHistory();
}

export function withShotCameraHistoryStacks(
  byShotId: ShotCameraHistoryByShotId,
  shotId: string,
  stacks: ShotCameraHistoryStacks,
): ShotCameraHistoryByShotId {
  return { ...byShotId, [shotId]: stacks };
}

export function pushShotCameraHistoryPast(
  stacks: ShotCameraHistoryStacks,
  entry: ShotCameraHistoryEntry,
  maxDepth = MAX_SHOT_CAMERA_HISTORY,
): ShotCameraHistoryStacks {
  const past = [...stacks.past, cloneShotCameraHistoryEntry(entry)];
  while (past.length > maxDepth) past.shift();
  return {
    past,
    future: [],
  };
}

export function undoShotCameraHistory(
  stacks: ShotCameraHistoryStacks,
  current: ShotCameraHistoryEntry,
): { stacks: ShotCameraHistoryStacks; restored: ShotCameraHistoryEntry } | undefined {
  if (stacks.past.length === 0) return undefined;
  const past = [...stacks.past];
  const restored = past.pop()!;
  return {
    stacks: {
      past,
      future: [cloneShotCameraHistoryEntry(current), ...stacks.future],
    },
    restored: cloneShotCameraHistoryEntry(restored),
  };
}

export function redoShotCameraHistory(
  stacks: ShotCameraHistoryStacks,
  current: ShotCameraHistoryEntry,
): { stacks: ShotCameraHistoryStacks; restored: ShotCameraHistoryEntry } | undefined {
  if (stacks.future.length === 0) return undefined;
  const future = [...stacks.future];
  const restored = future.shift()!;
  return {
    stacks: {
      past: [...stacks.past, cloneShotCameraHistoryEntry(current)],
      future,
    },
    restored: cloneShotCameraHistoryEntry(restored),
  };
}

/** True when a new undo/redo restore generation should reseed the live framing camera. */
export function shouldApplyShotCameraHistoryRestore(
  restoreGeneration: number,
  lastHandledRestoreGeneration: number,
): boolean {
  return restoreGeneration !== lastHandledRestoreGeneration;
}
