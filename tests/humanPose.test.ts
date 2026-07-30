import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import type { HumanJointId, HumanPose, QuaternionTuple } from '../src/domain/types';
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
  applySemanticPoseToBones,
  captureBoneRests,
  resolvePoseableCharacterForObject,
} from '../src/engine/poseableCharacter';
import {
  HUMAN_JOINT_LIMITS_DEGREES,
  clampHumanJointEulerDegrees,
} from '../src/engine/humanoidSkeleton';
import {
  interpolateObjectOverrides,
  snapshotStageableObjectOverrides,
} from '../src/engine/objectKeyframes';
import { updateShotObjectOverrides } from '../src/engine/shotSceneState';
import { solveTwoBoneIk } from '../src/engine/humanIk';

function quatToEulerDegrees(q: QuaternionTuple): [number, number, number] {
  const [x, y, z, w] = q;
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);
  return [(roll * 180) / Math.PI, (pitch * 180) / Math.PI, (yaw * 180) / Math.PI];
}

function jointEuler(pose: HumanPose, jointId: HumanJointId): [number, number, number] {
  return quatToEulerDegrees(pose.joints[jointId]?.rotation ?? [0, 0, 0, 1]);
}

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
    // Tip joints must not alias hand/foot bones (would wipe poses on apply).
    expect(BUILTIN_MANNEQUIN_BONE_MAP.leftHandEnd).toBeUndefined();
    expect(BUILTIN_MANNEQUIN_BONE_MAP.rightHandEnd).toBeUndefined();
    expect(HUMAN_JOINT_IDS).toHaveLength(32);
    const person = createSceneObject('human_dummy', 1);
    const character = resolvePoseableCharacterForObject(person);
    expect(character?.skeleton.joints).toHaveLength(32);
    expect(character?.skeleton.joints[0]?.limitsDegrees).toBeDefined();
    expect(character?.createInstance).toBeTypeOf('function');
    const source = readFileSync(new URL('../src/domain/types.ts', import.meta.url), 'utf8');
    expect(source).toContain('HumanJointId');
    expect(source).toContain('PoseableRigAsset');
    expect(source).not.toContain('LeftForeArm');
  });

  it('keeps leftHand pose when a tip joint aliases the same bone object', () => {
    // Shared-bone map: tip id points at the same THREE.Bone as leftHand (historical bug).
    const hand = new THREE.Bone();
    hand.name = 'LeftHand';
    const bones = new Map<HumanJointId, THREE.Bone>([
      ['leftHand', hand],
      ['leftHandEnd', hand],
    ]);
    const rests = captureBoneRests(bones);
    const pose: HumanPose = {
      version: 1,
      joints: {
        leftHand: { rotation: eulerDegreesToQuaternion(45, 0, 0) },
      },
    };
    applySemanticPoseToBones({ bones, rests, pose });
    // Tip joint must not reset the shared bone back to identity rest.
    expect(hand.quaternion.angleTo(rests.get('leftHand')!.quaternion)).toBeGreaterThan(0.5);
    const expected = rests.get('leftHand')!.quaternion.clone().multiply(
      new THREE.Quaternion().set(...eulerDegreesToQuaternion(45, 0, 0)),
    );
    expect(hand.quaternion.angleTo(expected)).toBeLessThan(1e-5);
  });

  it('routes scene construction through PoseableCharacter.createInstance', () => {
    const sceneObjects = readFileSync(new URL('../src/engine/sceneObjects.ts', import.meta.url), 'utf8');
    expect(sceneObjects).toContain('resolvePoseableCharacterForObject');
    expect(sceneObjects).toContain('character.createInstance');
  });

  it('registers a PoseableCharacter for the builtin mannequin', () => {
    const person = createSceneObject('human_dummy');
    const character = resolvePoseableCharacterForObject(person);
    expect(character?.source).toEqual({ kind: 'builtin', characterId: 'adult-male' });
  });

  it('keeps presets inside soft joint limits for the mannequin Euler convention', () => {
    for (const preset of HUMAN_POSE_PRESETS) {
      for (const jointId of HUMAN_JOINT_IDS) {
        const joint = preset.pose.joints[jointId];
        if (!joint) continue;
        const euler = quatToEulerDegrees(joint.rotation);
        const clamped = clampHumanJointEulerDegrees(jointId, euler);
        expect(clamped[0]).toBeCloseTo(euler[0], 0);
        expect(clamped[1]).toBeCloseTo(euler[1], 0);
        expect(clamped[2]).toBeCloseTo(euler[2], 0);
        const limits = HUMAN_JOINT_LIMITS_DEGREES[jointId];
        expect(euler[0]).toBeGreaterThanOrEqual(limits.min[0] - 0.5);
        expect(euler[0]).toBeLessThanOrEqual(limits.max[0] + 0.5);
      }
    }
  });

  it('mirrors reaching-left toward reaching-right and recovers after two mirrors', () => {
    const left = applyHumanPosePreset('reaching-left');
    const right = applyHumanPosePreset('reaching-right');
    const mirrored = mirrorHumanPose(left);

    expect(mirrored.joints.rightUpperArm).toBeDefined();
    expect(mirrored.joints.leftUpperArm).toBeUndefined();

    const mirroredArm = jointEuler(mirrored, 'rightUpperArm');
    const rightArm = jointEuler(right, 'rightUpperArm');
    // Soft behavioral match: mirrored reach lands near the authored opposite preset.
    expect(mirroredArm[0]).toBeCloseTo(rightArm[0], 0);
    expect(Math.sign(mirroredArm[1] || 0)).toBe(Math.sign(rightArm[1] || 0) || Math.sign(mirroredArm[1] || 0));
    expect(Math.sign(mirroredArm[2] || 0)).toBe(Math.sign(rightArm[2] || 0) || Math.sign(mirroredArm[2] || 0));

    const lookingLeft = applyHumanPosePreset('looking-left');
    const lookingMirrored = mirrorHumanPose(lookingLeft);
    expect(jointEuler(lookingMirrored, 'head')[1]).toBeCloseTo(-jointEuler(lookingLeft, 'head')[1], 5);
    expect(jointEuler(lookingMirrored, 'head')[0]).toBeCloseTo(jointEuler(lookingLeft, 'head')[0], 5);

    const roundTrip = mirrorHumanPose(mirrored);
    expect(humanPosesEqual(roundTrip, left)).toBe(true);
  });

  it('clones and interpolates human poses with quaternion slerp', () => {
    const start = applyHumanPosePreset('reaching-left');
    const end = applyHumanPosePreset('reaching-right');
    const mid = interpolateHumanPose(undefined, start, end, 0.5);
    expect(mid?.joints.leftUpperArm).toBeDefined();
    expect(mid?.joints.rightUpperArm).toBeDefined();
    expect(humanPosesEqual(cloneHumanPose(start), start)).toBe(true);
  });

  it('preserves explicit neutral poses through snapshot, save/reload, and interpolation', () => {
    const project = createDefaultProject();
    const human = project.scene.objects.find((object) => object.type === 'human_dummy');
    expect(human).toBeDefined();
    if (!human) return;

    // Keyframe 1: untouched neutral character.
    const shot = project.shots[0];
    const firstSnapshot = snapshotStageableObjectOverrides(project, shot);
    expect(firstSnapshot[human.id]?.humanPose).toEqual(createEmptyHumanPose());

    // Pose the live character after capturing keyframe 1.
    human.humanPose = applyHumanPosePreset('reaching-left');
    const secondSnapshot = snapshotStageableObjectOverrides(project, shot);
    expect(secondSnapshot[human.id]?.humanPose?.presetId).toBe('reaching-left');

    const keyframes = [
      { id: 'kf1', label: 'Start', timeSeconds: 0, camera: shot.camera, objectOverrides: firstSnapshot },
      { id: 'kf2', label: 'End', timeSeconds: 1, camera: shot.camera, objectOverrides: secondSnapshot },
    ];
    const mid = interpolateObjectOverrides(keyframes, 0.5, {}, project.scene.objects);
    const midPose = mid[human.id]?.humanPose;
    expect(midPose?.joints.leftUpperArm).toBeDefined();
    // Neutral start must not inherit the live posed base — mid should be between identity and reach.
    const startArm = [0, 0, 0, 1] as QuaternionTuple;
    const endArm = secondSnapshot[human.id]!.humanPose!.joints.leftUpperArm!.rotation;
    const midArm = midPose!.joints.leftUpperArm!.rotation;
    expect(midArm[0]).not.toBeCloseTo(endArm[0], 3);
    expect(midArm[0]).not.toBeCloseTo(startArm[0], 3);

    // Empty neutral survives serialize/parse.
    human.humanPose = createEmptyHumanPose();
    const roundTrip = parseProject(serializeProject(project));
    const reloaded = roundTrip.scene.objects.find((object) => object.id === human.id);
    expect(reloaded?.humanPose).toEqual(createEmptyHumanPose());
    expect(normalizeHumanPose({ version: 1, joints: {} })).toEqual(createEmptyHumanPose());
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

  it('wires Stage pose authoring through ShotsWorkspace without mutating Build', () => {
    const shots = readFileSync(new URL('../src/components/workspaces/ShotsWorkspace.tsx', import.meta.url), 'utf8');
    const stagingController = readFileSync(new URL('../src/hooks/useShotStagingController.ts', import.meta.url), 'utf8');
    expect(shots).toContain('CharacterPosePanel');
    expect(shots).toContain('poseEditActive={posingStagedCharacter}');
    expect(shots).toContain('updateStagedPose');
    expect(shots).toContain('resetStagedPose');
    expect(shots).toContain('data-shots-staging-mode-pose');
    expect(shots).toContain('Reset pose to set');
    expect(shots).toContain('Reset all staging to set');
    expect(shots).toContain('clearShotObjectPoseOverride');
    expect(stagingController).toContain("StagingEditMode = 'translate' | 'rotate' | 'pose'");
    expect(shots).toContain('{ humanPose }');
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
