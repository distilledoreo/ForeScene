import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { getSortedCameraKeyframes, setTwoPointCameraKeyframe } from '../src/engine/cameraKeyframes';
import { renderCameraMoveFrame } from '../src/engine/renderers';

describe('animated characters-only frames', () => {
  it('keeps set geometry hidden when their visible keyframe snapshot is applied', () => {
    const project = createDefaultProject();
    const shot = project.shots[0];
    const person = createSceneObject('human_dummy', 1);
    const floor = createSceneObject('floor', 1);
    const attached = createSceneObject('box', 1);
    attached.stagingRole = 'prop';
    attached.metadata = { characterOwnerId: person.id };
    project.scene.objects.push(person, floor, attached);

    shot.cameraKeyframes = setTwoPointCameraKeyframe({
      keyframes: setTwoPointCameraKeyframe({
        keyframes: [],
        slot: 'start',
        camera: shot.camera,
        durationSeconds: 2,
        objectOverrides: {
          [person.id]: { transform: person.transform, visible: true },
          [floor.id]: { transform: floor.transform, visible: true },
          [attached.id]: { transform: attached.transform, visible: true },
        },
      }),
      slot: 'end',
      camera: shot.camera,
      durationSeconds: 2,
      objectOverrides: {
        [person.id]: { transform: person.transform, visible: true },
        [floor.id]: { transform: floor.transform, visible: true },
        [attached.id]: { transform: attached.transform, visible: true },
      },
    });

    const scene = new THREE.Scene();
    const personNode = new THREE.Group();
    personNode.userData.sceneObjectId = person.id;
    const floorNode = new THREE.Group();
    floorNode.userData.sceneObjectId = floor.id;
    const attachedNode = new THREE.Group();
    attachedNode.userData.sceneObjectId = attached.id;
    scene.add(personNode, floorNode, attachedNode);
    const render = vi.fn();
    const renderer = { render } as unknown as THREE.WebGLRenderer;
    const camera = new THREE.PerspectiveCamera();

    for (const timeSeconds of [0, 1, 2]) {
      personNode.visible = false;
      floorNode.visible = true;
      attachedNode.visible = false;
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
          objectAnimation: {
            shot,
            baseObjects: project.scene.objects,
            contentMode: 'characters_only',
            includeCharacterAttachments: true,
          },
        },
      );
      expect(personNode.visible).toBe(true);
      expect(floorNode.visible).toBe(false);
      expect(attachedNode.visible).toBe(true);
    }

    expect(render).toHaveBeenCalledTimes(3);
  });
});
