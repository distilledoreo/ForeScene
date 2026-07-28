import * as THREE from 'three';
import type { AutorigOrthoFrame } from './autorigMarkerFrame';
import { configureAutorigOrthoCamera } from './autorigMarkerFrame';

export interface AutorigMarkerPreviewGl {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  root: THREE.Object3D | null;
  /** Count of on-demand render() calls (tests / diagnostics). */
  renderCount: number;
  /** Always false for this preview — no continuous rAF loop. */
  hasContinuousLoop: boolean;
}

/**
 * Create a demand-only WebGL preview stack for the marker wizard.
 * Does **not** start a continuous animation loop; call `renderAutorigMarkerPreview` explicitly.
 */
export function createAutorigMarkerPreviewGl(params: {
  width: number;
  height: number;
  canvas?: HTMLCanvasElement;
}): AutorigMarkerPreviewGl {
  const canvas = params.canvas ?? document.createElement('canvas');
  canvas.width = params.width;
  canvas.height = params.height;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(params.width, params.height, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const ambient = new THREE.AmbientLight(0xffffff, 0.72);
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(2.5, 4, 3);
  scene.add(ambient);
  scene.add(key);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 100);
  return {
    canvas,
    renderer,
    scene,
    camera,
    root: null,
    renderCount: 0,
    hasContinuousLoop: false,
  };
}

export function setAutorigMarkerPreviewRoot(
  gl: AutorigMarkerPreviewGl,
  root: THREE.Object3D | null,
): void {
  if (gl.root) {
    gl.scene.remove(gl.root);
  }
  gl.root = root;
  if (root) gl.scene.add(root);
}

export function resizeAutorigMarkerPreviewGl(
  gl: AutorigMarkerPreviewGl,
  width: number,
  height: number,
): void {
  gl.canvas.width = width;
  gl.canvas.height = height;
  gl.renderer.setSize(width, height, false);
}

/** Single on-demand frame — never schedules rAF. */
export function renderAutorigMarkerPreview(
  gl: AutorigMarkerPreviewGl,
  frame: AutorigOrthoFrame,
): void {
  configureAutorigOrthoCamera(gl.camera, frame);
  gl.renderer.render(gl.scene, gl.camera);
  gl.renderCount += 1;
}

/**
 * Dispose renderer + release WebGL context. Safe to call multiple times.
 * Does not dispose shared template geometries (preview uses cloned meshes with own materials).
 */
export function disposeAutorigMarkerPreviewGl(gl: AutorigMarkerPreviewGl | null | undefined): void {
  if (!gl) return;
  if (gl.root) {
    gl.scene.remove(gl.root);
    gl.root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Preview materials are owned by this instance (not SHARED_MATERIALS).
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        material?.dispose();
      }
      // Do not dispose geometry: createAutorigPreviewInstance clones template meshes
      // with shared geometry references from the source template cache.
    });
    gl.root = null;
  }
  gl.renderer.dispose();
  const lose = gl.renderer.getContext()?.getExtension?.('WEBGL_lose_context');
  lose?.loseContext();
  gl.renderCount = 0;
}
