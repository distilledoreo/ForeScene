import type { HumanJointId, HumanPose } from '../domain/types';
import {
  createEmptyHumanPose,
  eulerDegreesToQuaternion,
} from './humanPose';

export interface HumanPosePreset {
  id: string;
  label: string;
  pose: HumanPose;
}

function joints(
  entries: Partial<Record<HumanJointId, [number, number, number]>>,
  presetId: string,
): HumanPose {
  const pose = createEmptyHumanPose(presetId);
  for (const [jointId, euler] of Object.entries(entries) as Array<[HumanJointId, [number, number, number]]>) {
    pose.joints[jointId] = {
      rotation: eulerDegreesToQuaternion(euler[0], euler[1], euler[2]),
    };
  }
  return pose;
}

/**
 * Compact preset library stored as semantic joint deltas (Euler degrees → quaternions).
 * Values are approximate and intentionally simple for previs blocking.
 */
export const HUMAN_POSE_PRESETS: readonly HumanPosePreset[] = [
  {
    id: 'neutral',
    label: 'Neutral',
    pose: createEmptyHumanPose('neutral'),
  },
  {
    id: 'a-pose',
    label: 'A-pose',
    pose: joints({
      leftUpperArm: [0, 0, 35],
      rightUpperArm: [0, 0, -35],
    }, 'a-pose'),
  },
  {
    id: 'arms-raised',
    label: 'Arms raised',
    pose: joints({
      leftUpperArm: [0, 0, 85],
      rightUpperArm: [0, 0, -85],
    }, 'arms-raised'),
  },
  {
    id: 'elbows-bent',
    label: 'Elbows bent',
    pose: joints({
      leftUpperArm: [0, 0, 35],
      rightUpperArm: [0, 0, -35],
      leftLowerArm: [95, 0, 0],
      rightLowerArm: [95, 0, 0],
    }, 'elbows-bent'),
  },
  {
    id: 'standing-relaxed',
    label: 'Standing relaxed',
    pose: joints({
      leftUpperArm: [8, 0, 12],
      rightUpperArm: [8, 0, -12],
      leftLowerArm: [15, 0, 0],
      rightLowerArm: [15, 0, 0],
      leftUpperLeg: [4, 0, 3],
      rightUpperLeg: [4, 0, -3],
    }, 'standing-relaxed'),
  },
  {
    id: 'walk-contact-left',
    label: 'Walking contact left',
    pose: joints({
      leftUpperLeg: [-28, 0, 0],
      rightUpperLeg: [22, 0, 0],
      leftLowerLeg: [12, 0, 0],
      rightLowerLeg: [35, 0, 0],
      leftUpperArm: [18, 0, 10],
      rightUpperArm: [-18, 0, -10],
      leftLowerArm: [25, 0, 0],
      rightLowerArm: [20, 0, 0],
    }, 'walk-contact-left'),
  },
  {
    id: 'walk-contact-right',
    label: 'Walking contact right',
    pose: joints({
      leftUpperLeg: [22, 0, 0],
      rightUpperLeg: [-28, 0, 0],
      leftLowerLeg: [35, 0, 0],
      rightLowerLeg: [12, 0, 0],
      leftUpperArm: [-18, 0, 10],
      rightUpperArm: [18, 0, -10],
      leftLowerArm: [20, 0, 0],
      rightLowerArm: [25, 0, 0],
    }, 'walk-contact-right'),
  },
  {
    id: 'walking',
    label: 'Walking',
    pose: joints({
      leftUpperLeg: [-28, 0, 0],
      rightUpperLeg: [22, 0, 0],
      leftLowerLeg: [12, 0, 0],
      rightLowerLeg: [35, 0, 0],
      leftUpperArm: [18, 0, 10],
      rightUpperArm: [-18, 0, -10],
    }, 'walking'),
  },
  {
    id: 'sitting',
    label: 'Sitting',
    pose: joints({
      hips: [-8, 0, 0],
      leftUpperLeg: [-82, 0, 8],
      rightUpperLeg: [-82, 0, -8],
      leftLowerLeg: [90, 0, 0],
      rightLowerLeg: [90, 0, 0],
      leftUpperArm: [20, 0, 25],
      rightUpperArm: [20, 0, -25],
      leftLowerArm: [40, 0, 0],
      rightLowerArm: [40, 0, 0],
    }, 'sitting'),
  },
  {
    id: 'crouching',
    label: 'Crouching',
    pose: joints({
      hips: [-18, 0, 0],
      spine: [12, 0, 0],
      leftUpperLeg: [-95, 0, 10],
      rightUpperLeg: [-95, 0, -10],
      leftLowerLeg: [110, 0, 0],
      rightLowerLeg: [110, 0, 0],
      leftUpperArm: [30, 0, 20],
      rightUpperArm: [30, 0, -20],
    }, 'crouching'),
  },
  {
    id: 'reaching-left',
    label: 'Reaching left',
    pose: joints({
      leftUpperArm: [-70, 20, 40],
      leftLowerArm: [20, 0, 0],
      spine: [0, -12, 0],
      head: [0, -10, 0],
    }, 'reaching-left'),
  },
  {
    id: 'reaching-right',
    label: 'Reaching right',
    pose: joints({
      rightUpperArm: [-70, -20, -40],
      rightLowerArm: [20, 0, 0],
      spine: [0, 12, 0],
      head: [0, 10, 0],
    }, 'reaching-right'),
  },
  {
    id: 'holding-waist',
    label: 'Holding object at waist',
    pose: joints({
      leftUpperArm: [35, 10, 25],
      rightUpperArm: [35, -10, -25],
      leftLowerArm: [70, 0, 0],
      rightLowerArm: [70, 0, 0],
      leftHand: [0, 0, -15],
      rightHand: [0, 0, 15],
    }, 'holding-waist'),
  },
  {
    id: 'pointing',
    label: 'Pointing',
    pose: joints({
      rightUpperArm: [-60, -15, -20],
      rightLowerArm: [10, 0, 0],
      rightHand: [0, 0, 0],
      head: [0, 12, 0],
    }, 'pointing'),
  },
  {
    id: 'looking-left',
    label: 'Looking left',
    pose: joints({
      neck: [0, -25, 0],
      head: [0, -20, 0],
    }, 'looking-left'),
  },
  {
    id: 'looking-right',
    label: 'Looking right',
    pose: joints({
      neck: [0, 25, 0],
      head: [0, 20, 0],
    }, 'looking-right'),
  },
  {
    id: 'looking-up',
    label: 'Looking up',
    pose: joints({
      neck: [-18, 0, 0],
      head: [-20, 0, 0],
    }, 'looking-up'),
  },
  {
    id: 'looking-down',
    label: 'Looking down',
    pose: joints({
      neck: [18, 0, 0],
      head: [22, 0, 0],
    }, 'looking-down'),
  },
];

/** Architecture-doc / previs semantic aliases used by plans and the pose API. */
export const HUMAN_POSE_PRESET_ALIASES: Record<string, string> = {
  guard: 'elbows-bent',
  defensive: 'elbows-bent',
  reach: 'reaching-right',
  'sword-raised': 'pointing',
  'standing-neutral': 'neutral',
  'standing-alert': 'standing-relaxed',
  'standing-defensive': 'elbows-bent',
  running: 'walk-contact-left',
  kneeling: 'crouching',
  seated: 'sitting',
  reaching: 'reaching-right',
  'holding-object': 'holding-waist',
  'shield-ready': 'elbows-bent',
  'sword-ready': 'pointing',
  injured: 'crouching',
};

export function resolveHumanPosePresetId(id: string): { requestedId: string; resolvedId: string; aliased: boolean } {
  const resolvedId = HUMAN_POSE_PRESET_ALIASES[id] ?? id;
  return { requestedId: id, resolvedId, aliased: resolvedId !== id };
}

export function getHumanPosePreset(id: string): HumanPosePreset | undefined {
  return HUMAN_POSE_PRESETS.find((preset) => preset.id === id);
}

export function applyHumanPosePreset(presetId: string): HumanPose {
  const preset = getHumanPosePreset(resolveHumanPosePresetId(presetId).resolvedId);
  if (!preset) return createEmptyHumanPose();
  return {
    version: 1,
    joints: { ...preset.pose.joints },
    presetId: preset.id,
  };
}
