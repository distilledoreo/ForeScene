import { describe, expect, it } from 'vitest';
import {
  createInitialVideoAuthoringState,
  reduceVideoAuthoring,
  tryReduceVideoAuthoring,
  VideoAuthoringError,
} from '../src/engine/videoAuthoringMachine';

describe('video authoring state machine', () => {
  it('transitions ENTER_VIDEO → CAPTURE_POSE → FINISH_MOVE → NEXT_SHOT', () => {
    let state = createInitialVideoAuthoringState();
    state = reduceVideoAuthoring(state, { type: 'ENTER_VIDEO' });
    expect(state.mode).toBe('video');
    expect(state.captureState).toBe('empty');

    state = reduceVideoAuthoring(state, { type: 'CAPTURE_POSE', keyframeCountAfter: 1 });
    expect(state.captureState).toBe('capturing');
    expect(state.keyframeCount).toBe(1);

    state = reduceVideoAuthoring(state, { type: 'CAPTURE_POSE', keyframeCountAfter: 2 });
    expect(state.captureState).toBe('capturing');
    expect(state.keyframeCount).toBe(2);

    state = reduceVideoAuthoring(state, { type: 'FINISH_MOVE' });
    expect(state.captureState).toBe('finished');

    state = reduceVideoAuthoring(state, { type: 'NEXT_SHOT' });
    expect(state.captureState).toBe('empty');
    expect(state.keyframeCount).toBe(0);
  });

  it('supports CONTINUE_MOVE, RETAKE, preview, and UNDO_RESTORED', () => {
    let state = createInitialVideoAuthoringState({
      mode: 'video',
      captureState: 'finished',
      keyframeCount: 3,
      timelineOpen: true,
    });
    state = reduceVideoAuthoring(state, { type: 'CONTINUE_MOVE' });
    expect(state.captureState).toBe('capturing');

    state = reduceVideoAuthoring(state, { type: 'START_PREVIEW' });
    expect(state.isPreviewing).toBe(true);
    state = reduceVideoAuthoring(state, { type: 'STOP_PREVIEW' });
    expect(state.isPreviewing).toBe(false);

    state = reduceVideoAuthoring(state, {
      type: 'UNDO_RESTORED',
      keyframeCount: 1,
      previousCaptureState: 'capturing',
    });
    expect(state.captureState).toBe('capturing');
    expect(state.keyframeCount).toBe(1);

    state = reduceVideoAuthoring(state, { type: 'RETAKE' });
    expect(state.captureState).toBe('empty');
    expect(state.keyframeCount).toBe(0);
    expect(state.timelineOpen).toBe(false);
  });

  it('rejects impossible combinations', () => {
    const empty = createInitialVideoAuthoringState();
    expect(() => reduceVideoAuthoring(empty, { type: 'FINISH_MOVE' })).toThrow(VideoAuthoringError);
    expect(() => reduceVideoAuthoring(empty, { type: 'CAPTURE_POSE', keyframeCountAfter: 1 }))
      .toThrow(VideoAuthoringError);

    const finished = createInitialVideoAuthoringState({
      mode: 'video',
      captureState: 'finished',
      keyframeCount: 2,
    });
    expect(() => reduceVideoAuthoring(finished, { type: 'CAPTURE_POSE', keyframeCountAfter: 3 }))
      .toThrow(VideoAuthoringError);
    expect(() => reduceVideoAuthoring(finished, { type: 'FINISH_MOVE' })).toThrow(VideoAuthoringError);

    const rejected = tryReduceVideoAuthoring(empty, { type: 'CONTINUE_MOVE' });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.error instanceof VideoAuthoringError).toBe(true);
    expect(rejected.state).toEqual(empty);
  });
});
