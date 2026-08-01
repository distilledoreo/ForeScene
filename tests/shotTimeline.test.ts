import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  clearKeyframeStaging,
  createShotKeyframe,
  deleteShotKeyframe,
  inspectShotTimeline,
  replaceShotTimeline,
  sampleShotTimeline,
  setShotTimelineDuration,
  stageObjectAtKeyframe,
  updateShotKeyframe,
} from '../src/engine/shotTimeline';
import { setTwoPointCameraKeyframe } from '../src/engine/cameraKeyframes';

describe('shot timeline domain service', () => {
  it('replaces and inspects a cloned, sorted timeline without mutating the source', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const end = { ...shot.camera, position: [2, 2, -2] as [number, number, number] };
    const keyframes = setTwoPointCameraKeyframe({ keyframes: [], slot: 'end', camera: end, durationSeconds: 4 });
    keyframes.push(...setTwoPointCameraKeyframe({ keyframes: [], slot: 'start', camera: shot.camera, durationSeconds: 4 }));
    const next = replaceShotTimeline(project, shot.id, { keyframes: keyframes.slice(0, 2), durationSeconds: 4 });

    expect(project.shots[0]!.cameraKeyframes).toEqual([]);
    expect(next.shots[0]!.cameraKeyframes.map((item) => item.timeSeconds)).toEqual([0, 4]);
    const inspection = inspectShotTimeline(next, shot.id);
    expect(inspection.renderable).toBe(true);
    inspection.keyframes[0]!.camera.position[0] = 99;
    expect(next.shots[0]!.cameraKeyframes[0]!.camera.position[0]).not.toBe(99);
  });

  it('supports create, update, duration scaling, and intermediate delete', () => {
    const project = createDefaultProject();
    const shotId = project.shots[0]!.id;
    const shot = project.shots[0]!;
    let next = replaceShotTimeline(project, shotId, {
      durationSeconds: 4,
      keyframes: setTwoPointCameraKeyframe({ keyframes: [], slot: 'end', camera: shot.camera, durationSeconds: 4 })
        .concat(setTwoPointCameraKeyframe({ keyframes: [], slot: 'start', camera: shot.camera, durationSeconds: 4 })),
    });
    next = createShotKeyframe(next, shotId, { timeSeconds: 2, camera: shot.camera, label: 'Middle' });
    const middle = next.shots[0]!.cameraKeyframes.find((item) => item.label === 'Middle')!;
    next = updateShotKeyframe(next, shotId, middle.id, { timeSeconds: 1.5, camera: { fovDegrees: 40 } });
    next = setShotTimelineDuration(next, shotId, 6);
    expect(next.shots[0]!.cameraKeyframes.map((item) => item.timeSeconds)).toEqual([0, 2.25, 6]);
    expect(next.shots[0]!.cameraKeyframes.find((item) => item.id === middle.id)!.camera.fovDegrees).toBe(40);
    next = deleteShotKeyframe(next, shotId, middle.id);
    expect(next.shots[0]!.cameraKeyframes).toHaveLength(2);
  });

  it('samples camera and staged object interpolation at arbitrary time', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    project.scene.objects.push(actor);
    const shot = project.shots[0]!;
    const start = setTwoPointCameraKeyframe({
      keyframes: [], slot: 'start', camera: shot.camera, durationSeconds: 2,
      objectOverrides: { [actor.id]: { transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, visible: true } },
    });
    const end = setTwoPointCameraKeyframe({
      keyframes: start, slot: 'end', camera: { ...shot.camera, position: [2, 1, 0] as [number, number, number] }, durationSeconds: 2,
      objectOverrides: { [actor.id]: { transform: { position: [2, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1] }, visible: false } },
    });
    const next = replaceShotTimeline(project, shot.id, { durationSeconds: 2, keyframes: end });
    const sample = sampleShotTimeline(next, shot.id, 1);
    expect(sample.camera.position[0]).toBeCloseTo(1);
    expect(sample.objectOverrides[actor.id]!.transform!.position[0]).toBeCloseTo(1);
    expect(sample.objectOverrides[actor.id]!.visible).toBe(false);
  });

  it('stages and clears a keyframe object without changing Build geometry', () => {
    const project = createDefaultProject();
    const actor = createSceneObject('human_dummy', 1);
    project.scene.objects.push(actor);
    const shot = project.shots[0]!;
    const keyframes = setTwoPointCameraKeyframe({ keyframes: [], slot: 'start', camera: shot.camera, durationSeconds: 2 });
    const withEnd = setTwoPointCameraKeyframe({ keyframes, slot: 'end', camera: shot.camera, durationSeconds: 2 });
    let next = replaceShotTimeline(project, shot.id, { durationSeconds: 2, keyframes: withEnd });
    const endId = next.shots[0]!.cameraKeyframes.at(-1)!.id;
    next = stageObjectAtKeyframe(next, shot.id, endId, actor.id, {
      transform: { position: [3, 0, 0], rotation: [0, 20, 0], scale: [1, 1, 1] },
      visible: false,
    });
    expect(next.scene.objects.find((item) => item.id === actor.id)!.transform.position).toEqual(actor.transform.position);
    expect(next.shots[0]!.cameraKeyframes.at(-1)!.objectOverrides![actor.id]!.visible).toBe(false);
    next = clearKeyframeStaging(next, shot.id, endId, actor.id);
    expect(next.shots[0]!.cameraKeyframes.at(-1)!.objectOverrides![actor.id]).toBeUndefined();
  });

  it('invalidates attached video and keyframe preview assets when the timeline changes', () => {
    const project = createDefaultProject();
    const shot = project.shots[0]!;
    const keyframes = setTwoPointCameraKeyframe({ keyframes: [], slot: 'start', camera: shot.camera, durationSeconds: 2 });
    const withEnd = setTwoPointCameraKeyframe({ keyframes, slot: 'end', camera: shot.camera, durationSeconds: 2 });
    withEnd[0]!.previewAssetId = 'preview';
    project.assets.assets.preview = { id: 'preview', type: 'image', name: 'preview', uri: 'data:image/png;base64,x', createdAt: new Date().toISOString() };
    project.shots[0] = { ...shot, cameraKeyframes: withEnd, assets: { ...shot.assets, cameraMoveVideoAssetId: 'video' } };
    project.assets.assets.video = { id: 'video', type: 'video', name: 'video', uri: 'data:video/mp4;base64,x', createdAt: new Date().toISOString() };
    const next = setShotTimelineDuration(project, shot.id, 3);
    expect(next.shots[0]!.assets.cameraMoveVideoAssetId).toBeUndefined();
    expect(next.shots[0]!.cameraKeyframes[0]!.previewAssetId).toBeUndefined();
    expect(next.assets.assets.preview).toBeUndefined();
    expect(next.assets.assets.video).toBeUndefined();
  });
});
