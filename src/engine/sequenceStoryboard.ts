/**
 * Sequence / storyboard helpers: order, duration, status, animatic timing.
 */

import type { LocationProject, Shot, ShotStatus } from '../domain/types';
import { getCameraMoveDurationSeconds, hasRenderableCameraMove } from './cameraKeyframes';
import { hasShotCapture } from '../domain/shotMedia';

export type SequenceShotKind = 'still' | 'video' | 'empty';

export interface SequenceStoryboardItem {
  shotId: string;
  index: number;
  productionShotId?: string;
  name: string;
  status: ShotStatus;
  kind: SequenceShotKind;
  durationSeconds: number;
  hasCapture: boolean;
  thumbnailAssetId?: string;
  keyframeCount: number;
}

export interface SequenceStoryboard {
  items: SequenceStoryboardItem[];
  totalDurationSeconds: number;
  shotCount: number;
  videoCount: number;
  stillCount: number;
}

const DEFAULT_STILL_DURATION_SECONDS = 2;

export function getShotSequenceKind(shot: Shot): SequenceShotKind {
  if (hasRenderableCameraMove(shot.cameraKeyframes)) return 'video';
  if (shot.assets.viewportRenderAssetId || shot.assets.cameraMoveVideoAssetId) return 'still';
  if ((shot.cameraKeyframes?.length ?? 0) > 0) return 'video';
  return 'empty';
}

export function getShotSequenceDurationSeconds(shot: Shot): number {
  if (hasRenderableCameraMove(shot.cameraKeyframes)) {
    return getCameraMoveDurationSeconds(shot.cameraKeyframes);
  }
  return DEFAULT_STILL_DURATION_SECONDS;
}

export function buildSequenceStoryboard(
  project: LocationProject,
): SequenceStoryboard {
  const items: SequenceStoryboardItem[] = project.shots.map((shot, index) => {
    const kind = getShotSequenceKind(shot);
    return {
      shotId: shot.id,
      index,
      productionShotId: shot.productionShotId,
      name: shot.name,
      status: shot.status,
      kind,
      durationSeconds: getShotSequenceDurationSeconds(shot),
      hasCapture: hasShotCapture(project, shot),
      thumbnailAssetId: shot.assets.viewportRenderAssetId
        ?? shot.assets.finalBaseFrameAssetId
        ?? shot.assets.panoCropAssetId,
      keyframeCount: shot.cameraKeyframes?.length ?? 0,
    };
  });
  const totalDurationSeconds = items.reduce((sum, item) => sum + item.durationSeconds, 0);
  return {
    items,
    totalDurationSeconds,
    shotCount: items.length,
    videoCount: items.filter((item) => item.kind === 'video').length,
    stillCount: items.filter((item) => item.kind === 'still').length,
  };
}

/** Reorder shots by moving shotId to targetIndex (0-based). */
export function reorderShots(
  shots: readonly Shot[],
  shotId: string,
  targetIndex: number,
): Shot[] {
  const fromIndex = shots.findIndex((shot) => shot.id === shotId);
  if (fromIndex < 0) return [...shots];
  const clamped = Math.max(0, Math.min(shots.length - 1, targetIndex));
  if (fromIndex === clamped) return [...shots];
  const next = [...shots];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(clamped, 0, moved);
  return next;
}

/** Copy staging (objectOverrides + linked people visibility) from source onto target. */
export function copyStagingToShot(source: Shot, target: Shot): Shot {
  return {
    ...target,
    objectOverrides: source.objectOverrides
      ? structuredClone(source.objectOverrides)
      : undefined,
  };
}

/** Duplicate staging of shot at index onto the next shot when present. */
export function copyStagingToNextShot(
  shots: readonly Shot[],
  sourceShotId: string,
): Shot[] {
  const index = shots.findIndex((shot) => shot.id === sourceShotId);
  if (index < 0 || index >= shots.length - 1) return [...shots];
  const source = shots[index];
  const target = shots[index + 1];
  return shots.map((shot, i) => (i === index + 1 ? copyStagingToShot(source, target) : shot));
}

export interface AnimaticFrame {
  shotId: string;
  localTimeSeconds: number;
  globalTimeSeconds: number;
  durationSeconds: number;
}

/** Resolve which storyboard item is active at a global animatic time. */
export function resolveAnimaticFrame(
  board: SequenceStoryboard,
  globalTimeSeconds: number,
): AnimaticFrame | undefined {
  if (board.items.length === 0) return undefined;
  const total = board.totalDurationSeconds;
  if (total <= 0) {
    const first = board.items[0];
    return {
      shotId: first.shotId,
      localTimeSeconds: 0,
      globalTimeSeconds: 0,
      durationSeconds: first.durationSeconds,
    };
  }
  let t = globalTimeSeconds % total;
  if (t < 0) t += total;
  let cursor = 0;
  for (const item of board.items) {
    const end = cursor + item.durationSeconds;
    if (t < end || item === board.items[board.items.length - 1]) {
      return {
        shotId: item.shotId,
        localTimeSeconds: Math.max(0, t - cursor),
        globalTimeSeconds: t,
        durationSeconds: item.durationSeconds,
      };
    }
    cursor = end;
  }
  const last = board.items[board.items.length - 1];
  return {
    shotId: last.shotId,
    localTimeSeconds: 0,
    globalTimeSeconds: t,
    durationSeconds: last.durationSeconds,
  };
}
