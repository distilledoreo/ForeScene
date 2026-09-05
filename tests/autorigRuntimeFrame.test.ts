import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { PoseableRigAsset, SceneObject } from '../src/domain/types';
import { captureAutorigRestTransform, prepareAutorigBindMesh, prepareCanonicalAutorigMesh, extractCanonicalVertexPositions } from '../src/engine/autorigCanonicalMesh';
import { createAutoriggedPoseableCharacterShell, setAutorigSourceTemplateForTests, resetAutoriggedCharacterTemplatesForTests } from '../src/engine/autoriggedPoseableCharacter';
import { ensureSkeletonCloneReady, resetAutorigRuntimeCachesForTests } from '../src/engine/autorigSkinnedMesh';

afterEach(() => { resetAutorigRuntimeCachesForTests(); resetAutoriggedCharacterTemplatesForTests(); });

describe('saved rig coordinate frame', () => {
  it.each([false, true])('rotates vertices about their saved bone pivot after scene centering (saved transform=%s)', async (saved) => {
    const source = new THREE.Mesh(new THREE.BoxGeometry(1, 2, .4));
    const canonical = prepareCanonicalAutorigMesh({ source, orientation: { frontAxis: '+z', upAxis: '+y', groundLevelMeters: 0 }, targetHeightMeters: 2 });
    const count = source.geometry.getAttribute('position').count;
    const rig: PoseableRigAsset = { version: 1, id: 'frame-rig', skeletonJoints: ['hips'],
      bindMatrices: { hips: new THREE.Matrix4().makeTranslation(0, 1, 0).toArray() },
      generationSettings: { approximateHeightMeters: saved ? 9 : 2 },
      ...(saved ? { restTransform: captureAutorigRestTransform(canonical.root) } : {}),
      skin: { influencesPerVertex: 4, indices: new Array(count * 4).fill(0), weights: Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0) },
    };
    setAutorigSourceTemplateForTests('source', source);
    await ensureSkeletonCloneReady();
    const shell = createAutoriggedPoseableCharacterShell({ assetId: 'asset', rigId: rig.id, sourceAssetId: 'source', rig, approximateHeightMeters: rig.generationSettings!.approximateHeightMeters });
    const object = { id: 'actor', name: 'actor', dimensions: [1, 2, .4], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } as SceneObject;
    const instance = shell.createInstance(object, new THREE.MeshStandardMaterial());
    let mesh!: THREE.SkinnedMesh; let bone!: THREE.Bone;
    instance.traverse(n => { if ((n as THREE.SkinnedMesh).isSkinnedMesh) mesh = n as THREE.SkinnedMesh; if ((n as THREE.Bone).isBone) bone = n as THREE.Bone; });
    expect(mesh).toBeDefined();
    bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    instance.updateMatrixWorld(true); mesh.skeleton.update();
    const actual = mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    const expected = new THREE.Vector3().fromBufferAttribute(source.geometry.getAttribute('position'), 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    expect(actual.distanceTo(expected)).toBeLessThan(1e-5);
  });
  it('round trips the wizard source transform rather than refitting saved vertices', () => {
    const source = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 1));
    source.position.set(3, -2, 4);
    const preview = prepareCanonicalAutorigMesh({ source, orientation: { frontAxis: '+x', upAxis: '+y', groundLevelMeters: .3 }, targetHeightMeters: 2 });
    preview.root.position.x += .7; preview.root.rotateY(.2); preview.root.scale.z *= 1.2;
    const rig: PoseableRigAsset = { version: 1, id: 'saved', skeletonJoints: [], restTransform: captureAutorigRestTransform(preview.root), generationSettings: { approximateHeightMeters: 8 } };
    const restored = prepareAutorigBindMesh(source, rig);
    const a = extractCanonicalVertexPositions(preview.root), b = extractCanonicalVertexPositions(restored.root);
    expect(b.length).toBe(a.length);
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 5));
  });
});
