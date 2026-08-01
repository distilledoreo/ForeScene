import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { HumanJointId, ImportedHumanoidRigBinding, ProjectAsset, SceneObject } from '../src/domain/types';
import { createDefaultProject } from '../src/domain/defaults';
import { createEmptyHumanPose, eulerDegreesToQuaternion } from '../src/engine/humanPose';
import { analyzeHumanoidSkeleton } from '../src/engine/importedRig/analyzeSkeleton';
import { calculateCanonicalPoseBases } from '../src/engine/importedRig/canonicalFrames';
import { fingerprintImportedRestPose, fingerprintImportedSkeleton } from '../src/engine/importedRig/fingerprints';
import { MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMeshConstants';
import {
  ensureImportedRiggedCharactersForProject,
  hydrateImportedRiggedCharactersFromAssets,
  resetImportedRigRuntimeCachesForTests,
} from '../src/engine/importedRiggedPoseableCharacter';
import { loadPoseableSource } from '../src/engine/poseableSourceLoader';
import { resolvePoseableCharacterForObject, updateSkinnedMeshes } from '../src/engine/poseableCharacter';
import { parseProject, serializeProject } from '../src/engine/projectIO';
import { putModelAsset, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';
import { preservedRigGlb } from './fixtures/preservedRigGlb';

function makePose(rotation: [number, number, number]) {
  return {
    ...createEmptyHumanPose(),
    joints: {
      leftUpperArm: { rotation: eulerDegreesToQuaternion(...rotation) },
    },
  };
}

function skinnedVertex(instance: THREE.Object3D, index: number): THREE.Vector3 {
  const mesh = instance.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh | undefined;
  if (!mesh) throw new Error('Imported rig instance did not contain a skinned mesh.');
  updateSkinnedMeshes(instance);
  return mesh.getVertexPosition(index, new THREE.Vector3());
}

async function createImportedRigProject() {
  const bytes = preservedRigGlb();
  const sourceAsset: ProjectAsset = {
    id: 'source-1',
    type: 'model',
    name: 'preserved.glb',
    uri: `${MODEL_ASSET_URI_PREFIX}integration/source-1`,
    createdAt: new Date(0).toISOString(),
    metadata: { format: 'glb', poseableSource: true },
  };
  await putModelAsset('integration/source-1', bytes);
  const loaded = await loadPoseableSource(sourceAsset, bytes);
  const mapping = analyzeHumanoidSkeleton(loaded);
  const [skeletonHash, restPoseHash] = await Promise.all([
    fingerprintImportedSkeleton(loaded.root, loaded.bones),
    fingerprintImportedRestPose(loaded.root, loaded.bones),
  ]);
  const rigId = 'rig-1';
  const binding: ImportedHumanoidRigBinding = {
    version: 1,
    id: rigId,
    sourceAssetId: sourceAsset.id,
    sourceFormat: 'glb',
    profile: mapping.detectedProfile,
    boneMap: mapping.boneMap,
    canonicalPoseBases: calculateCanonicalPoseBases({ root: loaded.root, boneMap: mapping.boneMap }),
    skeletonHash,
    restPoseHash,
    hipsBonePath: mapping.boneMap.hips!,
    orientation: { frontAxis: '+z', upAxis: '+y', groundLevelMeters: 0 },
    approximateHeightMeters: 1.75,
    requiredJointCoverage: 1,
    optionalJointCoverage: 0,
  };
  const rigAsset: ProjectAsset = {
    id: 'rig-asset',
    type: 'poseable_rig',
    name: 'preserved rig',
    uri: 'data:application/json,{}',
    createdAt: new Date(0).toISOString(),
    metadata: { poseableRig: { version: 1, id: rigId, skeletonJoints: Object.keys(mapping.boneMap) as HumanJointId[], importedRigBinding: binding } },
  };
  const object = (id: string, humanPose: ReturnType<typeof makePose>): SceneObject => ({
    id,
    name: id,
    type: 'human_dummy',
    transform: { position: [0, 0.875, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    dimensions: [0.55, 1.75, 0.55],
    category: 'helper',
    locked: false,
    visible: true,
    stagingRole: 'person',
    humanPose,
    poseableCharacter: { kind: 'importedRig', assetId: rigAsset.id, rigId },
  });
  const project = createDefaultProject();
  project.assets.assets[sourceAsset.id] = sourceAsset;
  project.assets.assets[rigAsset.id] = rigAsset;
  project.scene.objects.push(object('actor-a', makePose([35, 0, 0]),), object('actor-b', makePose([-25, 0, 0])));
  return { project, sourceAsset, rigAsset };
}

describe('imported rig runtime integration', () => {
  afterEach(() => {
    resetImportedRigRuntimeCachesForTests();
    resetModelAssetStoreForTests();
  });

  it('loads, clones, poses, serializes, reloads, and preserves independent deformation', async () => {
    const { project } = await createImportedRigProject();
    hydrateImportedRiggedCharactersFromAssets(project.assets);
    await ensureImportedRiggedCharactersForProject(project);

    const objectA = project.scene.objects.find((object) => object.id === 'actor-a')!;
    const objectB = project.scene.objects.find((object) => object.id === 'actor-b')!;
    const character = resolvePoseableCharacterForObject(objectA, project.assets)!;
    await character.ensureLoaded();
    const material = new THREE.MeshStandardMaterial();
    const instanceA = character.createInstance(objectA, material);
    const instanceB = character.createInstance(objectB, material);
    character.applyPose(instanceA, objectA.humanPose);
    character.applyPose(instanceB, objectB.humanPose);

    const armA = character.getJoints(instanceA).find((joint) => joint.id === 'leftUpperArm')!.node;
    const armB = character.getJoints(instanceB).find((joint) => joint.id === 'leftUpperArm')!.node;
    expect(armA.quaternion.equals(armB.quaternion)).toBe(false);
    const vertexA = skinnedVertex(instanceA, 3);
    const vertexB = skinnedVertex(instanceB, 3);
    expect(vertexA.distanceTo(vertexB)).toBeGreaterThan(0.01);
    const armABeforeBMutation = armA.quaternion.clone();
    character.applyPose(instanceB, makePose([-70, 0, 0]));
    expect(armA.quaternion.equals(armABeforeBMutation)).toBe(true);

    const reloadedProject = parseProject(serializeProject(project));
    resetImportedRigRuntimeCachesForTests();
    hydrateImportedRiggedCharactersFromAssets(reloadedProject.assets);
    await ensureImportedRiggedCharactersForProject(reloadedProject);
    const reloadedA = reloadedProject.scene.objects.find((object) => object.id === 'actor-a')!;
    const reloadedCharacter = resolvePoseableCharacterForObject(reloadedA, reloadedProject.assets)!;
    await reloadedCharacter.ensureLoaded();
    const reloadedInstance = reloadedCharacter.createInstance(reloadedA, new THREE.MeshStandardMaterial());
    reloadedCharacter.applyPose(reloadedInstance, reloadedA.humanPose);
    const reloadedArm = reloadedCharacter.getJoints(reloadedInstance).find((joint) => joint.id === 'leftUpperArm')!.node;
    expect(reloadedArm.quaternion.equals(armA.quaternion)).toBe(true);
    expect(skinnedVertex(reloadedInstance, 3).distanceTo(vertexA)).toBeLessThan(0.001);
  });
});
