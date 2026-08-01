import { describe, expect, it } from 'vitest';
import { normalizePoseableCharacterSource } from '../src/engine/humanPose';
import { normalizePoseableRigAsset } from '../src/engine/poseableRigNormalize';
import { getReferencedProjectAssetIds } from '../src/engine/projectAssets';
import type { LocationProject } from '../src/domain/types';

const binding = {
  version: 1 as const,
  id: 'rig-1',
  sourceAssetId: 'source-1',
  sourceFormat: 'fbx' as const,
  profile: 'mixamo' as const,
  boneMap: { hips: 'Armature[0]/Hips[0]', head: 'Armature[0]/Head[0]' },
  canonicalPoseBases: { hips: [0, 0, 0, 1] as [number, number, number, number] },
  skeletonHash: 'skeleton-hash',
  restPoseHash: 'rest-hash',
  hipsBonePath: 'Armature[0]/Hips[0]',
  orientation: { frontAxis: '+z' as const, upAxis: '+y' as const, groundLevelMeters: 0 },
  approximateHeightMeters: 1.8,
  requiredJointCoverage: 1,
  optionalJointCoverage: 0.2,
};

describe('imported rig persistence', () => {
  it('normalizes imported sources and binding metadata without embedding skin data', () => {
    expect(normalizePoseableCharacterSource({ kind: 'importedRig', assetId: 'rig-asset', rigId: 'rig-1' })).toEqual({
      kind: 'importedRig', assetId: 'rig-asset', rigId: 'rig-1',
    });
    const normalized = normalizePoseableRigAsset({
      version: 1,
      id: 'rig-1',
      skeletonJoints: ['hips', 'head'],
      importedRigBinding: binding,
      skin: { influencesPerVertex: 4, indices: [0, 0, 0, 0], weights: [1, 0, 0, 0] },
    });
    expect(normalized?.importedRigBinding?.sourceFormat).toBe('fbx');
    expect(normalized?.importedRigBinding?.boneMap.hips).toContain('Hips');
    expect(normalized?.skin?.indices).toEqual([0, 0, 0, 0]);
  });

  it('keeps imported source and rig assets reachable from an imported scene object', () => {
    const project = {
      scene: {
        objects: [{
          id: 'object-1', name: 'Actor', type: 'human_dummy', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          dimensions: [1, 2, 1], category: 'helper', locked: false, visible: true,
          poseableCharacter: { kind: 'importedRig', assetId: 'rig-asset', rigId: 'rig-1' },
        }],
      },
      assets: {
        assets: {
          'source-1': { id: 'source-1', type: 'model', name: 'actor.fbx', uri: 'panoref-model:source', createdAt: '' },
          'rig-asset': { id: 'rig-asset', type: 'poseable_rig', name: 'actor rig', uri: 'data:,{}', createdAt: '', metadata: { poseableRig: { id: 'rig-1', skeletonJoints: ['hips'], importedRigBinding: binding } } },
        },
      },
      panoRefs: [], shots: [],
    } as unknown as LocationProject;
    expect(getReferencedProjectAssetIds(project)).toEqual(new Set(['rig-asset', 'source-1']));
  });
});

