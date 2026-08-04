/** Minimal event-aware frame sampling for still and motion review. */

import type { CameraKeyframe, Shot } from '../../domain/types';
import { getCameraMoveDurationSeconds, getSortedCameraKeyframes } from '../cameraKeyframes';

export type ReviewSamplingStrategy = 'event-aware' | 'single';

export interface ReviewSample {
  shotId: string;
  timeSeconds: number;
  reasons: string[];
}

export interface ReviewSamplePlan {
  shotId: string;
  strategy: ReviewSamplingStrategy;
  samples: ReviewSample[];
  durationSeconds: number;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function direction(a: CameraKeyframe, b: CameraKeyframe): [number, number, number] | undefined {
  const delta: [number, number, number] = [
    b.camera.position[0] - a.camera.position[0],
    b.camera.position[1] - a.camera.position[1],
    b.camera.position[2] - a.camera.position[2],
  ];
  const length = Math.hypot(...delta);
  return length > 1e-6 ? [delta[0] / length, delta[1] / length, delta[2] / length] : undefined;
}

function hasTemporalObjectEvent(previous: CameraKeyframe | undefined, current: CameraKeyframe): boolean {
  if (!current.objectOverrides) return false;
  if (!previous?.objectOverrides) return Object.keys(current.objectOverrides).length > 0;
  return JSON.stringify(previous.objectOverrides) !== JSON.stringify(current.objectOverrides);
}

function addCandidate(
  candidates: Map<number, Set<string>>,
  timeSeconds: number,
  reason: string,
): void {
  const rounded = Math.round(timeSeconds * 1000) / 1000;
  const reasons = candidates.get(rounded) ?? new Set<string>();
  reasons.add(reason);
  candidates.set(rounded, reasons);
}

/**
 * Choose enough samples to communicate temporal intent without producing a
 * video or a full pass matrix. Event boundaries always outrank filler frames.
 */
export function planReviewSamples(input: {
  shotId: string;
  shot: Pick<Shot, 'id' | 'camera' | 'cameraKeyframes'>;
  strategy?: ReviewSamplingStrategy;
  maxSamples?: number;
}): ReviewSamplePlan {
  const strategy = input.strategy ?? 'event-aware';
  const maxSamples = Math.max(1, Math.floor(input.maxSamples ?? 3));
  const keyframes = getSortedCameraKeyframes(input.shot.cameraKeyframes);
  const durationSeconds = getCameraMoveDurationSeconds(keyframes);
  const candidates = new Map<number, Set<string>>();

  addCandidate(candidates, 0, keyframes.length >= 2 ? 'motion_start' : 'static_frame');
  if (strategy === 'single' || keyframes.length < 2 || durationSeconds <= 0) {
    return {
      shotId: input.shotId,
      strategy,
      durationSeconds,
      samples: [...candidates.entries()].map(([timeSeconds, reasons]) => ({ shotId: input.shotId, timeSeconds, reasons: [...reasons] })),
    };
  }

  addCandidate(candidates, durationSeconds, 'motion_end');
  let previousDirection: [number, number, number] | undefined;
  for (let index = 1; index < keyframes.length; index += 1) {
    const previous = keyframes[index - 1]!;
    const current = keyframes[index]!;
    if (hasTemporalObjectEvent(previous, current)) addCandidate(candidates, current.timeSeconds, 'visibility_or_pose_event');
    const currentDirection = direction(previous, current);
    if (currentDirection && previousDirection) {
      const dot = currentDirection[0] * previousDirection[0]
        + currentDirection[1] * previousDirection[1]
        + currentDirection[2] * previousDirection[2];
      if (dot < 0.8) addCandidate(candidates, current.timeSeconds, 'camera_direction_change');
    }
    if (currentDirection) previousDirection = currentDirection;
  }

  // A motion path with more than two authored segments is complex enough to
  // merit a bounded middle sample even when no explicit event was authored.
  if (keyframes.length > 2) {
    for (let index = 1; index < keyframes.length - 1; index += 1) {
      addCandidate(candidates, keyframes[index]!.timeSeconds, 'keyframe_boundary');
    }
  }

  const sorted = [...candidates.entries()].sort(([a], [b]) => a - b);
  const selected = sorted.length <= maxSamples
    ? sorted
    : [
      sorted[0]!,
      ...sorted.slice(1, -1)
        .filter(([, reasons]) => [...reasons].some((reason) => (
          reason.includes('event')
          || reason.includes('change')
          || reason === 'keyframe_boundary'
        )))
        .slice(0, Math.max(0, maxSamples - 2)),
      sorted.at(-1)!,
    ].sort(([a], [b]) => a - b);
  const uniqueSelected = new Map<number, Set<string>>(selected);
  return {
    shotId: input.shotId,
    strategy,
    durationSeconds,
    samples: [...uniqueSelected.entries()].slice(0, maxSamples).map(([timeSeconds, reasons]) => ({
      shotId: input.shotId,
      timeSeconds,
      reasons: [...reasons],
    })),
  };
}

/** Stable helper for comparing authored camera movement magnitude. */
export function cameraMoveDistance(shot: Pick<Shot, 'camera' | 'cameraKeyframes'>): number {
  const keyframes = getSortedCameraKeyframes(shot.cameraKeyframes);
  if (keyframes.length < 2) return 0;
  return keyframes.slice(1).reduce((total, keyframe, index) => (
    total + distance(keyframes[index]!.camera.position, keyframe.camera.position)
  ), 0);
}
