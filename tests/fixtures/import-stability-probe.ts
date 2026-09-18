import * as THREE from 'three';
import { sourceFixture } from './source-model-fixture';
import { importModelJob } from '../../src/engine/modelImport';
import { createDefaultProject, createCameraData } from '../../src/domain/defaults';
import { buildScene, disposeScene } from '../../src/engine/sceneObjects';
import { renderViewportClay } from '../../src/engine/renderers';
import { renderViewportDepth } from '../../src/engine/depthRender';
import { SCENE_DEPTH_PRECISION } from '../../src/engine/rendererPrecision';
import { resetSourceModelRuntimeForTests } from '../../src/engine/sourceModelRuntime';
import { resetModelAssetStoreForTests } from '../../src/engine/modelAssetStore';

interface SurfacePixels { red: number; blue: number }
export interface ImportStabilityResult {
  ordinary: SurfacePixels[];
  stable: SurfacePixels[];
  exported: SurfacePixels;
  metricDepth: number;
  meshCount: number;
}
function count(data: Uint8Array | Uint8ClampedArray): SurfacePixels {
  let red = 0; let blue = 0;
  for (let y = 32; y < 96; y++) for (let x = 32; x < 96; x++) {
    const i = (y * 128 + x) * 4;
    if (data[i + 2] > data[i] + 40) blue++;
    if (data[i] > data[i + 2] + 40) red++;
  }
  return { red, blue };
}

/** Two authored layers 3 mm apart, 200 m from a camera with a close near plane. */
export async function probe(): Promise<ImportStabilityResult> {
  const d = sourceFixture().document;
  d.nodes[0].translation = [0, 0, 0];
  d.nodes[1].translation = [0, 0, 0]; d.nodes[1].scale = [60, 60, 1];
  d.nodes[2].translation = [0, 0, -0.003]; d.nodes[2].scale = [60, 60, 1]; d.nodes[2].mesh = 1;
  d.meshes[0].weights = [0];
  d.meshes.push({ ...d.meshes[0], primitives: d.meshes[0].primitives.map((p) => ({ ...p, material: 1 })) });
  d.materials[0].pbrMetallicRoughness.baseColorFactor = [1, 0, 0, 1];
  d.materials.push({ ...d.materials[0], pbrMetallicRoughness: { ...d.materials[0].pbrMetallicRoughness, baseColorFactor: [0, 0, 1, 1] } });
  const json = new TextEncoder().encode(JSON.stringify(d));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(20 + paddedLength); const view = new DataView(bytes);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true); view.setUint32(12, paddedLength, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20).fill(32); new Uint8Array(bytes, 20, json.length).set(json);
  const batch = await importModelJob({ kind: 'file', file: new File([bytes], 'thin-panels.glb') }, { mode: 'separate' });
  const project = createDefaultProject(); project.scene.objects = batch.items.map((item) => item.object);
  batch.items.forEach((item) => { project.assets.assets[item.asset.id] = item.asset; });
  const scene = buildScene(project, { showGrid: false, showHelpers: false, fog: false });
  let meshCount = 0; scene.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshCount++; });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
  const sample = (precision: THREE.WebGLRendererParameters): SurfacePixels[] => {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, ...precision });
    try {
      renderer.setSize(128, 128); renderer.outputColorSpace = THREE.SRGBColorSpace;
      const gl = renderer.getContext(); const samples: SurfacePixels[] = [];
      for (let i = 0; i < 8; i++) {
        camera.position.set(3 + i * 0.003, 2, 200); camera.lookAt(0, 0, 0);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(128 * 128 * 4);
        gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        samples.push(count(pixels));
      }
      return samples;
    } finally { renderer.dispose(); renderer.forceContextLoss(); }
  };
  try {
    const ordinary = sample({ logarithmicDepthBuffer: false });
    const stable = sample(SCENE_DEPTH_PRECISION);
    const cameraData = { ...createCameraData([3, 2, 200], [0, 0, 0], 50), near: 0.01, far: 10000 };
    const exported = await renderViewportClay(project, cameraData, 128, 128);
    const image = new Image(); image.src = exported.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D unavailable.');
    context.drawImage(image, 0, 0);
    const depth = await renderViewportDepth(project, cameraData, 128, 128, { includeMetricDepth: true });
    return { ordinary, stable, meshCount, exported: count(context.getImageData(0, 0, 128, 128).data), metricDepth: depth.metricDepthMeters?.[64 * 128 + 64] ?? 0 };
  } finally {
    disposeScene(scene); resetSourceModelRuntimeForTests(); resetModelAssetStoreForTests();
  }
}
