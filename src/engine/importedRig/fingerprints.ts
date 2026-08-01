import * as THREE from 'three';
import type { HumanJointId } from '../../domain/types';
import { sha256Digest } from '../binaryIntegrity';
import { buildBonePathMap } from './bonePaths';

function stableNumber(value: number): number {
  return Number(value.toFixed(7));
}

export async function fingerprintImportedSkeleton(
  root: THREE.Object3D,
  bones: readonly THREE.Bone[],
): Promise<string> {
  const entries = [...buildBonePathMap(root, bones).entries()]
    .map(([path, bone]) => ({ path, name: bone.name, parent: bone.parent?.name ?? '' }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return sha256Digest(new TextEncoder().encode(JSON.stringify(entries)).buffer);
}

export async function fingerprintImportedRestPose(
  root: THREE.Object3D,
  bones: readonly THREE.Bone[],
): Promise<string> {
  const entries = [...buildBonePathMap(root, bones).entries()]
    .map(([path, bone]) => ({
      path,
      position: bone.position.toArray().map(stableNumber),
      quaternion: bone.quaternion.toArray().map(stableNumber),
      scale: bone.scale.toArray().map(stableNumber),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return sha256Digest(new TextEncoder().encode(JSON.stringify(entries)).buffer);
}

export async function fingerprintImportedMapping(
  boneMap: Partial<Record<HumanJointId, string>>,
): Promise<string> {
  const entries = Object.entries(boneMap).sort(([a], [b]) => a.localeCompare(b));
  return sha256Digest(new TextEncoder().encode(JSON.stringify(entries)).buffer);
}

