import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { getSortedCameraKeyframes, setTwoPointCameraKeyframe } from '../src/engine/cameraKeyframes';
import { renderCameraMoveFrame } from '../src/engine/renderers';

describe('animated clean-plate MP4 frames', () => {
  it('keeps people hidden when their visible keyframe snapshot is applied', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const person = createSceneObject('human_dummy', 1);
    project.scene.objects.push(person);

    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
        objectOverrides: { [person.id]: { transform: person.transform, visible: true } },
      }),
      slot: 'end',
      camera: shot.camera,
      durationSeconds: 2,
      objectOverrides: { [person.id]: { transform: person.transform, visible: true } },
    });

    const scene = new THREE.Scene();
    const personNode = new THREE.Group();
    personNode.userData.sceneObjectId = person.id;
    scene.add(personNode);
    const render = vi.fn();
    const renderer = { render } as unknown as THREE.WebGLRenderer;
    const camera = new THREE.PerspectiveCamera();

    for (const timeSeconds of [0, 1, 2]) {
      // Simulate a source-visible node on every frame; the clean-plate rule
      // must win over the snapshot at start, in-between, and end.
      personNode.visible = true;
      renderCameraMoveFrame(
        renderer,
        scene,
        camera,
        getSortedCameraKeyframes(shot.cameraKeyframes),
        timeSeconds,
        1920,
        1080,
        { near: 0.1, far: 100 },
        {
          shot,
          baseObjects: project.scene.objects,
          peopleVariant: 'clean_plate',
        },
      );
      expect(personNode.visible).toBe(false);
    }

    expect(render).toHaveBeenCalledTimes(3);
  });
});
