import { describe, expect, it } from 'vitest';
import { createCameraKeyframe, createDefaultProject, createPanoReference, createSceneObject } from '../src/domain/defaults';
import { cameraKeyframesHaveObjectAnimation, interpolateObjectOverrides } from '../src/engine/objectKeyframes';
import { resolveProjectForAnimatedCameraMove, resolveProjectForShot } from '../src/engine/shotSceneState';
import { buildScene, disposeScene } from '../src/engine/sceneObjects';

function middleOnlyScene() {
  const project = createDefaultProject();
  const prop = createSceneObject('box', 1);
  prop.stagingRole = 'prop';
  prop.visible = false;
  project.scene.objects = [prop];
  const shot = project.shots[0];
  shot.cameraKeyframes = [0, 1, 2].map((timeSeconds) => createCameraKeyframe({
    label: String(timeSeconds), timeSeconds, camera: shot.camera,
    ...(timeSeconds === 1 ? { objectOverrides: { [prop.id]: { visible: true } } } : {}),
  }));
  return { project, prop, shot };
}

describe('animated shot scene consistency', () => {
  it('builds render geometry for an object visible only at a middle keyframe', () => {
    const { project, prop, shot } = middleOnlyScene();
    expect(cameraKeyframesHaveObjectAnimation(shot.cameraKeyframes)).toBe(true);
    const resolved = resolveProjectForAnimatedCameraMove(project, shot);
    expect(resolved.scene.objects[0].visible).toBe(true);
    const scene = buildScene(resolved, { showGrid: false, showHelpers: false, hideShotFrustums: true });
    try {
      expect(scene.children.some((child) => child.userData.sceneObjectId === prop.id)).toBe(true);
    } finally { disposeScene(scene); }
    expect(interpolateObjectOverrides(shot.cameraKeyframes, 1, {}, [prop])[prop.id].visible).toBe(true);
    expect(project.scene.objects[0].visible).toBe(false);
  });

  it('respects explicit empty snapshots and legacy fallback when unioning visibility', () => {
    const { project, prop, shot } = middleOnlyScene();
    shot.objectOverrides = { [prop.id]: { visible: true } };
    shot.cameraKeyframes.forEach((frame) => { frame.objectOverrides = {}; });
    expect(resolveProjectForAnimatedCameraMove(project, shot).scene.objects[0].visible).toBe(false);
    shot.cameraKeyframes[1].objectOverrides = undefined;
    expect(resolveProjectForAnimatedCameraMove(project, shot).scene.objects[0].visible).toBe(true);
  });

  it.each([null, 'alternate', 'missing', undefined])('uses the same panorama routing as a still for binding %s', (binding) => {
    const { project, shot } = middleOnlyScene();
    const primary = createPanoReference({ name: 'Primary', assetId: 'primary-asset', type: 'ai_global_reference', origin: [0, 1.6, 0], width: 2, height: 1, isCanonical: true });
    const alternate = { ...primary, id: 'alternate', isCanonical: false };
    project.panoRefs = [primary, alternate];
    project.settings.projectedStyle = { ...project.settings.projectedStyle!, panoId: primary.id, secondaryPanoId: alternate.id, blendMode: 'primary_dominant' };
    shot.linkedPanoId = binding;
    const still = resolveProjectForShot(project, shot);
    const animated = resolveProjectForAnimatedCameraMove(project, shot);
    expect(animated.panoRefs).toEqual(still.panoRefs);
    expect(animated.settings.projectedStyle).toEqual(still.settings.projectedStyle);
    if (binding === null || binding === 'missing') expect(animated.panoRefs).toEqual([]);
    if (binding === 'alternate') expect(animated.panoRefs).toEqual([alternate]);
    expect(project.panoRefs).toHaveLength(2);
  });
});
