import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import { getReferencedProjectAssetIds, pruneUnreferencedProjectAssets } from '../src/engine/projectAssets';
import {
  defaultPoseableOrientation,
  normalizePoseableRigAsset,
  orientationQuaternion,
} from '../src/engine/poseableCharacterImport';
import { HUMAN_JOINT_IDS } from '../src/engine/humanPose';
import { registerModelAssetBytes } from '../src/engine/modelAssetStore';
import { MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';
import { hydrateAutoriggedCharactersFromAssets } from '../src/engine/autoriggedPoseableCharacter';
import { resolvePoseableCharacter } from '../src/engine/poseableCharacter';
import type { PoseableRigAsset, ProjectAsset, SceneObject } from '../src/domain/types';
import { createId } from '../src/utils/ids';
import * as THREE from 'three';

function makeMinimalGlbBytes(): ArrayBuffer {
  // Not a real GLB — importPoseableCharacter tests that need parse go through fixtures.
  // Asset lifecycle tests only need durable binary bytes.
  return new TextEncoder().encode('fake-poseable-source').buffer;
}

describe('poseable character import shell', () => {
  it('normalizes poseable_rig orientation, rest, and generation settings', () => {
    const rig = normalizePoseableRigAsset({
      version: 1,
      id: 'rig_1',
      skeletonJoints: ['hips', 'bogus', 'head'],
      originalSourceAssetId: 'src_1',
      orientation: { frontAxis: '-z', upAxis: '+y', groundLevelMeters: 0.05 },
      restTransform: { position: [1, 2, 3], rotation: [0, 90, 0], scale: [1, 1, 1] },
      generationSettings: { approximateHeightMeters: 1.8, poseHint: 't-pose', notes: ['ok'] },
    });
    expect(rig).toMatchObject({
      id: 'rig_1',
      originalSourceAssetId: 'src_1',
      orientation: { frontAxis: '-z', upAxis: '+y', groundLevelMeters: 0.05 },
      generationSettings: { approximateHeightMeters: 1.8, poseHint: 't-pose' },
    });
    expect(rig?.skeletonJoints).toEqual(['hips', 'head']);
    expect(rig?.restTransform?.rotation).toEqual([0, 90, 0]);
  });

  it('marks current-generation rigs as reusable and legacy rigs as requiring rerigging', () => {
    const current = normalizePoseableRigAsset({
      version: 1,
      id: 'current',
      skeletonJoints: ['hips'],
      rigGenerationVersion: 2,
    });
    const legacy = normalizePoseableRigAsset({
      version: 1,
      id: 'legacy',
      skeletonJoints: ['hips'],
      rigGenerationVersion: 1,
    });
    expect(current?.requiresRerigging).toBeUndefined();
    expect(legacy?.requiresRerigging).toBe(true);
  });

  it('builds a non-identity orientation quaternion for swapped front axes', () => {
    const q = orientationQuaternion({ frontAxis: '-z', upAxis: '+y', groundLevelMeters: 0 });
    expect(q.equals(new THREE.Quaternion())).toBe(false);
    const identity = orientationQuaternion(defaultPoseableOrientation());
    expect(identity.length()).toBeCloseTo(1, 5);
  });

  it('keeps poseable_rig and original source assets referenced and round-trips project JSON', () => {
    const sourceKey = 'poseable-source-test';
    registerModelAssetBytes(sourceKey, makeMinimalGlbBytes());

    const sourceAsset: ProjectAsset = {
      id: 'src_poseable',
      type: 'model',
      name: 'hero.glb',
      uri: `${MODEL_ASSET_URI_PREFIX}${sourceKey}`,
      mimeType: 'model/gltf-binary',
      createdAt: new Date().toISOString(),
      metadata: { poseableSource: true },
    };
    const rig: PoseableRigAsset = {
      version: 1,
      id: 'rig_poseable',
      skeletonJoints: [...HUMAN_JOINT_IDS],
      originalSourceAssetId: sourceAsset.id,
      sourceMeshAssetId: sourceAsset.id,
      orientation: defaultPoseableOrientation(),
      generationSettings: { approximateHeightMeters: 1.75, poseHint: 'a-pose' },
      rigGenerationVersion: 1,
    };
    const rigAsset: ProjectAsset = {
      id: 'asset_rig',
      type: 'poseable_rig',
      name: 'hero rig',
      uri: 'data:application/json,{}',
      mimeType: 'application/json',
      createdAt: new Date().toISOString(),
      metadata: { poseableRig: rig },
    };
    const object: SceneObject = {
      id: createId('obj'),
      name: 'Hero',
      type: 'human_dummy',
      category: 'helper',
      transform: { position: [0, 0.875, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [0.55, 1.75, 0.55],
      visible: true,
      locked: false,
      stagingRole: 'person',
      poseableCharacter: { kind: 'autorigged', assetId: rigAsset.id, rigId: rig.id },
    };

    const project = createDefaultProject();
    project.assets.assets[sourceAsset.id] = sourceAsset;
    project.assets.assets[rigAsset.id] = rigAsset;
    project.scene.objects.push(object);

    const referenced = getReferencedProjectAssetIds(project);
    expect(referenced.has(sourceAsset.id)).toBe(true);
    expect(referenced.has(rigAsset.id)).toBe(true);

    const pruned = pruneUnreferencedProjectAssets(project);
    expect(pruned.assets.assets[sourceAsset.id]).toBeTruthy();
    expect(pruned.assets.assets[rigAsset.id]).toBeTruthy();

    const parsed = parseProject(serializeProject(project));
    const parsedObject = parsed.scene.objects.find((item) => item.id === object.id);
    expect(parsedObject?.poseableCharacter).toEqual({
      kind: 'autorigged',
      assetId: rigAsset.id,
      rigId: rig.id,
    });
    const parsedRig = parsed.assets.assets[rigAsset.id]?.metadata?.poseableRig;
    expect(parsedRig?.originalSourceAssetId).toBe(sourceAsset.id);
    expect(parsedRig?.orientation?.frontAxis).toBe('+z');
    expect(parsedRig?.generationSettings?.approximateHeightMeters).toBe(1.75);

    const hydrated = hydrateAutoriggedCharactersFromAssets(parsed.assets);
    expect(hydrated).toBeGreaterThan(0);
    const character = resolvePoseableCharacter(parsedObject?.poseableCharacter, parsed.assets);
    expect(character?.source).toEqual({ kind: 'autorigged', assetId: rigAsset.id, rigId: rig.id });
    expect(character?.skeleton.joints).toHaveLength(17);
  });

  it('exposes the Build tray command for poseable import', async () => {
    const build = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../src/components/workspaces/BuildWorkspace.tsx', import.meta.url),
      'utf8',
    ));
    expect(build).toContain('data-build-import-poseable-character');
    expect(build).toContain('Import poseable character');
    expect(build).toContain('PoseableCharacterImportDialog');
  });
});
