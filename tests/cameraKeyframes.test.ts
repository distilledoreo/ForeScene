import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  appendSequentialCameraKeyframe,
  CAMERA_KEYFRAME_TIME_EPSILON,
  canInsertCameraKeyframeAfter,
  captureStateAfterKeyframeRestore,
  captureStateFromKeyframes,
  clampDuration,
  getCameraKeyframeDisplayLabel,
  getCameraMoveDurationSeconds,
  getCameraMoveReferenceFrames,
  getIntermediateCameraKeyframeTimeBounds,
  hasManualCameraKeyframeTiming,
  hasRenderableCameraMove,
  insertCameraKeyframeInSegment,
  insertIntermediateCameraKeyframe,
  interpolateCameraKeyframes,
  MAX_CAMERA_MOVE_DURATION_SECONDS,
  recaptureCameraKeyframe,
  removeIntermediateCameraKeyframe,
  setTwoPointCameraKeyframe,
  updateCameraKeyframeEasing,
  updateCameraMoveDuration,
  updateIntermediateCameraKeyframeTime,
} from '../src/engine/cameraKeyframes';

describe('camera keyframes', () => {
  it('captures sorted start and end camera keyframes for a shot move', () => {
    const shot = createDefaultProject().shots[0];
    const endCamera = {
      ...shot.camera,
      position: [2, 1.8, -3] as [number, number, number],
      target: [0, 1.5, 4] as [number, number, number],
      fovDegrees: 45,
    };

    const withEnd = setTwoPointCameraKeyframe({
      keyframes: [],
      slot: 'end',
      camera: endCamera,
      durationSeconds: 4,
    });
    const keyframes = setTwoPointCameraKeyframe({
      keyframes: withEnd,
      slot: 'start',
      camera: shot.camera,
      durationSeconds: 4,
    });

    expect(keyframes.map((keyframe) => keyframe.label)).toEqual(['Start', 'End']);
    expect(keyframes.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 4]);
    expect(hasRenderableCameraMove(keyframes)).toBe(true);
  });

  it('interpolates camera position, target, and fov at the requested time', () => {
    const shot = createDefaultProject().shots[0];
    const endCamera = {
      ...shot.camera,
      position: [4, 2, -2] as [number, number, number],
      target: [0, 2, 2] as [number, number, number],
      fovDegrees: 35,
    };
    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
      }),
      slot: 'end',
      camera: endCamera,
      durationSeconds: 2,
    });

    const halfway = interpolateCameraKeyframes(keyframes, 1);
    expect(halfway.position[0]).toBeCloseTo(2);
    expect(halfway.position[1]).toBeCloseTo(1.825);
    expect(halfway.target[2]).toBeCloseTo(6);
    expect(halfway.fovDegrees).toBeCloseTo((shot.camera.fovDegrees + endCamera.fovDegrees) / 2);
  });

  it('samples start, mid, and end reference frames from a camera move', () => {
    const shot = createDefaultProject().shots[0];
    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 4,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [4, 2, -2],
        target: [0, 2, 2],
      },
      durationSeconds: 4,
    });

    const frames = getCameraMoveReferenceFrames(keyframes);
    expect(frames.map((frame) => frame.id)).toEqual(['start', 'mid', 'end']);
    expect(frames.map((frame) => frame.timeSeconds)).toEqual([0, 2, 4]);
    expect(frames[1].camera.position[0]).toBeCloseTo(2);
  });

  it('does not sample reference frames until a renderable move exists', () => {
    const shot = createDefaultProject().shots[0];
    const keyframes = setTwoPointCameraKeyframe({
      keyframes: [],
      slot: 'start',
      camera: shot.camera,
    });

    expect(getCameraMoveReferenceFrames(keyframes)).toEqual([]);
  });

  it('clamps and updates the end keyframe duration', () => {
    const shot = createDefaultProject().shots[0];
    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [0, 2, -4],
      },
      durationSeconds: 2,
    });

    const updated = updateCameraMoveDuration(keyframes, 60);
    expect(getCameraMoveDurationSeconds(updated)).toBe(30);
    expect(updated[1].timeSeconds).toBe(30);
    expect(clampDuration(Number.NaN)).toBe(3);
  });

  it('captures, retimes, and removes intermediate keyframes without changing the endpoints', () => {
    const shot = createDefaultProject().shots[0];
    const endpoints = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 4,
      }),
      slot: 'end',
      camera: { ...shot.camera, position: [4, 2, -2] },
      durationSeconds: 4,
    });

    const withMiddle = insertIntermediateCameraKeyframe({
      keyframes: endpoints,
      camera: { ...shot.camera, position: [1, 3, 1] },
    });
    expect(withMiddle.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 2, 4]);
    expect(withMiddle[1].label).toBe('Keyframe 1');

    const retimed = updateIntermediateCameraKeyframeTime(withMiddle, withMiddle[1].id, 3);
    expect(retimed.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 3, 4]);
    expect(retimed[1].camera.position).toEqual([1, 3, 1]);

    const removed = removeIntermediateCameraKeyframe(retimed, retimed[1].id);
    expect(removed.map((keyframe) => keyframe.label)).toEqual(['Start', 'End']);
  });

  it('inserts new points into the largest open gap and scales their timing with duration', () => {
    const shot = createDefaultProject().shots[0];
    let keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 8,
      }),
      slot: 'end',
      camera: { ...shot.camera, position: [8, 2, -2] },
      durationSeconds: 8,
    });
    keyframes = insertIntermediateCameraKeyframe({
      keyframes,
      camera: { ...shot.camera, position: [4, 2, -2] },
    });
    keyframes = insertIntermediateCameraKeyframe({
      keyframes,
      camera: { ...shot.camera, position: [2, 2, -2] },
    });
    expect(keyframes.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 2, 4, 8]);

    const shortened = updateCameraMoveDuration(keyframes, 4);
    expect(shortened.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 1, 2, 4]);
  });

  it('keeps retimed intermediate keyframes strictly between their neighbors', () => {
    const shot = createDefaultProject().shots[0];
    let keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: { ...shot.camera, position: [0, shot.camera.position[1], shot.camera.position[2]] },
        durationSeconds: 8,
      }),
      slot: 'end',
      camera: { ...shot.camera, position: [8, shot.camera.position[1], shot.camera.position[2]] },
      durationSeconds: 8,
    });
    keyframes = insertIntermediateCameraKeyframe({
      keyframes,
      camera: { ...shot.camera, position: [4, shot.camera.position[1], shot.camera.position[2]] },
    });
    keyframes = insertIntermediateCameraKeyframe({
      keyframes,
      camera: { ...shot.camera, position: [2, shot.camera.position[1], shot.camera.position[2]] },
    });

    const retimed = updateIntermediateCameraKeyframeTime(keyframes, keyframes[1].id, 4);

    expect(retimed.map((keyframe) => keyframe.timeSeconds)).toEqual([0, 3.99, 4, 8]);
    expect(interpolateCameraKeyframes(retimed, 4).position[0]).toBeCloseTo(4);
    expect(interpolateCameraKeyframes(retimed, 4.0001).position[0]).toBeCloseTo(4.0001);
  });

  it('contracts the retime margin for tightly packed neighboring points', () => {
    const shot = createDefaultProject().shots[0];
    const keyframes = [
      { id: 'start', label: 'Start', timeSeconds: 0, camera: shot.camera },
      { id: 'middle', label: 'Keyframe 1', timeSeconds: 0.004, camera: shot.camera },
      { id: 'next', label: 'Keyframe 2', timeSeconds: 0.008, camera: shot.camera },
      { id: 'end', label: 'End', timeSeconds: 0.5, camera: shot.camera },
    ];

    const bounds = getIntermediateCameraKeyframeTimeBounds(keyframes, 'middle');
    const retimed = updateIntermediateCameraKeyframeTime(keyframes, 'middle', 0.5);

    expect(bounds).toEqual({
      minimumTimeSeconds: expect.closeTo(0.0013333333333333333),
      maximumTimeSeconds: expect.closeTo(0.006666666666666666),
    });
    expect(retimed.map((keyframe) => keyframe.timeSeconds)).toEqual([
      0,
      expect.closeTo(0.006666666666666666),
      0.008,
      0.5,
    ]);
  });

  it('applies the selected easing curve between every camera keyframe', () => {
    const shot = createDefaultProject().shots[0];
    const endpoints = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
      }),
      slot: 'end',
      camera: { ...shot.camera, position: [4, shot.camera.position[1], shot.camera.position[2]] },
      durationSeconds: 2,
    });
    const eased = updateCameraKeyframeEasing(endpoints, 'easeIn');

    expect(interpolateCameraKeyframes(eased, 1).position[0]).toBeCloseTo(1);
    expect(eased[0].easing).toBe('easeIn');
    expect(eased[1].easing).toBeUndefined();
  });
});

describe('appendSequentialCameraKeyframe', () => {
  const cam = (x: number) => {
    const shot = createDefaultProject().shots[0];
    return {
      ...shot.camera,
      position: [x, shot.camera.position[1], shot.camera.position[2]] as [number, number, number],
    };
  };

  it('creates Start at 0s from zero keyframes', () => {
    const keyframes = appendSequentialCameraKeyframe({
      keyframes: [],
      camera: cam(0),
      durationSeconds: 6,
      easing: 'easeInOut',
      preserveManualTiming: false,
      objectOverrides: { 'obj-1': { visible: false } },
    });
    expect(keyframes).toHaveLength(1);
    expect(keyframes[0].timeSeconds).toBe(0);
    expect(keyframes[0].label).toBe('Start');
    expect(keyframes[0].camera.position[0]).toBe(0);
    expect(keyframes[0].objectOverrides).toEqual({ 'obj-1': { visible: false } });
    expect(keyframes[0].easing).toBeUndefined();
  });

  it('creates End at duration from one keyframe and assigns easing to Start', () => {
    const start = appendSequentialCameraKeyframe({
      keyframes: [],
      camera: cam(0),
      durationSeconds: 6,
      easing: 'linear',
      preserveManualTiming: false,
    });
    const keyframes = appendSequentialCameraKeyframe({
      keyframes: start,
      camera: cam(6),
      durationSeconds: 6,
      easing: 'easeOut',
      preserveManualTiming: false,
    });
    expect(keyframes.map((k) => k.timeSeconds)).toEqual([0, 6]);
    expect(keyframes[0].id).toBe(start[0].id);
    expect(keyframes[0].easing).toBe('easeOut');
    expect(keyframes[1].easing).toBeUndefined();
    expect(keyframes[1].camera.position[0]).toBe(6);
    expect(hasRenderableCameraMove(keyframes)).toBe(true);
  });

  it('demotes End on third capture, preserves IDs, assigns intermediate label + easing, new End has new id', () => {
    let keyframes = appendSequentialCameraKeyframe({
      keyframes: [],
      camera: cam(0),
      durationSeconds: 6,
      easing: 'linear',
      preserveManualTiming: false,
    });
    keyframes = appendSequentialCameraKeyframe({
      keyframes,
      camera: cam(6),
      durationSeconds: 6,
      easing: 'linear',
      preserveManualTiming: false,
    });
    const startId = keyframes[0].id;
    const endId = keyframes[1].id;
    const endOverrides = { 'prop': { visible: true } };
    keyframes = keyframes.map((k, i) => (
      i === 1 ? { ...k, objectOverrides: endOverrides } : k
    ));

    const next = appendSequentialCameraKeyframe({
      keyframes,
      camera: cam(3),
      durationSeconds: 6,
      easing: 'easeIn',
      preserveManualTiming: false,
    });

    expect(next).toHaveLength(3);
    expect(next.map((k) => k.timeSeconds)).toEqual([0, 3, 6]);
    expect(next[0].id).toBe(startId);
    expect(next[1].id).toBe(endId);
    expect(next[1].label).toMatch(/^Keyframe \d+$/);
    expect(next[1].label).not.toBe('End');
    expect(next[1].objectOverrides).toEqual(endOverrides);
    expect(next[1].camera.position[0]).toBe(6);
    expect(next[1].easing).toBe('easeIn');
    expect(next[2].id).not.toBe(endId);
    expect(next[2].id).not.toBe(startId);
    expect(next[2].label).toBe('End');
    expect(next[2].easing).toBeUndefined();
    expect(next[2].camera.position[0]).toBe(3);
    // Only one End label remains so setTwoPoint Set End cannot wipe the intermediate.
    expect(next.filter((k) => k.label.toLowerCase() === 'end')).toHaveLength(1);
    const afterSetEnd = setTwoPointCameraKeyframe({
      keyframes: next,
      slot: 'end',
      camera: cam(9),
      durationSeconds: 6,
    });
    expect(afterSetEnd).toHaveLength(3);
    expect(afterSetEnd[1].id).toBe(endId);
    expect(afterSetEnd[2].camera.position[0]).toBe(9);
  });

  it('redistributes evenly for automatic timing with 2/3/4 poses', () => {
    let keyframes = appendSequentialCameraKeyframe({
      keyframes: [],
      camera: cam(0),
      durationSeconds: 6,
      easing: 'linear',
      preserveManualTiming: false,
    });
    keyframes = appendSequentialCameraKeyframe({
      keyframes,
      camera: cam(1),
      durationSeconds: 6,
      easing: 'linear',
      preserveManualTiming: false,
    });
    expect(keyframes.map((k) => k.timeSeconds)).toEqual([0, 6]);

    keyframes = appendSequentialCameraKeyframe({
      keyframes,
      camera: cam(2),
      durationSeconds: 6,
      easing: 'linear',
      preserveManualTiming: false,
    });
    expect(keyframes.map((k) => k.timeSeconds)).toEqual([0, 3, 6]);

    keyframes = appendSequentialCameraKeyframe({
      keyframes,
      camera: cam(3),
      durationSeconds: 6,
      easing: 'linear',
      preserveManualTiming: false,
    });
    expect(keyframes.map((k) => k.timeSeconds)).toEqual([0, 2, 4, 6]);
  });

  it('manual timing splits only the final segment', () => {
    // 0 — 1 — 4 — 6 with manual intermediate times
    const base = [
      { id: 's', label: 'Start', timeSeconds: 0, camera: cam(0), easing: 'linear' as const },
      { id: 'a', label: 'Keyframe 1', timeSeconds: 1, camera: cam(1), easing: 'linear' as const },
      { id: 'b', label: 'Keyframe 2', timeSeconds: 4, camera: cam(4), easing: 'linear' as const },
      { id: 'e', label: 'End', timeSeconds: 6, camera: cam(6) },
    ];
    const next = appendSequentialCameraKeyframe({
      keyframes: base,
      camera: cam(5),
      durationSeconds: 6,
      easing: 'easeOut',
      preserveManualTiming: true,
    });
    expect(next.map((k) => k.timeSeconds)).toEqual([0, 1, 4, 5, 6]);
    expect(next[0].id).toBe('s');
    expect(next[1].id).toBe('a');
    expect(next[2].id).toBe('b');
    expect(next[3].id).toBe('e');
    expect(next[3].easing).toBe('easeOut');
    expect(next[4].camera.position[0]).toBe(5);
    expect(next[4].easing).toBeUndefined();
  });

  it('clamps invalid duration and returns safe result for empty invalid append path', () => {
    const keyframes = appendSequentialCameraKeyframe({
      keyframes: [],
      camera: cam(0),
      durationSeconds: 999,
      easing: 'linear',
      preserveManualTiming: false,
    });
    expect(keyframes[0].timeSeconds).toBe(0);
    const withEnd = appendSequentialCameraKeyframe({
      keyframes,
      camera: cam(1),
      durationSeconds: 999,
      easing: 'linear',
      preserveManualTiming: false,
    });
    expect(withEnd[1].timeSeconds).toBe(MAX_CAMERA_MOVE_DURATION_SECONDS);
  });
});

describe('insertCameraKeyframeInSegment', () => {
  const cam = (x: number) => {
    const shot = createDefaultProject().shots[0];
    return {
      ...shot.camera,
      position: [x, shot.camera.position[1], shot.camera.position[2]] as [number, number, number],
    };
  };

  it('inserts at segment midpoint, preserves order/times/ids, assigns easing', () => {
    const endpoints = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: cam(0),
        durationSeconds: 6,
      }),
      slot: 'end',
      camera: cam(6),
      durationSeconds: 6,
    });
    const startId = endpoints[0].id;
    const endId = endpoints[1].id;
    const inserted = insertCameraKeyframeInSegment({
      keyframes: endpoints,
      afterKeyframeId: startId,
      camera: cam(3),
      easing: 'easeIn',
      objectOverrides: { a: { visible: true } },
    });
    expect(inserted).toHaveLength(3);
    expect(inserted.map((k) => k.timeSeconds)).toEqual([0, 3, 6]);
    expect(inserted[0].id).toBe(startId);
    expect(inserted[2].id).toBe(endId);
    expect(inserted[1].easing).toBe('easeIn');
    expect(inserted[1].camera.position[0]).toBe(3);
    expect(inserted[1].objectOverrides).toEqual({ a: { visible: true } });
  });

  it('rejects insertion after last keyframe and unknown ids safely', () => {
    const endpoints = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: cam(0),
        durationSeconds: 4,
      }),
      slot: 'end',
      camera: cam(4),
      durationSeconds: 4,
    });
    const endId = endpoints[1].id;
    expect(canInsertCameraKeyframeAfter(endpoints, endId)).toBe(false);
    expect(canInsertCameraKeyframeAfter(endpoints, 'missing')).toBe(false);
    expect(insertCameraKeyframeInSegment({
      keyframes: endpoints,
      afterKeyframeId: endId,
      camera: cam(2),
      easing: 'linear',
    })).toEqual(endpoints);
    expect(insertCameraKeyframeInSegment({
      keyframes: endpoints,
      afterKeyframeId: 'missing',
      camera: cam(2),
      easing: 'linear',
    })).toEqual(endpoints);
  });
});

describe('recaptureCameraKeyframe', () => {
  it('replaces camera and overrides while preserving id/time/easing/label', () => {
    const shot = createDefaultProject().shots[0];
    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 4,
      }),
      slot: 'end',
      camera: { ...shot.camera, position: [4, 2, -2] },
      durationSeconds: 4,
    });
    const withEasing = updateCameraKeyframeEasing(keyframes, 'easeInOut');
    const targetId = withEasing[0].id;
    const nextCamera = {
      ...shot.camera,
      position: [9, 1, 0] as [number, number, number],
      target: [1, 1, 1] as [number, number, number],
    };
    const recaptured = recaptureCameraKeyframe({
      keyframes: withEasing,
      keyframeId: targetId,
      camera: nextCamera,
      objectOverrides: { stage: { visible: false } },
    });
    expect(recaptured[0].id).toBe(targetId);
    expect(recaptured[0].label).toBe(withEasing[0].label);
    expect(recaptured[0].timeSeconds).toBe(0);
    expect(recaptured[0].easing).toBe('easeInOut');
    expect(recaptured[0].camera.position).toEqual([9, 1, 0]);
    expect(recaptured[0].objectOverrides).toEqual({ stage: { visible: false } });
    expect(recaptured[1]).toEqual(withEasing[1]);
  });

  it('leaves data unchanged for unknown id', () => {
    const shot = createDefaultProject().shots[0];
    const keyframes = setTwoPointCameraKeyframe({
      keyframes: [],
      slot: 'start',
      camera: shot.camera,
    });
    expect(recaptureCameraKeyframe({
      keyframes,
      keyframeId: 'nope',
      camera: { ...shot.camera, position: [1, 1, 1] },
    })).toEqual(keyframes);
  });
});

describe('hasManualCameraKeyframeTiming', () => {
  const shotCam = () => createDefaultProject().shots[0].camera;

  it('returns false for fewer than three keyframes', () => {
    expect(hasManualCameraKeyframeTiming([], 6)).toBe(false);
    expect(hasManualCameraKeyframeTiming([
      { id: 'a', label: 'Start', timeSeconds: 0, camera: shotCam() },
      { id: 'b', label: 'End', timeSeconds: 6, camera: shotCam() },
    ], 6)).toBe(false);
  });

  it('returns false for evenly distributed timing within epsilon', () => {
    const even = [
      { id: 'a', label: 'Start', timeSeconds: 0, camera: shotCam() },
      { id: 'b', label: 'K', timeSeconds: 3 + CAMERA_KEYFRAME_TIME_EPSILON / 2, camera: shotCam() },
      { id: 'c', label: 'End', timeSeconds: 6, camera: shotCam() },
    ];
    expect(hasManualCameraKeyframeTiming(even, 6)).toBe(false);
  });

  it('returns true for meaningful manual deviation', () => {
    const manual = [
      { id: 'a', label: 'Start', timeSeconds: 0, camera: shotCam() },
      { id: 'b', label: 'K', timeSeconds: 1, camera: shotCam() },
      { id: 'c', label: 'End', timeSeconds: 6, camera: shotCam() },
    ];
    expect(hasManualCameraKeyframeTiming(manual, 6)).toBe(true);
  });

  it('sorts unsorted input before comparing and respects duration', () => {
    const unsorted = [
      { id: 'c', label: 'End', timeSeconds: 8, camera: shotCam() },
      { id: 'a', label: 'Start', timeSeconds: 0, camera: shotCam() },
      { id: 'b', label: 'K', timeSeconds: 4, camera: shotCam() },
    ];
    expect(hasManualCameraKeyframeTiming(unsorted, 8)).toBe(false);
    expect(hasManualCameraKeyframeTiming(unsorted, 6)).toBe(true);
  });

  it('derives display labels from chronological index', () => {
    expect(getCameraKeyframeDisplayLabel(0, 4)).toBe('Start');
    expect(getCameraKeyframeDisplayLabel(1, 4)).toBe('K1');
    expect(getCameraKeyframeDisplayLabel(2, 4)).toBe('K2');
    expect(getCameraKeyframeDisplayLabel(3, 4)).toBe('End');
  });
});

describe('video capture state after keyframe restore', () => {
  it('maps keyframe counts to empty/capturing/finished for load', () => {
    expect(captureStateFromKeyframes([])).toBe('empty');
    expect(captureStateFromKeyframes([{}])).toBe('capturing');
    expect(captureStateFromKeyframes([{}, {}])).toBe('finished');
  });

  it('undo from finished two-pose to start-only returns capturing (not stuck finished)', () => {
    expect(captureStateAfterKeyframeRestore([{}], 'finished')).toBe('capturing');
    expect(captureStateAfterKeyframeRestore([], 'finished')).toBe('empty');
  });

  it('preserves capturing when multi-pose sequence is still being authored', () => {
    expect(captureStateAfterKeyframeRestore([{}, {}, {}], 'capturing')).toBe('capturing');
    expect(captureStateAfterKeyframeRestore([{}, {}], 'finished')).toBe('finished');
  });
});

