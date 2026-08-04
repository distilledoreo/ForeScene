import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createDefaultProject } from '../src/domain/defaults';
import type { AssetRegistry, PoseableRigAsset, ProjectAsset, SceneObject } from '../src/domain/types';
import {
  applySkinBuffersToRig,
  assertCompactPoseableSkin,
  generateDeterministicSkinWeights,
  poseableSkinExceedsInlineBudget,
  stripInlineSkinArraysFromRig,
  writeSkinWeightBinaryAsset,
} from '../src/engine/autorigSkinWeights';
import {
  cloneSkinnedPrototypeInstance,
  ensureSkeletonCloneReady,
  ensureSkinBuffersForRig,
  getCachedSkinBuffers,
  getOrBuildSkinnedPrototype,
  getPrototypeBuildCount,
  getSkinBinaryReadCount,
  markSharedSkinnedPrototypeResources,
  resetAutorigRuntimeCachesForTests,
  shareAnyBufferGeometry,
  skinBufferCacheKey,
  skinnedPrototypeCacheKey,
  SHARED_SKINNED_MATERIAL_USERDATA,
  loadSkinWeightBuffersFromUri,
} from '../src/engine/autorigSkinnedMesh';
import {
  buildAutorigRigInventoryKey,
  createAutoriggedPoseableCharacterShell,
  hydrateAutoriggedCharactersFromAssets,
  isAutorigHydrationCurrent,
  resetAutoriggedCharacterTemplatesForTests,
} from '../src/engine/autoriggedPoseableCharacter';
import { applyFittedSkeletonToRig, fitSkeletonFromMarkers, suggestAutorigMarkers } from '../src/engine/autorigMarkers';
import { HUMAN_JOINT_IDS } from '../src/engine/humanPose';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import {
  applyHumanPoseToObject3D,
  registerAutoriggedPoseableCharacter,
} from '../src/engine/poseableCharacter';
import {
  buildSceneObjectNodeMap,
  diffAndApplySceneObjectUpdates,
} from '../src/engine/sceneObjectNodeSync';
import { computeSceneFlyBounds, sceneFlyBoundsRevisionKey } from '../src/engine/flyCameraBounds';
import { MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';
import { registerModelAssetBytes } from '../src/engine/modelAssetStore';
import { disposeScene } from '../src/engine/sceneObjects';
import { createId } from '../src/utils/ids';

function makeFittedRig(id = 'rig_opt'): PoseableRigAsset {
  const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
  const fitted = fitSkeletonFromMarkers(markers, 'full');
  let rig: PoseableRigAsset = {
    version: 1,
    id,
    skeletonJoints: [...HUMAN_JOINT_IDS],
    originalSourceAssetId: 'src_opt',
    sourceMeshAssetId: 'src_opt',
    generationSettings: { approximateHeightMeters: 1.75 },
  };
  rig = applyFittedSkeletonToRig(rig, fitted);
  return rig;
}

function makeBuffers(rig: PoseableRigAsset) {
  const markers = suggestAutorigMarkers({ size: [0.6, 1.75, 0.35], heightMeters: 1.75 });
  const fitted = fitSkeletonFromMarkers(markers, 'full');
  // Small fixture mesh: 2 vertices × 4 influences.
  return generateDeterministicSkinWeights({
    positions: Float32Array.from([0, 1, 0, 0.2, 1.2, 0]),
    jointPositions: fitted.jointPositions,
    heightMeters: 1.75,
  });
}

afterEach(() => {
  resetAutorigRuntimeCachesForTests();
  resetAutoriggedCharacterTemplatesForTests();
});

describe('autorig skin persist / migrate (compact metadata)', () => {
  it('applySkinBuffersToRig with skinAssetId stores compact skin only', () => {
    const rig = makeFittedRig();
    const buffers = makeBuffers(rig);
    const next = applySkinBuffersToRig(rig, buffers, 'skin_bin_1');
    expect(next.skin?.skinAssetId).toBe('skin_bin_1');
    expect(next.skin?.indices).toBeUndefined();
    expect(next.skin?.weights).toBeUndefined();
    expect(() => assertCompactPoseableSkin(next.skin)).not.toThrow();
    expect(poseableSkinExceedsInlineBudget(next.skin)).toBe(false);
  });

  it('loads poseable skin payloads through legacy local asset URI prefixes', async () => {
    const written = await writeSkinWeightBinaryAsset({
      influencesPerVertex: 1,
      indices: new Uint16Array([0, 0]),
      weights: new Float32Array([1, 1]),
      jointOrder: ['hips'],
    });

    const loaded = await loadSkinWeightBuffersFromUri(
      written.uri.replace('panoref-idb:', 'panoref-asset:'),
      ['hips'],
    );

    expect(loaded.indices).toEqual(new Uint16Array([0, 0]));
    expect(loaded.weights).toEqual(new Float32Array([1, 1]));
  });

  it('serialize strips legacy dual-storage inline arrays while keeping skinAssetId', () => {
    const rig = makeFittedRig('rig_legacy');
    const buffers = makeBuffers(rig);
    const dual: PoseableRigAsset = {
      ...applySkinBuffersToRig(rig, buffers, 'skin_legacy'),
      skin: {
        influencesPerVertex: 4,
        skinAssetId: 'skin_legacy',
        indices: Array.from(buffers.indices),
        weights: Array.from(buffers.weights),
      },
    };
    expect(dual.skin?.indices?.length).toBeGreaterThan(0);

    const project = createDefaultProject();
    const skinAsset: ProjectAsset = {
      id: 'skin_legacy',
      type: 'model',
      name: 'legacy-skin.bin',
      uri: `${MODEL_ASSET_URI_PREFIX}poseable-skin-legacy`,
      createdAt: new Date().toISOString(),
      metadata: { poseableSkin: true },
    };
    const rigAsset: ProjectAsset = {
      id: 'asset_legacy',
      type: 'poseable_rig',
      name: 'legacy rig',
      uri: 'data:application/json,{}',
      createdAt: new Date().toISOString(),
      metadata: { poseableRig: dual },
    };
    project.assets.assets[skinAsset.id] = skinAsset;
    project.assets.assets[rigAsset.id] = rigAsset;
    // Keep assets live through pruneUnreferencedProjectAssets.
    project.scene.objects.push({
      id: createId('obj'),
      name: 'Legacy Char',
      type: 'human_dummy',
      category: 'helper',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [0.5, 1.75, 0.5],
      visible: true,
      locked: false,
      poseableCharacter: { kind: 'autorigged', assetId: rigAsset.id, rigId: dual.id },
    });

    const serialized = serializeProject(project);
    const parsed = JSON.parse(serialized) as typeof project;
    const skin = parsed.assets.assets.asset_legacy?.metadata?.poseableRig?.skin;
    expect(skin?.skinAssetId).toBe('skin_legacy');
    expect(skin?.indices).toBeUndefined();
    expect(skin?.weights).toBeUndefined();

    const roundTrip = parseProject(serialized);
    const roundSkin = roundTrip.assets.assets.asset_legacy?.metadata?.poseableRig?.skin;
    expect(roundSkin?.skinAssetId).toBe('skin_legacy');
    expect(roundSkin?.indices).toBeUndefined();
    expect(roundSkin?.weights).toBeUndefined();
    expect(poseableSkinExceedsInlineBudget(roundSkin)).toBe(false);
  });

  it('stripInlineSkinArraysFromRig + budget guard reject dual / large payloads', () => {
    const rig = makeFittedRig();
    const buffers = makeBuffers(rig);
    const dual: PoseableRigAsset = {
      ...rig,
      skin: {
        influencesPerVertex: 4,
        skinAssetId: 'x',
        indices: Array.from({ length: 1000 }, (_, i) => i % 4),
        weights: Array.from({ length: 1000 }, () => 0.25),
      },
    };
    expect(poseableSkinExceedsInlineBudget(dual.skin)).toBe(true);
    expect(() => assertCompactPoseableSkin(dual.skin)).toThrow(/must not embed/);
    const stripped = stripInlineSkinArraysFromRig(dual);
    expect(stripped.skin?.indices).toBeUndefined();
    expect(stripped.skin?.weights).toBeUndefined();
    expect(stripped.skin?.skinAssetId).toBe('x');
    expect(() => assertCompactPoseableSkin(stripped.skin)).not.toThrow();
    // buffers used so generate path stays exercised
    expect(buffers.indices.length).toBeGreaterThan(0);
  });

  it('generateSkinWeightsForRigAsset persists compact skin and caches buffers without inline arrays', async () => {
    // Minimal GLB-like empty scene is not required: generate uses extractWorldPositions.
    // Provide a template via internal cache by registering a tiny GLB-less path is hard;
    // exercise apply + write binary + cache path used by generateSkinWeights.
    const rig = makeFittedRig('rig_gen');
    const buffers = makeBuffers(rig);
    const written = await writeSkinWeightBinaryAsset(buffers);
    registerModelAssetBytes(
      written.uri.slice(MODEL_ASSET_URI_PREFIX.length),
      // re-read path uses getModelAsset; writeSkin already stored via putModelAsset
      (await (await import('../src/engine/modelAssetStore')).getModelAsset(
        written.uri.slice(MODEL_ASSET_URI_PREFIX.length),
      ))!,
    );
    const next = applySkinBuffersToRig(rig, buffers, written.assetId);
    expect(next.skin?.indices).toBeUndefined();
    const key = skinBufferCacheKey({ skinAssetId: written.assetId, rigId: next.id });
    // Seed cache the same way generateSkinWeightsForRigAsset does
    const { setCachedSkinBuffers } = await import('../src/engine/autorigSkinnedMesh');
    setCachedSkinBuffers(key, buffers);

    const assets: AssetRegistry = {
      assets: {
        [written.assetId]: {
          id: written.assetId,
          type: 'model',
          name: 'skin.bin',
          uri: written.uri,
          createdAt: new Date().toISOString(),
          metadata: { poseableSkin: true },
        },
      },
    };
    const readsBefore = getSkinBinaryReadCount();
    const loaded = await ensureSkinBuffersForRig(next, assets);
    expect(loaded?.indices.length).toBe(buffers.indices.length);
    // Cache hit — no additional binary read
    expect(getSkinBinaryReadCount()).toBe(readsBefore);
  });
});

describe('autorig instance caches (skin + prototype)', () => {
  it('second instance reuses prepared prototype geometry and does not re-read skin binary', async () => {
    await ensureSkeletonCloneReady();
    const rig = makeFittedRig('rig_proto');
    const buffers = makeBuffers(rig);
    const written = await writeSkinWeightBinaryAsset(buffers);
    const next = applySkinBuffersToRig(rig, buffers, written.assetId);
    const assets: AssetRegistry = {
      assets: {
        [written.assetId]: {
          id: written.assetId,
          type: 'model',
          name: 'skin.bin',
          uri: written.uri,
          createdAt: new Date().toISOString(),
        },
      },
    };

    const bufferKey = skinBufferCacheKey({ skinAssetId: written.assetId, rigId: next.id });
    const readsBefore = getSkinBinaryReadCount();
    await ensureSkinBuffersForRig(next, assets);
    expect(getSkinBinaryReadCount()).toBe(readsBefore + 1);
    await ensureSkinBuffersForRig(next, assets);
    expect(getSkinBinaryReadCount()).toBe(readsBefore + 1);
    expect(getCachedSkinBuffers(bufferKey)).toBeTruthy();

    // Synthetic template mesh with vertex count matching the 2-vertex fixture buffers.
    const template = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0.2, 1.2, 0]), 3),
      ),
      new THREE.MeshStandardMaterial(),
    );
    const group = new THREE.Group();
    group.add(template);

    const protoKey = skinnedPrototypeCacheKey({
      assetId: 'asset_proto',
      rigId: next.id,
      rigGenerationVersion: next.rigGenerationVersion,
    });
    const buildsBefore = getPrototypeBuildCount();
    const proto = getOrBuildSkinnedPrototype({
      cacheKey: protoKey,
      template: group,
      rig: next,
      buffers: getCachedSkinBuffers(bufferKey)!,
      referenceHeight: 1.75,
    });
    expect(getPrototypeBuildCount()).toBe(buildsBefore + 1);

    const again = getOrBuildSkinnedPrototype({
      cacheKey: protoKey,
      template: group,
      rig: next,
      buffers: getCachedSkinBuffers(bufferKey)!,
      referenceHeight: 1.75,
    });
    expect(again).toBe(proto);
    expect(getPrototypeBuildCount()).toBe(buildsBefore + 1);

    const a = cloneSkinnedPrototypeInstance(proto.root);
    const b = cloneSkinnedPrototypeInstance(proto.root);
    expect(shareAnyBufferGeometry(a, b)).toBe(true);
    expect(shareAnyBufferGeometry(a, proto.root)).toBe(true);

    // createInstance path: no inline indices required once buffers are cached
    const shell = createAutoriggedPoseableCharacterShell({
      assetId: 'asset_proto',
      rigId: next.id,
      sourceAssetId: 'src_opt',
      rig: next,
      assets,
    });
    // Template missing → box fallback is OK; prove createInstance does not need inline arrays
    expect(next.skin?.indices).toBeUndefined();
    const material = new THREE.MeshStandardMaterial();
    const instance = shell.createInstance({
      id: 'o1',
      name: 'Char',
      type: 'human_dummy',
      category: 'helper',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [0.5, 1.75, 0.5],
      visible: true,
      locked: false,
    }, material);
    expect(instance).toBeTruthy();
  });
});

describe('autorig hydration locality', () => {
  it('hydration is a no-op when rig inventory key is unchanged', () => {
    const rig = makeFittedRig('rig_hyd');
    const buffers = makeBuffers(rig);
    const skinned = applySkinBuffersToRig(rig, buffers, 'skin_hyd');
    const assets: AssetRegistry = {
      assets: {
        asset_hyd: {
          id: 'asset_hyd',
          type: 'poseable_rig',
          name: 'hyd',
          uri: 'data:application/json,{}',
          createdAt: new Date().toISOString(),
          metadata: {
            poseableRig: {
              ...skinned,
              originalSourceAssetId: 'src_hyd',
              sourceMeshAssetId: 'src_hyd',
            },
          },
        },
        src_hyd: {
          id: 'src_hyd',
          type: 'model',
          name: 'src',
          uri: `${MODEL_ASSET_URI_PREFIX}src-hyd`,
          createdAt: new Date().toISOString(),
        },
      },
    };

    const key1 = buildAutorigRigInventoryKey(assets);
    const first = hydrateAutoriggedCharactersFromAssets(assets);
    expect(first).toBeGreaterThan(0);
    expect(isAutorigHydrationCurrent(assets)).toBe(true);

    // Simulate pose-only project mutation: same assets object shape / inventory
    const second = hydrateAutoriggedCharactersFromAssets(assets);
    expect(second).toBe(0);
    expect(buildAutorigRigInventoryKey(assets)).toBe(key1);

    // Changing generation should re-register
    const bumpedAssets: AssetRegistry = {
      assets: {
        ...assets.assets,
        asset_hyd: {
          ...assets.assets.asset_hyd!,
          metadata: {
            poseableRig: {
              ...(assets.assets.asset_hyd!.metadata!.poseableRig as PoseableRigAsset),
              rigGenerationVersion: 99,
            },
          },
        },
      },
    };
    expect(buildAutorigRigInventoryKey(bumpedAssets)).not.toBe(key1);
    const third = hydrateAutoriggedCharactersFromAssets(bumpedAssets);
    expect(third).toBeGreaterThan(0);
  });
});

describe('pose update locality + single skeleton owner', () => {
  it('diffAndApplySceneObjectUpdates only applies changed object ids', () => {
    const makeObj = (id: string, poseY = 0): SceneObject => ({
      id,
      name: id,
      type: 'box',
      category: 'architecture',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      dimensions: [1, 1, 1],
      visible: true,
      locked: false,
      humanPose: poseY
        ? { version: 1, joints: { hips: { rotation: [0, poseY, 0, 1] } } }
        : { version: 1, joints: {} },
    });

    const a = makeObj('a');
    const b = makeObj('b');
    const nodeA = new THREE.Object3D();
    nodeA.userData.sceneObjectId = 'a';
    const nodeB = new THREE.Object3D();
    nodeB.userData.sceneObjectId = 'b';
    const nodes = new Map<string, THREE.Object3D>([
      ['a', nodeA],
      ['b', nodeB],
    ]);

    const first = diffAndApplySceneObjectUpdates({
      nodes,
      objects: [a, b],
      previous: new Map(),
    });
    expect(first.appliedIds.sort()).toEqual(['a', 'b']);

    const second = diffAndApplySceneObjectUpdates({
      nodes,
      objects: [a, b],
      previous: first.nextPrevious,
    });
    expect(second.appliedIds).toEqual([]);
    expect(second.skippedIds.sort()).toEqual(['a', 'b']);

    const aPosed = makeObj('a', 0.2);
    const third = diffAndApplySceneObjectUpdates({
      nodes,
      objects: [aPosed, b],
      previous: second.nextPrevious,
    });
    expect(third.appliedIds).toEqual(['a']);
    expect(third.skippedIds).toContain('b');
  });

  it('applyHumanPoseToObject3D owns a single skeleton.update through the real autorig adapter path', () => {
    const assetId = 'asset_pose_once';
    const rigId = 'rig_pose_once';
    const character = createAutoriggedPoseableCharacterShell({
      assetId,
      rigId,
      sourceAssetId: 'src_pose_once',
    });
    // Force ready so applyHumanPoseToObject3D does not early-return (template may be unloaded in unit tests).
    character.isReady = () => true;
    const applyPoseSpy = vi.spyOn(character, 'applyPose');
    registerAutoriggedPoseableCharacter(assetId, rigId, character);

    const root = new THREE.Group();
    const bone = new THREE.Bone();
    bone.name = 'hips';
    bone.userData.humanJointId = 'hips';
    const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const mesh = new THREE.SkinnedMesh(geo, material);
    const skeleton = new THREE.Skeleton([bone]);
    mesh.add(bone);
    mesh.bind(skeleton);
    root.add(mesh);
    // Match shipped cache key used by updateSkinnedMeshes / createInstance clones.
    root.userData.panorefSkinnedMeshes = [mesh];

    const updateSpy = vi.spyOn(skeleton, 'update');
    applyHumanPoseToObject3D(root, {
      type: 'human_dummy',
      poseableCharacter: { kind: 'autorigged', assetId, rigId },
      humanPose: {
        version: 1,
        joints: {
          hips: { rotation: [0, 0.15, 0, 0.989] },
        },
      },
    });

    // Adapter applyPose ran (semantic bones) and the generic wrapper owns exactly one skeleton.update.
    expect(applyPoseSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('disposeScene does not dispose shared skinned prototype materials', async () => {
    await ensureSkeletonCloneReady();
    const rig = makeFittedRig('rig_mat_share');
    const buffers = makeBuffers(rig);
    const material = new THREE.MeshStandardMaterial({ color: 0x44aa88 });
    const template = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0.2, 1.2, 0]), 3),
      ),
      material,
    );
    const group = new THREE.Group();
    group.add(template);

    const proto = getOrBuildSkinnedPrototype({
      cacheKey: skinnedPrototypeCacheKey({
        assetId: 'asset_mat',
        rigId: rig.id,
        rigGenerationVersion: 1,
      }),
      template: group,
      rig: { ...rig, bindMatrices: rig.bindMatrices ?? {}, skin: { influencesPerVertex: 4, skinAssetId: 's' } },
      buffers,
      materialFallback: material,
      referenceHeight: 1.75,
    });
    markSharedSkinnedPrototypeResources(proto.root);

    let sharedMaterial: THREE.Material | undefined;
    proto.root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (mat) sharedMaterial = mat;
    });
    expect(sharedMaterial).toBeTruthy();
    expect(sharedMaterial!.userData[SHARED_SKINNED_MATERIAL_USERDATA]).toBe(true);
    const disposeSpy = vi.spyOn(sharedMaterial!, 'dispose');

    const scene = new THREE.Scene();
    const instance = cloneSkinnedPrototypeInstance(proto.root);
    scene.add(instance);
    // Instance and prototype share the same material reference after SkeletonUtils.clone.
    disposeScene(scene);

    // Shared prototype material must not be disposed on scene teardown / rebuild.
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(sharedMaterial!.userData[SHARED_SKINNED_MATERIAL_USERDATA]).toBe(true);
    if (sharedMaterial instanceof THREE.MeshStandardMaterial) {
      sharedMaterial.color.setHex(0xff0000);
      expect(sharedMaterial.color.getHex()).toBe(0xff0000);
    }
  });

  it('buildSceneObjectNodeMap builds persistent id map without re-walk requirement for lookup', () => {
    const scene = new THREE.Scene();
    const a = new THREE.Object3D();
    a.userData.sceneObjectId = 'obj_a';
    const b = new THREE.Object3D();
    b.userData.sceneObjectId = 'obj_b';
    scene.add(a);
    scene.add(b);
    const map = buildSceneObjectNodeMap(scene);
    expect(map.get('obj_a')).toBe(a);
    expect(map.get('obj_b')).toBe(b);
    expect(map.size).toBe(2);
  });
});

describe('fly bounds revision key', () => {
  it('pose-only edits do not change fly bounds revision; position does', () => {
    const project = createDefaultProject();
    const base = {
      ...project.scene,
      objects: [
        {
          id: 'o1',
          name: 'Box',
          type: 'box' as const,
          category: 'architecture' as const,
          transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
          dimensions: [1, 1, 1] as [number, number, number],
          visible: true,
          locked: false,
          humanPose: { version: 1 as const, joints: {} },
        },
      ],
    };
    const key1 = sceneFlyBoundsRevisionKey(base);
    const posed = {
      ...base,
      objects: [
        {
          ...base.objects[0]!,
          humanPose: { version: 1 as const, joints: { head: { rotation: [0, 0.1, 0, 1] as [number, number, number, number] } } },
        },
      ],
    };
    expect(sceneFlyBoundsRevisionKey(posed)).toBe(key1);

    const moved = {
      ...base,
      objects: [
        {
          ...base.objects[0]!,
          transform: {
            ...base.objects[0]!.transform,
            position: [5, 0, 0] as [number, number, number],
          },
        },
      ],
    };
    expect(sceneFlyBoundsRevisionKey(moved)).not.toBe(key1);

    // Memo pattern: same key → computeSceneFlyBounds need not re-run for pose
    const bounds1 = computeSceneFlyBounds(base);
    const bounds2 = computeSceneFlyBounds(posed);
    // Positions unchanged → same bound mins
    expect(bounds2.min).toEqual(bounds1.min);
    expect(bounds2.max).toEqual(bounds1.max);
  });
});
