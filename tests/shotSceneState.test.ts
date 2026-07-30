import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import {
  canStageObjectPerShot,
  clearShotObjectOverride,
  clearShotObjectPoseOverride,
  filterStagingObjectList,
  getStageableObjectsForShot,
  getSceneObjectStagingRole,
  resolveProjectForShot,
  STAGING_OBJECT_LIST_LIMIT,
  updateShotObjectOverrides,
} from '../src/engine/shotSceneState';
import { applyHumanPosePreset } from '../src/engine/humanPosePresets';
import type { SceneObject } from '../src/domain/types';

describe('per-shot scene state', () => {
  it('applies sparse transforms without mutating the Build scene', () => {
    const project = createDefaultProject();
    const person = createSceneObject('human_dummy', 1);
    project.scene.objects.push(person);
    const shot = project.shots[0];
    const stagedTransform = {
      ...person.transform,
      position: [4, 0.875, -2] as [number, number, number],
      rotation: [0, 45, 0] as [number, number, number],
    };
    shot.objectOverrides = updateShotObjectOverrides(shot, person, { transform: stagedTransform });

    const resolved = resolveProjectForShot(project, shot);
    const resolvedPerson = resolved.scene.objects.find((object) => object.id === person.id);

    expect(resolvedPerson?.transform.position).toEqual([4, 0.875, -2]);
    expect(resolvedPerson?.transform.rotation).toEqual([0, 45, 0]);
    expect(person.transform.position).not.toEqual([4, 0.875, -2]);
  });

  it('classifies built-in and imported people consistently for clean plates', () => {
    const project = createDefaultProject();
    const mannequin = createSceneObject('human_dummy', 1);
    const importedPerson = createSceneObject('imported_model', 1);
    importedPerson.stagingRole = 'person';
    const prop = createSceneObject('box', 1);
    prop.stagingRole = 'prop';
    project.scene.objects.push(mannequin, importedPerson, prop);

    const resolved = resolveProjectForShot(project, project.shots[0], { contentMode: 'clean_plate' });
    const byId = new Map(resolved.scene.objects.map((object) => [object.id, object]));

    expect(byId.get(mannequin.id)?.visible).toBe(false);
    expect(byId.get(importedPerson.id)?.visible).toBe(false);
    expect(byId.get(prop.id)?.visible).toBe(true);
    expect(getSceneObjectStagingRole(mannequin)).toBe('person');
    expect(canStageObjectPerShot(prop)).toBe(true);
    expect(canStageObjectPerShot(createSceneObject('box', 2))).toBe(true);
    expect(canStageObjectPerShot(createSceneObject('sun_marker', 1))).toBe(false);
  });

  it('drops redundant overrides and supports reset to base', () => {
    const project = createDefaultProject();
    const prop = createSceneObject('box', 1);
    prop.stagingRole = 'prop';
    const shot = project.shots[0];

    const redundant = updateShotObjectOverrides(shot, prop, {
      transform: prop.transform,
      visible: prop.visible,
    });
    expect(redundant).toEqual({});

    shot.objectOverrides = updateShotObjectOverrides(shot, prop, { visible: false });
    expect(shot.objectOverrides[prop.id]?.visible).toBe(false);
    expect(clearShotObjectOverride(shot, prop.id)).toEqual({});
  });

  it('clears pose overrides without discarding transform or visibility staging', () => {
    const project = createDefaultProject();
    const human = createSceneObject('human_dummy', 1);
    human.humanPose = applyHumanPosePreset('a-pose');
    project.scene.objects.push(human);
    const shot = project.shots[0];
    const stagedTransform = {
      ...human.transform,
      position: [3, 0.875, -1] as [number, number, number],
    };

    shot.objectOverrides = updateShotObjectOverrides(shot, human, {
      transform: stagedTransform,
      visible: false,
      humanPose: applyHumanPosePreset('pointing'),
    });
    expect(shot.objectOverrides[human.id]?.humanPose?.presetId).toBe('pointing');
    expect(shot.objectOverrides[human.id]?.transform?.position).toEqual([3, 0.875, -1]);
    expect(shot.objectOverrides[human.id]?.visible).toBe(false);

    const poseCleared = clearShotObjectPoseOverride(shot, human.id);
    expect(poseCleared[human.id]?.humanPose).toBeUndefined();
    expect(poseCleared[human.id]?.transform?.position).toEqual([3, 0.875, -1]);
    expect(poseCleared[human.id]?.visible).toBe(false);

    const resolved = resolveProjectForShot(project, { ...shot, objectOverrides: poseCleared });
    const resolvedHuman = resolved.scene.objects.find((object) => object.id === human.id);
    expect(resolvedHuman?.humanPose?.presetId).toBe('a-pose');
    expect(resolvedHuman?.transform.position).toEqual([3, 0.875, -1]);
    expect(resolvedHuman?.visible).toBe(false);
    expect(human.humanPose?.presetId).toBe('a-pose');
  });

  it('stages pose into a transient keyframe inspection map the same way as transforms', () => {
    const project = createDefaultProject();
    const human = createSceneObject('human_dummy', 1);
    human.humanPose = applyHumanPosePreset('a-pose');
    project.scene.objects.push(human);
    const shotOverrides = updateShotObjectOverrides(
      { objectOverrides: {} },
      human,
      { transform: { ...human.transform, position: [1, 0.875, 0] } },
    );
    // Mimic Stage-with-keyframe-selected: edits land in a sparse inspection map.
    const inspection = updateShotObjectOverrides(
      { objectOverrides: shotOverrides },
      human,
      { humanPose: applyHumanPosePreset('reaching-left') },
    );
    expect(inspection[human.id]?.transform?.position).toEqual([1, 0.875, 0]);
    expect(inspection[human.id]?.humanPose?.presetId).toBe('reaching-left');

    const resolved = resolveProjectForShot(project, {
      ...project.shots[0],
      objectOverrides: inspection,
    });
    const resolvedHuman = resolved.scene.objects.find((object) => object.id === human.id);
    expect(resolvedHuman?.humanPose?.presetId).toBe('reaching-left');
    expect(resolvedHuman?.transform.position).toEqual([1, 0.875, 0]);
    expect(human.humanPose?.presetId).toBe('a-pose');
  });

  it('keeps objects hidden for a shot in the staging recovery list', () => {
    const project = createDefaultProject();
    const hiddenProp = createSceneObject('box', 1);
    hiddenProp.stagingRole = 'prop';
    project.scene.objects.push(hiddenProp);
    const shot = project.shots[0];
    shot.objectOverrides = updateShotObjectOverrides(shot, hiddenProp, { visible: false });

    const resolved = resolveProjectForShot(project, shot);
    const hidden = resolved.scene.objects.find((object) => object.id === hiddenProp.id);
    const stageable = getStageableObjectsForShot(resolved.scene.objects);

    expect(hidden?.visible).toBe(false);
    expect(stageable.map((object) => object.id)).toContain(hiddenProp.id);
  });

  it('defaults the Stage panel list to people/props and caps large inventories', () => {
    const objects: SceneObject[] = [];
    for (let index = 0; index < 800; index += 1) {
      const wall = createSceneObject('wall', index + 1);
      wall.name = `Wall ${index + 1}`;
      objects.push(wall);
    }
    for (let index = 0; index < 120; index += 1) {
      const prop = createSceneObject('box', index + 1);
      prop.stagingRole = 'prop';
      prop.name = `Prop ${index + 1}`;
      objects.push(prop);
    }
    const person = createSceneObject('human_dummy', 1);
    person.name = 'Lead actor';
    objects.push(person);
    const locked = createSceneObject('box', 999);
    locked.locked = true;
    locked.stagingRole = 'prop';
    objects.push(locked);

    const started = performance.now();
    const primary = filterStagingObjectList({ objects, scope: 'people_props' });
    const all = filterStagingObjectList({ objects, scope: 'all' });
    const searched = filterStagingObjectList({ objects, scope: 'all', query: 'Wall 799' });
    const pinnedFar = filterStagingObjectList({
      objects,
      scope: 'all',
      pinnedObjectId: objects[700]?.id,
    });
    const elapsedMs = performance.now() - started;

    expect(primary.stageableTotal).toBe(921); // 800 walls + 120 props + 1 person
    expect(primary.primaryTotal).toBe(121);
    expect(primary.items).toHaveLength(STAGING_OBJECT_LIST_LIMIT);
    expect(primary.items.every((object) => getSceneObjectStagingRole(object) !== 'set')).toBe(true);
    expect(primary.truncated).toBe(true);
    expect(primary.totalMatching).toBe(121);

    expect(all.items).toHaveLength(STAGING_OBJECT_LIST_LIMIT);
    expect(all.totalMatching).toBe(921);
    expect(all.truncated).toBe(true);

    expect(searched.items).toHaveLength(1);
    expect(searched.items[0]?.name).toBe('Wall 799');
    expect(pinnedFar.items.some((object) => object.id === objects[700]?.id)).toBe(true);
    expect(pinnedFar.items).toHaveLength(STAGING_OBJECT_LIST_LIMIT);
    // Filtering 900+ objects for Stage open must stay well under a frame budget.
    expect(elapsedMs).toBeLessThan(50);
  });
});
