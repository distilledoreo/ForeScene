import * as THREE from 'three';
import type { CanonicalAutorigTopology } from './topology';
import type { AutorigOrthoFrame } from '../autorigMarkerFrame';
import { configureAutorigOrthoCamera } from '../autorigMarkerFrame';
import { lassoBoundingRect, pointInPolygon, type LassoPoint } from './regionSelection';

/**
 * Offscreen triangle-ID selection pass for body-part lasso.
 * Encodes triangle index into RGB, depth-tests so only the visible surface is read.
 */

const MAX_ENCODED_TRIANGLES = 256 * 256 * 256 - 1;

export interface RegionSelectionPass {
  renderer: THREE.WebGLRenderer;
  target: THREE.WebGLRenderTarget;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  triangleCount: number;
  width: number;
  height: number;
}

const selectionVertexShader = /* glsl */ `
attribute vec3 triangleColor;
varying vec3 vTriangleColor;
void main() {
  vTriangleColor = triangleColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const selectionFragmentShader = /* glsl */ `
varying vec3 vTriangleColor;
void main() {
  gl_FragColor = vec4(vTriangleColor, 1.0);
}
`;

function encodeTriangleId(id: number): [number, number, number] {
  const r = (id & 255) / 255;
  const g = ((id >> 8) & 255) / 255;
  const b = ((id >> 16) & 255) / 255;
  return [r, g, b];
}

function decodeTriangleId(r: number, g: number, b: number): number {
  return (r & 255) + ((g & 255) << 8) + ((b & 255) << 16);
}

/**
 * Build a non-indexed selection geometry (one unique triangle color per face).
 * Call only while the Body Parts stage is active; dispose afterward.
 */
export function createRegionSelectionPass(params: {
  topology: CanonicalAutorigTopology;
  width: number;
  height: number;
  /** Optional shared renderer — creates a dedicated one when omitted. */
  renderer?: THREE.WebGLRenderer;
}): RegionSelectionPass {
  const { topology } = params;
  const triangleCount = Math.floor(topology.triangles.length / 3);
  if (triangleCount > MAX_ENCODED_TRIANGLES) {
    throw new Error('Mesh has too many triangles for RGB selection encoding.');
  }

  const positions = new Float32Array(triangleCount * 9);
  const colors = new Float32Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t += 1) {
    const [cr, cg, cb] = encodeTriangleId(t + 1); // 0 reserved for empty
    for (let k = 0; k < 3; k += 1) {
      const v = topology.triangles[t * 3 + k]!;
      const dst = (t * 3 + k) * 3;
      positions[dst] = topology.positions[v * 3]!;
      positions[dst + 1] = topology.positions[v * 3 + 1]!;
      positions[dst + 2] = topology.positions[v * 3 + 2]!;
      colors[dst] = cr;
      colors[dst + 1] = cg;
      colors[dst + 2] = cb;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('triangleColor', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.ShaderMaterial({
    vertexShader: selectionVertexShader,
    fragmentShader: selectionFragmentShader,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Scene();
  scene.add(mesh);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 100);

  let renderer = params.renderer;
  let ownsRenderer = false;
  if (!renderer) {
    // Headless/offscreen canvas for the pick pass when no shared renderer is provided.
    const canvas = typeof document !== 'undefined'
      ? document.createElement('canvas')
      : undefined;
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    ownsRenderer = true;
  }
  renderer.setSize(params.width, params.height, false);

  const target = new THREE.WebGLRenderTarget(params.width, params.height, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const pass: RegionSelectionPass & { ownsRenderer?: boolean } = {
    renderer,
    target,
    scene,
    camera,
    mesh,
    geometry,
    material,
    triangleCount,
    width: params.width,
    height: params.height,
  };
  if (ownsRenderer) pass.ownsRenderer = true;
  return pass;
}

export function disposeRegionSelectionPass(pass: RegionSelectionPass | null | undefined): void {
  if (!pass) return;
  pass.geometry.dispose();
  pass.material.dispose();
  pass.target.dispose();
  if ((pass as RegionSelectionPass & { ownsRenderer?: boolean }).ownsRenderer) {
    pass.renderer.dispose();
  }
}

/**
 * Render the selection pass and read triangle IDs inside the lasso bounds.
 * Returns 0-based triangle indices (encoding used 1-based colors).
 */
export function pickVisibleTrianglesInLasso(params: {
  pass: RegionSelectionPass;
  frame: AutorigOrthoFrame;
  polygon: ReadonlyArray<LassoPoint>;
}): Uint32Array {
  const { pass, frame, polygon } = params;
  if (polygon.length < 3) return new Uint32Array(0);
  const bounds = lassoBoundingRect(polygon);
  if (!bounds) return new Uint32Array(0);

  configureAutorigOrthoCamera(pass.camera, frame);
  pass.camera.updateMatrixWorld(true);

  const prevTarget = pass.renderer.getRenderTarget();
  pass.renderer.setRenderTarget(pass.target);
  pass.renderer.setClearColor(0x000000, 1);
  pass.renderer.clear();
  pass.renderer.render(pass.scene, pass.camera);
  pass.renderer.setRenderTarget(prevTarget);

  const x0 = Math.max(0, Math.floor(bounds.minX));
  const y0 = Math.max(0, Math.floor(bounds.minY));
  const x1 = Math.min(pass.width, Math.ceil(bounds.maxX) + 1);
  const y1 = Math.min(pass.height, Math.ceil(bounds.maxY) + 1);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  if (w === 0 || h === 0) return new Uint32Array(0);

  // WebGL read origin is bottom-left; canvas / lasso Y is top-down.
  const readY = pass.height - y1;
  const pixels = new Uint8Array(w * h * 4);
  pass.renderer.readRenderTargetPixels(pass.target, x0, readY, w, h, pixels);

  const hit = new Set<number>();
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      const px = x0 + col;
      // Convert read-buffer row back to canvas Y.
      const py = y1 - 1 - row;
      if (!pointInPolygon(px + 0.5, py + 0.5, polygon)) continue;
      const i = (row * w + col) * 4;
      const id = decodeTriangleId(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      if (id <= 0 || id > pass.triangleCount) continue;
      hit.add(id - 1);
    }
  }
  return Uint32Array.from(hit);
}
