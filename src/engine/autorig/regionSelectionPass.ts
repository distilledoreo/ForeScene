import * as THREE from 'three';
import type { CanonicalAutorigTopology } from './topology';
import type { AutorigOrthoFrame } from '../autorigMarkerFrame';
import { configureAutorigOrthoCamera } from '../autorigMarkerFrame';
import {
  brushStrokeBoundingRect,
  lassoBoundingRect,
  pointHitsBrushStroke,
  pointInPolygon,
  simplifyBrushStroke,
  type BrushStrokePoint,
  type LassoPoint,
} from './regionSelection';

/**
 * Offscreen triangle-ID selection pass for posed body-part painting.
 * Encodes triangle index into RGB, depth-tests so only the visible surface is read.
 * Positions can be updated from a skinned preview without changing triangle IDs.
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
  canonicalTopology: CanonicalAutorigTopology;
  /** Deformed canonical positions (xyz per vertex). Defaults to rest. */
  posedCanonicalPositions: Float32Array;
  /** When true, the pick target is stale and must be re-rendered. */
  pickDirty: boolean;
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

function writePosedPositionsIntoGeometry(
  geometry: THREE.BufferGeometry,
  topology: CanonicalAutorigTopology,
  posed: Float32Array,
): void {
  const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const triangleCount = Math.floor(topology.triangles.length / 3);
  for (let t = 0; t < triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = topology.triangles[t * 3 + k]!;
      const dst = (t * 3 + k) * 3;
      positionAttr.array[dst] = posed[v * 3]!;
      positionAttr.array[dst + 1] = posed[v * 3 + 1]!;
      positionAttr.array[dst + 2] = posed[v * 3 + 2]!;
    }
  }
  positionAttr.needsUpdate = true;
  geometry.computeBoundingSphere();
}

/**
 * Build a non-indexed selection geometry (one unique triangle color per face).
 * Call while Pose & Fix is active; dispose afterward.
 */
export function createRegionSelectionPass(params: {
  topology: CanonicalAutorigTopology;
  width: number;
  height: number;
  /** Optional shared renderer — creates a dedicated one when omitted. */
  renderer?: THREE.WebGLRenderer;
  /** Optional initial posed positions (defaults to rest topology positions). */
  posedPositions?: Float32Array;
}): RegionSelectionPass {
  const { topology } = params;
  const triangleCount = Math.floor(topology.triangles.length / 3);
  if (triangleCount > MAX_ENCODED_TRIANGLES) {
    throw new Error('Mesh has too many triangles for RGB selection encoding.');
  }

  const posedCanonicalPositions = params.posedPositions
    ? new Float32Array(params.posedPositions)
    : new Float32Array(topology.positions);

  const positions = new Float32Array(triangleCount * 9);
  const colors = new Float32Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t += 1) {
    const [cr, cg, cb] = encodeTriangleId(t + 1); // 0 reserved for empty
    for (let k = 0; k < 3; k += 1) {
      const v = topology.triangles[t * 3 + k]!;
      const dst = (t * 3 + k) * 3;
      positions[dst] = posedCanonicalPositions[v * 3]!;
      positions[dst + 1] = posedCanonicalPositions[v * 3 + 1]!;
      positions[dst + 2] = posedCanonicalPositions[v * 3 + 2]!;
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
    canonicalTopology: topology,
    posedCanonicalPositions,
    pickDirty: true,
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

export interface AutorigPreviewMeshBindingLike {
  mesh: THREE.SkinnedMesh;
  canonicalVertexStart: number;
  vertexCount: number;
}

/**
 * Copy posed world-space vertex positions from a skinned preview into the pick pass.
 * Triangle IDs stay fixed; only deformed positions change.
 */
export function updateRegionSelectionPassFromSkinnedRoot(
  pass: RegionSelectionPass,
  root: THREE.Object3D,
  bindings?: AutorigPreviewMeshBindingLike[] | null,
): void {
  const posed = pass.posedCanonicalPositions;
  const point = new THREE.Vector3();
  root.updateMatrixWorld(true);

  if (bindings && bindings.length > 0) {
    for (const binding of bindings) {
      const { mesh, canonicalVertexStart, vertexCount } = binding;
      for (let i = 0; i < vertexCount; i += 1) {
        mesh.getVertexPosition(i, point);
        point.applyMatrix4(mesh.matrixWorld);
        const dst = (canonicalVertexStart + i) * 3;
        posed[dst] = point.x;
        posed[dst + 1] = point.y;
        posed[dst + 2] = point.z;
      }
    }
  } else {
    let vertexCursor = 0;
    root.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh && !(mesh as THREE.Mesh).isMesh) return;
      const geometry = mesh.geometry;
      if (!geometry) return;
      const position = geometry.getAttribute('position');
      if (!position) return;
      const count = position.count;
      const skinned = mesh as THREE.SkinnedMesh;
      for (let i = 0; i < count; i += 1) {
        if (skinned.isSkinnedMesh) {
          skinned.getVertexPosition(i, point);
        } else {
          point.fromBufferAttribute(position, i);
        }
        point.applyMatrix4(mesh.matrixWorld);
        const dst = (vertexCursor + i) * 3;
        if (dst + 2 < posed.length) {
          posed[dst] = point.x;
          posed[dst + 1] = point.y;
          posed[dst + 2] = point.z;
        }
      }
      vertexCursor += count;
    });
  }

  writePosedPositionsIntoGeometry(pass.geometry, pass.canonicalTopology, posed);
  pass.pickDirty = true;
}

/** Reset pick geometry to canonical rest positions. */
export function resetRegionSelectionPassToRest(pass: RegionSelectionPass): void {
  pass.posedCanonicalPositions.set(pass.canonicalTopology.positions);
  writePosedPositionsIntoGeometry(
    pass.geometry,
    pass.canonicalTopology,
    pass.posedCanonicalPositions,
  );
  pass.pickDirty = true;
}

function renderPickTarget(pass: RegionSelectionPass, frame: AutorigOrthoFrame): void {
  configureAutorigOrthoCamera(pass.camera, frame);
  pass.camera.updateMatrixWorld(true);
  const prevTarget = pass.renderer.getRenderTarget();
  pass.renderer.setRenderTarget(pass.target);
  pass.renderer.setClearColor(0x000000, 1);
  pass.renderer.clear();
  pass.renderer.render(pass.scene, pass.camera);
  pass.renderer.setRenderTarget(prevTarget);
  pass.pickDirty = false;
}

function collectTriangleIdsInRect(params: {
  pass: RegionSelectionPass;
  frame: AutorigOrthoFrame;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  acceptPixel: (px: number, py: number) => boolean;
}): Uint32Array {
  const { pass, frame } = params;
  if (pass.pickDirty) renderPickTarget(pass, frame);

  const x0 = Math.max(0, Math.floor(params.minX));
  const y0 = Math.max(0, Math.floor(params.minY));
  const x1 = Math.min(pass.width, Math.ceil(params.maxX) + 1);
  const y1 = Math.min(pass.height, Math.ceil(params.maxY) + 1);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  if (w === 0 || h === 0) return new Uint32Array(0);

  // WebGL read origin is bottom-left; canvas Y is top-down.
  const readY = pass.height - y1;
  const pixels = new Uint8Array(w * h * 4);
  pass.renderer.readRenderTargetPixels(pass.target, x0, readY, w, h, pixels);

  const hit = new Set<number>();
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      const px = x0 + col;
      const py = y1 - 1 - row;
      if (!params.acceptPixel(px + 0.5, py + 0.5)) continue;
      const i = (row * w + col) * 4;
      const id = decodeTriangleId(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      if (id <= 0 || id > pass.triangleCount) continue;
      hit.add(id - 1);
    }
  }
  return Uint32Array.from(hit);
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
  return collectTriangleIdsInRect({
    pass,
    frame,
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    acceptPixel: (px, py) => pointInPolygon(px, py, polygon),
  });
}

/**
 * Batch-read the posed ID target once for a completed brush stroke.
 * Tests each pixel against the brush polyline (not just sample centers).
 */
export function pickVisibleTrianglesAlongBrushStroke(params: {
  pass: RegionSelectionPass;
  frame: AutorigOrthoFrame;
  stroke: ReadonlyArray<BrushStrokePoint>;
}): Uint32Array {
  const { pass, frame } = params;
  const stroke = simplifyBrushStroke(params.stroke);
  if (stroke.length === 0) return new Uint32Array(0);
  const bounds = brushStrokeBoundingRect(stroke);
  if (!bounds) return new Uint32Array(0);
  return collectTriangleIdsInRect({
    pass,
    frame,
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    acceptPixel: (px, py) => pointHitsBrushStroke(px, py, stroke),
  });
}

/** Force a fresh pick render on the next read (after pose / camera / weight changes). */
export function invalidateRegionSelectionPick(pass: RegionSelectionPass | null | undefined): void {
  if (pass) pass.pickDirty = true;
}
