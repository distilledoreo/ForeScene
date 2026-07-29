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
 *
 * Important: callers may remount this on the same canvas (React Strict Mode). Do not
 * force-lose the context on dispose — that permanently paints Chrome's "sad face"
 * on the element and blocks a replacement WebGLRenderer.
 */
export function createAutorigMarkerPreviewGl(params: {
  width: number;
  height: number;
  canvas?: HTMLCanvasElement;
}): AutorigMarkerPreviewGl {
  const canvas = params.canvas ?? document.createElement('canvas');
  // A previously lost context leaves the canvas unusable; swap to a fresh node.
  if (typeof (canvas as HTMLCanvasElement & { isContextLost?: () => boolean }).isContextLost === 'function'
    && (canvas as HTMLCanvasElement & { isContextLost: () => boolean }).isContextLost()) {
    throw new Error('Autorig marker preview canvas context was lost; provide a fresh canvas.');
  }
  canvas.width = params.width;
  canvas.height = params.height;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    const context = renderer.getContext();
    if (!context || (typeof (context as WebGLRenderingContext).isContextLost === 'function'
      && (context as WebGLRenderingContext).isContextLost())) {
      renderer.dispose();
      throw new Error('Autorig marker preview WebGL context is unavailable.');
    }
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Autorig marker preview WebGL context is unavailable.');
  }
  renderer.setPixelRatio(1);
  renderer.setSize(params.width, params.height, false);
  // Opaque charcoal clear — transparent clear showed a blank white surface panel
  // when the mesh had not drawn yet or the context flickered.
  renderer.setClearColor(0x1c1f26, 1);

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
  if (!gl.renderer.getContext()) return;
  try {
    configureAutorigOrthoCamera(gl.camera, frame);
    gl.renderer.render(gl.scene, gl.camera);
    gl.renderCount += 1;
  } catch {
    // Context loss mid-frame must not tear down the host Build workspace.
  }
}

/**
 * Dispose renderer resources. Safe to call multiple times.
 * Does **not** call WEBGL_lose_context — forcing loss permanently marks the
 * canvas with Chrome's context-lost glyph and blocks Strict Mode remounts on
 * the same element. GPU memory is released by dispose() alone for this
 * short-lived wizard preview.
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
  gl.renderCount = 0;
}

/** Replace a poisoned (context-lost) canvas with a fresh one in the same parent. */
export function replaceAutorigMarkerPreviewCanvas(
  oldCanvas: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const next = document.createElement('canvas');
  next.width = width;
  next.height = height;
  next.className = oldCanvas.className;
  for (const attr of oldCanvas.getAttributeNames()) {
    if (attr === 'width' || attr === 'height') continue;
    const value = oldCanvas.getAttribute(attr);
    if (value !== null) next.setAttribute(attr, value);
  }
  oldCanvas.parentElement?.replaceChild(next, oldCanvas);
  return next;
}
