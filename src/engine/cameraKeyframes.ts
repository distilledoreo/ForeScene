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

export type CameraMoveKeyframeSlot = 'start' | 'end';

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

  const usedNumbers = new Set(
    sorted
      .map((keyframe) => /^Keyframe (\d+)$/i.exec(keyframe.label)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number),
  );
  let labelNumber = 1;
  while (usedNumbers.has(labelNumber)) labelNumber += 1;

  const before = sorted[gapStartIndex];
  const after = sorted[gapStartIndex + 1];
  const inserted = createCameraKeyframe({
    label: `Keyframe ${labelNumber}`,
    timeSeconds: before.timeSeconds + ((after.timeSeconds - before.timeSeconds) / 2),
    camera: params.camera,
    easing: before.easing ?? 'linear',
    objectOverrides: params.objectOverrides,
  });
  return getSortedCameraKeyframes([...sorted, inserted]);
}

export function updateIntermediateCameraKeyframeTime(
  keyframes: readonly CameraKeyframe[],
  keyframeId: string,
  timeSeconds: number,
): CameraKeyframe[] {
  const sorted = getSortedCameraKeyframes(keyframes);
  if (sorted.length < 3 || !Number.isFinite(timeSeconds)) return sorted;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (keyframeId === first.id || keyframeId === last.id) return sorted;
  const margin = Math.min(0.01, (last.timeSeconds - first.timeSeconds) / 4);
  const clamped = Math.max(first.timeSeconds + margin, Math.min(last.timeSeconds - margin, timeSeconds));
  return getSortedCameraKeyframes(sorted.map((keyframe) => (
    keyframe.id === keyframeId ? { ...keyframe, timeSeconds: clamped } : keyframe
  )));
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
