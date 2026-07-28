import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import { getReferencedProjectAssetIds } from '../src/engine/projectAssets';
import { suggestAutorigMarkers, fitSkeletonFromMarkers, applyFittedSkeletonToRig } from '../src/engine/autorigMarkers';
import { applySkinBuffersToRig, generateDeterministicSkinWeights } from '../src/engine/autorigSkinWeights';
import { hydrateAutoriggedCharactersFromAssets } from '../src/engine/autoriggedPoseableCharacter';
import { resolvePoseableCharacter } from '../src/engine/poseableCharacter';
import { createId } from '../src/utils/ids';
import { MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';
import { registerModelAssetBytes } from '../src/engine/modelAssetStore';
import { HUMAN_JOINT_IDS } from '../src/engine/humanPose';
import type { PoseableRigAsset, ProjectAsset, SceneObject } from '../src/domain/types';
import * as THREE from 'three';

describe('autorigged character lifecycle (2D)', () => {
  it('round-trips fitted rig + skin through serialize/parse and keeps asset refs', () => {
    registerModelAssetBytes('poseable-source-lifecycle', new TextEncoder().encode('src').buffer);

    const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
    const fitted = fitSkeletonFromMarkers(markers, 'full');
    let rig: PoseableRigAsset = {
      version: 1,
      id: 'rig_life',
      skeletonJoints: [...HUMAN_JOINT_IDS],
      originalSourceAssetId: 'src_life',
      sourceMeshAssetId: 'src_life',
      generationSettings: { approximateHeightMeters: 1.75 },
    };
    rig = applyFittedSkeletonToRig(rig, fitted);
    const buffers = generateDeterministicSkinWeights({
      positions: Float32Array.from([0, 1, 0, 0.2, 1.2, 0]),
      jointPositions: fitted.jointPositions,
    });
    rig = applySkinBuffersToRig(rig, buffers, 'skin_life');

    const sourceAsset: ProjectAsset = {
      id: 'src_life',
      type: 'model',
      name: 'life.glb',
      uri: `${MODEL_ASSET_URI_PREFIX}poseable-source-lifecycle`,
      createdAt: new Date().toISOString(),
    };
    const skinAsset: ProjectAsset = {
      id: 'skin_life',
      type: 'model',
      name: 'life-skin.bin',
      uri: `${MODEL_ASSET_URI_PREFIX}poseable-skin-lifecycle`,
      createdAt: new Date().toISOString(),
      metadata: { poseableSkin: true },
    };
    const rigAsset: ProjectAsset = {
      id: 'asset_life',
      type: 'poseable_rig',
      name: 'life rig',
      uri: 'data:application/json,{}',
      createdAt: new Date().toISOString(),
      metadata: { poseableRig: rig },
    };
    const object: SceneObject = {
      id: createId('obj'),
      name: 'Life',
      type: 'human_dummy',
      category: 'helper',
      transform: { position: [0, 0.9, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [0.55, 1.75, 0.55],
      visible: true,
      locked: false,
      stagingRole: 'person',
      poseableCharacter: { kind: 'autorigged', assetId: rigAsset.id, rigId: rig.id },
      humanPose: { version: 1, joints: {} },
    };

    const project = createDefaultProject();
    project.assets.assets[sourceAsset.id] = sourceAsset;
    project.assets.assets[skinAsset.id] = skinAsset;
    project.assets.assets[rigAsset.id] = rigAsset;
    project.scene.objects.push(object);

    const referenced = getReferencedProjectAssetIds(project);
    expect(referenced.has('src_life')).toBe(true);
    expect(referenced.has('skin_life')).toBe(true);
    expect(referenced.has('asset_life')).toBe(true);

    const parsed = parseProject(serializeProject(project));
    const parsedObject = parsed.scene.objects.find((item) => item.id === object.id);
    expect(parsedObject?.poseableCharacter?.kind).toBe('autorigged');
    expect(parsed.assets.assets.asset_life?.metadata?.poseableRig?.skin?.skinAssetId).toBe('skin_life');
    expect(parsed.assets.assets.asset_life?.metadata?.poseableRig?.markers?.length).toBeGreaterThan(5);

    hydrateAutoriggedCharactersFromAssets(parsed.assets);
    const character = resolvePoseableCharacter(parsedObject?.poseableCharacter, parsed.assets);
    expect(character?.source.kind).toBe('autorigged');
  });

  it('falls back to a rigid instance when skin buffers are corrupt', () => {
    const character = hydrateAutoriggedCharactersFromAssets({
      assets: {
        asset_bad: {
          id: 'asset_bad',
          type: 'poseable_rig',
          name: 'bad',
          uri: 'data:application/json,{}',
          createdAt: new Date().toISOString(),
          metadata: {
            poseableRig: {
              version: 1,
              id: 'rig_bad',
              skeletonJoints: [...HUMAN_JOINT_IDS],
              originalSourceAssetId: 'missing_source',
              bindMatrices: {},
              skin: {
                influencesPerVertex: 4,
                indices: [0, 0, 0, 0],
                weights: [1, 0, 0, 0],
              },
            },
          },
        },
      },
    });
    expect(character).toBeGreaterThanOrEqual(0);

    // createInstance without a loaded template returns a box fallback — must not throw.
    const resolved = resolvePoseableCharacter({ kind: 'autorigged', assetId: 'asset_bad', rigId: 'rig_bad' });
    const material = new THREE.MeshStandardMaterial();
    const instance = resolved?.createInstance({
      id: 'o',
      name: 'Bad',
      type: 'human_dummy',
      category: 'helper',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [0.5, 1.7, 0.5],
      visible: true,
      locked: false,
    }, material);
    expect(instance).toBeTruthy();
  });
});
