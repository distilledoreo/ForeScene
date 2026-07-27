/**
 * Explicit video authoring state machine for sequential capture.
 * Prevents impossible capture/preview combinations by named events.
 * UI must read mode/captureState/isPreviewing from reduced state only.
 */

import type { VideoCaptureState } from './cameraKeyframes';

export type VideoAuthoringMode = 'still' | 'video';

export type VideoAuthoringEvent =
  | { type: 'ENTER_VIDEO'; keyframeCount?: number }
  | { type: 'EXIT_VIDEO' }
  | { type: 'CAPTURE_POSE'; keyframeCountAfter: number }
  | { type: 'FINISH_MOVE' }
  | { type: 'CONTINUE_MOVE' }
  | { type: 'UNDO_RESTORED'; keyframeCount: number; previousCaptureState: VideoCaptureState }
  | { type: 'RETAKE' }
  | { type: 'NEXT_SHOT' }
  | { type: 'START_PREVIEW' }
  | { type: 'STOP_PREVIEW' }
  | { type: 'OPEN_TIMELINE' }
  | { type: 'CLOSE_TIMELINE' }
  | { type: 'SET_KEYFRAME_COUNT'; count: number };

export interface VideoAuthoringState {
  mode: VideoAuthoringMode;
  captureState: VideoCaptureState;
  isPreviewing: boolean;
  timelineOpen: boolean;
  keyframeCount: number;
}

export class VideoAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoAuthoringError';
  }
}

export function createInitialVideoAuthoringState(
  partial?: Partial<VideoAuthoringState>,
): VideoAuthoringState {
  return {
    mode: 'still',
    captureState: 'empty',
    isPreviewing: false,
    timelineOpen: false,
    keyframeCount: 0,
    ...partial,
  };
}

function captureStateFromCount(count: number): VideoCaptureState {
  if (count <= 0) return 'empty';
  if (count === 1) return 'capturing';
  return 'finished';
}

function afterRestore(count: number, previous: VideoCaptureState): VideoCaptureState {
  if (count <= 0) return 'empty';
  if (count === 1) return 'capturing';
  if (previous === 'capturing') return 'capturing';
  return 'finished';
}

/** Reduce video authoring chrome. Throws VideoAuthoringError on illegal transitions. */
export function reduceVideoAuthoring(
  state: VideoAuthoringState,
  event: VideoAuthoringEvent,
): VideoAuthoringState {
  switch (event.type) {
    case 'ENTER_VIDEO': {
      const keyframeCount = event.keyframeCount ?? state.keyframeCount;
      const captureState = captureStateFromCount(keyframeCount);
      return {
        ...state,
        mode: 'video',
        keyframeCount,
        captureState,
        isPreviewing: false,
        timelineOpen: keyframeCount > 2 ? state.timelineOpen : false,
      };
    }
    case 'EXIT_VIDEO':
      return {
        ...state,
        mode: 'still',
        isPreviewing: false,
        captureState: 'empty',
        timelineOpen: false,
      };
    case 'CAPTURE_POSE': {
      if (state.mode !== 'video') {
        throw new VideoAuthoringError('CAPTURE_POSE requires video mode.');
      }
      if (state.isPreviewing) {
        throw new VideoAuthoringError('Cannot capture pose while preview is playing.');
      }
      if (state.captureState === 'finished') {
        throw new VideoAuthoringError('Capture is finished; use CONTINUE_MOVE or RETAKE.');
      }
      const keyframeCount = Math.max(0, event.keyframeCountAfter);
      return {
        ...state,
        keyframeCount,
        // Stay capturing until FINISH_MOVE (even with ≥2 poses).
        captureState: keyframeCount <= 0 ? 'empty' : 'capturing',
        timelineOpen: keyframeCount > 2 ? true : state.timelineOpen,
      };
    }
    case 'FINISH_MOVE': {
      if (state.mode !== 'video') {
        throw new VideoAuthoringError('FINISH_MOVE requires video mode.');
      }
      if (state.keyframeCount < 2) {
        throw new VideoAuthoringError('FINISH_MOVE requires at least two poses.');
      }
      if (state.captureState !== 'capturing') {
        throw new VideoAuthoringError('FINISH_MOVE only applies while capturing.');
      }
      return {
        ...state,
        captureState: 'finished',
        isPreviewing: false,
      };
    }
    case 'CONTINUE_MOVE': {
      if (state.mode !== 'video') {
        throw new VideoAuthoringError('CONTINUE_MOVE requires video mode.');
      }
      if (state.captureState !== 'finished' || state.keyframeCount < 2) {
        throw new VideoAuthoringError('CONTINUE_MOVE requires a finished move with ≥2 poses.');
      }
      return {
        ...state,
        captureState: 'capturing',
        isPreviewing: false,
      };
    }
    case 'UNDO_RESTORED': {
      const captureState = afterRestore(event.keyframeCount, event.previousCaptureState);
      return {
        ...state,
        keyframeCount: Math.max(0, event.keyframeCount),
        captureState,
        isPreviewing: false,
        timelineOpen: event.keyframeCount > 2 ? state.timelineOpen : false,
      };
    }
    case 'RETAKE':
      return {
        ...state,
        mode: 'video',
        captureState: 'empty',
        isPreviewing: false,
        timelineOpen: false,
        keyframeCount: 0,
      };
    case 'NEXT_SHOT':
      return {
        ...state,
        mode: 'video',
        captureState: 'empty',
        isPreviewing: false,
        timelineOpen: false,
        keyframeCount: 0,
      };
    case 'START_PREVIEW': {
      if (state.mode !== 'video') {
        throw new VideoAuthoringError('START_PREVIEW requires video mode.');
      }
      if (state.keyframeCount < 2) {
        throw new VideoAuthoringError('START_PREVIEW requires at least two poses.');
      }
      return { ...state, isPreviewing: true };
    }
    case 'STOP_PREVIEW':
      return { ...state, isPreviewing: false };
    case 'OPEN_TIMELINE':
      return { ...state, timelineOpen: true };
    case 'CLOSE_TIMELINE':
      return { ...state, timelineOpen: false };
    case 'SET_KEYFRAME_COUNT': {
      const keyframeCount = Math.max(0, event.count);
      let captureState = state.captureState;
      if (state.mode === 'video') {
        if (keyframeCount === 0) captureState = 'empty';
        else if (keyframeCount === 1) captureState = 'capturing';
        else if (state.captureState === 'capturing') captureState = 'capturing';
        else captureState = 'finished';
      }
      return {
        ...state,
        keyframeCount,
        captureState,
        timelineOpen: keyframeCount > 2
          ? true
          : keyframeCount <= 2
            ? (state.timelineOpen && keyframeCount >= 2 ? state.timelineOpen : false)
            : state.timelineOpen,
      };
    }
    default: {
      const _exhaustive: never = event;
      throw new VideoAuthoringError(`Unknown event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Safe reduce that returns the previous state on illegal transitions. */
export function tryReduceVideoAuthoring(
  state: VideoAuthoringState,
  event: VideoAuthoringEvent,
): { ok: true; state: VideoAuthoringState } | { ok: false; error: VideoAuthoringError; state: VideoAuthoringState } {
  try {
    return { ok: true, state: reduceVideoAuthoring(state, event) };
  } catch (error) {
    if (error instanceof VideoAuthoringError) {
      return { ok: false, error, state };
    }
    throw error;
  }
}
