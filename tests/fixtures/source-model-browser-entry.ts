import * as THREE from 'three';
import { sourceFixtureGlb, sourceFixture } from './source-model-fixture';
import { createDefaultProject, createCameraData, defaultProjectedStyleSettings } from '../../src/domain/defaults';
import { importModelJob } from '../../src/engine/modelImport';
import { createObject3D, disposeScene, buildScene } from '../../src/engine/sceneObjects';
import { createProjectPackage, readProjectFile } from '../../src/engine/projectIO';
import { ensureSourceModelsForProject, resetSourceModelRuntimeForTests } from '../../src/engine/sourceModelRuntime';
import { resetModelAssetStoreForTests } from '../../src/engine/modelAssetStore';
import { renderViewportDepth } from '../../src/engine/depthRender';
import { renderViewportClay } from '../../src/engine/renderers';
import { createProjectedStyleMaterial } from '../../src/engine/projectedStyleMaterials';
import { generateProjectorOcclusionMap } from '../../src/engine/projectorOcclusion';

function requireTest(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function runSourceModelBrowserGate() {
  const passed: string[] = [];
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(128, 128); renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0,0,5); camera.lookAt(0,0,0);
  const live: THREE.Scene[] = [];
  const pixels = (scene: THREE.Scene) => {
    renderer.render(scene, camera);
    const data = new Uint8Array(128 * 128 * 4);
    renderer.getContext().readPixels(0,0,128,128,renderer.getContext().RGBA,renderer.getContext().UNSIGNED_BYTE,data);
    return data;
  };
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
  const project = createDefaultProject(); project.scene.objects = [];
  const texture = new THREE.DataTexture(new Uint8Array([0,255,255,255, 255,0,255,255]), 2,1);
  texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
  try {
    const batch = await importModelJob({ kind: 'file', file: new File([sourceFixtureGlb({ texture: true })], 'painted.glb') }, { mode: 'separate' });
    project.scene.objects = batch.items.map((item) => item.object);
    batch.items.forEach((item) => { project.assets.assets[item.asset.id] = item.asset; });
    const scene = new THREE.Scene(); live.push(scene);
    const root = createObject3D(project.scene.objects[0], false, 'light', project.assets); scene.add(root);
    const meshes: THREE.Mesh[] = []; root.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
    const map = (meshes[0].material as THREE.MeshBasicMaterial).map;
    requireTest(map?.image && (map.image as { width: number }).width === 2, 'Embedded PNG was not decoded into a real texture.');
    const before = pixels(scene);
    const screenshot = renderer.domElement.toDataURL('image/png');
    let red = 0, blue = 0, green = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] > 180 && before[i+1] < 120 && before[i+2] < 120) red += 1;
      if (before[i+2] > 180 && before[i] < 120 && before[i+1] < 120) blue += 1;
      if (before[i+1] > 180 && before[i] < 120 && before[i+2] < 120) green += 1;
    }
    requireTest(red > 50 && green > 50 && blue > 50, `Texture pixels missing (red ${red}, green ${green}, blue ${blue}).`);
    passed.push('embedded texture pixels render in original UV coordinates');
    const alternate = new THREE.Scene(); live.push(alternate);
    alternate.add(createObject3D({ ...project.scene.objects[0], surfaceStyle: 'checkerboard' }, false, 'light', project.assets));
    alternate.add(new THREE.AmbientLight(0xffffff, 2)); pixels(alternate);
    disposeScene(alternate); live.splice(live.indexOf(alternate),1);
    requireTest(same(before, pixels(scene)), 'Other scene cleanup corrupted a shared texture or geometry.');
    passed.push('material overrides and scene cleanup leave original textured rendering unchanged');
    const archive = await createProjectPackage(project);
    live.splice(0).forEach(disposeScene);
    resetSourceModelRuntimeForTests(); resetModelAssetStoreForTests();
    const reopened = await readProjectFile(new File([archive], 'painted.fsp'));
    await ensureSourceModelsForProject(reopened);
    const restored = new THREE.Scene(); live.push(restored);
    restored.add(createObject3D(reopened.scene.objects[0], false, 'light', reopened.assets));
    requireTest(same(before, pixels(restored)), 'Save/fresh-cache/reopen changed texture pixels.');
    passed.push('fresh-cache .fsp round trip restores identical textured pixels');
    const cameraData = createCameraData([0,0,5], [0,0,0], 50);
    const exported = await renderViewportClay(reopened, cameraData, 128, 128);
    requireTest(exported.dataUrl.startsWith('data:image/png'), 'Viewport export did not produce PNG.');
    const depth = await renderViewportDepth(reopened, cameraData, 128, 128, { includeMetricDepth: true });
    requireTest(depth.metricDepthMeters?.some((value) => value > 0), 'Depth export missed source geometry.');
    passed.push('authored viewport and metric depth exports include source geometry');
    for (const kind of ['instanced', 'skinned'] as const) {
      const imported = await importModelJob({ kind: 'file', file: new File([sourceFixtureGlb({ [kind]: true })], `${kind}.glb`) }, { mode: 'combined' });
      const projectedProject = createDefaultProject(); projectedProject.scene.objects = imported.items.map((item) => item.object);
      imported.items.forEach((item) => { projectedProject.assets.assets[item.asset.id] = item.asset; });
      const projected = new THREE.Scene(); live.push(projected);
      const object = createObject3D(projectedProject.scene.objects[0], false, 'light', projectedProject.assets);
      const material = createProjectedStyleMaterial({ texture, origin: [0,0,5], rotation: [0,0,0], settings: { ...defaultProjectedStyleSettings }, fallbackColor: 0x888888, disposable: true });
      object.traverse((node) => { if ((node as THREE.Mesh).isMesh) (node as THREE.Mesh).material = material; });
      projected.add(object, new THREE.AmbientLight(0xffffff, 2)); pixels(projected);
      const occlusion = generateProjectorOcclusionMap(renderer, projectedProject, [0,0,5], { faceSize: 32 });
      occlusion.dispose();
      const metric = await renderViewportDepth(projectedProject, cameraData,128,128,{ includeMetricDepth: true });
      requireTest(metric.metricDepthMeters?.some((value) => value > 0), `${kind} depth is empty.`);
      passed.push(`${kind} source projection, occlusion and metric depth shaders render`);
    }
    // A missing image must be an import failure, even though GLTFLoader normally catches texture errors.
    const bad = sourceFixture({ texture: true }); bad.document.images![0].uri = 'missing.png';
    let rejected = false;
    try { await importModelJob({ kind: 'file', file: new File([JSON.stringify(bad.document)], 'missing.gltf') }, { mode:'combined' }); }
    catch (error) { rejected = /companion|resource/i.test(String(error)); }
    requireTest(rejected, 'Missing image was silently replaced by a plain material.');
    passed.push('missing texture dependencies fail explicitly instead of degrading silently');
    return { passed, texturePixels: { red, green, blue }, screenshot };
  } finally {
    live.splice(0).forEach(disposeScene); texture.dispose(); renderer.dispose(); renderer.forceContextLoss();
    resetSourceModelRuntimeForTests(); resetModelAssetStoreForTests();
  }
}
