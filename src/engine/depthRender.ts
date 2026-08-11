import * as THREE from 'three';
import type { CameraData, LocationProject, Shot, ShotDepthSettings } from '../domain/types';
import {
  defaultShotDepthSettings,
  normalizeShotDepthSettings,
} from '../domain/defaults';
import {
  getSortedCameraKeyframes,
} from './cameraKeyframes';
import { computeCameraMoveClippingRange, type ExportClippingRange } from './exportClipping';
import { createFinalRenderSceneOptions } from './finalRenderProfile';
import { applyFlyCameraToPerspectiveCamera } from './flyCamera';
import { ensureHumanMannequinForProject } from './humanMannequinModel';
import type { PeopleRenderVariant } from './peopleExport';
import { buildScene, disposeScene } from './sceneObjects';
import { resolveProjectForShot } from './shotSceneState';
import { flyCameraFromCamera } from './sync';

export interface DepthRangeMeters {
  nearMeters: number;
  farMeters: number;
}

export interface DepthRenderResult {
  dataUrl: string;
  /** Binary PNG when the caller opts out of the legacy data-URL path. */
  blob?: Blob;
  width: number;
  height: number;
  nearMeters: number;
  farMeters: number;
  invert: boolean;
  encoding: 'linear-camera-depth';
}

export interface DepthMetadata {
  encoding: 'linear-camera-depth';
  nearMeters: number;
  farMeters: number;
  nearColor: 'white' | 'black';
  farColor: 'white' | 'black';
  backgroundColor: 'black';
  invert: boolean;
  rangeMode: ShotDepthSettings['rangeMode'];
  /** Present when a depth camera-move video is included. */
  frameRate?: number;
}

/** Shared render-pass identity for clay / projected / depth camera-move loops. */
export type SceneRenderPass = 'clay' | 'projected' | 'depth';

/** True when depth stills should be written into the shot package. */
export function shouldExportViewportDepth(settings?: ShotDepthSettings | null): boolean {
  const depth = normalizeShotDepthSettings(settings);
  return depth.enabled && depth.includeViewportStill;
}

/** True when depth camera-move reference stills should be packaged. */
export function shouldExportDepthReferenceFrames(
  settings: ShotDepthSettings | null | undefined,
  hasReferenceFrames: boolean,
): boolean {
  const depth = normalizeShotDepthSettings(settings);
  return depth.enabled && depth.includeReferenceFrames && hasReferenceFrames;
}

/** True when a depth camera-move MP4 should be packaged. */
export function shouldExportCameraMoveDepth(
  settings: ShotDepthSettings | null | undefined,
  hasRenderableMove: boolean,
): boolean {
  const depth = normalizeShotDepthSettings(settings);
  return depth.enabled && depth.includeCameraMoveVideo && hasRenderableMove;
}

/** True when any depth package artifact is requested. */
export function shouldExportAnyDepth(
  settings: ShotDepthSettings | null | undefined,
  options: { hasReferenceFrames?: boolean; hasRenderableMove?: boolean } = {},
): boolean {
  return shouldExportViewportDepth(settings)
    || shouldExportDepthReferenceFrames(settings, options.hasReferenceFrames === true)
    || shouldExportCameraMoveDepth(settings, options.hasRenderableMove === true);
}

export function resolveShotDepthSettings(shot: Pick<Shot, 'exportSettings'>): ShotDepthSettings {
  return normalizeShotDepthSettings(shot.exportSettings.depth ?? defaultShotDepthSettings);
}

/**
 * One fixed metric depth range for the entire shot.
 * Auto mode reuses camera-move clipping / scene-bound far across all keyframes.
 */
export function resolveShotDepthRange(params: {
  scene: THREE.Scene;
  shot: Pick<Shot, 'camera' | 'cameraKeyframes'>;
  depth: ShotDepthSettings;
}): DepthRangeMeters {
  const cameras = collectShotDepthCameras(params.shot);
  const clipping = computeCameraMoveClippingRange({
    scene: params.scene,
    keyframeCameras: cameras,
    nearMeters: params.shot.camera.near,
  });

  if (params.depth.rangeMode === 'manual') {
    return clampDepthRange(
      params.depth.nearMeters ?? clipping.near,
      params.depth.farMeters ?? clipping.far,
    );
  }

  return {
    nearMeters: clipping.near,
    farMeters: clipping.far,
  };
}

/** Camera near/far used for the depth pass — identical to clay clipping. */
export function resolveDepthCameraClipping(params: {
  scene: THREE.Scene;
  cameraData: CameraData;
  shotCameras?: readonly CameraData[];
}): ExportClippingRange {
  return computeCameraMoveClippingRange({
    scene: params.scene,
    keyframeCameras: params.shotCameras && params.shotCameras.length > 0
      ? params.shotCameras
      : [params.cameraData],
    nearMeters: params.cameraData.near,
  });
}

export function buildDepthMetadata(
  depth: ShotDepthSettings,
  range: DepthRangeMeters,
  extras: { frameRate?: number } = {},
): DepthMetadata {
  const invert = depth.invert === true;
  return {
    encoding: 'linear-camera-depth',
    nearMeters: range.nearMeters,
    farMeters: range.farMeters,
    nearColor: invert ? 'black' : 'white',
    farColor: invert ? 'white' : 'black',
    backgroundColor: 'black',
    invert,
    rangeMode: depth.rangeMode,
    ...(extras.frameRate != null ? { frameRate: extras.frameRate } : {}),
  };
}

export function formatDepthRangeLegend(range: DepthRangeMeters): string {
  return `Near ${formatMeters(range.nearMeters)} → Far ${formatMeters(range.farMeters)}`;
}

/**
 * Render packed camera depth, unpack/linearize, and map the shot metric range
 * to an 8-bit RGB grayscale PNG (white = nearest by default).
 */
export async function renderViewportDepth(
  project: LocationProject,
  cameraData: CameraData,
  width: number,
  height: number,
  options: {
    depth?: ShotDepthSettings;
    /** Cameras used for the shared auto range (defaults to this frame only). */
    rangeCameras?: readonly CameraData[];
    output?: 'data-url' | 'blob';
  } = {},
): Promise<DepthRenderResult> {
  const depth = normalizeShotDepthSettings(options.depth ?? defaultShotDepthSettings);
  await ensureHumanMannequinForProject(project);

  const renderer = createDepthRenderer(width, height);
  let scene: THREE.Scene | undefined;
  try {
    scene = buildScene(project, createFinalRenderSceneOptions());
    scene.background = new THREE.Color(0x000000);
    scene.fog = null;

    const rangeCameras = options.rangeCameras && options.rangeCameras.length > 0
      ? options.rangeCameras
      : [cameraData];
    const clipping = computeCameraMoveClippingRange({
      scene,
      keyframeCameras: rangeCameras,
      nearMeters: cameraData.near,
    });
    const range = depth.rangeMode === 'manual'
      ? clampDepthRange(depth.nearMeters ?? clipping.near, depth.farMeters ?? clipping.far)
      : { nearMeters: clipping.near, farMeters: clipping.far };

    const camera = new THREE.PerspectiveCamera(
      cameraData.fovDegrees,
      width / height,
      clipping.near,
      clipping.far,
    );
    applyFlyCameraToPerspectiveCamera(
      camera,
      flyCameraFromCamera(cameraData),
      cameraData.fovDegrees,
      width / height,
      clipping.near,
      clipping.far,
    );
    renderDepthGrayscale(renderer, scene, camera, {
      nearMeters: range.nearMeters,
      farMeters: range.farMeters,
      invert: depth.invert === true,
      cameraNear: clipping.near,
      cameraFar: clipping.far,
    });
    const encoded = options.output === 'blob'
      ? { dataUrl: '', blob: await canvasToBlob(renderer.domElement, 'image/png') }
      : { dataUrl: renderer.domElement.toDataURL('image/png') };
    return {
      ...encoded,
      width,
      height,
      nearMeters: range.nearMeters,
      farMeters: range.farMeters,
      invert: depth.invert === true,
      encoding: 'linear-camera-depth',
    };
  } finally {
    if (scene) disposeScene(scene);
    disposeDepthRenderer(renderer);
  }
}

export async function renderShotDepthFrame(
  project: LocationProject,
  shot: Shot,
  options: {
    peopleVariant?: PeopleRenderVariant;
    /** Shared shot-wide range; when omitted, auto/manual is resolved from this variant's scene. */
    depthRange?: DepthRangeMeters;
    output?: 'data-url' | 'blob';
  } = {},
): Promise<DepthRenderResult> {
  const depth = resolveShotDepthSettings(shot);
  const rangeCameras = collectShotDepthCameras(shot);
  const depthForRender: ShotDepthSettings = options.depthRange
    ? {
      ...depth,
      rangeMode: 'manual',
      nearMeters: options.depthRange.nearMeters,
      farMeters: options.depthRange.farMeters,
    }
    : depth;
  return renderViewportDepth(
    resolveProjectForShot(project, shot, {
      contentMode: options.peopleVariant === 'clean_plate' ? 'clean_plate' : 'full_scene',
    }),
    shot.camera,
    shot.exportSettings.width,
    shot.exportSettings.height,
    { depth: depthForRender, rangeCameras, output: options.output },
  );
}

/**
 * Resolve the shared metric depth range for a shot from the with-people scene.
 * Clean-plate variants reuse this so stationary geometry does not re-normalize.
 */
export async function resolveShotDepthRangeForExport(
  project: LocationProject,
  shot: Shot,
): Promise<DepthRangeMeters> {
  const depth = resolveShotDepthSettings(shot);
  await ensureHumanMannequinForProject(project);
  const shotProject = resolveProjectForShot(project, shot, { contentMode: 'full_scene' });
  const scene = buildScene(shotProject, createFinalRenderSceneOptions());
  try {
    return resolveShotDepthRange({
      scene,
      shot,
      depth,
    });
  } finally {
    disposeScene(scene);
  }
}

export interface DepthPassOptions {
  nearMeters: number;
  farMeters: number;
  invert: boolean;
  cameraNear: number;
  cameraFar: number;
}

/** Reusable GPU resources for multi-frame depth video / preview. */
export interface DepthPassResources {
  width: number;
  height: number;
  depthTarget: THREE.WebGLRenderTarget;
  depthMaterial: THREE.MeshDepthMaterial;
  blitScene: THREE.Scene;
  blitCamera: THREE.OrthographicCamera;
  blitMaterial: THREE.ShaderMaterial;
  blitMesh: THREE.Mesh;
  dispose(): void;
}

export function createDepthPassResources(width: number, height: number): DepthPassResources {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const depthTarget = new THREE.WebGLRenderTarget(w, h, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.UnsignedByteType,
  });
  depthTarget.texture.colorSpace = THREE.NoColorSpace;
  depthTarget.texture.generateMipmaps = false;

  const depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });

  const blitMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDepth: { value: depthTarget.texture },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 100 },
      nearMeters: { value: 0.1 },
      farMeters: { value: 100 },
      invert: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: DEPTH_LINEARIZE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMaterial);
  const blitScene = new THREE.Scene();
  blitScene.add(blitMesh);

  return {
    width: w,
    height: h,
    depthTarget,
    depthMaterial,
    blitScene,
    blitCamera,
    blitMaterial,
    blitMesh,
    dispose() {
      depthTarget.dispose();
      depthMaterial.dispose();
      blitMesh.geometry.dispose();
      blitMaterial.dispose();
    },
  };
}

const DEPTH_LINEARIZE_FRAGMENT = /* glsl */`
  #include <packing>

  uniform sampler2D tDepth;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float nearMeters;
  uniform float farMeters;
  uniform float invert;
  varying vec2 vUv;

  void main() {
    float fragCoordZ = unpackRGBAToDepth(texture2D(tDepth, vUv));
    // No geometry leaves the packed clear value at 1.0 → black.
    if (fragCoordZ >= 0.99999) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    float viewZ = perspectiveDepthToViewZ(fragCoordZ, cameraNear, cameraFar);
    float linearDepth = -viewZ;
    float normalized = clamp(
      (linearDepth - nearMeters) / max(farMeters - nearMeters, 0.0001),
      0.0,
      1.0
    );
    // Default: white = nearest, black = farthest.
    float gray = invert > 0.5 ? normalized : (1.0 - normalized);
    gl_FragColor = vec4(gray, gray, gray, 1.0);
  }
`;

/**
 * Two-pass depth visualization into the renderer's current drawing buffer:
 * 1) MeshDepthMaterial → packed depth RT
 * 2) Fullscreen unpack + linear metric remap → grayscale RGB
 *
 * Pass `resources` for multi-frame encodes to avoid per-frame allocations.
 */
export function renderDepthGrayscale(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  options: DepthPassOptions,
  resources?: DepthPassResources,
): void {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const width = Math.max(1, Math.round(size.x));
  const height = Math.max(1, Math.round(size.y));

  const ownsResources = !resources
    || resources.width !== width
    || resources.height !== height;
  const pass = ownsResources ? createDepthPassResources(width, height) : resources;

  const previousOverride = scene.overrideMaterial;
  const previousBackground = scene.background;
  const previousFog = scene.fog;
  const previousClearColor = new THREE.Color();
  const previousClearAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const previousToneMapping = renderer.toneMapping;
  const previousOutputColorSpace = renderer.outputColorSpace;
  const previousRenderTarget = renderer.getRenderTarget();
  renderer.getClearColor(previousClearColor);

  const packedFar = packDepthRGBA(1);
  const clearPacked = new THREE.Color(packedFar.r, packedFar.g, packedFar.b);

  try {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = true;
    renderer.setClearColor(clearPacked, 1);
    scene.overrideMaterial = pass.depthMaterial;
    scene.background = null;
    scene.fog = null;

    renderer.setRenderTarget(pass.depthTarget);
    renderer.clear();
    renderer.render(scene, camera);

    const uniforms = pass.blitMaterial.uniforms;
    uniforms.tDepth.value = pass.depthTarget.texture;
    uniforms.cameraNear.value = options.cameraNear;
    uniforms.cameraFar.value = options.cameraFar;
    uniforms.nearMeters.value = options.nearMeters;
    uniforms.farMeters.value = options.farMeters;
    uniforms.invert.value = options.invert ? 1 : 0;

    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(pass.blitScene, pass.blitCamera);
  } finally {
    scene.overrideMaterial = previousOverride;
    scene.background = previousBackground;
    scene.fog = previousFog;
    renderer.setRenderTarget(previousRenderTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.toneMapping = previousToneMapping;
    renderer.outputColorSpace = previousOutputColorSpace;
    if (ownsResources) pass.dispose();
  }
}

function collectShotDepthCameras(shot: Pick<Shot, 'camera' | 'cameraKeyframes'>): CameraData[] {
  const keyframes = getSortedCameraKeyframes(shot.cameraKeyframes ?? []);
  if (keyframes.length === 0) return [shot.camera];
  const cameras = keyframes.map((keyframe) => keyframe.camera);
  const hasCurrent = cameras.some((camera) => camera === shot.camera);
  if (!hasCurrent) cameras.push(shot.camera);
  return cameras;
}

function clampDepthRange(nearMeters: number, farMeters: number): DepthRangeMeters {
  const near = Number.isFinite(nearMeters) && nearMeters > 0 ? nearMeters : 0.1;
  const far = Number.isFinite(farMeters) && farMeters > near + 0.01
    ? farMeters
    : near + 1;
  return { nearMeters: near, farMeters: far };
}

function formatMeters(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded.replace(/\.?0+$/, '')} m`;
}

/** Pack a 0–1 depth into an RGB color matching Three.js RGBADepthPacking (A unused). */
function packDepthRGBA(depth: number): { r: number; g: number; b: number } {
  const v = Math.min(1, Math.max(0, depth));
  const r = Math.floor(v * 255) / 255;
  const g = Math.floor((v * 255 * 255) % 255) / 255;
  const b = Math.floor((v * 255 * 255 * 255) % 255) / 255;
  return { r, g, b };
}

function createDepthRenderer(width: number, height: number): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  return renderer;
}

function disposeDepthRenderer(renderer: THREE.WebGLRenderer) {
  renderer.dispose();
  renderer.forceContextLoss();
  const canvas = renderer.domElement;
  if (canvas.parentElement) {
    canvas.parentElement.removeChild(canvas);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode rendered image.'));
    }, type);
  });
}
