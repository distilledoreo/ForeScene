import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { parseProject } from '../src/engine/projectIO';
import {
  HUMAN_JOINT_IDS,
  cloneHumanPose,
  createEmptyHumanPose,
  eulerDegreesToQuaternion,
  humanPosesEqual,
  interpolateHumanPose,
  mirrorHumanPose,
  normalizeHumanPose,
  normalizePoseableCharacterSource,
} from '../src/engine/humanPose';
import { applyHumanPosePreset, HUMAN_POSE_PRESETS } from '../src/engine/humanPosePresets';
import { BUILTIN_MANNEQUIN_BONE_MAP } from '../src/engine/builtinMannequinCharacter';
import {
  resolvePoseableCharacterForObject,
} from '../src/engine/poseableCharacter';
import { snapshotStageableObjectOverrides } from '../src/engine/objectKeyframes';
import { updateShotObjectOverrides } from '../src/engine/shotSceneState';
import { solveTwoBoneIk } from '../src/engine/humanIk';

describe('poseable character foundation', () => {
  it('creates human dummies with a builtin poseableCharacter source', () => {
    const person = createSceneObject('human_dummy', 1);
    expect(person.poseableCharacter).toEqual({ kind: 'builtin', characterId: 'adult-male' });
    expect(normalizePoseableCharacterSource(undefined, 'human_dummy')).toEqual({
      kind: 'builtin',
      characterId: 'adult-male',
    });
  });

  it('normalizes missing pose fields on legacy projects', () => {
    const project = createDefaultProject();
    const legacy = structuredClone(project);
    for (const object of legacy.scene.objects) {
      delete object.poseableCharacter;
      delete object.humanPose;
    }
    const parsed = parseProject(JSON.stringify(legacy));
    const human = parsed.scene.objects.find((object) => object.type === 'human_dummy');
    expect(human?.poseableCharacter).toEqual({ kind: 'builtin', characterId: 'adult-male' });
  });

  it('maps semantic joints to mannequin bones without persisting bone names', () => {
    expect(BUILTIN_MANNEQUIN_BONE_MAP.leftUpperArm).toBe('LeftArm');
    expect(BUILTIN_MANNEQUIN_BONE_MAP.hips).toBe('Hips');
    expect(HUMAN_JOINT_IDS).toHaveLength(17);
    const source = readFileSync(new URL('../src/domain/types.ts', import.meta.url), 'utf8');
    expect(source).toContain('HumanJointId');
    expect(source).not.toContain('LeftForeArm');
  });

  it('registers a PoseableCharacter for the builtin mannequin', () => {
    const person = createSceneObject('human_dummy');
    const character = resolvePoseableCharacterForObject(person);
    expect(character?.source).toEqual({ kind: 'builtin', characterId: 'adult-male' });
  });

  it('clones, mirrors, and interpolates human poses with quaternion slerp', () => {
    const start = applyHumanPosePreset('reaching-left');
    const end = applyHumanPosePreset('reaching-right');
    const mid = interpolateHumanPose(undefined, start, end, 0.5);
    expect(mid?.joints.leftUpperArm).toBeDefined();
    expect(mid?.joints.rightUpperArm).toBeDefined();
    const mirrored = mirrorHumanPose(start);
    expect(mirrored.joints.rightUpperArm).toBeDefined();
    expect(mirrored.joints.leftUpperArm).toBeUndefined();
    expect(humanPosesEqual(cloneHumanPose(start), start)).toBe(true);
  });

  it('exposes the initial preset library', () => {
    expect(HUMAN_POSE_PRESETS.map((preset) => preset.id)).toEqual(expect.arrayContaining([
      'neutral',
      'a-pose',
      'standing-relaxed',
      'walk-contact-left',
      'walk-contact-right',
      'sitting',
      'crouching',
      'reaching-left',
      'reaching-right',
      'holding-waist',
      'pointing',
      'looking-left',
      'looking-right',
      'looking-up',
      'looking-down',
    ]));
  });

  it('snapshots and stages humanPose through shot overrides', () => {
    const project = createDefaultProject();
    const human = project.scene.objects.find((object) => object.type === 'human_dummy');
    expect(human).toBeDefined();
    if (!human) return;
    human.humanPose = applyHumanPosePreset('a-pose');
    const shot = project.shots[0];
    const snapshot = snapshotStageableObjectOverrides(project, shot);
    expect(snapshot[human.id]?.humanPose?.presetId).toBe('a-pose');

    const next = updateShotObjectOverrides(shot, human, {
      humanPose: applyHumanPosePreset('pointing'),
    });
    expect(next[human.id]?.humanPose?.presetId).toBe('pointing');
  });

  it('normalizes humanPose JSON safely', () => {
    const pose = normalizeHumanPose({
      version: 1,
      joints: {
        head: { rotation: eulerDegreesToQuaternion(10, 0, 0) },
        bogus: { rotation: [0, 0, 0, 1] },
      },
      presetId: 'looking-up',
    });
    expect(pose?.joints.head).toBeDefined();
    expect((pose?.joints as Record<string, unknown>).bogus).toBeUndefined();
    expect(normalizeHumanPose(null)).toBeUndefined();
    expect(createEmptyHumanPose().joints).toEqual({});
  });

  it('provides a reusable two-bone IK solver for later target gizmos', () => {
    const result = solveTwoBoneIk({
      root: [0, 1.4, 0],
      mid: [0.2, 1.1, 0],
      tip: [0.4, 0.9, 0],
      target: [0.5, 1.2, 0.2],
    });
    expect(result?.tip[0]).toBeCloseTo(0.5, 1);
  });

  it('renames object transform helpers and keyframe recapture label', () => {
    const sceneObjects = readFileSync(new URL('../src/engine/sceneObjects.ts', import.meta.url), 'utf8');
    const keyframeStrip = readFileSync(new URL('../src/components/workspaces/KeyframeStrip.tsx', import.meta.url), 'utf8');
    const build = readFileSync(new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url), 'utf8');
    expect(sceneObjects).toContain('applySceneObjectTransform');
    expect(sceneObjects).not.toContain('applySceneObjectPose');
    expect(keyframeStrip).toContain('Recapture keyframe');
    expect(keyframeStrip).not.toContain('Update pose');
    expect(build).toContain('Pose Character');
    expect(build).toContain('CharacterPosePanel');
  });
});
