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
}

/** True when depth stills should be written into the shot package. */
export function shouldExportViewportDepth(settings?: ShotDepthSettings | null): boolean {
  const depth = normalizeShotDepthSettings(settings);
  return depth.enabled && depth.includeViewportStill;
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
  } = {},
): Promise<DepthRenderResult> {
  const depth = normalizeShotDepthSettings(options.depth ?? defaultShotDepthSettings);
  await ensureHumanMannequinForProject(project);

  const renderer = createDepthRenderer(width, height);
  const scene = buildScene(project, createFinalRenderSceneOptions());
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

  try {
    renderDepthGrayscale(renderer, scene, camera, {
      nearMeters: range.nearMeters,
      farMeters: range.farMeters,
      invert: depth.invert === true,
      cameraNear: clipping.near,
      cameraFar: clipping.far,
    });
    const dataUrl = renderer.domElement.toDataURL('image/png');
    return {
      dataUrl,
      width,
      height,
      nearMeters: range.nearMeters,
      farMeters: range.farMeters,
      invert: depth.invert === true,
      encoding: 'linear-camera-depth',
    };
  } finally {
    disposeScene(scene);
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
    resolveProjectForShot(project, shot, { hidePeople: options.peopleVariant === 'clean_plate' }),
    shot.camera,
    shot.exportSettings.width,
    shot.exportSettings.height,
    { depth: depthForRender, rangeCameras },
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
  const shotProject = resolveProjectForShot(project, shot, { hidePeople: false });
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

/**
 * Two-pass depth visualization into the renderer's current drawing buffer:
 * 1) MeshDepthMaterial → packed depth RT
 * 2) Fullscreen unpack + linear metric remap → grayscale RGB
 */
export function renderDepthGrayscale(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  options: DepthPassOptions,
): void {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const width = Math.max(1, Math.round(size.x));
  const height = Math.max(1, Math.round(size.y));

  const depthTarget = new THREE.WebGLRenderTarget(width, height, {
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
    scene.overrideMaterial = depthMaterial;
    scene.background = null;
    scene.fog = null;

    renderer.setRenderTarget(depthTarget);
    renderer.clear();
    renderer.render(scene, camera);

    blitLinearDepth(renderer, depthTarget.texture, {
      ...options,
      width,
      height,
    });
  } finally {
    scene.overrideMaterial = previousOverride;
    scene.background = previousBackground;
    scene.fog = previousFog;
    renderer.setRenderTarget(previousRenderTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.toneMapping = previousToneMapping;
    renderer.outputColorSpace = previousOutputColorSpace;
    depthMaterial.dispose();
    depthTarget.dispose();
  }
}

function blitLinearDepth(
  renderer: THREE.WebGLRenderer,
  depthTexture: THREE.Texture,
  options: DepthPassOptions & { width: number; height: number },
): void {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tDepth: { value: depthTexture },
      cameraNear: { value: options.cameraNear },
      cameraFar: { value: options.cameraFar },
      nearMeters: { value: options.nearMeters },
      farMeters: { value: options.farMeters },
      invert: { value: options.invert ? 1 : 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
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
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(mesh);

  const previousToneMapping = renderer.toneMapping;
  const previousOutputColorSpace = renderer.outputColorSpace;
  try {
    renderer.toneMapping = THREE.NoToneMapping;
    // Keep linear values so PNG grayscale matches the shader output.
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(scene, camera);
  } finally {
    renderer.toneMapping = previousToneMapping;
    renderer.outputColorSpace = previousOutputColorSpace;
    mesh.geometry.dispose();
    material.dispose();
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
