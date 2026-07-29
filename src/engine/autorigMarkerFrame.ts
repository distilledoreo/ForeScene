import * as THREE from 'three';
import type { Vec3 } from '../domain/types';

export type AutorigMarkerView = 'front' | 'side' | 'back';

/** Axis-aligned bounds of the oriented, scaled, grounded preview mesh (world meters). */
export interface OrientedMeshBounds {
  min: Vec3;
  max: Vec3;
}

/**
 * Shared orthographic window used by both the 2D marker canvas and the WebGL mesh layer.
 * Horizontal axis is world X (front), −X (back), or world Z (side); vertical is always world Y.
 */
export interface AutorigOrthoFrame {
  view: AutorigMarkerView;
  horizMin: number;
  horizMax: number;
  vertMin: number;
  vertMax: number;
  depthMin: number;
  depthMax: number;
  marginPx: number;
  canvasWidth: number;
  canvasHeight: number;
}

export function horizontalWorldComponent(position: Vec3, view: AutorigMarkerView): number {
  if (view === 'front') return position[0];
  if (view === 'back') return -position[0];
  return position[2];
}

/**
 * Build one orthographic frame from actual oriented mesh bounds.
 * When bounds are missing, falls back to a height-based window (legacy marker-only behaviour).
 */
export function computeAutorigOrthoFrame(params: {
  bounds?: OrientedMeshBounds | null;
  view: AutorigMarkerView;
  canvasWidth: number;
  canvasHeight: number;
  marginPx?: number;
  /** Extra padding as a fraction of each axis span (default 0.08). */
  paddingFraction?: number;
  fallbackHeightMeters?: number;
}): AutorigOrthoFrame {
  const marginPx = params.marginPx ?? 24;
  const pad = params.paddingFraction ?? 0.08;
  const fallbackH = Math.max(params.fallbackHeightMeters ?? 1.75, 0.5);

  let horizMin: number;
  let horizMax: number;
  let vertMin: number;
  let vertMax: number;
  let depthMin: number;
  let depthMax: number;

  if (params.bounds) {
    const { min, max } = params.bounds;
    if (params.view === 'front') {
      horizMin = min[0];
      horizMax = max[0];
      vertMin = min[1];
      vertMax = max[1];
      depthMin = min[2];
      depthMax = max[2];
    } else if (params.view === 'back') {
      // Negate X so canvas mapping matches the behind-camera projection.
      horizMin = -max[0];
      horizMax = -min[0];
      vertMin = min[1];
      vertMax = max[1];
      depthMin = min[2];
      depthMax = max[2];
    } else {
      horizMin = min[2];
      horizMax = max[2];
      vertMin = min[1];
      vertMax = max[1];
      depthMin = min[0];
      depthMax = max[0];
    }
  } else {
    // Legacy assumed body: span from ground up, centered on origin horizontally.
    const span = Math.max(fallbackH * 1.15, 1);
    horizMin = -span * 0.5;
    horizMax = span * 0.5;
    vertMin = 0;
    vertMax = span;
    depthMin = -span * 0.5;
    depthMax = span * 0.5;
  }

  const hw = Math.max(horizMax - horizMin, 1e-4);
  const hh = Math.max(vertMax - vertMin, 1e-4);
  horizMin -= hw * pad;
  horizMax += hw * pad;
  vertMin -= hh * pad;
  vertMax += hh * pad;

  // Fit usable canvas aspect so mesh + markers are not stretched.
  const usableW = Math.max(params.canvasWidth - marginPx * 2, 1);
  const usableH = Math.max(params.canvasHeight - marginPx * 2, 1);
  const canvasAspect = usableW / usableH;
  let worldW = horizMax - horizMin;
  let worldH = vertMax - vertMin;
  const worldAspect = worldW / Math.max(worldH, 1e-6);
  if (worldAspect > canvasAspect) {
    const targetH = worldW / canvasAspect;
    const cy = (vertMin + vertMax) * 0.5;
    vertMin = cy - targetH * 0.5;
    vertMax = cy + targetH * 0.5;
  } else {
    const targetW = worldH * canvasAspect;
    const cx = (horizMin + horizMax) * 0.5;
    horizMin = cx - targetW * 0.5;
    horizMax = cx + targetW * 0.5;
  }

  // Ensure depth has a usable near/far thickness.
  if (Math.abs(depthMax - depthMin) < 1e-3) {
    const mid = (depthMin + depthMax) * 0.5;
    depthMin = mid - 0.5;
    depthMax = mid + 0.5;
  }

  return {
    view: params.view,
    horizMin,
    horizMax,
    vertMin,
    vertMax,
    depthMin,
    depthMax,
    marginPx,
    canvasWidth: params.canvasWidth,
    canvasHeight: params.canvasHeight,
  };
}

/** Project a world-space joint/mesh point into canvas pixels (Y-down). */
export function worldToCanvas(position: Vec3, frame: AutorigOrthoFrame): { x: number; y: number } {
  const xWorld = horizontalWorldComponent(position, frame.view);
  const yWorld = position[1];
  const usableW = Math.max(frame.canvasWidth - frame.marginPx * 2, 1);
  const usableH = Math.max(frame.canvasHeight - frame.marginPx * 2, 1);
  const worldW = Math.max(frame.horizMax - frame.horizMin, 1e-6);
  const worldH = Math.max(frame.vertMax - frame.vertMin, 1e-6);
  const nx = (xWorld - frame.horizMin) / worldW;
  const ny = (yWorld - frame.vertMin) / worldH;
  return {
    x: frame.marginPx + nx * usableW,
    y: frame.marginPx + (1 - ny) * usableH,
  };
}

/**
 * Inverse of worldToCanvas.
 * - Front: edits lateral X and height Y; preserves depth Z from `current`.
 * - Back: edits lateral X (via −X mapping) and height Y; preserves depth Z.
 * - Side: edits depth Z only; preserves X and Y so Front placements stay intact.
 */
export function canvasToWorld(
  x: number,
  y: number,
  frame: AutorigOrthoFrame,
  current: Vec3,
): Vec3 {
  const usableW = Math.max(frame.canvasWidth - frame.marginPx * 2, 1);
  const usableH = Math.max(frame.canvasHeight - frame.marginPx * 2, 1);
  const worldW = Math.max(frame.horizMax - frame.horizMin, 1e-6);
  const worldH = Math.max(frame.vertMax - frame.vertMin, 1e-6);
  const nx = (x - frame.marginPx) / usableW;
  const ny = 1 - (y - frame.marginPx) / usableH;
  const xWorld = frame.horizMin + nx * worldW;
  const yWorld = frame.vertMin + ny * worldH;
  if (frame.view === 'front') return [xWorld, yWorld, current[2]];
  if (frame.view === 'back') return [-xWorld, yWorld, current[2]];
  // Side view is depth-only: horizontal canvas maps to world Z.
  return [current[0], current[1], xWorld];
}

/**
 * Configure a Three.js orthographic camera so its projection matches `frame`
 * (same world↔pixel mapping as worldToCanvas).
 */
export function configureAutorigOrthoCamera(
  camera: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    near: number;
    far: number;
    position: { set: (x: number, y: number, z: number) => void };
    up: { set: (x: number, y: number, z: number) => void };
    lookAt: (x: number, y: number, z: number) => void;
    updateProjectionMatrix: () => void;
  },
  frame: AutorigOrthoFrame,
): void {
  const halfW = (frame.horizMax - frame.horizMin) * 0.5;
  const halfH = (frame.vertMax - frame.vertMin) * 0.5;
  const midH = (frame.horizMin + frame.horizMax) * 0.5;
  const midV = (frame.vertMin + frame.vertMax) * 0.5;
  const midD = (frame.depthMin + frame.depthMax) * 0.5;
  const depthSpan = Math.max(Math.abs(frame.depthMax - frame.depthMin), 1);
  const eyePad = depthSpan + 2;

  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.near = 0.05;
  camera.far = depthSpan * 4 + 20;
  camera.up.set(0, 1, 0);

  if (frame.view === 'front') {
    // Looking −Z from +Z: local +X = world +X, local +Y = world +Y
    // (matches worldToCanvas: larger X → larger canvas X).
    camera.position.set(midH, midV, frame.depthMax + eyePad);
    camera.lookAt(midH, midV, midD);
  } else if (frame.view === 'back') {
    // Looking +Z from −Z. Frame horiz is −X, so midH = −avgX → world X = −midH.
    const worldX = -midH;
    camera.position.set(worldX, midV, frame.depthMin - eyePad);
    camera.lookAt(worldX, midV, midD);
  } else {
    // Looking +X from −X: Three.js local +X becomes world +Z
    // (matches worldToCanvas: larger Z → larger canvas X). Eye on +X looking −X
    // would flip the mesh horizontally relative to markers.
    camera.position.set(frame.depthMin - eyePad, midV, midH);
    camera.lookAt(midD, midV, midH);
  }
  camera.updateProjectionMatrix();
}

/**
 * Project a world point with the same orthographic camera configuration used by the mesh layer.
 * Returns NDC in [-1, 1] (Three.js clip space after projection; y-up).
 * Used to verify WebGL projection matches worldToCanvas.
 */
export function projectWorldToNdc(
  position: Vec3,
  frame: AutorigOrthoFrame,
  camera: THREE.OrthographicCamera = new THREE.OrthographicCamera(),
): { x: number; y: number } {
  configureAutorigOrthoCamera(camera, frame);
  camera.updateMatrixWorld(true);
  const v = new THREE.Vector3(position[0], position[1], position[2]);
  v.project(camera);
  return { x: v.x, y: v.y };
}

/**
 * Convert worldToCanvas pixel coords into the same NDC space as projectWorldToNdc
 * (x: left=-1…right=+1, y: bottom=-1…top=+1) over the usable (margin-inset) rect.
 */
export function canvasPointToNdc(
  canvasX: number,
  canvasY: number,
  frame: AutorigOrthoFrame,
): { x: number; y: number } {
  const usableW = Math.max(frame.canvasWidth - frame.marginPx * 2, 1);
  const usableH = Math.max(frame.canvasHeight - frame.marginPx * 2, 1);
  const nx = (canvasX - frame.marginPx) / usableW;
  const ny = (canvasY - frame.marginPx) / usableH;
  return {
    x: nx * 2 - 1,
    y: 1 - ny * 2, // canvas Y-down → NDC Y-up
  };
}

/**
 * Draw a magnifier that zooms the mesh preview under a marker (not a solid dark disc alone).
 * Samples from the mesh WebGL canvas at the marker's canvas coordinates.
 */
export function drawAutorigMarkerMagnifier(params: {
  ctx: CanvasRenderingContext2D;
  /** Bottom-layer mesh canvas (same CSS/pixel size as marker canvas), or null if unloaded. */
  meshCanvas: HTMLCanvasElement | null | undefined;
  markerCanvasX: number;
  markerCanvasY: number;
  magnifierCenterX: number;
  magnifierCenterY: number;
  radius?: number;
  zoom?: number;
  markerFill: string;
  ringStroke?: string;
}): void {
  const radius = params.radius ?? 48;
  const zoom = params.zoom ?? 2.5;
  const {
    ctx,
    meshCanvas,
    markerCanvasX,
    markerCanvasY,
    magnifierCenterX,
    magnifierCenterY,
    markerFill,
  } = params;
  const ringStroke = params.ringStroke ?? '#94a3b8';

  ctx.save();
  ctx.beginPath();
  ctx.arc(magnifierCenterX, magnifierCenterY, radius, 0, Math.PI * 2);
  ctx.clip();

  if (meshCanvas && meshCanvas.width > 0 && meshCanvas.height > 0) {
    const srcR = radius / zoom;
    // drawImage source rect is in mesh canvas pixels (matched to marker coords).
    ctx.drawImage(
      meshCanvas,
      markerCanvasX - srcR,
      markerCanvasY - srcR,
      srcR * 2,
      srcR * 2,
      magnifierCenterX - radius,
      magnifierCenterY - radius,
      radius * 2,
      radius * 2,
    );
  } else {
    ctx.fillStyle = '#111827';
    ctx.fillRect(
      magnifierCenterX - radius,
      magnifierCenterY - radius,
      radius * 2,
      radius * 2,
    );
  }

  // Enlarged marker on top of the zoomed mesh crop.
  ctx.beginPath();
  ctx.fillStyle = markerFill;
  ctx.arc(magnifierCenterX, magnifierCenterY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = ringStroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(magnifierCenterX, magnifierCenterY, radius, 0, Math.PI * 2);
  ctx.stroke();
}
