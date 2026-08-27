import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSceneObject } from '../src/domain/defaults';
import { encodeBinaryGrayboxMesh, createImportedMeshNode, MODEL_ASSET_URI_PREFIX } from '../src/engine/importedMesh';
import { registerModelAssetBytes, resetModelAssetStoreForTests } from '../src/engine/modelAssetStore';

describe('imported mesh bounds', () => {
  afterEach(() => {
    resetModelAssetStoreForTests();
  });

  it('centers non-set imported meshes on the declared dimensions box', () => {
    const packed = encodeBinaryGrayboxMesh(
      new Float32Array([
        0, 0, 0,
        2, 0, 0,
        0, 4, 0,
        0, 0, 2,
      ]),
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    );
    registerModelAssetBytes('imported-bounds-foot-origin', packed.buffer);
    const object = createSceneObject('imported_model', 1);
    object.stagingRole = 'prop';
    object.modelAssetId = 'mesh';
    object.dimensions = [1, 2, 1];
    object.transform.scale = [1, 1, 1];
    const assets = {
      assets: {
        mesh: {
          id: 'mesh',
          type: 'model' as const,
          name: 'foot-origin.glb',
          uri: `${MODEL_ASSET_URI_PREFIX}imported-bounds-foot-origin`,
          storageKey: 'imported-bounds-foot-origin',
          createdAt: new Date(0).toISOString(),
        },
      },
    };
    const root = createImportedMeshNode(object, assets, new THREE.MeshStandardMaterial());
    const mesh = root.children[0] as THREE.Mesh;
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    expect((box.min.y + box.max.y) / 2).toBeCloseTo(0, 5);
    expect(box.min.y).toBeCloseTo(-1, 5);
    expect(box.max.y).toBeCloseTo(1, 5);

    const uncentered = createImportedMeshNode(
      object,
      assets,
      new THREE.MeshStandardMaterial(),
      { centerNonSetMesh: false },
    );
    const raw = uncentered.children[0] as THREE.Mesh;
    expect(raw.position.y).toBe(0);
  });

  it('keeps untagged imported architecture at its source AABB', () => {
    const packed = encodeBinaryGrayboxMesh(
      new Float32Array([
        0, 0, 0,
        2, 0, 0,
        0, 4, 0,
        0, 0, 2,
      ]),
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    );
    registerModelAssetBytes('imported-bounds-architecture', packed.buffer);
    const object = createSceneObject('imported_model', 1);
    delete object.stagingRole;
    object.modelAssetId = 'mesh';
    object.dimensions = [2, 4, 2];
    object.transform.scale = [1, 1, 1];
    const assets = {
      assets: {
        mesh: {
          id: 'mesh',
          type: 'model' as const,
          name: 'architecture.glb',
          uri: `${MODEL_ASSET_URI_PREFIX}imported-bounds-architecture`,
          storageKey: 'imported-bounds-architecture',
          createdAt: new Date(0).toISOString(),
        },
      },
    };
    const root = createImportedMeshNode(object, assets, new THREE.MeshStandardMaterial());
    const mesh = root.children[0] as THREE.Mesh;
    expect(mesh.position.y).toBe(0);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(box.max.y).toBeCloseTo(4, 5);
  });
});
