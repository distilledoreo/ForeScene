import {
  CameraData,
  CameraKeyframe,
  CameraKeyframeEasing,
  ShotObjectOverrides,
} from '../domain/types';
import { createCameraKeyframe } from '../domain/defaults';

export const DEFAULT_CAMERA_MOVE_DURATION_SECONDS = 3;
export const MIN_CAMERA_MOVE_DURATION_SECONDS = 0.5;
export const MAX_CAMERA_MOVE_DURATION_SECONDS = 30;
/** Tolerance when comparing authored times to even automatic distribution. */
export const CAMERA_KEYFRAME_TIME_EPSILON = 0.001;

export type CameraMoveKeyframeSlot = 'start' | 'end';
export type VideoCaptureState = 'empty' | 'capturing' | 'finished';

export const CAMERA_KEYFRAME_EASING_OPTIONS: readonly {
  value: CameraKeyframeEasing;
  label: string;
}[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'easeIn', label: 'Ease in' },
  { value: 'easeOut', label: 'Ease out' },
  { value: 'easeInOut', label: 'Ease in & out' },
];

export interface CameraMoveReferenceFrame {
  id: 'start' | 'mid' | 'end';
  label: 'Start' | 'Mid' | 'End';
  timeSeconds: number;
  camera: CameraData;
}

export function getSortedCameraKeyframes(keyframes: readonly CameraKeyframe[] = []): CameraKeyframe[] {
  return [...keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
}

export function hasRenderableCameraMove(keyframes: readonly CameraKeyframe[] = []): boolean {
  const sorted = getSortedCameraKeyframes(keyframes);
  return sorted.length >= 2 && getCameraMoveDurationSeconds(sorted) > 0;
}

export function getCameraMoveDurationSeconds(
  keyframes: readonly CameraKeyframe[] = [],
  fallback = DEFAULT_CAMERA_MOVE_DURATION_SECONDS,
): number {
  const sorted = getSortedCameraKeyframes(keyframes);
  if (sorted.length < 2) return fallback;
  const first = sorted[0]?.timeSeconds ?? 0;
  const last = sorted[sorted.length - 1]?.timeSeconds ?? fallback;
  return clampDuration(last - first);
}

export function setTwoPointCameraKeyframe(params: {
  keyframes: readonly CameraKeyframe[];
  slot: CameraMoveKeyframeSlot;
  camera: CameraData;
  durationSeconds?: number;
  /** Staged-object snapshot frozen with this keyframe for video animation. */
  objectOverrides?: ShotObjectOverrides;
}): CameraKeyframe[] {
  const durationSeconds = clampDuration(params.durationSeconds ?? getCameraMoveDurationSeconds(params.keyframes));
  const label = params.slot === 'start' ? 'Start' : 'End';
  const timeSeconds = params.slot === 'start' ? 0 : durationSeconds;
  const replacement = createCameraKeyframe({
    label,
    timeSeconds,
    camera: params.camera,
    easing: params.keyframes.find((keyframe) => keyframe.label.toLowerCase() === label.toLowerCase())?.easing,
    objectOverrides: params.objectOverrides,
  });
  const filtered = params.keyframes.filter((keyframe) => keyframe.label.toLowerCase() !== label.toLowerCase());
  return getSortedCameraKeyframes([...filtered, replacement]);
}

export function updateCameraMoveDuration(
  keyframes: readonly CameraKeyframe[],
  durationSeconds: number,
): CameraKeyframe[] {
  const duration = clampDuration(durationSeconds);
  const sorted = getSortedCameraKeyframes(keyframes);
  if (sorted.length < 2) return sorted;
  const firstTime = sorted[0].timeSeconds;
  const oldDuration = Math.max(
    sorted[sorted.length - 1].timeSeconds - firstTime,
    Number.EPSILON,
  );
  return sorted.map((keyframe, index) => ({
    ...keyframe,
    timeSeconds: index === sorted.length - 1
      ? duration
      : ((keyframe.timeSeconds - firstTime) / oldDuration) * duration,
  }));
}

export function insertIntermediateCameraKeyframe(params: {
  keyframes: readonly CameraKeyframe[];
  camera: CameraData;
  objectOverrides?: ShotObjectOverrides;
}): CameraKeyframe[] {
  const sorted = getSortedCameraKeyframes(params.keyframes);
  if (!hasRenderableCameraMove(sorted)) return sorted;

  let gapStartIndex = 0;
  let largestGap = -1;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const gap = sorted[index + 1].timeSeconds - sorted[index].timeSeconds;
    if (gap > largestGap) {
      largestGap = gap;
      gapStartIndex = index;
    }
  }

  const before = sorted[gapStartIndex];
  const after = sorted[gapStartIndex + 1];
  const inserted = createCameraKeyframe({
    label: nextIntermediateCameraKeyframeLabel(sorted),
    timeSeconds: before.timeSeconds + ((after.timeSeconds - before.timeSeconds) / 2),
    camera: params.camera,
    easing: before.easing ?? 'linear',
    objectOverrides: params.objectOverrides,
  });
  return getSortedCameraKeyframes([...sorted, inserted]);
}

/**
 * Append the current camera pose as the next sequential keyframe.
 * First pose → Start@0; second → End@duration; further poses demote End to intermediate
 * and create a new End, redistributing times evenly unless preserveManualTiming is set.
 */
export function appendSequentialCameraKeyframe(params: {
  keyframes: readonly CameraKeyframe[];
  camera: CameraData;
  durationSeconds: number;
  objectOverrides?: ShotObjectOverrides;
  easing: CameraKeyframeEasing;
  preserveManualTiming: boolean;
}): CameraKeyframe[] {
  const duration = clampDuration(params.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    return getSortedCameraKeyframes(params.keyframes);
  }

  const sorted = getSortedCameraKeyframes(params.keyframes);

  if (sorted.length === 0) {
    return [
      createCameraKeyframe({
        label: 'Start',
        timeSeconds: 0,
        camera: params.camera,
        objectOverrides: params.objectOverrides,
      }),
    ];
  }

  if (sorted.length === 1) {
    const start: CameraKeyframe = {
      ...sorted[0],
      timeSeconds: 0,
      easing: params.easing,
    };
    const end = createCameraKeyframe({
      label: 'End',
      timeSeconds: duration,
      camera: params.camera,
      objectOverrides: params.objectOverrides,
    });
    return [start, end];
  }

  // Two or more: demote current End (preserve id/camera/overrides), create new End.
  // Re-label demoted End so label-based tools (e.g. setTwoPointCameraKeyframe) do not
  // treat multiple "End" labels as one slot and drop intermediates.
  const formerEnd = sorted[sorted.length - 1];
  const preservedPrefix = sorted.slice(0, -1).map((keyframe) => ({ ...keyframe }));
  const demotedEnd: CameraKeyframe = {
    ...formerEnd,
    label: nextIntermediateCameraKeyframeLabel(sorted),
    easing: params.easing,
  };
  const newEnd = createCameraKeyframe({
    label: 'End',
    timeSeconds: duration,
    camera: params.camera,
    objectOverrides: params.objectOverrides,
  });

  if (params.preserveManualTiming) {
    const previous = preservedPrefix[preservedPrefix.length - 1];
    const previousTime = previous?.timeSeconds ?? 0;
    demotedEnd.timeSeconds = previousTime + ((duration - previousTime) / 2);
    // Keep all existing intermediate times; only demoted former End and new End change.
    return getSortedCameraKeyframes([
      ...preservedPrefix,
      demotedEnd,
      newEnd,
    ]);
  }

  // Automatic: even distribution across all poses (including the new End).
  const all = [...preservedPrefix, demotedEnd, newEnd];
  const lastIndex = all.length - 1;
  return all.map((keyframe, index) => {
    const timeSeconds = (index / lastIndex) * duration;
    if (index === lastIndex) {
      const { easing: _omit, ...withoutEasing } = keyframe;
      return { ...withoutEasing, timeSeconds };
    }
    if (index === lastIndex - 1) {
      return { ...keyframe, timeSeconds, easing: params.easing };
    }
    return { ...keyframe, timeSeconds };
  });
}

/**
 * Insert a keyframe at the midpoint of the segment that starts at afterKeyframeId.
 * Returns unchanged data when the id is unknown or is the final keyframe.
 */
export function insertCameraKeyframeInSegment(params: {
  keyframes: readonly CameraKeyframe[];
  afterKeyframeId: string;
  camera: CameraData;
  objectOverrides?: ShotObjectOverrides;
  easing: CameraKeyframeEasing;
}): CameraKeyframe[] {
  const sorted = getSortedCameraKeyframes(params.keyframes);
  if (!canInsertCameraKeyframeAfter(sorted, params.afterKeyframeId)) {
    return sorted;
  }
  const index = sorted.findIndex((keyframe) => keyframe.id === params.afterKeyframeId);
  const before = sorted[index];
  const after = sorted[index + 1];
  const inserted = createCameraKeyframe({
    label: nextIntermediateCameraKeyframeLabel(sorted),
    timeSeconds: before.timeSeconds + ((after.timeSeconds - before.timeSeconds) / 2),
    camera: params.camera,
    easing: params.easing,
    objectOverrides: params.objectOverrides,
  });
  return getSortedCameraKeyframes([...sorted, inserted]);
}

export function canInsertCameraKeyframeAfter(
  keyframes: readonly CameraKeyframe[],
  afterKeyframeId: string,
): boolean {
  if (!afterKeyframeId) return false;
  const sorted = getSortedCameraKeyframes(keyframes);
  const index = sorted.findIndex((keyframe) => keyframe.id === afterKeyframeId);
  return index >= 0 && index < sorted.length - 1;
}

/**
 * Overwrite camera + objectOverrides for an existing keyframe.
 * Preserves id, label, time, easing, and sequence position.
 */
export function recaptureCameraKeyframe(params: {
  keyframes: readonly CameraKeyframe[];
  keyframeId: string;
  camera: CameraData;
  objectOverrides?: ShotObjectOverrides;
}): CameraKeyframe[] {
  const sorted = getSortedCameraKeyframes(params.keyframes);
  if (!sorted.some((keyframe) => keyframe.id === params.keyframeId)) {
    return sorted;
  }
  return sorted.map((keyframe) => {
    if (keyframe.id !== params.keyframeId) return keyframe;
    const next: CameraKeyframe = {
      ...keyframe,
      camera: cloneCamera(params.camera),
    };
    if (params.objectOverrides !== undefined) {
      next.objectOverrides = structuredClone(params.objectOverrides);
    } else {
      delete next.objectOverrides;
    }
    return next;
  });
}

/**
 * True when sorted keyframe times deviate from even distribution by more than epsilon.
 * Always false for fewer than three keyframes.
 */
export function hasManualCameraKeyframeTiming(
  keyframes: readonly CameraKeyframe[],
  durationSeconds: number,
): boolean {
  const sorted = getSortedCameraKeyframes(keyframes);
  const n = sorted.length;
  if (n < 3) return false;
  const duration = clampDuration(durationSeconds);
  for (let index = 0; index < n; index += 1) {
    const expectedTime = (index / (n - 1)) * duration;
    if (Math.abs(sorted[index].timeSeconds - expectedTime) > CAMERA_KEYFRAME_TIME_EPSILON) {
      return true;
    }
  }
  return false;
}

/** Display label from chronological index (not persisted labels). */
export function getCameraKeyframeDisplayLabel(
  index: number,
  total: number,
): string {
  if (total <= 0) return '';
  if (index === 0) return 'Start';
  if (index === total - 1) return 'End';
  return `K${index}`;
}

function nextIntermediateCameraKeyframeLabel(keyframes: readonly CameraKeyframe[]): string {
  const usedNumbers = new Set(
    keyframes
      .map((keyframe) => /^Keyframe (\d+)$/i.exec(keyframe.label)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number),
  );
  let labelNumber = 1;
  while (usedNumbers.has(labelNumber)) labelNumber += 1;
  return `Keyframe ${labelNumber}`;
}

export function updateIntermediateCameraKeyframeTime(
  keyframes: readonly CameraKeyframe[],
  keyframeId: string,
  timeSeconds: number,
): CameraKeyframe[] {
  const sorted = getSortedCameraKeyframes(keyframes);
  if (sorted.length < 3 || !Number.isFinite(timeSeconds)) return sorted;
  const bounds = getIntermediateCameraKeyframeTimeBounds(sorted, keyframeId);
  if (!bounds) return sorted;
  const clamped = Math.max(
    bounds.minimumTimeSeconds,
    Math.min(bounds.maximumTimeSeconds, timeSeconds),
  );
  return getSortedCameraKeyframes(sorted.map((keyframe) => (
    keyframe.id === keyframeId ? { ...keyframe, timeSeconds: clamped } : keyframe
  )));
}

export interface IntermediateCameraKeyframeTimeBounds {
  minimumTimeSeconds: number;
  maximumTimeSeconds: number;
}

/**
 * Return a strict, neighbor-aware time window for an intermediate point.
 * The margin contracts for tightly packed points so valid imports and short
 * camera moves cannot be retimed past an adjacent keyframe.
 */
export function getIntermediateCameraKeyframeTimeBounds(
  keyframes: readonly CameraKeyframe[],
  keyframeId: string,
): IntermediateCameraKeyframeTimeBounds | undefined {
  const sorted = getSortedCameraKeyframes(keyframes);
  const keyframeIndex = sorted.findIndex((keyframe) => keyframe.id === keyframeId);
  if (keyframeIndex <= 0 || keyframeIndex >= sorted.length - 1) return undefined;

  const previous = sorted[keyframeIndex - 1];
  const next = sorted[keyframeIndex + 1];
  const gap = next.timeSeconds - previous.timeSeconds;
  if (!Number.isFinite(gap) || gap <= 0) return undefined;

  const margin = Math.min(0.01, gap / 3);
  return {
    minimumTimeSeconds: previous.timeSeconds + margin,
    maximumTimeSeconds: next.timeSeconds - margin,
  };
}

export function removeIntermediateCameraKeyframe(
  keyframes: readonly CameraKeyframe[],
  keyframeId: string,
): CameraKeyframe[] {
  const sorted = getSortedCameraKeyframes(keyframes);
  if (sorted.length <= 2) return sorted;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (keyframeId === first.id || keyframeId === last.id) return sorted;
  return sorted.filter((keyframe) => keyframe.id !== keyframeId);
}

export function updateCameraKeyframeEasing(
  keyframes: readonly CameraKeyframe[],
  easing: CameraKeyframeEasing,
): CameraKeyframe[] {
  const sorted = getSortedCameraKeyframes(keyframes);
  return sorted.map((keyframe, index) => (
    index < sorted.length - 1 ? { ...keyframe, easing } : keyframe
  ));
}

export function applyCameraKeyframeEasing(
  easing: CameraKeyframeEasing | undefined,
  progress: number,
): number {
  const t = Math.max(0, Math.min(1, progress));
  switch (easing) {
    case 'easeIn':
      return t * t;
    case 'easeOut':
      return 1 - ((1 - t) * (1 - t));
    case 'easeInOut':
      return t * t * (3 - (2 * t));
    default:
      return t;
  }
}

export function getCameraMoveReferenceFrames(
  keyframes: readonly CameraKeyframe[],
): CameraMoveReferenceFrame[] {
  const sorted = getSortedCameraKeyframes(keyframes);
  if (!hasRenderableCameraMove(sorted)) return [];
  const start = sorted[0];
  const end = sorted[sorted.length - 1];
  const midTimeSeconds = start.timeSeconds + ((end.timeSeconds - start.timeSeconds) / 2);
  return [
    {
      id: 'start',
      label: 'Start',
      timeSeconds: start.timeSeconds,
      camera: cloneCamera(start.camera),
    },
    {
      id: 'mid',
      label: 'Mid',
      timeSeconds: midTimeSeconds,
      camera: interpolateCameraKeyframes(sorted, midTimeSeconds),
    },
    {
      id: 'end',
      label: 'End',
      timeSeconds: end.timeSeconds,
      camera: cloneCamera(end.camera),
    },
  ];
}

export function interpolateCameraKeyframes(
  keyframes: readonly CameraKeyframe[],
  timeSeconds: number,
): CameraData {
  const sorted = getSortedCameraKeyframes(keyframes);
  if (sorted.length === 0) {
    throw new Error('At least one camera keyframe is required.');
  }
  if (sorted.length === 1 || timeSeconds <= sorted[0].timeSeconds) {
    return cloneCamera(sorted[0].camera);
  }
  const last = sorted[sorted.length - 1];
  if (timeSeconds >= last.timeSeconds) {
    return cloneCamera(last.camera);
  }

  const nextIndex = sorted.findIndex((keyframe) => keyframe.timeSeconds >= timeSeconds);
  const start = sorted[Math.max(0, nextIndex - 1)];
  const end = sorted[nextIndex];
  const span = Math.max(end.timeSeconds - start.timeSeconds, Number.EPSILON);
  const t = applyCameraKeyframeEasing(
    start.easing,
    (timeSeconds - start.timeSeconds) / span,
  );

  return {
    position: lerpVec3(start.camera.position, end.camera.position, t),
    target: lerpVec3(start.camera.target, end.camera.target, t),
    fovDegrees: lerp(start.camera.fovDegrees, end.camera.fovDegrees, t),
    aspectRatio: lerp(start.camera.aspectRatio, end.camera.aspectRatio, t),
    near: lerp(start.camera.near, end.camera.near, t),
    far: lerp(start.camera.far, end.camera.far, t),
  };
}

export function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CAMERA_MOVE_DURATION_SECONDS;
  return Math.max(MIN_CAMERA_MOVE_DURATION_SECONDS, Math.min(MAX_CAMERA_MOVE_DURATION_SECONDS, value));
}

function cloneCamera(camera: CameraData): CameraData {
  return {
    position: [...camera.position],
    target: [...camera.target],
    fovDegrees: camera.fovDegrees,
    aspectRatio: camera.aspectRatio,
    near: camera.near,
    far: camera.far,
  };
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function lerpVec3(start: CameraData['position'], end: CameraData['position'], t: number): CameraData['position'] {
  return [
    lerp(start[0], end[0], t),
    lerp(start[1], end[1], t),
    lerp(start[2], end[2], t),
  ];
}
