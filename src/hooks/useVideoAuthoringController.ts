import { useCallback, useReducer, useRef } from 'react';
import type { VideoCaptureState } from '../engine/cameraKeyframes';
import {
  createInitialVideoAuthoringState,
  reduceVideoAuthoring,
  tryReduceVideoAuthoring,
  type VideoAuthoringEvent,
  type VideoAuthoringState,
} from '../engine/videoAuthoringMachine';

export type { VideoAuthoringEvent, VideoAuthoringState };

/**
 * React controller for sequential video capture chrome.
 * All transitions go through the named-event state machine.
 */
export function useVideoAuthoringController(
  initial?: Partial<VideoAuthoringState>,
) {
  const [state, dispatchRaw] = useReducer(
    (current: VideoAuthoringState, event: VideoAuthoringEvent) => reduceVideoAuthoring(current, event),
    createInitialVideoAuthoringState(initial),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatch = useCallback((event: VideoAuthoringEvent) => {
    dispatchRaw(event);
  }, []);

  const tryDispatch = useCallback((event: VideoAuthoringEvent) => {
    const result = tryReduceVideoAuthoring(stateRef.current, event);
    if (result.ok) dispatchRaw(event);
    return result;
  }, []);

  const syncFromKeyframes = useCallback((
    keyframeCount: number,
    previousCaptureState?: VideoCaptureState,
  ) => {
    dispatchRaw({
      type: 'UNDO_RESTORED',
      keyframeCount,
      previousCaptureState: previousCaptureState ?? stateRef.current.captureState,
    });
  }, []);

  return {
    state,
    dispatch,
    tryDispatch,
    syncFromKeyframes,
    mode: state.mode,
    captureState: state.captureState,
    isPreviewing: state.isPreviewing,
    timelineOpen: state.timelineOpen,
    keyframeCount: state.keyframeCount,
  };
}
