import { describe, expect, it } from 'vitest';
import { createCameraKeyframe, createDefaultProject, createPanoReference, createTransform } from '../src/domain/defaults';
import { createShotDuplicationPatch } from '../src/engine/shotDuplication';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import { useProjectStore } from '../src/state/useProjectStore';

function authoredShot() {
  const project = createDefaultProject();
  const shot = project.shots[0];
  shot.objectOverrides = {
    actor: { transform: createTransform([3, 0, 2]), humanPose: { version: 1, joints: {} }, visible: false },
  };
  shot.cameraKeyframes = [createCameraKeyframe({ label: 'Start', timeSeconds: 0, camera: shot.camera, objectOverrides: shot.objectOverrides })];
  shot.promptOverrides = { imagePrompt: 'Keep the staged actor' };
  shot.assets.cameraMoveVideoAssetId = 'old-render';
  project.panoRefs = [
    createPanoReference({ name: 'Canonical', assetId: 'canonical-image', type: 'ai_global_reference', origin: [0, 1.6, 0], width: 2, height: 1, isCanonical: true }),
    createPanoReference({ name: 'Alternate', assetId: 'alternate-image', type: 'ai_global_reference', origin: [5, 1.6, 0], width: 2, height: 1, isCanonical: false }),
  ];
  return { project, shot };
}

describe('shot duplication authoring content', () => {
  it.each(['unlinked', 'alternate'] as const)('preserves staging and %s panorama through store update and save/reopen', (binding) => {
    const { project, shot } = authoredShot();
    shot.linkedPanoId = binding === 'unlinked' ? null : project.panoRefs[1].id;
    useProjectStore.getState().setProject(project);
    const copy = useProjectStore.getState().addCamera();
    useProjectStore.getState().updateShot(copy.id, createShotDuplicationPatch(shot));
    const duplicate = useProjectStore.getState().project.shots.find((item) => item.id === copy.id)!;
    expect(duplicate.id).not.toBe(shot.id);
    expect(duplicate.assets).toEqual({});
    expect(duplicate.objectOverrides).toEqual(shot.objectOverrides);
    expect(duplicate.linkedPanoId).toBe(shot.linkedPanoId);
    expect(duplicate.promptOverrides).toEqual(shot.promptOverrides);
    const reopened = parseProject(serializeProject(useProjectStore.getState().project));
    const restored = reopened.shots.find((item) => item.id === copy.id)!;
    expect(restored.objectOverrides).toEqual(shot.objectOverrides);
    expect(restored.linkedPanoId).toBe(shot.linkedPanoId);
  });

  it('detaches nested staging and camera data from the source', () => {
    const { shot } = authoredShot();
    const patch = createShotDuplicationPatch(shot);
    patch.objectOverrides!.actor.transform!.position[0] = 99;
    patch.cameraKeyframes[0].objectOverrides!.actor.visible = true;
    patch.camera.position[0] = 99;
    expect(shot.objectOverrides!.actor.transform!.position[0]).toBe(3);
    expect(shot.cameraKeyframes[0].objectOverrides!.actor.visible).toBe(false);
    expect(shot.camera.position[0]).not.toBe(99);
  });
});
