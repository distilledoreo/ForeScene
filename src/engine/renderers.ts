import * as THREE from 'three';
import { CameraData, Euler, LocationProject, PanoCropSettings, Shot, Vec3 } from '../domain/types';
import {
  getCameraMoveDurationSeconds,
  getSortedCameraKeyframes,
  hasRenderableCameraMove,
  interpolateCameraKeyframes,
} from './cameraKeyframes';
import {
  CAMERA_MOVE_CUBEMAP_FACES,
  DEFAULT_CAMERA_MOVE_CUBEMAP_FACE_SIZE,
  type CameraMoveCubemapFaceId,
} from './cameraMoveCubemap';
import { DEFAULT_GRAYBOX_PANO_HEIGHT, DEFAULT_GRAYBOX_PANO_WIDTH } from '../domain/defaults';
import { ensureHumanMannequinForProject } from './humanMannequinModel';
import { applyFlyCameraToPerspectiveCamera } from './flyCamera';
export { applyFlyCameraToPerspectiveCamera } from './flyCamera';
import { resolveProjectedProjectorAssets } from './multiOriginProjection';
import {
  canUseProjectedAppearance,
} from './projectedStyle';
import {
  acquireProjectedStyleTexture,
  isProjectedStyleMaterial,
  releaseProjectedStyleTexture,
} from './projectedStyleMaterials';
import {
  applySceneObjectTransform,
  buildScene,
  disposeScene,
  sceneObjectUsesProceduralScale,
  type ProjectedSceneOptions,
  type SceneVisualTheme,
} from './sceneObjects';
import { applyHumanPoseToObject3D } from './poseableCharacter';
import './builtinMannequinCharacter';
import {
  DEFAULT_OCCLUSION_FACE_SIZE,
  DEFAULT_OCCLUSION_NEAR,
  generateProjectorOcclusionMap,
  type ProjectorOcclusionMap,
  type ProjectorOcclusionSet,
} from './projectorOcclusion';
import { degreesToRadians, flyCameraFromCamera } from './sync';
import { computeGrayboxPanoFarPlane } from './sceneBounds';
import { createFinalRenderSceneOptions } from './finalRenderProfile';
import {
  isObjectVisibleForContentMode,
  resolveProjectForAnimatedCameraMove,
  resolveProjectForShot,
  type SceneContentMode,
} from './shotSceneState';
import {
  cameraKeyframesHaveObjectAnimation,
  interpolateObjectOverrides,
} from './objectKeyframes';
import { findSceneObjectMesh } from './transformGizmo';
import type { PeopleRenderVariant } from './peopleExport';
import {
  characterPassIncludesGreenMp4,
  characterPassIncludesPngSequence,
} from './characterPassExport';
import type { CharacterMotionExportFormat } from '../domain/types';
import {
  clampShotNearClip,
} from './cameraClipping';
import { computeCameraMoveClippingRange } from './exportClipping';
import {
  createDepthPassResources,
  renderDepthGrayscale,
  type DepthPassResources,
  type SceneRenderPass,
} from './depthRender';
import {
  canUseDeterministicMp4Export,
  encodeCanvasFramesToMp4,
} from './videoEncode';
import {
  cameraMoveFrameTimeSeconds,
  computeCameraMoveFrameCount,
  DEFAULT_VIDEO_FRAME_RATE,
  resolveVideoPreset,
  type VideoResolutionPresetId,
} from './videoPresets';
import {
  computeRenderPixelStats,
  type RenderPixelStats,
} from './previs/renderPixelStats';
import {
  analyzeProjectionDebugPixels,
  type ProjectionHealthMetrics,
} from './previs/shotEnvironment';

export interface ImageRenderResult {
  dataUrl: string;
  width: number;
  height: number;
  /** Present when the render path computed canvas pixel sanity stats. */
  pixelStats?: RenderPixelStats;
}

export interface ProjectedHealthRenderResult extends ImageRenderResult {
  projectionHealth: ProjectionHealthMetrics;
}

export {
  renderShotDepthFrame,
  renderViewportDepth,
} from './depthRender';
export type {
  DepthMetadata,
  DepthRenderResult,
  SceneRenderPass,
} from './depthRender';

export interface BlobImageRenderResult {
  blob: Blob;
  width: number;
  height: number;
}

export interface VideoRenderResult {
  blob: Blob;
  /** Present only when `includeDataUrl` was requested (e.g. clay shot-library persistence). */
  dataUrl?: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  mimeType: string;
  fileExtension: 'mp4';
  /** How the file was produced. */
  encodeMode?: 'render' | 'quickPreview';
  frameCount?: number;
  codecString?: string;
}

export interface PanoCubemapRenderResult {
  faceSize: number;
  faces: Record<CameraMoveCubemapFaceId, ImageRenderResult>;
}

/**
 * Binary cubemap output for export paths. Keeping the PNGs as Blobs avoids the
 * 33% base64 expansion while the six faces are assembled into a package.
 */
export interface PanoCubemapBlobRenderResult {
  faceSize: number;
  faces: Record<CameraMoveCubemapFaceId, BlobImageRenderResult>;
}

export interface PanoCubemapRenderOptions {
  faceSize?: number;
  panoRotation?: Euler;
  /** Called after each face is rendered, before the next WebGL context starts. */
  onFaceRendered?: (
    face: CameraMoveCubemapFaceId,
    result: BlobImageRenderResult,
  ) => void | Promise<void>;
}

export type CameraMoveExportPhase =
  | 'preparing'
  | 'rendering'
  | 'finalizing'
  | 'complete';

export interface CameraMoveExportProgress {
  phase: CameraMoveExportPhase;
  /** Overall 0–1 progress. */
  progress: number;
  completedFrames?: number;
  totalFrames?: number;
  message: string;
}

export interface CameraMoveVideoOptions {
  frameRate?: number;
  mimeType?: string;
  videoBitsPerSecond?: number;
  onProgress?: (progress: number | CameraMoveExportProgress) => void;
  /** Optional abort; stops encoding and rejects without downloading. */
  signal?: AbortSignal;
  /** Wall-clock timeout in ms (Quick Preview only; default 90s). */
  timeoutMs?: number;
  /**
   * Scene appearance for the encoded move.
   * `projected` requires a valid styled panorama projector.
   * `depth` renders linear camera-space depth with a fixed shot range.
   */
  appearance?: 'clay' | 'projected' | 'depth';
  /**
   * Fixed metric depth range for `appearance: 'depth'`.
   * Required for depth video so every frame shares one normalization.
   */
  depthRange?: { nearMeters: number; farMeters: number };
  /** Depth invert flag (white = near by default). */
  depthInvert?: boolean;
  /**
   * `render` = fixed-step WebCodecs + Mediabunny MP4 (default).
   * `quickPreview` = real-time MediaRecorder only when explicitly requested.
   * Explicit `render` never silently falls back to Quick Preview.
   */
  mode?: 'render' | 'quickPreview';
  /** Video resolution preset. Stills keep shot.exportSettings; video defaults to 1080p. */
  resolutionPreset?: VideoResolutionPresetId;
  width?: number;
  height?: number;
  /**
   * Projected occlusion filtering for video exports.
   * Defaults to `fast` (one cubemap sample) for Render MP4.
   */
  occlusionFilter?: 'soft' | 'fast';
  /**
   * When true, also produce a base64 data URL (needed for shot-library persistence).
   * Default false — downloads and ZIP packaging should use `blob` only.
   */
  includeDataUrl?: boolean;
  /** Hide all objects classified as people for clean-plate output. */
  peopleVariant?: PeopleRenderVariant;
  /** Preferred over peopleVariant when set (full / clean plate / characters only). */
  contentMode?: SceneContentMode;
  /** Hex background for characters-only green-screen MP4 (e.g. `#00FF00`). */
  backgroundColor?: string;
  /** Include character-linked props when contentMode is characters_only. */
  includeCharacterAttachments?: boolean;
  /**
   * Alpha-capable WebGL context. Required for transparent character frames;
   * when combined with backgroundColor + characters_only, frames are composited
   * onto green before H.264 encode (Both format).
   */
  transparent?: boolean;
  /**
   * Called after each deterministic frame is rendered to the WebGL canvas,
   * before H.264 encode — used to fork transparent PNG frames without a second pass.
   */
  onFrameRendered?: (
    canvas: HTMLCanvasElement,
    frameIndex: number,
    timeSeconds: number,
  ) => void | Promise<void>;
}

const MP4_MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01E"',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs="avc1.640028"',
  'video/mp4;codecs=avc1.640028',
  'video/mp4',
] as const;

export function getSupportedCameraMoveMp4MimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  return MP4_MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

/** True when deterministic WebCodecs H.264 export can run for the given preset. */
export async function canUseRenderMp4Export(
  resolutionPreset: VideoResolutionPresetId = '1080p',
): Promise<boolean> {
  return canUseDeterministicMp4Export(resolveVideoPreset(resolutionPreset));
}

function emitProgress(
  onProgress: CameraMoveVideoOptions['onProgress'] | undefined,
  info: CameraMoveExportProgress,
) {
  onProgress?.(info);
}

/** Re-exported for backward compatibility (history/imports). */
export { computeGrayboxPanoFarPlane };


/**
 * Bake capture-origin yaw into the equirect so stamping scene.panoRotation on the
 * graybox ref matches Projected Style sampling (inverse yaw on world directions).
 * CubeCamera is always world-aligned; yaw is applied when remapping cube → equirect.
 */
export function grayboxCubeSampleDirection(
  equirectLocalDirection: Vec3,
  panoYawRadians: number,
): Vec3 {
  const s = Math.sin(panoYawRadians);
  const c = Math.cos(panoYawRadians);
  const [x, y, z] = equirectLocalDirection;
  // Inverse of applyInversePanoYaw: local (pano) → world for textureCube lookup.
  return [
    x * c + z * s,
    y,
    -x * s + z * c,
  ];
}

/**
 * Capture the scene from `project.scene.panoOrigin` into a 2:1 equirect PNG,
 * baking capture-origin yaw the same way graybox references stamp `panoRotation`.
 */
function captureEquirectangularFromOrigin(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  project: LocationProject,
  width: number,
  height: number,
): Promise<Blob> {
  // A 1024px cube face matches the angular sample density of a 4096px-wide
  // equirect. The previous 2048px faces were a 4x color-target oversample.
  const cubeFaceSize = Math.min(1024, Math.max(512, Math.round(width / 4)));
  const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(cubeFaceSize, {
    type: THREE.UnsignedByteType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const cubeCamera = new THREE.CubeCamera(
    0.1,
    computeGrayboxPanoFarPlane(scene, project.scene.panoOrigin),
    cubeRenderTarget,
  );
  cubeCamera.position.fromArray(project.scene.panoOrigin);
  cubeCamera.update(renderer, scene);

  // Degrees → radians; yaw is Euler[1], matching createPanoReference / projected materials.
  const panoYawRadians = degreesToRadians(project.scene.panoRotation?.[1] ?? 0);

  const panoScene = new THREE.Scene();
  const panoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      cubeMap: { value: cubeRenderTarget.texture },
      panoYaw: { value: panoYawRadians },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform samplerCube cubeMap;
      uniform float panoYaw;
      varying vec2 vUv;
      const float PI = 3.141592653589793;
      void main() {
        float theta = vUv.x * 2.0 * PI - PI;
        float phi = vUv.y * PI - PI * 0.5;
        // Equirect UV → direction in pano-local frame (same as projection sampling).
        vec3 localDir = normalize(vec3(
          sin(theta) * cos(phi),
          sin(phi),
          cos(theta) * cos(phi)
        ));
        // Rotate local → world so CubeCamera (world-aligned) samples the correct face.
        float s = sin(panoYaw);
        float c = cos(panoYaw);
        vec3 worldDir = normalize(vec3(
          localDir.x * c + localDir.z * s,
          localDir.y,
          -localDir.x * s + localDir.z * c
        ));
        gl_FragColor = textureCube(cubeMap, worldDir);
      }
    `,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  panoScene.add(plane);

  try {
    renderer.setSize(width, height, false);
    renderer.render(panoScene, panoCamera);
    return canvasToBlob(renderer.domElement, 'image/png');
  } finally {
    cubeRenderTarget.dispose();
    material.dispose();
    plane.geometry.dispose();
  }
}

export async function renderGrayboxEquirectangularPano(
  project: LocationProject,
  width = DEFAULT_GRAYBOX_PANO_WIDTH,
  height = DEFAULT_GRAYBOX_PANO_HEIGHT,
  theme: SceneVisualTheme = 'light',
): Promise<BlobImageRenderResult> {
  await ensureHumanMannequinForProject(project);
  const renderer = createRenderer(width, height);
  const scene = buildScene(project, {
    showHelpers: false,
    hiddenObjectTypes: ['sun_marker'],
    theme,
    fog: false,
  });
  const blob = await captureEquirectangularFromOrigin(renderer, scene, project, width, height);
  disposeScene(scene);
  disposeRenderer(renderer);
  return { blob, width, height };
}

export async function renderShotFrame(
  project: LocationProject,
  shot: Shot,
  options: { peopleVariant?: PeopleRenderVariant } = {},
): Promise<ImageRenderResult> {
  return renderViewportClay(
    resolveProjectForShot(project, shot, {
      contentMode: options.peopleVariant === 'clean_plate' ? 'clean_plate' : 'full_scene',
    }),
    shot.camera,
    shot.exportSettings.width,
    shot.exportSettings.height,
  );
}

export async function renderShotCameraMoveMp4(
  project: LocationProject,
  shot: Shot,
  options: CameraMoveVideoOptions = {},
): Promise<VideoRenderResult> {
  const contentMode = resolveCameraMoveContentMode(options);
  const includeCharacterAttachments = options.includeCharacterAttachments !== false;
  const animateObjects = cameraKeyframesHaveObjectAnimation(shot.cameraKeyframes);
  const resolveOptions = {
    contentMode,
    includeCharacterAttachments,
  };
  const shotProject = animateObjects
    ? resolveProjectForAnimatedCameraMove(project, shot, resolveOptions)
    : resolveProjectForShot(project, shot, resolveOptions);
  const keyframes = getSortedCameraKeyframes(shot.cameraKeyframes);
  if (!hasRenderableCameraMove(keyframes)) {
    throw new Error('Capture start and end camera keyframes before exporting MP4.');
  }

  const appearance = options.appearance ?? 'clay';
  if (appearance === 'projected' && !canUseProjectedAppearance(shotProject)) {
    throw new Error(
      'Projected camera-move MP4 requires an importable styled panorama with a valid image asset.',
    );
  }
  if (appearance === 'depth' && !options.depthRange) {
    throw new Error('Depth camera-move MP4 requires a fixed depthRange for the shot.');
  }

  const requestedMode = options.mode ?? 'render';
  const resolutionPresetId = options.resolutionPreset ?? '1080p';
  const preset = resolveVideoPreset(resolutionPresetId);
  const frameRate = options.frameRate ?? preset.frameRate ?? DEFAULT_VIDEO_FRAME_RATE;
  const width = options.width ?? preset.width;
  const height = options.height ?? preset.height;
  const durationSeconds = getCameraMoveDurationSeconds(keyframes);
  const encodePreset = { ...preset, width, height, frameRate };

  if (requestedMode === 'render') {
    const canRender = await canUseDeterministicMp4Export(encodePreset);
    if (!canRender) {
      throw new Error(
        `Render MP4 requires WebCodecs H.264 for ${encodePreset.label} (${encodePreset.avcCodecString}). `
        + 'This browser or preset is unsupported. Choose Quick Preview explicitly, or try Chrome/Edge with a supported resolution.',
      );
    }
    return renderShotCameraMoveMp4Deterministic(shotProject, shot, {
      ...options,
      frameRate,
      width,
      height,
      appearance,
      durationSeconds,
      keyframes,
      preset: encodePreset,
      occlusionFilter: options.occlusionFilter ?? 'fast',
      includeDataUrl: options.includeDataUrl === true,
      animateObjects,
      sourceProject: project,
      peopleVariant: options.peopleVariant,
      contentMode,
      includeCharacterAttachments,
      backgroundColor: options.backgroundColor,
      onFrameRendered: options.onFrameRendered,
      transparent: options.transparent === true,
      depthRange: options.depthRange,
      depthInvert: options.depthInvert === true,
    });
  }

  const mimeType = options.mimeType ?? getSupportedCameraMoveMp4MimeType();
  if (!mimeType) {
    throw new Error('Quick Preview MP4 export is not supported in this browser.');
  }
  return renderShotCameraMoveMp4QuickPreview(shotProject, shot, {
    ...options,
    mimeType,
    frameRate,
    width,
    height,
    appearance,
    durationSeconds,
    keyframes,
    includeDataUrl: options.includeDataUrl === true,
    animateObjects,
    sourceProject: project,
    peopleVariant: options.peopleVariant,
    contentMode,
    includeCharacterAttachments,
    backgroundColor: options.backgroundColor,
    depthRange: options.depthRange,
    depthInvert: options.depthInvert === true,
  });
}

function resolveCameraMoveContentMode(options: {
  contentMode?: SceneContentMode;
  peopleVariant?: PeopleRenderVariant;
}): SceneContentMode {
  if (options.contentMode) return options.contentMode;
  if (options.peopleVariant === 'clean_plate') return 'clean_plate';
  return 'full_scene';
}

interface CameraMoveRenderContext {
  mimeType?: string;
  frameRate: number;
  width: number;
  height: number;
  appearance: 'clay' | 'projected' | 'depth';
  durationSeconds: number;
  keyframes: ReturnType<typeof getSortedCameraKeyframes>;
  onProgress?: CameraMoveVideoOptions['onProgress'];
  signal?: AbortSignal;
  timeoutMs?: number;
  videoBitsPerSecond?: number;
  preset?: ReturnType<typeof resolveVideoPreset> & { width: number; height: number; frameRate: number };
  occlusionFilter?: 'soft' | 'fast';
  includeDataUrl?: boolean;
  animateObjects?: boolean;
  /** Original project (pre-shot resolve) for base object transforms during animation. */
  sourceProject?: LocationProject;
  /** Legacy people variant; prefer contentMode. */
  peopleVariant: PeopleRenderVariant | undefined;
  contentMode: SceneContentMode;
  includeCharacterAttachments: boolean;
  backgroundColor?: string;
  onFrameRendered?: CameraMoveVideoOptions['onFrameRendered'];
  /** When true, create an alpha-capable WebGL context (transparent PNG path). */
  transparent?: boolean;
  depthRange?: { nearMeters: number; farMeters: number };
  depthInvert?: boolean;
}

async function renderShotCameraMoveMp4Deterministic(
  project: LocationProject,
  shot: Shot,
  ctx: CameraMoveRenderContext,
): Promise<VideoRenderResult> {
  const {
    frameRate,
    width,
    height,
    appearance,
    durationSeconds,
    keyframes,
    signal,
    onProgress,
    preset,
    occlusionFilter = 'fast',
    includeDataUrl = false,
    animateObjects = false,
    sourceProject,
    contentMode,
    includeCharacterAttachments,
    backgroundColor,
    onFrameRendered,
    transparent = false,
    depthRange,
    depthInvert = false,
  } = ctx;

  if (!preset) {
    throw new Error('Deterministic MP4 export requires a video preset.');
  }

  const totalFrames = computeCameraMoveFrameCount(durationSeconds, frameRate);
  emitProgress(onProgress, {
    phase: 'preparing',
    progress: 0,
    completedFrames: 0,
    totalFrames,
    message: 'Preparing scene',
  });

  if (signal?.aborted) {
    throw new Error('MP4 export was cancelled.');
  }

  await ensureHumanMannequinForProject(project);
  const renderer = createRenderer(width, height, { alpha: transparent });
  let projectedResources: ProjectedSceneResources | undefined;
  let scene: THREE.Scene | undefined;
  let depthResources: DepthPassResources | undefined;
  let compositeCanvas: HTMLCanvasElement | undefined;
  let compositeCtx: CanvasRenderingContext2D | undefined;

  try {
    if (appearance === 'projected') {
      projectedResources = await loadProjectedSceneResources(renderer, project, {
        occlusionFilterMode: occlusionFilter,
      });
    }

    scene = buildScene(project, {
      ...createFinalRenderSceneOptions(),
      appearance: projectedResources ? 'projected' : 'clay',
      projected: projectedResources?.options,
    });
    if (appearance === 'depth') {
      scene.background = new THREE.Color(0x000000);
      scene.fog = null;
      depthResources = createDepthPassResources(width, height);
    } else if (contentMode === 'characters_only') {
      scene.fog = null;
      if (transparent) {
        scene.background = null;
        renderer.setClearColor(0x000000, 0);
      } else if (backgroundColor) {
        scene.background = new THREE.Color(backgroundColor);
      }
    }

    // When transparent characters-only + green background, encode from a 2D composite.
    const encodeOntoGreen = Boolean(
      contentMode === 'characters_only'
      && backgroundColor
      && transparent,
    );
    if (encodeOntoGreen) {
      compositeCanvas = document.createElement('canvas');
      compositeCanvas.width = width;
      compositeCanvas.height = height;
      compositeCtx = compositeCanvas.getContext('2d') ?? undefined;
      if (!compositeCtx) {
        throw new Error('Could not create composite canvas for character MP4 encode.');
      }
    }

    const nearMeters = Math.max(
      ...keyframes.map((keyframe) =>
        clampShotNearClip(keyframe.camera.near, keyframe.camera.far),
      ),
    );
    const clipping = computeCameraMoveClippingRange({
      scene,
      keyframeCameras: keyframes.map((keyframe) => keyframe.camera),
      nearMeters,
    });

    const camera = new THREE.PerspectiveCamera(
      shot.camera.fovDegrees,
      width / height,
      clipping.near,
      clipping.far,
    );

    emitProgress(onProgress, {
      phase: 'rendering',
      progress: 0.02,
      completedFrames: 0,
      totalFrames,
      message: `Rendering frame 0 of ${totalFrames}`,
    });

    const encoded = await encodeCanvasFramesToMp4({
      canvas: encodeOntoGreen && compositeCanvas ? compositeCanvas : renderer.domElement,
      preset,
      totalFrames,
      signal,
      renderFrame: async (frameIndex) => {
        if (signal?.aborted) {
          throw new Error('MP4 export was cancelled.');
        }
        const timeSeconds = cameraMoveFrameTimeSeconds(frameIndex, frameRate, durationSeconds);
        renderCameraMoveFrame(
          renderer,
          scene!,
          camera,
          keyframes,
          timeSeconds,
          width,
          height,
          clipping,
          {
            pass: appearance,
            objectAnimation: animateObjects
              ? {
                shot,
                baseObjects: (sourceProject ?? project).scene.objects,
                assets: (sourceProject ?? project).assets,
                contentMode,
                includeCharacterAttachments,
              }
              : undefined,
            depth: appearance === 'depth' && depthRange
              ? {
                nearMeters: depthRange.nearMeters,
                farMeters: depthRange.farMeters,
                invert: depthInvert,
                resources: depthResources,
              }
              : undefined,
          },
        );
        if (onFrameRendered) {
          await onFrameRendered(renderer.domElement, frameIndex, timeSeconds);
        }
        if (encodeOntoGreen && compositeCtx && compositeCanvas && backgroundColor) {
          compositeCtx.fillStyle = backgroundColor;
          compositeCtx.fillRect(0, 0, width, height);
          compositeCtx.drawImage(renderer.domElement, 0, 0);
        }
      },
      onFrameEncoded: (completedFrames, frames) => {
        const renderProgress = completedFrames / frames;
        emitProgress(onProgress, {
          phase: 'rendering',
          progress: 0.02 + renderProgress * 0.90,
          completedFrames,
          totalFrames: frames,
          message: `Rendering frame ${completedFrames} of ${frames}`,
        });
      },
    });

    emitProgress(onProgress, {
      phase: 'finalizing',
      progress: 0.95,
      completedFrames: totalFrames,
      totalFrames,
      message: 'Finalizing MP4',
    });

    const result: VideoRenderResult = {
      blob: encoded.blob,
      dataUrl: includeDataUrl ? await blobToDataUrl(encoded.blob) : undefined,
      width: encoded.width,
      height: encoded.height,
      durationSeconds,
      frameRate: encoded.frameRate,
      mimeType: encoded.mimeType,
      fileExtension: 'mp4',
      encodeMode: 'render',
      frameCount: encoded.frameCount,
      codecString: encoded.codecString,
    };

    emitProgress(onProgress, {
      phase: 'complete',
      progress: 1,
      completedFrames: totalFrames,
      totalFrames,
      message: 'Complete',
    });

    return result;
  } finally {
    if (scene) disposeScene(scene);
    depthResources?.dispose();
    projectedResources?.dispose();
    disposeRenderer(renderer);
  }
}

/** Real-time MediaRecorder path — fast, may drop frames (Quick Preview). */
async function renderShotCameraMoveMp4QuickPreview(
  project: LocationProject,
  shot: Shot,
  ctx: CameraMoveRenderContext,
): Promise<VideoRenderResult> {
  const {
    mimeType,
    frameRate,
    width,
    height,
    appearance,
    durationSeconds,
    keyframes,
    signal: externalSignal,
    onProgress,
    timeoutMs: optionTimeoutMs,
    videoBitsPerSecond,
    occlusionFilter = 'soft',
    includeDataUrl = false,
    animateObjects = false,
    sourceProject,
    contentMode,
    includeCharacterAttachments,
    backgroundColor,
    depthRange,
    depthInvert = false,
  } = ctx;

  if (!mimeType) {
    throw new Error('MP4 camera move export is not supported in this browser.');
  }

  emitProgress(onProgress, {
    phase: 'preparing',
    progress: 0,
    message: 'Preparing scene',
  });

  await ensureHumanMannequinForProject(project);
  const renderer = createRenderer(width, height);
  let projectedResources: ProjectedSceneResources | undefined;
  let depthResources: DepthPassResources | undefined;
  if (appearance === 'projected') {
    projectedResources = await loadProjectedSceneResources(renderer, project, {
      occlusionFilterMode: occlusionFilter,
    });
  }
  const scene = buildScene(project, {
    ...createFinalRenderSceneOptions(),
    appearance: projectedResources ? 'projected' : 'clay',
    projected: projectedResources?.options,
  });
  if (appearance === 'depth') {
    scene.background = new THREE.Color(0x000000);
    scene.fog = null;
    depthResources = createDepthPassResources(width, height);
  } else if (contentMode === 'characters_only') {
    scene.fog = null;
    if (backgroundColor) {
      scene.background = new THREE.Color(backgroundColor);
    }
  }

  const nearMeters = Math.max(
    ...keyframes.map((keyframe) =>
      clampShotNearClip(keyframe.camera.near, keyframe.camera.far),
    ),
  );
  const clipping = computeCameraMoveClippingRange({
    scene,
    keyframeCameras: keyframes.map((keyframe) => keyframe.camera),
    nearMeters,
  });

  const camera = new THREE.PerspectiveCamera(
    shot.camera.fovDegrees,
    width / height,
    clipping.near,
    clipping.far,
  );

  const captureStream = renderer.domElement.captureStream?.bind(renderer.domElement);
  if (!captureStream) {
    disposeScene(scene);
    depthResources?.dispose();
    projectedResources?.dispose();
    disposeRenderer(renderer);
    throw new Error('Canvas video capture is not supported in this browser.');
  }

  const stream = captureStream(frameRate);
  const chunks: Blob[] = [];
  const timeoutMs = optionTimeoutMs ?? Math.max(90_000, Math.ceil(durationSeconds * 12_000));

  try {
    if (externalSignal?.aborted) {
      throw new Error('MP4 export was cancelled.');
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: videoBitsPerSecond ?? Math.max(1_000_000, width * height * 2),
    });

    await new Promise<void>((resolve, reject) => {
      let animationFrame = 0;
      let startTime = 0;
      let stopping = false;
      let settled = false;
      let timeoutId = 0;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeoutId) window.clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', onAbort);
        fn();
      };

      const stopRecorder = () => {
        if (stopping) return;
        stopping = true;
        cancelAnimationFrame(animationFrame);
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          // ignore stop races
        }
      };

      const onAbort = () => {
        stopRecorder();
        settle(() => reject(new Error('MP4 export was cancelled.')));
      };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        stopRecorder();
        settle(() => reject(new Error('MP4 recording failed in this browser.')));
      };
      recorder.onstop = () => settle(() => resolve());

      const renderFrame = (now: number) => {
        if (settled) return;
        if (!startTime) startTime = now;
        const elapsedSeconds = Math.min((now - startTime) / 1000, durationSeconds);
        renderCameraMoveFrame(
          renderer,
          scene,
          camera,
          keyframes,
          elapsedSeconds,
          width,
          height,
          clipping,
          {
            pass: appearance,
            objectAnimation: animateObjects
              ? {
                shot,
                baseObjects: (sourceProject ?? project).scene.objects,
                assets: (sourceProject ?? project).assets,
                contentMode,
                includeCharacterAttachments,
              }
              : undefined,
            depth: appearance === 'depth' && depthRange
              ? {
                nearMeters: depthRange.nearMeters,
                farMeters: depthRange.farMeters,
                invert: depthInvert,
                resources: depthResources,
              }
              : undefined,
          },
        );
        emitProgress(onProgress, {
          phase: 'rendering',
          progress: durationSeconds === 0 ? 1 : elapsedSeconds / durationSeconds,
          message: `Rendering (quick preview) ${Math.round((elapsedSeconds / Math.max(durationSeconds, 1e-6)) * 100)}%`,
        });

        if (elapsedSeconds >= durationSeconds) {
          try {
            if (recorder.state === 'recording') recorder.requestData();
          } catch {
            // requestData is best-effort
          }
          stopRecorder();
          return;
        }
        animationFrame = requestAnimationFrame(renderFrame);
      };

      externalSignal?.addEventListener('abort', onAbort);
      timeoutId = window.setTimeout(() => {
        stopRecorder();
        settle(() => reject(new Error(
          `MP4 export timed out after ${Math.round(timeoutMs / 1000)} seconds. Try a shorter move or smaller resolution.`,
        )));
      }, timeoutMs);

      renderCameraMoveFrame(renderer, scene, camera, keyframes, 0, width, height, clipping, {
        pass: appearance,
        depth: appearance === 'depth' && depthRange
          ? {
            nearMeters: depthRange.nearMeters,
            farMeters: depthRange.farMeters,
            invert: depthInvert,
            resources: depthResources,
          }
          : undefined,
      });
      recorder.start(250);
      animationFrame = requestAnimationFrame(renderFrame);
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    disposeScene(scene);
    depthResources?.dispose();
    projectedResources?.dispose();
    disposeRenderer(renderer);
  }

  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) {
    throw new Error(
      'MP4 recording produced an empty file. Try Chrome or Edge, or reduce resolution/duration.',
    );
  }

  emitProgress(onProgress, {
    phase: 'complete',
    progress: 1,
    message: 'Complete',
  });

  return {
    blob,
    dataUrl: includeDataUrl ? await blobToDataUrl(blob) : undefined,
    width,
    height,
    durationSeconds,
    frameRate,
    mimeType,
    fileExtension: 'mp4',
    encodeMode: 'quickPreview',
  };
}

/** Render one camera-move frame; exported for frame-level MP4 integration coverage. */
export function renderCameraMoveFrame(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  keyframes: ReturnType<typeof getSortedCameraKeyframes>,
  timeSeconds: number,
  width: number,
  height: number,
  clipping: { near: number; far: number },
  options?: {
    pass?: SceneRenderPass;
    objectAnimation?: {
      shot: Pick<Shot, 'objectOverrides'>;
      baseObjects: LocationProject['scene']['objects'];
      assets?: LocationProject['assets'];
      contentMode?: SceneContentMode;
      includeCharacterAttachments?: boolean;
      /** @deprecated Prefer contentMode. */
      peopleVariant?: PeopleRenderVariant;
    };
    depth?: {
      nearMeters: number;
      farMeters: number;
      invert: boolean;
      resources?: DepthPassResources;
    };
  },
) {
  // Legacy callers passed objectAnimation as the 9th argument.
  const normalized = normalizeCameraMoveFrameOptions(options);
  const cameraData = interpolateCameraKeyframes(keyframes, timeSeconds);
  // Always use the fixed move clipping range — never interpolated cameraData.near/far.
  applyFlyCameraToPerspectiveCamera(
    camera,
    flyCameraFromCamera(cameraData),
    cameraData.fovDegrees,
    width / height,
    clipping.near,
    clipping.far,
  );

  if (normalized.objectAnimation) {
    applyAnimatedObjectOverridesToScene(
      scene,
      interpolateObjectOverrides(
        keyframes,
        timeSeconds,
        normalized.objectAnimation.shot.objectOverrides,
        normalized.objectAnimation.baseObjects,
       ),
       normalized.objectAnimation.baseObjects,
       normalized.objectAnimation.assets,
       {
        contentMode: normalized.objectAnimation.contentMode
          ?? (normalized.objectAnimation.peopleVariant === 'clean_plate' ? 'clean_plate' : 'full_scene'),
        includeCharacterAttachments: normalized.objectAnimation.includeCharacterAttachments,
      },
    );
  }

  if (normalized.pass === 'depth' && normalized.depth) {
    renderDepthGrayscale(
      renderer,
      scene,
      camera,
      {
        nearMeters: normalized.depth.nearMeters,
        farMeters: normalized.depth.farMeters,
        invert: normalized.depth.invert,
        cameraNear: clipping.near,
        cameraFar: clipping.far,
      },
      normalized.depth.resources,
    );
    return;
  }

  renderer.render(scene, camera);
}

type CameraMoveObjectAnimationOptions = {
  shot: Pick<Shot, 'objectOverrides'>;
  baseObjects: LocationProject['scene']['objects'];
  assets?: LocationProject['assets'];
  contentMode?: SceneContentMode;
  includeCharacterAttachments?: boolean;
  peopleVariant?: PeopleRenderVariant;
};

function normalizeCameraMoveFrameOptions(
  options: Parameters<typeof renderCameraMoveFrame>[8],
): {
  pass: SceneRenderPass;
  objectAnimation?: CameraMoveObjectAnimationOptions;
  depth?: {
    nearMeters: number;
    farMeters: number;
    invert: boolean;
    resources?: DepthPassResources;
  };
} {
  if (!options) return { pass: 'clay' };
  // Detect legacy objectAnimation-shaped 9th argument.
  if ('shot' in options && 'baseObjects' in options && !('pass' in options) && !('objectAnimation' in options)) {
    return {
      pass: 'clay',
      objectAnimation: options as CameraMoveObjectAnimationOptions,
    };
  }
  return {
    pass: options.pass ?? (options.depth ? 'depth' : 'clay'),
    objectAnimation: options.objectAnimation,
    depth: options.depth,
  };
}

function applyAnimatedObjectOverridesToScene(
  scene: THREE.Scene,
  overrides: ReturnType<typeof interpolateObjectOverrides>,
  baseObjects: LocationProject['scene']['objects'],
  assets: LocationProject['assets'] | undefined,
  contentOptions: {
    contentMode?: SceneContentMode;
    includeCharacterAttachments?: boolean;
  },
) {
  const baseById = new Map(baseObjects.map((object) => [object.id, object]));
  for (const [objectId, override] of Object.entries(overrides)) {
    const node = findSceneObjectMesh(scene, objectId);
    if (!node) continue;
    const base = baseById.get(objectId);
    if (!base) continue;
    const transform = override.transform ?? base.transform;
    const requestedVisible = override.visible ?? base.visible;
    applySceneObjectTransform(node, transform, {
      applyScale: !sceneObjectUsesProceduralScale(base.type),
      // Keyframe snapshots retain source visibility, so they must never
      // reverse clean-plate / characters-only rules after the scene is resolved.
      visible: isObjectVisibleForContentMode(base, requestedVisible, contentOptions),
    });
      applyHumanPoseToObject3D(node, {
        id: objectId,
        type: base.type,
        poseableCharacter: base.poseableCharacter,
        humanPose: override.humanPose ?? base.humanPose,
      }, assets);
  }
}

export async function renderViewportClay(
  project: LocationProject,
  cameraData: CameraData,
  width: number,
  height: number,
): Promise<ImageRenderResult> {
  await ensureHumanMannequinForProject(project);
  const renderer = createRenderer(width, height);
  const scene = buildScene(project, createFinalRenderSceneOptions());
  const clipping = computeCameraMoveClippingRange({
    scene,
    keyframeCameras: [cameraData],
    nearMeters: cameraData.near,
  });
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
  renderer.render(scene, camera);

  // Pixel stats from the clean canvas before PNG encode (shared by package + agent).
  let pixelStats: RenderPixelStats | undefined;
  try {
    const gl = renderer.getContext();
    if (gl && width > 0 && height > 0) {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      pixelStats = computeRenderPixelStats(pixels, width, height);
    }
  } catch {
    pixelStats = undefined;
  }

  const dataUrl = renderer.domElement.toDataURL('image/png');

  disposeScene(scene);
  disposeRenderer(renderer);

  return { dataUrl, width, height, pixelStats };
}

export interface ProjectedSceneResources {
  options: ProjectedSceneOptions;
  dispose(): void;
}

/**
 * Resolve primary (and optional secondary) projector panoramas, acquire their
 * color textures, and generate live geometry-occlusion cubemaps. Returns
 * complete scene options plus a single cleanup function releasing textures and
 * disposing cubemap render targets.
 *
 * Occlusion generation failures are non-fatal: the helper falls back to plain
 * (legacy) projection so an export never crashes because a depth map failed.
 */
export async function loadProjectedSceneResources(
  renderer: THREE.WebGLRenderer,
  project: LocationProject,
  loadOptions: {
    occlusionFilterMode?: 'soft' | 'fast';
  } = {},
): Promise<ProjectedSceneResources | undefined> {
  if (!canUseProjectedAppearance(project)) return undefined;
  const assets = resolveProjectedProjectorAssets(project);
  if (!assets) return undefined;
  const settings = {
    ...assets.settings,
    occlusionFilterMode: loadOptions.occlusionFilterMode ?? assets.settings.occlusionFilterMode ?? 'soft',
  };
  const pano = assets.primary;
  const imageUrl = assets.primaryUrl;

  await ensureHumanMannequinForProject(project);
  const texture = await acquireProjectedStyleTexture(imageUrl);
  if (!texture) return undefined;

  // Optional secondary projector.
  let secondaryPano = assets.secondary;
  let secondaryTexture: THREE.Texture | null = null;
  let secondaryUrl: string | undefined;
  if (secondaryPano && assets.secondaryUrl) {
    secondaryUrl = assets.secondaryUrl;
    secondaryTexture = await acquireProjectedStyleTexture(secondaryUrl);
  }

  const occlusionSet: ProjectorOcclusionSet = { dispose() { /* populated below */ } };
  let primaryOcclusion: ProjectorOcclusionMap | undefined;
  let secondaryOcclusion: ProjectorOcclusionMap | undefined;

  if (settings.occlusionEnabled && renderer) {
    try {
      primaryOcclusion = generateProjectorOcclusionMap(renderer, project, pano.origin, {
        faceSize: DEFAULT_OCCLUSION_FACE_SIZE,
        nearMeters: DEFAULT_OCCLUSION_NEAR,
      });
      // Reuse a single map when both origins are identical.
      const sameOrigin = secondaryPcclusionSameOrigin(pano.origin, secondaryPano?.origin);
      if (secondaryPano && secondaryTexture && !sameOrigin) {
        secondaryOcclusion = generateProjectorOcclusionMap(renderer, project, secondaryPano.origin, {
          faceSize: DEFAULT_OCCLUSION_FACE_SIZE,
          nearMeters: DEFAULT_OCCLUSION_NEAR,
        });
      } else if (secondaryPano && secondaryTexture && sameOrigin) {
        secondaryOcclusion = primaryOcclusion;
      }
      occlusionSet.dispose = () => {
        primaryOcclusion?.dispose();
        if (secondaryOcclusion && secondaryOcclusion !== primaryOcclusion) secondaryOcclusion.dispose();
      };
    } catch (error) {
      console.error('[projected-occlusion] generation failed; using legacy projection:', error);
      primaryOcclusion = undefined;
      secondaryOcclusion = undefined;
      occlusionSet.dispose = () => {};
    }
  }

  const options: ProjectedSceneOptions = {
    texture,
    origin: pano.origin,
    rotation: pano.rotation,
    panoramaWidth: pano.width,
    panoramaHeight: pano.height,
    settings,
    disposableMaterials: true,
    occlusionTexture: primaryOcclusion?.texture,
    occlusionNearMeters: primaryOcclusion?.nearMeters,
    occlusionFarMeters: primaryOcclusion?.farMeters,
    occlusionFaceSize: primaryOcclusion?.faceSize,
    secondaryTexture: secondaryTexture ?? undefined,
    secondaryOrigin: secondaryPano?.origin,
    secondaryRotation: secondaryPano?.rotation,
    secondaryPanoramaWidth: secondaryPano?.width,
    secondaryPanoramaHeight: secondaryPano?.height,
    secondaryOcclusionTexture: secondaryOcclusion?.texture,
    secondaryOcclusionNearMeters: secondaryOcclusion?.nearMeters,
    secondaryOcclusionFarMeters: secondaryOcclusion?.farMeters,
    secondaryOcclusionFaceSize: secondaryOcclusion?.faceSize,
  };

  return {
    options,
    dispose() {
      occlusionSet.dispose();
      releaseProjectedStyleTexture(imageUrl);
      if (secondaryUrl) releaseProjectedStyleTexture(secondaryUrl);
    },
  };
}

function secondaryPcclusionSameOrigin(
  a: Vec3 | undefined,
  b: Vec3 | undefined,
): boolean {
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Render a 4K equirect from the current capture origin with Projected Style applied.
 * Use after moving the origin (e.g. coverage optimizer B) to seed second-pano inpainting.
 * Does not write a project pano ref — download/import is the caller's job.
 */
export async function renderProjectedEquirectangularPano(
  project: LocationProject,
  width = DEFAULT_GRAYBOX_PANO_WIDTH,
  height = DEFAULT_GRAYBOX_PANO_HEIGHT,
  theme: SceneVisualTheme = 'light',
): Promise<ImageRenderResult> {
  await ensureHumanMannequinForProject(project);
  const renderer = createRenderer(width, height);
  const resources = await loadProjectedSceneResources(renderer, project);
  if (!resources) {
    disposeRenderer(renderer);
    throw new Error(
      'Projected 360 export requires an importable styled panorama with a valid image asset.',
    );
  }

  const scene = buildScene(project, {
    showHelpers: false,
    showGrid: false,
    hiddenObjectTypes: ['sun_marker'],
    theme,
    fog: false,
    appearance: 'projected',
    projected: resources.options,
  });
  const dataUrl = await blobToDataUrl(await captureEquirectangularFromOrigin(renderer, scene, project, width, height));
  disposeScene(scene);
  resources.dispose();
  disposeRenderer(renderer);
  return { dataUrl, width, height };
}

/**
 * Render a camera frame with world-space projected style appearance.
 * Throws when projected export is requested but no valid projector is available.
 */
export async function renderViewportProjected(
  project: LocationProject,
  cameraData: CameraData,
  width: number,
  height: number,
): Promise<ImageRenderResult> {
  return renderViewportProjectedInternal(project, cameraData, width, height, false);
}

/**
 * Render the projected frame and a renderer-derived coverage pass. The health
 * pass uses the projected shader's ownership colors rather than white-pixel
 * heuristics, so fallback geometry and actual panorama contribution are
 * measured independently.
 */
export async function renderViewportProjectedWithHealth(
  project: LocationProject,
  cameraData: CameraData,
  width: number,
  height: number,
): Promise<ProjectedHealthRenderResult> {
  return renderViewportProjectedInternal(project, cameraData, width, height, true) as Promise<ProjectedHealthRenderResult>;
}

async function renderViewportProjectedInternal(
  project: LocationProject,
  cameraData: CameraData,
  width: number,
  height: number,
  includeHealth: boolean,
): Promise<ImageRenderResult & { projectionHealth?: ProjectionHealthMetrics }> {
  await ensureHumanMannequinForProject(project);
  const renderer = createRenderer(width, height);
  const resources = await loadProjectedSceneResources(renderer, project);
  if (!resources) {
    disposeRenderer(renderer);
    throw new Error(
      'Projected viewport export requires an importable styled panorama with a valid image asset.',
    );
  }

  const scene = buildScene(project, {
    ...createFinalRenderSceneOptions(),
    appearance: 'projected',
    projected: resources.options,
  });
  let projectedMaterialCount = 0;
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    projectedMaterialCount += materials.filter((material) => isProjectedStyleMaterial(material)).length;
  });
  const clipping = computeCameraMoveClippingRange({
    scene,
    keyframeCameras: [cameraData],
    nearMeters: cameraData.near,
  });
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
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL('image/png');

  let projectionHealth: ProjectionHealthMetrics | undefined;
  if (includeHealth) {
    const debugScene = buildScene(project, {
      ...createFinalRenderSceneOptions(),
      appearance: 'projected',
      projected: {
        ...resources.options,
        settings: {
          ...resources.options.settings,
          occlusionDebugMode: 'coverage',
        },
      },
    });
    renderer.render(debugScene, camera);
    const pixels = new Uint8Array(Math.max(0, width * height * 4));
    let analyzed = analyzeProjectionDebugPixels(pixels, width, height);
    try {
      const gl = renderer.getContext();
      if (gl && width > 0 && height > 0) {
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        analyzed = analyzeProjectionDebugPixels(pixels, width, height);
      }
    } catch {
      // Keep zeroed metrics; the Agent result will expose the failed coverage
      // rather than pretending a linked panorama proves projection health.
    }
    projectionHealth = {
      projectedTextureAvailable: true,
      occlusionMapAvailable: Boolean(
        resources.options.occlusionTexture || resources.options.secondaryOcclusionTexture,
      ),
      projectedMaterialCount,
      ...analyzed,
    };
    disposeScene(debugScene);
  }

  disposeScene(scene);
  resources.dispose();
  disposeRenderer(renderer);

  return {
    dataUrl,
    width,
    height,
    ...(projectionHealth ? { projectionHealth } : {}),
  };
}

export async function renderShotProjectedFrame(
  project: LocationProject,
  shot: Shot,
  options: { peopleVariant?: PeopleRenderVariant } = {},
): Promise<ImageRenderResult> {
  return renderViewportProjected(
    resolveProjectForShot(project, shot, {
      contentMode: options.peopleVariant === 'clean_plate' ? 'clean_plate' : 'full_scene',
    }),
    shot.camera,
    shot.exportSettings.width,
    shot.exportSettings.height,
  );
}

export async function renderShotProjectedFrameWithHealth(
  project: LocationProject,
  shot: Shot,
  options: { peopleVariant?: PeopleRenderVariant } = {},
): Promise<ProjectedHealthRenderResult> {
  return renderViewportProjectedWithHealth(
    resolveProjectForShot(project, shot, {
      contentMode: options.peopleVariant === 'clean_plate' ? 'clean_plate' : 'full_scene',
    }),
    shot.camera,
    shot.exportSettings.width,
    shot.exportSettings.height,
  );
}

/** Transparent PNG still of characters (+ optional linked props) for package export. */
export async function renderShotCharacterFrame(
  project: LocationProject,
  shot: Shot,
  options: {
    appearance?: 'clay' | 'projected';
    includeAttachedProps?: boolean;
  } = {},
): Promise<BlobImageRenderResult> {
  const appearance = options.appearance ?? 'clay';
  const includeCharacterAttachments = options.includeAttachedProps !== false;
  const shotProject = resolveProjectForShot(project, shot, {
    contentMode: 'characters_only',
    includeCharacterAttachments,
  });

  await ensureHumanMannequinForProject(shotProject);
  const width = shot.exportSettings.width;
  const height = shot.exportSettings.height;
  const renderer = createRenderer(width, height, { alpha: true });
  let projectedResources: ProjectedSceneResources | undefined;
  let scene: THREE.Scene | undefined;

  try {
    if (appearance === 'projected') {
      projectedResources = await loadProjectedSceneResources(renderer, shotProject);
      if (!projectedResources) {
        throw new Error(
          'Projected character still requires an importable styled panorama with a valid image asset.',
        );
      }
    }

    scene = buildScene(shotProject, {
      ...createFinalRenderSceneOptions(),
      appearance: projectedResources ? 'projected' : 'clay',
      projected: projectedResources?.options,
    });
    scene.background = null;
    scene.fog = null;
    renderer.setClearColor(0x000000, 0);

    const clipping = computeCameraMoveClippingRange({
      scene,
      keyframeCameras: [shot.camera],
      nearMeters: shot.camera.near,
    });
    const camera = new THREE.PerspectiveCamera(
      shot.camera.fovDegrees,
      width / height,
      clipping.near,
      clipping.far,
    );
    applyFlyCameraToPerspectiveCamera(
      camera,
      flyCameraFromCamera(shot.camera),
      shot.camera.fovDegrees,
      width / height,
      clipping.near,
      clipping.far,
    );
    renderer.render(scene, camera);
    const blob = await canvasToBlob(renderer.domElement, 'image/png');
    return { blob, width, height };
  } finally {
    if (scene) disposeScene(scene);
    projectedResources?.dispose();
    disposeRenderer(renderer);
  }
}

export interface CharacterMotionExportResult {
  mp4?: VideoRenderResult;
  frameCount: number;
  durationSeconds: number;
  frameRate: number;
  width: number;
  height: number;
}

export interface CharacterMotionExportOptions {
  appearance?: 'clay' | 'projected';
  motionFormat: CharacterMotionExportFormat;
  backgroundColor?: string;
  includeAttachedProps?: boolean;
  frameRate?: number;
  resolutionPreset?: VideoResolutionPresetId;
  onProgress?: CameraMoveVideoOptions['onProgress'];
  signal?: AbortSignal;
  /** Receive each transparent PNG frame (1-based numbering handled by caller). */
  onPngFrame?: (
    frameIndex: number,
    blob: Blob,
    meta: { timeSeconds: number; width: number; height: number },
  ) => void | Promise<void>;
}

/**
 * Characters-only camera-move export: green MP4, transparent PNG sequence, or both
 * from a single WebGL pass when Both is selected.
 */
export async function renderShotCharacterMotion(
  project: LocationProject,
  shot: Shot,
  options: CharacterMotionExportOptions,
): Promise<CharacterMotionExportResult> {
  const includeMp4 = characterPassIncludesGreenMp4(options.motionFormat);
  const includePng = characterPassIncludesPngSequence(options.motionFormat);
  const backgroundColor = options.backgroundColor ?? '#00FF00';
  const includeAttachedProps = options.includeAttachedProps !== false;
  const appearance = options.appearance ?? 'clay';

  if (!includeMp4 && !includePng) {
    throw new Error('Character motion export requires MP4 and/or PNG sequence output.');
  }

  if (includeMp4 && includePng) {
    // One WebGL pass: transparent frames fork to PNG; composite onto green for H.264.
    const video = await renderShotCameraMoveMp4(project, shot, {
      mode: 'render',
      appearance,
      contentMode: 'characters_only',
      includeCharacterAttachments: includeAttachedProps,
      backgroundColor,
      transparent: true,
      resolutionPreset: options.resolutionPreset ?? '1080p',
      frameRate: options.frameRate,
      includeDataUrl: false,
      signal: options.signal,
      onProgress: options.onProgress,
      onFrameRendered: async (canvas, frameIndex, timeSeconds) => {
        if (!options.onPngFrame) return;
        const blob = await canvasToBlob(canvas, 'image/png');
        await options.onPngFrame(frameIndex, blob, {
          timeSeconds,
          width: canvas.width,
          height: canvas.height,
        });
      },
    });
    return {
      mp4: video,
      frameCount: computeCameraMoveFrameCount(video.durationSeconds, video.frameRate),
      durationSeconds: video.durationSeconds,
      frameRate: video.frameRate,
      width: video.width,
      height: video.height,
    };
  }

  if (includeMp4) {
    const video = await renderShotCameraMoveMp4(project, shot, {
      mode: 'render',
      appearance,
      contentMode: 'characters_only',
      includeCharacterAttachments: includeAttachedProps,
      backgroundColor,
      resolutionPreset: options.resolutionPreset ?? '1080p',
      frameRate: options.frameRate,
      includeDataUrl: false,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    return {
      mp4: video,
      frameCount: computeCameraMoveFrameCount(video.durationSeconds, video.frameRate),
      durationSeconds: video.durationSeconds,
      frameRate: video.frameRate,
      width: video.width,
      height: video.height,
    };
  }

  // PNG sequence only — shared deterministic frame producer, no encoder.
  const sequence = await renderCameraMoveFrames({
    project,
    shot,
    appearance,
    contentMode: 'characters_only',
    includeCharacterAttachments: includeAttachedProps,
    transparent: true,
    frameRate: options.frameRate,
    resolutionPreset: options.resolutionPreset ?? '1080p',
    signal: options.signal,
    onProgress: options.onProgress,
    consumeFrame: async (canvas, frameIndex, timeSeconds) => {
      if (!options.onPngFrame) return;
      const blob = await canvasToBlob(canvas, 'image/png');
      await options.onPngFrame(frameIndex, blob, {
        timeSeconds,
        width: canvas.width,
        height: canvas.height,
      });
    },
  });

  return {
    frameCount: sequence.frameCount,
    durationSeconds: sequence.durationSeconds,
    frameRate: sequence.frameRate,
    width: sequence.width,
    height: sequence.height,
  };
}

export interface CameraMoveSequenceMetadata {
  frameCount: number;
  durationSeconds: number;
  frameRate: number;
  width: number;
  height: number;
}

/**
 * Deterministic camera-move frame producer shared by MP4 and PNG sequence exporters.
 */
export async function renderCameraMoveFrames(options: {
  project: LocationProject;
  shot: Shot;
  width?: number;
  height?: number;
  frameRate?: number;
  resolutionPreset?: VideoResolutionPresetId;
  appearance?: 'clay' | 'projected' | 'depth';
  contentMode?: SceneContentMode;
  includeCharacterAttachments?: boolean;
  transparent?: boolean;
  backgroundColor?: string;
  signal?: AbortSignal;
  onProgress?: CameraMoveVideoOptions['onProgress'];
  consumeFrame: (
    canvas: HTMLCanvasElement,
    frameIndex: number,
    timeSeconds: number,
  ) => Promise<void>;
}): Promise<CameraMoveSequenceMetadata> {
  const contentMode = options.contentMode ?? 'full_scene';
  const includeCharacterAttachments = options.includeCharacterAttachments !== false;
  const appearance = options.appearance ?? 'clay';
  const animateObjects = cameraKeyframesHaveObjectAnimation(options.shot.cameraKeyframes);
  const resolveOptions = { contentMode, includeCharacterAttachments };
  const shotProject = animateObjects
    ? resolveProjectForAnimatedCameraMove(options.project, options.shot, resolveOptions)
    : resolveProjectForShot(options.project, options.shot, resolveOptions);
  const keyframes = getSortedCameraKeyframes(options.shot.cameraKeyframes);
  if (!hasRenderableCameraMove(keyframes)) {
    throw new Error('Capture start and end camera keyframes before exporting frames.');
  }

  const preset = resolveVideoPreset(options.resolutionPreset ?? '1080p');
  const frameRate = options.frameRate ?? preset.frameRate ?? DEFAULT_VIDEO_FRAME_RATE;
  const width = options.width ?? preset.width;
  const height = options.height ?? preset.height;
  const durationSeconds = getCameraMoveDurationSeconds(keyframes);
  const totalFrames = computeCameraMoveFrameCount(durationSeconds, frameRate);
  const signal = options.signal;

  emitProgress(options.onProgress, {
    phase: 'preparing',
    progress: 0,
    completedFrames: 0,
    totalFrames,
    message: 'Preparing scene',
  });

  if (signal?.aborted) {
    throw new Error('Camera move export was cancelled.');
  }

  await ensureHumanMannequinForProject(shotProject);
  const renderer = createRenderer(width, height, { alpha: options.transparent === true });
  let projectedResources: ProjectedSceneResources | undefined;
  let scene: THREE.Scene | undefined;

  try {
    if (appearance === 'projected') {
      projectedResources = await loadProjectedSceneResources(renderer, shotProject, {
        occlusionFilterMode: 'fast',
      });
      if (!projectedResources) {
        throw new Error(
          'Projected character sequence requires an importable styled panorama with a valid image asset.',
        );
      }
    }

    scene = buildScene(shotProject, {
      ...createFinalRenderSceneOptions(),
      appearance: projectedResources ? 'projected' : 'clay',
      projected: projectedResources?.options,
    });
    scene.fog = null;
    if (options.transparent) {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    } else if (options.backgroundColor) {
      scene.background = new THREE.Color(options.backgroundColor);
    }

    const nearMeters = Math.max(
      ...keyframes.map((keyframe) =>
        clampShotNearClip(keyframe.camera.near, keyframe.camera.far),
      ),
    );
    const clipping = computeCameraMoveClippingRange({
      scene,
      keyframeCameras: keyframes.map((keyframe) => keyframe.camera),
      nearMeters,
    });
    const camera = new THREE.PerspectiveCamera(
      options.shot.camera.fovDegrees,
      width / height,
      clipping.near,
      clipping.far,
    );

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (signal?.aborted) {
        throw new Error('Camera move export was cancelled.');
      }
      const timeSeconds = cameraMoveFrameTimeSeconds(frameIndex, frameRate, durationSeconds);
      renderCameraMoveFrame(
        renderer,
        scene,
        camera,
        keyframes,
        timeSeconds,
        width,
        height,
        clipping,
        {
          pass: appearance === 'depth' ? 'clay' : appearance,
          objectAnimation: animateObjects
            ? {
              shot: options.shot,
              baseObjects: options.project.scene.objects,
              assets: options.project.assets,
              contentMode,
              includeCharacterAttachments,
            }
            : undefined,
        },
      );
      await options.consumeFrame(renderer.domElement, frameIndex, timeSeconds);
      const completedFrames = frameIndex + 1;
      emitProgress(options.onProgress, {
        phase: 'rendering',
        progress: completedFrames / totalFrames,
        completedFrames,
        totalFrames,
        message: `Rendering frame ${completedFrames} of ${totalFrames}`,
      });
    }

    return {
      frameCount: totalFrames,
      durationSeconds,
      frameRate,
      width,
      height,
    };
  } finally {
    if (scene) disposeScene(scene);
    projectedResources?.dispose();
    disposeRenderer(renderer);
  }
}

export async function renderPanoPerspectiveCrop(
  imageUrl: string,
  crop: PanoCropSettings,
  panoRotation: Euler = [0, 0, 0],
): Promise<ImageRenderResult> {
  const renderer = createRenderer(crop.width, crop.height);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const texture = await loadTexture(imageUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      panoMap: { value: texture },
      yaw: { value: degreesToRadians(crop.yawDegrees - panoRotation[1]) },
      pitch: { value: degreesToRadians(crop.pitchDegrees) },
      roll: { value: degreesToRadians(crop.rollDegrees) },
      fov: { value: degreesToRadians(crop.fovDegrees) },
      aspect: { value: crop.aspectRatio },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D panoMap;
      uniform float yaw;
      uniform float pitch;
      uniform float roll;
      uniform float fov;
      uniform float aspect;
      varying vec2 vUv;
      const float PI = 3.141592653589793;

      mat3 rotateX(float angle) {
        float s = sin(angle);
        float c = cos(angle);
        return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c);
      }

      mat3 rotateY(float angle) {
        float s = sin(angle);
        float c = cos(angle);
        return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
      }

      mat3 rotateZ(float angle) {
        float s = sin(angle);
        float c = cos(angle);
        return mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0);
      }

      void main() {
        // Looking +Z with Y-up: +ndc.x samples +X (screen right). Must match the 3D
        // viewfinder and cubemap faces — do not negate X or pano crops appear mirrored.
        vec2 ndc = vUv * 2.0 - 1.0;
        float tanHalfFov = tan(fov * 0.5);
        vec3 dir = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, 1.0));
        dir = rotateY(yaw) * rotateX(pitch) * rotateZ(roll) * dir;
        float u = atan(dir.x, dir.z) / (2.0 * PI) + 0.5;
        float v = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;
        gl_FragColor = texture2D(panoMap, vec2(fract(u), clamp(v, 0.0, 1.0)));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(plane);

  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL('image/png');

  plane.geometry.dispose();
  material.dispose();
  texture.dispose();
  disposeRenderer(renderer);

  return { dataUrl, width: crop.width, height: crop.height };
}

export async function renderPanoCubemapFaces(
  imageUrl: string,
  options: PanoCubemapRenderOptions = {},
): Promise<PanoCubemapRenderResult> {
  const cubemap = await renderPanoCubemapFacesAsBlobs(imageUrl, options);
  const faces = {} as Record<CameraMoveCubemapFaceId, ImageRenderResult>;

  for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
    const rendered = cubemap.faces[face];
    faces[face] = {
      dataUrl: await blobToDataUrl(rendered.blob),
      width: rendered.width,
      height: rendered.height,
    };
  }

  return { faceSize: cubemap.faceSize, faces };
}

/**
 * Render faces one at a time and retain PNG Blobs for memory-sensitive export
 * flows. The source panorama is decoded once instead of once per face.
 */
export async function renderPanoCubemapFacesAsBlobs(
  imageUrl: string,
  options: PanoCubemapRenderOptions = {},
): Promise<PanoCubemapBlobRenderResult> {
  const faceSize = options.faceSize ?? DEFAULT_CAMERA_MOVE_CUBEMAP_FACE_SIZE;
  const sourceImage = await loadImage(imageUrl);
  const faces = {} as Record<CameraMoveCubemapFaceId, BlobImageRenderResult>;

  try {
    for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
      const rendered = await renderPanoCubemapFaceBlob(
        sourceImage,
        face,
        faceSize,
        options.panoRotation ?? [0, 0, 0],
      );
      faces[face] = rendered;
      await options.onFaceRendered?.(face, rendered);
    }
  } finally {
    // Drop a potentially large data-URI reference as soon as every face has been drawn.
    sourceImage.src = '';
  }

  return {
    faceSize,
    faces,
  };
}

async function renderPanoCubemapFaceBlob(
  sourceImage: HTMLImageElement,
  face: CameraMoveCubemapFaceId,
  faceSize: number,
  panoRotation: Euler,
): Promise<BlobImageRenderResult> {
  const renderer = createRenderer(faceSize, faceSize);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const texture = new THREE.Texture(sourceImage);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      panoMap: { value: texture },
      faceIndex: { value: CAMERA_MOVE_CUBEMAP_FACES.indexOf(face) },
      panoYaw: { value: degreesToRadians(panoRotation[1] ?? 0) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D panoMap;
      uniform int faceIndex;
      uniform float panoYaw;
      varying vec2 vUv;
      const float PI = 3.141592653589793;

      vec3 applyInversePanoYaw(vec3 direction, float yaw) {
        float s = sin(yaw);
        float c = cos(yaw);
        return normalize(vec3(
          direction.x * c - direction.z * s,
          direction.y,
          direction.z * c + direction.x * s
        ));
      }

      vec3 directionForFace(float sc, float tc) {
        if (faceIndex == 0) return normalize(vec3(1.0, tc, -sc));
        if (faceIndex == 1) return normalize(vec3(-1.0, tc, sc));
        if (faceIndex == 2) return normalize(vec3(sc, 1.0, -tc));
        if (faceIndex == 3) return normalize(vec3(sc, -1.0, tc));
        if (faceIndex == 4) return normalize(vec3(sc, tc, 1.0));
        return normalize(vec3(-sc, tc, -1.0));
      }

      void main() {
        float sc = vUv.x * 2.0 - 1.0;
        float tc = vUv.y * 2.0 - 1.0;
        vec3 direction = applyInversePanoYaw(directionForFace(sc, tc), panoYaw);
        float u = atan(direction.x, direction.z) / (2.0 * PI) + 0.5;
        float v = asin(clamp(direction.y, -1.0, 1.0)) / PI + 0.5;
        gl_FragColor = texture2D(panoMap, vec2(fract(u), clamp(v, 0.0, 1.0)));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(plane);

  try {
    renderer.render(scene, camera);
    return {
      blob: await canvasToBlob(renderer.domElement, 'image/png'),
      width: faceSize,
      height: faceSize,
    };
  } finally {
    plane.geometry.dispose();
    material.dispose();
    texture.dispose();
    disposeRenderer(renderer);
  }
}

interface RendererCreationOptions {
  alpha?: boolean;
}

function createRenderer(
  width: number,
  height: number,
  options: RendererCreationOptions = {},
): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: options.alpha === true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/** Release GPU resources so offline graybox/shot renders can be re-run without exhausting WebGL contexts. */
function disposeRenderer(renderer: THREE.WebGLRenderer) {
  renderer.dispose();
  renderer.forceContextLoss();
  const canvas = renderer.domElement;
  if (canvas.parentElement) {
    canvas.parentElement.removeChild(canvas);
  }
}

function loadTexture(imageUrl: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(imageUrl, resolve, undefined, reject);
  });
}

function loadImage(imageUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load panorama image.'));
    image.src = imageUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode rendered image.'));
    }, type);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
