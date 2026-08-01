import * as THREE from 'three';
import type { HumanJointId, ImportedHumanoidRigProfile } from '../../domain/types';
import type { LoadedPoseableSource } from '../poseableSourceLoader';
import { HUMAN_JOINT_IDS } from '../humanPose';
import { buildBonePathMap, getRootRelativeNodePath } from './bonePaths';
import { allMappingProfiles, mappingNamesForProfile, normalizeBoneName } from './mappingProfiles';

export interface HumanoidMappingAnalysis {
  detectedProfile: ImportedHumanoidRigProfile;
  confidence: number;
  boneMap: Partial<Record<HumanJointId, string>>;
  requiredMapped: HumanJointId[];
  requiredMissing: HumanJointId[];
  optionalMapped: HumanJointId[];
  ambiguous: Array<{
    jointId: HumanJointId;
    candidates: Array<{ bonePath: string; confidence: number }>;
  }>;
  warnings: string[];
}

export const REQUIRED_IMPORTED_HUMANOID_JOINTS: readonly HumanJointId[] = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

const SIDE_REQUIRED: Readonly<Record<'left' | 'right', readonly HumanJointId[]>> = {
  left: ['leftUpperArm', 'leftLowerArm', 'leftHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot'],
  right: ['rightUpperArm', 'rightLowerArm', 'rightHand', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'],
};

function expectedSide(jointId: HumanJointId): 'left' | 'right' | undefined {
  if (jointId.startsWith('left')) return 'left';
  if (jointId.startsWith('right')) return 'right';
  return undefined;
}

function sourceSide(name: string): 'left' | 'right' | undefined {
  const normalized = normalizeBoneName(name);
  if (normalized.includes('left') || normalized.startsWith('l')) return 'left';
  if (normalized.includes('right') || normalized.startsWith('r')) return 'right';
  return undefined;
}

function scoreBone(jointId: HumanJointId, boneName: string, aliases: readonly string[]): number {
  const normalized = normalizeBoneName(boneName);
  const side = expectedSide(jointId);
  if (side && sourceSide(boneName) && sourceSide(boneName) !== side) return 0;
  const normalizedAliases = aliases.map(normalizeBoneName);
  const exact = normalizedAliases.findIndex((alias) => normalized === alias);
  if (exact >= 0) return 1 - exact * 0.025;
  const suffix = normalizedAliases.findIndex((alias) => normalized.endsWith(alias));
  if (suffix >= 0) return 0.86 - suffix * 0.025;
  const contains = normalizedAliases.findIndex((alias) => normalized.includes(alias));
  if (contains >= 0) return 0.72 - contains * 0.025;
  return 0;
}

function profileScore(profile: ImportedHumanoidRigProfile, bones: readonly THREE.Bone[]): number {
  const names = mappingNamesForProfile(profile);
  const scores = REQUIRED_IMPORTED_HUMANOID_JOINTS.map((jointId) => {
    const aliases = names[jointId] ?? [];
    return Math.max(...bones.map((bone) => scoreBone(jointId, bone.name, aliases)), 0);
  });
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function chooseProfile(bones: readonly THREE.Bone[]): ImportedHumanoidRigProfile {
  return [...allMappingProfiles()].sort((a, b) => profileScore(b, bones) - profileScore(a, bones))[0] ?? 'generic';
}

export function analyzeHumanoidSkeleton(
  source: Pick<LoadedPoseableSource, 'root' | 'bones'>,
): HumanoidMappingAnalysis {
  const { root, bones } = source;
  root.updateMatrixWorld(true);
  const profile = chooseProfile(bones);
  const names = mappingNamesForProfile(profile);
  const pathMap = buildBonePathMap(root, bones);
  const entries = [...pathMap.entries()];
  const boneMap: Partial<Record<HumanJointId, string>> = {};
  const ambiguous: HumanoidMappingAnalysis['ambiguous'] = [];
  const warnings: string[] = [];
  const confidenceByJoint = new Map<HumanJointId, number>();

  for (const jointId of HUMAN_JOINT_IDS) {
    const aliases = names[jointId] ?? [];
    if (aliases.length === 0) continue;
    const candidates = entries
      .map(([path, bone]) => ({ path, score: scoreBone(jointId, bone.name, aliases), bone }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const best = candidates[0];
    if (!best) continue;
    const second = candidates[1];
    if (second && best.score - second.score < 0.08) {
      ambiguous.push({
        jointId,
        candidates: candidates.slice(0, 3).map((candidate) => ({ bonePath: candidate.path, confidence: candidate.score })),
      });
    }
    boneMap[jointId] = best.path;
    confidenceByJoint.set(jointId, best.score);
  }

  const requiredMapped: HumanJointId[] = [];
  const requiredMissing: HumanJointId[] = [];
  for (const jointId of REQUIRED_IMPORTED_HUMANOID_JOINTS) {
    if (boneMap[jointId]) requiredMapped.push(jointId);
    else if (jointId === 'spine' && boneMap.chest) requiredMapped.push('chest');
    else requiredMissing.push(jointId);
  }
  const requiredSet = new Set(REQUIRED_IMPORTED_HUMANOID_JOINTS);
  const optionalMapped = HUMAN_JOINT_IDS.filter((jointId) => boneMap[jointId] && !requiredSet.has(jointId));
  const confidenceValues = [...confidenceByJoint.values()];
  const confidence = confidenceValues.length > 0
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : 0;

  const seenPaths = new Map<string, HumanJointId>();
  for (const [jointId, path] of Object.entries(boneMap) as Array<[HumanJointId, string]>) {
    const previous = seenPaths.get(path);
    if (previous) warnings.push(`Semantic joints ${previous} and ${jointId} resolve to the same source bone.`);
    seenPaths.set(path, jointId);
  }
  if (sourceSide('LeftArm') && SIDE_REQUIRED.left.some((jointId) => boneMap[jointId] && sourceSide(pathMap.get(boneMap[jointId]!)?.name ?? '') === 'right')) {
    warnings.push('At least one left semantic joint maps to a right-sided source bone.');
  }
  if (sourceSide('RightArm') && SIDE_REQUIRED.right.some((jointId) => boneMap[jointId] && sourceSide(pathMap.get(boneMap[jointId]!)?.name ?? '') === 'left')) {
    warnings.push('At least one right semantic joint maps to a left-sided source bone.');
  }
  if (requiredMissing.length > 0) warnings.push(`Missing required humanoid joints: ${requiredMissing.join(', ')}.`);
  if (ambiguous.length > 0) warnings.push(`${ambiguous.length} semantic joint mapping${ambiguous.length === 1 ? '' : 's'} need review.`);
  if (confidence < 0.7) warnings.push('Automatic mapping confidence is low; manual mapping is required.');

  return {
    detectedProfile: profile,
    confidence,
    boneMap,
    requiredMapped,
    requiredMissing,
    optionalMapped,
    ambiguous,
    warnings,
  };
}

export function bonePathForBone(root: THREE.Object3D, bone: THREE.Bone): string {
  return getRootRelativeNodePath(root, bone);
}
