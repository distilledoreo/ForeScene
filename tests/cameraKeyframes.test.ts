import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import {
  clampDuration,
  getCameraMoveDurationSeconds,
  getCameraMoveReferenceFrames,
  hasRenderableCameraMove,
  insertIntermediateCameraKeyframe,
  interpolateCameraKeyframes,
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
