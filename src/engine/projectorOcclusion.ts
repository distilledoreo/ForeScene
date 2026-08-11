import * as THREE from 'three';
import {
  LocationProject,
  SceneObject,
  SceneObjectType,
  Vec3,
} from '../domain/types';
import {
  computeGrayboxPanoFarPlane,
} from './sceneBounds';
import { createObject3D } from './sceneObjects';
import { releaseImportedGeometry } from './importedMesh';

const DEFAULT_OCCLUSION_FACE_SIZE = 512;
const DEFAULT_OCCLUSION_NEAR = 0.05;

/** Packed-depth clear: R=G=1, B=0 (no hit). Alpha is set separately. */
const NO_HIT_CLEAR = new THREE.Color(1, 1, 0);

export interface ProjectorOcclusionMap {
  target: THREE.WebGLCubeRenderTarget;
  texture: THREE.CubeTexture;
  origin: Vec3;
  nearMeters: number;
  farMeters: number;
  faceSize: number;
  key: string;
  dispose(): void;
}

export interface ProjectorOcclusionOptions {
  faceSize?: number;
  nearMeters?: number;
  hiddenObjectTypes?: SceneObjectType[];
}

export interface ProjectorOcclusionSet {
  primary?: ProjectorOcclusionMap;
  secondary?: ProjectorOcclusionMap;
  dispose(): void;
}

/**
 * People are staging references, not set geometry. They remain visible in the
 * projected viewport with their clay material, but must not cast projection
 * occlusion shadows or trigger cubemap regeneration when repositioned.
 */
export function shouldContributeProjectionOcclusion(
  object: Pick<SceneObject, 'type' | 'visible'>,
): boolean {
  if (!object.visible) return false;
  return object.type !== 'sun_marker' && object.type !== 'human_dummy';
}

function cloneAsCubeTexture(target: THREE.WebGLCubeRenderTarget): THREE.CubeTexture {
  return target.texture as unknown as THREE.CubeTexture;
}

/**
 * Build an occluder scene that contains only solid, opaque set geometry from
 * the current project: architecture, environment, and imported models. Editor
 * helpers and people are excluded so they never cast projection shadows.
 */
function buildOccluderScene(
  project: LocationProject,
  hiddenObjectTypes: SceneObjectType[] = [],
): THREE.Scene {
  const hiddenTypes = new Set<string>(hiddenObjectTypes);
  const scene = new THREE.Scene();
  scene.background = null;
  scene.environment = null;

  for (const object of project.scene.objects) {
    if (!shouldContributeProjectionOcclusion(object)) continue;
    if (hiddenTypes.has(object.type)) continue;
    const mesh = createObject3D(object, false, 'light', project.assets);
    mesh.userData.sceneObjectId = object.id;
    scene.add(mesh);
  }

  return scene;
}

function createRadialDepthMaterial(
  origin: Vec3,
  nearMeters: number,
  farMeters: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      occlusionOrigin: { value: new THREE.Vector3(...origin) },
      occlusionNear: { value: nearMeters },
      occlusionFar: { value: farMeters },
    },
    vertexShader: /* glsl */`
      varying vec3 vOcclusionWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vOcclusionWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 occlusionOrigin;
      uniform float occlusionNear;
      uniform float occlusionFar;
      varying vec3 vOcclusionWorldPosition;

      vec2 packDepth16(float value) {
        float scaled = floor(clamp(value, 0.0, 1.0) * 65535.0 + 0.5);
        float highByte = floor(scaled / 256.0);
        float lowByte = scaled - highByte * 256.0;
        return vec2(highByte, lowByte) / 255.0;
      }

      void main() {
        float distanceMeters = length(vOcclusionWorldPosition - occlusionOrigin);
        float normalizedDepth = clamp(
          (distanceMeters - occlusionNear) /
          max(occlusionFar - occlusionNear, 0.0001),
          0.0,
          1.0
        );
        gl_FragColor = vec4(packDepth16(normalizedDepth), 1.0, 1.0);
      }
    `,
  });
}

export function computeProjectorFarPlane(
  scene: THREE.Scene,
  projectorOrigin: Vec3,
  nearMeters = DEFAULT_OCCLUSION_NEAR,
): number {
  return computeGrayboxPanoFarPlane(scene, projectorOrigin, nearMeters);
}

function disposeOccluderScene(scene: THREE.Scene): void {
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!releaseImportedGeometry(mesh.geometry)) mesh.geometry.dispose();
  });
}

export function generateProjectorOcclusionMap(
  renderer: THREE.WebGLRenderer,
  project: LocationProject,
  origin: Vec3,
  options: ProjectorOcclusionOptions = {},
): ProjectorOcclusionMap {
  const faceSize = options.faceSize ?? DEFAULT_OCCLUSION_FACE_SIZE;
  const nearMeters = options.nearMeters ?? DEFAULT_OCCLUSION_NEAR;
  const occluderScene = buildOccluderScene(project, options.hiddenObjectTypes);
  let target: THREE.WebGLCubeRenderTarget | undefined;
  let depthMaterial: THREE.ShaderMaterial | undefined;
  let sceneDisposed = false;
  try {
    const farMeters = computeProjectorFarPlane(occluderScene, origin, nearMeters);
    target = new THREE.WebGLCubeRenderTarget(faceSize, {
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    target.texture.colorSpace = THREE.NoColorSpace;
    target.texture.generateMipmaps = false;
    target.texture.minFilter = THREE.NearestFilter;
    target.texture.magFilter = THREE.NearestFilter;
    (target.texture as THREE.CubeTexture).mapping = THREE.CubeReflectionMapping;

    const material = createRadialDepthMaterial(origin, nearMeters, farMeters);
    depthMaterial = material;
    occluderScene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.material = material;
    });

    const previousClearColor = new THREE.Color();
    const previousClearAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    const previousToneMapping = renderer.toneMapping;
    const previousOutputColorSpace = renderer.outputColorSpace;
    renderer.getClearColor(previousClearColor);

    const cubeCamera = new THREE.CubeCamera(nearMeters, farMeters, target);
    cubeCamera.position.set(origin[0], origin[1], origin[2]);
    try {
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.autoClear = true;
      renderer.setClearColor(NO_HIT_CLEAR, 1);
      cubeCamera.update(renderer, occluderScene);
    } finally {
      renderer.setClearColor(previousClearColor, previousClearAlpha);
      renderer.autoClear = previousAutoClear;
      renderer.toneMapping = previousToneMapping;
      renderer.outputColorSpace = previousOutputColorSpace;
    }

    disposeOccluderScene(occluderScene);
    sceneDisposed = true;
    depthMaterial.dispose();
    depthMaterial = undefined;

    const key = computeProjectorOcclusionKey(project, origin);
    const completedTarget = target;
    target = undefined;
    return {
      target: completedTarget,
      texture: cloneAsCubeTexture(completedTarget),
      origin: [...origin] as Vec3,
      nearMeters,
      farMeters,
      faceSize,
      key,
      dispose() {
        completedTarget.dispose();
      },
    };
  } catch (error) {
    if (!sceneDisposed) disposeOccluderScene(occluderScene);
    depthMaterial?.dispose();
    target?.dispose();
    throw error;
  }
}

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function computeProjectorOcclusionKey(
  project: LocationProject,
  primaryOrigin: Vec3,
  secondaryOrigin?: Vec3,
): string {
  const objects = [...project.scene.objects]
    .filter(shouldContributeProjectionOcclusion)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const parts: string[] = [];
  for (const object of objects) {
    const imported = object.importedModel;
    parts.push(JSON.stringify({
      id: object.id,
      type: object.type,
      visible: object.visible,
      position: object.transform.position,
      rotation: object.transform.rotation,
      scale: object.transform.scale,
      dimensions: object.dimensions,
      modelAssetId: object.modelAssetId,
      importedRevision: imported
        ? [imported.sourceImportId, imported.meshCount, imported.vertexCount, imported.triangleCount]
        : null,
    }));
  }

  const payload = JSON.stringify({
    o: project.scene.panoOrigin,
    p: primaryOrigin,
    s: secondaryOrigin ?? null,
    objects: parts,
  });
  return fnv1aHash(payload);
}

export { DEFAULT_OCCLUSION_FACE_SIZE, DEFAULT_OCCLUSION_NEAR };
