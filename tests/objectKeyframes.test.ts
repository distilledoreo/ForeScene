import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  setTwoPointCameraKeyframe,
  updateCameraKeyframeEasing,
} from '../src/engine/cameraKeyframes';
import {
  cameraKeyframesHaveObjectAnimation,
  interpolateObjectOverrides,
  snapshotStageableObjectOverrides,
} from '../src/engine/objectKeyframes';
import { updateShotObjectOverrides } from '../src/engine/shotSceneState';
import { createShotPackageManifest } from '../src/engine/exportManifest';

describe('object keyframes', () => {
  it('snapshots absolute stageable poses for camera keyframes', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const prop = createSceneObject('box', 1);
    prop.stagingRole = 'prop';
    project.scene.objects.push(prop);
    shot.objectOverrides = updateShotObjectOverrides(shot, prop, {
      transform: {
        ...prop.transform,
        position: [1, 0.7, 0],
      },
    });

    const snapshot = snapshotStageableObjectOverrides(project, shot);
    expect(snapshot[prop.id]?.transform?.position[0]).toBe(1);
    // Unmoved stageables (e.g. starter mannequin) are still frozen at their resolved pose.
    const mannequin = project.scene.objects.find((object) => object.type === 'human_dummy');
    expect(mannequin && snapshot[mannequin.id]?.transform).toBeTruthy();
  });

  it('stores staged-object snapshots on start and end camera keyframes', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const prop = createSceneObject('box', 1);
    prop.stagingRole = 'prop';
    project.scene.objects.push(prop);

    const startOverrides = snapshotStageableObjectOverrides(project, {
      objectOverrides: {
        [prop.id]: {
          transform: {
            ...prop.transform,
            position: [1, 0.7, 0],
          },
        },
      },
    });
    const endOverrides = snapshotStageableObjectOverrides(project, {
      objectOverrides: {
        [prop.id]: {
          transform: {
            ...prop.transform,
            position: [5, 0.7, 0],
          },
        },
      },
    });

    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
        objectOverrides: startOverrides,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [0, 2, -4],
      },
      durationSeconds: 2,
      objectOverrides: endOverrides,
    });

    expect(cameraKeyframesHaveObjectAnimation(keyframes)).toBe(true);
    expect(keyframes[0].objectOverrides?.[prop.id]?.transform?.position[0]).toBe(1);
    expect(keyframes[1].objectOverrides?.[prop.id]?.transform?.position[0]).toBe(5);
  });

  it('animates from build pose to staged end when start was captured before staging', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const prop = createSceneObject('box', 1);
    project.scene.objects.push(prop);

    // Start captured with no staging yet — explicit snapshot of build poses.
    const startSnapshot = snapshotStageableObjectOverrides(project, { objectOverrides: {} });
    shot.objectOverrides = updateShotObjectOverrides(shot, prop, {
      transform: {
        ...prop.transform,
        position: [4, 1, 0],
        rotation: [0, 90, 0],
      },
    });
    const endSnapshot = snapshotStageableObjectOverrides(project, shot);

    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
        objectOverrides: startSnapshot,
      }),
      slot: 'end',
      camera: shot.camera,
      durationSeconds: 2,
      objectOverrides: endSnapshot,
    });

    const mid = interpolateObjectOverrides(keyframes, 1, shot.objectOverrides, project.scene.objects);
    expect(mid[prop.id]?.transform?.position[0]).toBeCloseTo((prop.transform.position[0] + 4) / 2);
    expect(mid[prop.id]?.transform?.rotation[1]).toBeCloseTo(45);

    // Regression: must NOT collapse to the live end pose for the whole move.
    const early = interpolateObjectOverrides(keyframes, 0, shot.objectOverrides, project.scene.objects);
    expect(early[prop.id]?.transform?.position[0]).toBeCloseTo(prop.transform.position[0]);
  });

  it('does not fall back to live end overrides for an explicit empty start snapshot', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const prop = createSceneObject('box', 1);
    project.scene.objects.push(prop);
    const liveEnd = {
      [prop.id]: {
        transform: {
          ...prop.transform,
          position: [9, 1, 0] as [number, number, number],
        },
      },
    };
    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
        objectOverrides: {},
      }),
      slot: 'end',
      camera: shot.camera,
      durationSeconds: 2,
      objectOverrides: liveEnd,
    });

    expect(keyframes[0].objectOverrides).toEqual({});
    const mid = interpolateObjectOverrides(keyframes, 1, liveEnd, project.scene.objects);
    // Start is empty → base pose; end is liveEnd → mid should be halfway, not stuck at 9.
    expect(mid[prop.id]?.transform?.position[0]).toBeCloseTo((prop.transform.position[0] + 9) / 2);
  });

  it('interpolates object transforms between keyframe snapshots', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const prop = createSceneObject('box', 1);
    project.scene.objects.push(prop);

    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
        objectOverrides: {
          [prop.id]: {
            transform: {
              ...prop.transform,
              position: [0, 1, 0],
              rotation: [0, 0, 0],
            },
            visible: true,
          },
        },
      }),
      slot: 'end',
      camera: shot.camera,
      durationSeconds: 2,
      objectOverrides: {
        [prop.id]: {
          transform: {
            ...prop.transform,
            position: [4, 1, 0],
            rotation: [0, 90, 0],
          },
          visible: false,
        },
      },
    });

    const mid = interpolateObjectOverrides(keyframes, 1, {}, project.scene.objects);
    expect(mid[prop.id]?.transform?.position[0]).toBeCloseTo(2);
    expect(mid[prop.id]?.transform?.rotation[1]).toBeCloseTo(45);
    expect(mid[prop.id]?.visible).toBe(false);

    const early = interpolateObjectOverrides(keyframes, 0.4, {}, project.scene.objects);
    expect(early[prop.id]?.visible).toBe(true);

    const eased = updateCameraKeyframeEasing(keyframes, 'easeIn');
    const easedMid = interpolateObjectOverrides(eased, 1, {}, project.scene.objects);
    expect(easedMid[prop.id]?.transform?.position[0]).toBeCloseTo(1);
    expect(easedMid[prop.id]?.transform?.rotation[1]).toBeCloseTo(22.5);
  });

  it('uses the shortest rotation path across the 360-degree seam', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const prop = createSceneObject('box', 1);
    project.scene.objects.push(prop);

    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
        objectOverrides: {
          [prop.id]: { transform: { ...prop.transform, rotation: [0, 350, 0] } },
        },
      }),
      slot: 'end',
      camera: shot.camera,
      durationSeconds: 2,
      objectOverrides: {
        [prop.id]: { transform: { ...prop.transform, rotation: [0, 10, 0] } },
      },
    });

    const mid = interpolateObjectOverrides(keyframes, 1, {}, project.scene.objects);
    expect(mid[prop.id]?.transform?.rotation[1]).toBeCloseTo(360);
  });

  it('visibility toggles between start/end keyframes count as object animation for packaging', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const prop = createSceneObject('box', 1);
    prop.stagingRole = 'prop';
    project.scene.objects.push(prop);

    const startSnapshot = snapshotStageableObjectOverrides(project, { objectOverrides: {} });
    shot.objectOverrides = updateShotObjectOverrides(shot, prop, { visible: false });
    const endSnapshot = snapshotStageableObjectOverrides(project, shot);

    const keyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
        objectOverrides: startSnapshot,
      }),
      slot: 'end',
      camera: {
        ...shot.camera,
        position: [0, 2, -4],
      },
      durationSeconds: 2,
      objectOverrides: endSnapshot,
    });

    expect(cameraKeyframesHaveObjectAnimation(keyframes)).toBe(true);
    expect(keyframes[0].objectOverrides?.[prop.id]?.visible).not.toBe(false);
    expect(keyframes[1].objectOverrides?.[prop.id]?.visible).toBe(false);

    shot.cameraKeyframes = keyframes;
    shot.exportSettings = {
      ...shot.exportSettings,
      includeCameraMoveVideo: true,
    };
    const manifest = createShotPackageManifest(project, shot);
    const motionPaths = manifest.files.map((file) => file.path).filter((path) => path.includes('viewport_clay_motion'));
    expect(motionPaths.length).toBeGreaterThan(0);
  });
});
