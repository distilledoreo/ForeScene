import * as THREE from 'three';
import type { HumanJointId } from '../../domain/types';
import { REQUIRED_IMPORTED_HUMANOID_JOINTS } from './analyzeSkeleton';
import { resolveRootRelativeNodePath } from './bonePaths';
import { normalizeBoneName } from './mappingProfiles';

export interface HumanoidMappingValidation {
  ok: boolean;
  requiredMissing: HumanJointId[];
  duplicateAssignments: Array<{ path: string; joints: HumanJointId[] }>;
  sideMismatches: HumanJointId[];
  warnings: string[];
}

function sourceSide(name: string): 'left' | 'right' | undefined {
  const normalized = normalizeBoneName(name);
  if (normalized.includes('left') || normalized.startsWith('l')) return 'left';
  if (normalized.includes('right') || normalized.startsWith('r')) return 'right';
  return undefined;
}

function expectedSide(jointId: HumanJointId): 'left' | 'right' | undefined {
  if (jointId.startsWith('left')) return 'left';
  if (jointId.startsWith('right')) return 'right';
  return undefined;
}

export function validateHumanoidMapping(params: {
  root: THREE.Object3D;
  boneMap: Partial<Record<HumanJointId, string>>;
}): HumanoidMappingValidation {
  const requiredMissing = REQUIRED_IMPORTED_HUMANOID_JOINTS.filter((jointId) => (
    !params.boneMap[jointId] && !(jointId === 'spine' && params.boneMap.chest)
  ));
  const byPath = new Map<string, HumanJointId[]>();
  const sideMismatches: HumanJointId[] = [];
  const warnings: string[] = [];
  for (const [jointId, path] of Object.entries(params.boneMap) as Array<[HumanJointId, string]>) {
    if (!path) continue;
    const bone = resolveRootRelativeNodePath(params.root, path);
    if (!(bone instanceof THREE.Bone)) {
      warnings.push(`${jointId} points to a missing or non-bone path.`);
      continue;
    }
    const joints = byPath.get(path) ?? [];
    joints.push(jointId);
    byPath.set(path, joints);
    const expected = expectedSide(jointId);
    const actual = sourceSide(bone.name);
    if (expected && actual && expected !== actual) sideMismatches.push(jointId);
  }
  const duplicateAssignments = [...byPath.entries()]
    .filter(([, joints]) => joints.length > 1)
    .map(([path, joints]) => ({ path, joints }));
  if (requiredMissing.length > 0) warnings.push(`Missing required joints: ${requiredMissing.join(', ')}.`);
  if (duplicateAssignments.length > 0) warnings.push('Two semantic controls cannot share one source bone.');
  if (sideMismatches.length > 0) warnings.push(`Mirrored side mismatch on: ${sideMismatches.join(', ')}.`);
  return {
    ok: requiredMissing.length === 0 && duplicateAssignments.length === 0 && sideMismatches.length === 0 && warnings.every((warning) => !warning.includes('missing or non-bone')),
    requiredMissing,
    duplicateAssignments,
    sideMismatches,
    warnings,
  };
}
