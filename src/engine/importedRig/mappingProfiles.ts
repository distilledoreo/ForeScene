import type { HumanJointId, ImportedHumanoidRigProfile } from '../../domain/types';

export type MappingNameTable = Partial<Record<HumanJointId, readonly string[]>>;

const MIXAMO: MappingNameTable = {
  hips: ['Hips', 'Pelvis'], spine: ['Spine'], chest: ['Spine1', 'Chest'], upperSpine: ['Spine2', 'UpperChest'],
  neck: ['Neck'], head: ['Head'], leftClavicle: ['LeftShoulder', 'LeftClavicle'], leftUpperArm: ['LeftArm', 'LeftUpperArm'],
  leftLowerArm: ['LeftForeArm', 'LeftLowerArm', 'LeftForearm'], leftHand: ['LeftHand'], leftHandEnd: ['LeftHandEnd', 'LeftHandTip'],
  rightClavicle: ['RightShoulder', 'RightClavicle'], rightUpperArm: ['RightArm', 'RightUpperArm'], rightLowerArm: ['RightForeArm', 'RightLowerArm', 'RightForearm'], rightHand: ['RightHand'], rightHandEnd: ['RightHandEnd', 'RightHandTip'],
  leftUpperLeg: ['LeftUpLeg', 'LeftUpperLeg', 'LeftThigh'], leftLowerLeg: ['LeftLeg', 'LeftLowerLeg', 'LeftShin'], leftFoot: ['LeftFoot'], leftToeBase: ['LeftToeBase', 'LeftToe', 'LeftToes'],
  rightUpperLeg: ['RightUpLeg', 'RightUpperLeg', 'RightThigh'], rightLowerLeg: ['RightLeg', 'RightLowerLeg', 'RightShin'], rightFoot: ['RightFoot'], rightToeBase: ['RightToeBase', 'RightToe', 'RightToes'],
};

const HUMANIK: MappingNameTable = {
  hips: ['Hips', 'Pelvis', 'Reference'], spine: ['Spine', 'Spine1'], chest: ['Chest', 'Spine2', 'Spine3'], upperSpine: ['UpperChest', 'Spine4'],
  neck: ['Neck'], head: ['Head'], leftClavicle: ['LeftShoulder', 'LeftClavicle'], leftUpperArm: ['LeftArm', 'LeftUpperArm'], leftLowerArm: ['LeftForeArm', 'LeftForearm', 'LeftLowerArm'], leftHand: ['LeftHand'],
  rightClavicle: ['RightShoulder', 'RightClavicle'], rightUpperArm: ['RightArm', 'RightUpperArm'], rightLowerArm: ['RightForeArm', 'RightForearm', 'RightLowerArm'], rightHand: ['RightHand'],
  leftUpperLeg: ['LeftUpLeg', 'LeftUpperLeg', 'LeftThigh'], leftLowerLeg: ['LeftLeg', 'LeftLowerLeg', 'LeftShin'], leftFoot: ['LeftFoot', 'LeftAnkle'], leftToeBase: ['LeftToeBase', 'LeftToe'],
  rightUpperLeg: ['RightUpLeg', 'RightUpperLeg', 'RightThigh'], rightLowerLeg: ['RightLeg', 'RightLowerLeg', 'RightShin'], rightFoot: ['RightFoot', 'RightAnkle'], rightToeBase: ['RightToeBase', 'RightToe'],
};

const GENERIC: MappingNameTable = {
  hips: ['hips', 'pelvis', 'hip', 'root', 'center'], spine: ['spine', 'waist', 'abdomen'], chest: ['chest', 'torso', 'ribcage', 'upperbody'], upperSpine: ['upperchest', 'thorax'], neck: ['neck'], head: ['head', 'skull'],
  leftClavicle: ['leftshoulder', 'leftclavicle', 'lshoulder'], leftUpperArm: ['leftarm', 'leftupperarm', 'larm', 'lupperarm'], leftLowerArm: ['leftforearm', 'leftlowerarm', 'leftelbow', 'lforearm'], leftHand: ['lefthand', 'lwrist', 'leftwrist'],
  rightClavicle: ['rightshoulder', 'rightclavicle', 'rshoulder'], rightUpperArm: ['rightarm', 'rightupperarm', 'rarm', 'rupperarm'], rightLowerArm: ['rightforearm', 'rightlowerarm', 'rightelbow', 'rforearm'], rightHand: ['righthand', 'rwrist', 'rightwrist'],
  leftUpperLeg: ['leftupleg', 'leftupperleg', 'leftthigh', 'lthigh'], leftLowerLeg: ['leftleg', 'leftlowerleg', 'leftshin', 'leftknee'], leftFoot: ['leftfoot', 'leftankle'], leftToeBase: ['lefttoe', 'lefttoes'],
  rightUpperLeg: ['rightupleg', 'rightupperleg', 'rightthigh', 'rthigh'], rightLowerLeg: ['rightleg', 'rightlowerleg', 'rightshin', 'rightknee'], rightFoot: ['rightfoot', 'rightankle'], rightToeBase: ['righttoe', 'righttoes'],
};

export function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/^.*:/, '').replace(/[^a-z0-9]/g, '');
}

export function mappingNamesForProfile(profile: ImportedHumanoidRigProfile): MappingNameTable {
  return profile === 'mixamo' ? MIXAMO : profile === 'maya-humanik' ? HUMANIK : GENERIC;
}

export function allMappingProfiles(): readonly ImportedHumanoidRigProfile[] {
  return ['mixamo', 'maya-humanik', 'generic'];
}

