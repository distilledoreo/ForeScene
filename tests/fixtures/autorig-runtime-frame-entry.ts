import * as THREE from 'three';
import { prepareCanonicalAutorigMesh } from '../../src/engine/autorigCanonicalMesh';
import { getOrBuildSkinnedPrototype } from '../../src/engine/autorigSkinnedMesh';
const source = new THREE.Mesh(new THREE.BoxGeometry(1, 2, .4), new THREE.MeshBasicMaterial({ color: 'white' }));
const canonical = prepareCanonicalAutorigMesh({ source, orientation: { frontAxis: '+z', upAxis: '+y', groundLevelMeters: 0 }, targetHeightMeters: 2 });
const count = source.geometry.getAttribute('position').count;
const prototype = getOrBuildSkinnedPrototype({ cacheKey: 'pixel-proof', template: canonical.root,
  rig: { version: 1, id: 'rig', skeletonJoints: ['hips'], bindMatrices: { hips: new THREE.Matrix4().makeTranslation(0, 1, 0).toArray() } },
  buffers: { influencesPerVertex: 4, jointOrder: ['hips'], indices: new Uint16Array(count * 4), weights: Float32Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0) },
  referenceHeight: 2, centerForSceneObject: true,
});
prototype.root.traverse(node => { if ((node as THREE.Bone).isBone) node.rotation.z = Math.PI / 2; });
source.rotation.z = Math.PI / 2;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(64, 64); renderer.setClearColor(0, 1);
const target = new THREE.WebGLRenderTarget(64, 64);
const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 10); camera.position.z = 5;
function pixels(object: THREE.Object3D) {
  const scene = new THREE.Scene(); scene.add(object); scene.updateMatrixWorld(true);
  renderer.setRenderTarget(target); renderer.render(scene, camera);
  const result = new Uint8Array(64 * 64 * 4); renderer.readRenderTargetPixels(target, 0, 0, 64, 64, result); return result;
}
const posed = pixels(prototype.root), expected = pixels(source);
let mismatches = 0, filled = 0;
for (let i = 0; i < posed.length; i += 4) { if (posed[i] > 0) filled++; if (posed[i] !== expected[i]) mismatches++; }
(window as unknown as { __AUTORIG_FRAME__: unknown }).__AUTORIG_FRAME__ = { mismatches, filled };
renderer.dispose(); target.dispose();
