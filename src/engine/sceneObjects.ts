import * as THREE from 'three';
import {
  AssetRegistry,
  Euler,
  Landmark,
  LocationProject,
  ObjectSurfaceStyle,
  ProjectedStyleSettings,
  SceneObject,
  SceneObjectType,
  Transform,
  Vec3,
} from '../domain/types';
import { createHumanMannequinObject } from './humanMannequinModel';
import './builtinMannequinCharacter';
import {
  applyHumanPoseToObject3D,
  registerPoseableCharacterInstance,
  resolvePoseableCharacterForObject,
} from './poseableCharacter';
import { createImportedMeshNode, releaseImportedGeometry } from './importedMesh';
import { isMissingSceneObject } from './projectAssetRecovery';
import { createProjectedStyleMaterial, isProjectedStyleMaterial } from './projectedStyleMaterials';
import { degreesToRadians } from './sync';

export type SceneVisualTheme = 'light' | 'dark';

export const DEFAULT_BUILD_FOG_NEAR = 18;
export const DEFAULT_BUILD_FOG_FAR = 42;

/** Keep the shroud readable while making its outer edge follow Build visibility distance. */
export function computeBuildFogRange(distance: number): { near: number; far: number } {
  const far = Number.isFinite(distance) ? Math.max(DEFAULT_BUILD_FOG_NEAR + 1, distance) : DEFAULT_BUILD_FOG_FAR;
  return {
    near: Math.max(8, Math.min(far * 0.45, far - 1)),
    far,
  };
}

/** World-space checker tile size in meters (1m × 1m scale reference). */
export const CHECKERBOARD_TILE_METERS = 1;

const DEFAULT_SOLID_PALETTE = [
  '#c8cdc8',
  '#7aa2c4',
  '#c79a48',
  '#5f9b7a',
  '#c47a7a',
  '#8b7ab8',
  '#d4a574',
  '#6a9e8f',
] as const;

function createArchitectureMaterial(color: number, roughness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness: 0.04,
  });
}

const materialByTheme: Record<SceneVisualTheme, Record<SceneObject['category'], THREE.MeshStandardMaterial>> = {
  light: {
    architecture: createArchitectureMaterial(0xc8cdc8, 0.74),
    environment: createArchitectureMaterial(0x9aab96, 0.8),
    helper: new THREE.MeshStandardMaterial({ color: 0xc79a48, roughness: 0.72, metalness: 0.02 }),
    landmark: new THREE.MeshStandardMaterial({ color: 0x5f9b7a, roughness: 0.62, metalness: 0.03 }),
  },
  dark: {
    architecture: createArchitectureMaterial(0xb8c0bc, 0.8),
    environment: createArchitectureMaterial(0x8d9892, 0.84),
    helper: new THREE.MeshStandardMaterial({ color: 0xb8843a, roughness: 0.74, metalness: 0.02 }),
    landmark: new THREE.MeshStandardMaterial({ color: 0x4ab49c, roughness: 0.62, metalness: 0.03 }),
  },
};

const lightFloorMaterial = new THREE.MeshStandardMaterial({ color: 0xd8ddd8, roughness: 0.9, metalness: 0.01 });
const darkFloorMaterial = new THREE.MeshStandardMaterial({ color: 0x242c32, roughness: 0.92, metalness: 0.01 });
const panoOriginMaterial = new THREE.MeshStandardMaterial({ color: 0xd08a28, emissive: 0x3a2306 });
const landmarkMaterial = new THREE.MeshStandardMaterial({ color: 0x5f9b7a, emissive: 0x0b2e1e });
const mannequinMaterialByTheme: Record<SceneVisualTheme, THREE.MeshStandardMaterial> = {
  light: new THREE.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.72, metalness: 0.04 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x9aa5b0, roughness: 0.76, metalness: 0.05 }),
};
const treeTrunkMaterialByTheme: Record<SceneVisualTheme, THREE.MeshStandardMaterial> = {
  light: new THREE.MeshStandardMaterial({ color: 0x7c5a3a, roughness: 0.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x6f5b47, roughness: 0.9 }),
};
const treeCrownMaterialByTheme: Record<SceneVisualTheme, THREE.MeshStandardMaterial> = {
  light: new THREE.MeshStandardMaterial({ color: 0x6fa36c, roughness: 0.85 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x7f8d84, roughness: 0.85 }),
};
const panoOriginRingMaterial = new THREE.MeshBasicMaterial({ color: 0xf97316 });
const SHARED_MATERIALS = new Set<THREE.Material>([
  ...Object.values(materialByTheme.light),
  ...Object.values(materialByTheme.dark),
  lightFloorMaterial,
  darkFloorMaterial,
  panoOriginMaterial,
  landmarkMaterial,
  ...Object.values(mannequinMaterialByTheme),
  ...Object.values(treeTrunkMaterialByTheme),
  ...Object.values(treeCrownMaterialByTheme),
  panoOriginRingMaterial,
]);
const SHARED_GEOMETRIES = new Set<THREE.BufferGeometry>();
const primitiveGeometryCache = new Map<string, THREE.BufferGeometry>();
const solidMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
const checkerMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
const MAX_CACHED_PRIMITIVE_GEOMETRIES = 256;
const MAX_CACHED_SURFACE_MATERIALS = 128;

function getSharedPrimitiveGeometry<T extends THREE.BufferGeometry>(
  key: string,
  create: () => T,
): T {
  const cached = primitiveGeometryCache.get(key) as T | undefined;
  if (cached) return cached;
  const geometry = create();
  if (primitiveGeometryCache.size < MAX_CACHED_PRIMITIVE_GEOMETRIES) {
    primitiveGeometryCache.set(key, geometry);
    SHARED_GEOMETRIES.add(geometry);
  }
  return geometry;
}

function cacheSurfaceMaterial(
  cache: Map<string, THREE.MeshStandardMaterial>,
  key: string,
  create: () => THREE.MeshStandardMaterial,
): THREE.MeshStandardMaterial {
  const cached = cache.get(key);
  if (cached) return cached;
  const material = create();
  if (cache.size < MAX_CACHED_SURFACE_MATERIALS) {
    cache.set(key, material);
    SHARED_MATERIALS.add(material);
  }
  return material;
}

export function defaultSolidColorForObject(object: Pick<SceneObject, 'id' | 'category' | 'type'>): string {
  if (object.type === 'floor') return '#d8ddd8';
  if (object.category === 'environment') return '#9aab96';
  if (object.category === 'helper') return '#c79a48';
  if (object.category === 'landmark') return '#5f9b7a';
  const hash = object.id.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return DEFAULT_SOLID_PALETTE[hash % DEFAULT_SOLID_PALETTE.length];
}

export function defaultSecondaryColor(primaryHex: string): string {
  const color = new THREE.Color(primaryHex);
  color.offsetHSL(0, 0, color.getHSL({ h: 0, s: 0, l: 0 }).l > 0.45 ? -0.28 : 0.22);
  return `#${color.getHexString()}`;
}

function createSolidMaterial(hex: string): THREE.MeshStandardMaterial {
  const color = new THREE.Color(hex);
  return cacheSurfaceMaterial(solidMaterialCache, color.getHexString(), () => new THREE.MeshStandardMaterial({
    color,
    roughness: 0.76,
    metalness: 0.03,
  }));
}

/**
 * 1m × 1m world-space checkerboard with square tiles on each face.
 * Uses face-dominant axes (from screen-space derivatives of world position) so tiles stay
 * square meters on floors and walls, not 3D diagonal rhomboids.
 */
function createCheckerboardMaterial(primaryHex: string, secondaryHex: string): THREE.MeshStandardMaterial {
  const colorA = new THREE.Color(primaryHex);
  const colorB = new THREE.Color(secondaryHex);
  const cacheKey = `${colorA.getHexString()}:${colorB.getHexString()}`;
  return cacheSurfaceMaterial(checkerMaterialCache, cacheKey, () => {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.02,
    });
    material.onBeforeCompile = (shader) => {
    shader.uniforms.checkerColorA = { value: colorA };
    shader.uniforms.checkerColorB = { value: colorB };
    shader.uniforms.checkerSize = { value: CHECKERBOARD_TILE_METERS };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCheckerWorldPos;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vCheckerWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 checkerColorA;
uniform vec3 checkerColorB;
uniform float checkerSize;
varying vec3 vCheckerWorldPos;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// Face-aligned 1m squares: project world position onto the two dominant face axes.
vec3 p = vCheckerWorldPos / max(checkerSize, 1e-4);
vec3 faceNormal = normalize(cross(dFdx(vCheckerWorldPos), dFdy(vCheckerWorldPos)));
vec3 an = abs(faceNormal);
float u;
float v;
if (an.y >= an.x && an.y >= an.z) {
  u = p.x;
  v = p.z;
} else if (an.x >= an.y && an.x >= an.z) {
  u = p.z;
  v = p.y;
} else {
  u = p.x;
  v = p.y;
}
float checker = mod(floor(u) + floor(v), 2.0);
// Avoid negative-mod glitches at tile boundaries.
if (checker < 0.0) checker += 2.0;
vec3 tileColor = mix(checkerColorA, checkerColorB, step(0.5, checker));
diffuseColor.rgb *= tileColor;`,
      );
    };
    // Colors are uniforms, not shader structure. Reusing one program avoids a
    // shader variant for every color pair while retaining per-material color.
    material.customProgramCacheKey = () => 'checkerboard-1m-face';
    return material;
  });
}

export function resolveSurfaceStyle(object: SceneObject): ObjectSurfaceStyle {
  if (object.surfaceStyle === 'solid' || object.surfaceStyle === 'checkerboard') {
    return object.surfaceStyle;
  }
  return 'default';
}

export interface ProjectedSceneOptions {
  texture: THREE.Texture;
  origin: Vec3;
  rotation: Euler;
  panoramaWidth?: number;
  panoramaHeight?: number;
  settings: ProjectedStyleSettings;
  /** Dispose projected materials with the scene (export / one-shot). */
  disposableMaterials?: boolean;

  occlusionTexture?: THREE.CubeTexture;
  occlusionNearMeters?: number;
  occlusionFarMeters?: number;
  occlusionFaceSize?: number;

  secondaryTexture?: THREE.Texture;
  secondaryOrigin?: Vec3;
  secondaryRotation?: Euler;
  secondaryPanoramaWidth?: number;
  secondaryPanoramaHeight?: number;

  secondaryOcclusionTexture?: THREE.CubeTexture;
  secondaryOcclusionNearMeters?: number;
  secondaryOcclusionFarMeters?: number;
  secondaryOcclusionFaceSize?: number;
}

export function buildScene(
  project: LocationProject,
  options: {
    selectedObjectIds?: string[];
    selectedShotId?: string;
    hideShotFrustums?: boolean;
    showHelpers?: boolean;
    showSceneGuides?: boolean;
    showPanoOrigin?: boolean;
    /** Build viewport grid; default true. Disable for clean projected 360 exports. */
    showGrid?: boolean;
    hiddenObjectTypes?: SceneObjectType[];
    previewObject?: SceneObject;
    theme?: SceneVisualTheme;
    fogDistance?: number;
    fog?: boolean;
    /** When 'projected' and projected options are valid, style architecture with the pano. */
    appearance?: 'clay' | 'projected';
    projected?: ProjectedSceneOptions;
    /** Interactive scenes show recoverable placeholders; final exports omit them. */
    showMissingPlaceholders?: boolean;
  } = {},
) {
  const theme = options.theme ?? 'light';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme === 'dark' ? 0x0f1419 : 0xf3f6f4);
  if (options.fog !== false) {
    const fogRange = options.fogDistance === undefined
      ? { near: DEFAULT_BUILD_FOG_NEAR, far: DEFAULT_BUILD_FOG_FAR }
      : computeBuildFogRange(options.fogDistance);
    scene.fog = new THREE.Fog(
      theme === 'dark' ? 0x0f1419 : 0xf3f6f4,
      fogRange.near,
      fogRange.far,
    );
  }
  const hiddenTypes = new Set(options.hiddenObjectTypes ?? []);

  const hemisphere = new THREE.HemisphereLight(
    theme === 'dark' ? 0xb8c4d0 : 0xffffff,
    theme === 'dark' ? 0x1a2228 : 0xd8ddd6,
    theme === 'dark' ? 0.72 : 0.95,
  );
  scene.add(hemisphere);

  const ambient = new THREE.AmbientLight(0xffffff, theme === 'dark' ? 0.28 : 0.42);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, theme === 'dark' ? 1.15 : 1.35);
  keyLight.position.set(5.5, 8.5, 4.5);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(
    theme === 'dark' ? 0xa8c0d8 : 0xfff8f0,
    theme === 'dark' ? 0.42 : 0.55,
  );
  fillLight.position.set(-4.5, 3.5, -3);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, theme === 'dark' ? 0.22 : 0.28);
  rimLight.position.set(-2, 2, 6);
  scene.add(rimLight);

  if (options.showGrid !== false) {
    const grid = new THREE.GridHelper(
      14,
      14,
      theme === 'dark' ? 0x2f3a44 : 0x9aa7a2,
      theme === 'dark' ? 0x1b252d : 0xd7dedb,
    );
    grid.position.y = 0.002;
    scene.add(grid);
  }

  const useProjected = options.appearance === 'projected' && Boolean(options.projected?.texture);

  for (const object of project.scene.objects) {
    if (!object.visible) continue;
    if (hiddenTypes.has(object.type)) continue;
    if (options.showMissingPlaceholders === false && isMissingSceneObject(object, project)) continue;
    const mesh = createObject3D(
      object,
      Boolean(options.selectedObjectIds?.includes(object.id)),
      theme,
      project.assets,
    );
    mesh.userData.sceneObjectId = object.id;
    if (useProjected && options.projected && shouldReceiveProjectedStyle(object)) {
      applyProjectedStyleToObject(mesh, object, theme, options.projected);
    }
    scene.add(mesh);
  }

  if (options.previewObject) {
    scene.add(createPreviewMesh(options.previewObject));
  }

  const showGuides = options.showSceneGuides ?? (options.showHelpers !== false);
  const showPanoOrigin = options.showPanoOrigin ?? showGuides;

  if (showPanoOrigin) {
    scene.add(createPanoOrigin(project.scene.panoOrigin));
  }
  if (showGuides) {
    for (const landmark of project.landmarks) {
      if (landmark.visible) scene.add(createLandmarkMarker(landmark));
    }
    if (!options.hideShotFrustums) {
      for (const shot of project.shots) {
        if (options.selectedShotId && shot.id !== options.selectedShotId) continue;
        const camera = new THREE.PerspectiveCamera(
          shot.camera.fovDegrees,
          shot.camera.aspectRatio,
          shot.camera.near,
          shot.camera.far,
        );
        camera.position.fromArray(shot.camera.position);
        camera.lookAt(new THREE.Vector3().fromArray(shot.camera.target));
        camera.updateProjectionMatrix();
        const helper = new THREE.CameraHelper(camera);
        helper.name = `Frustum ${shot.shotNumber}`;
        helper.userData.shotId = shot.id;
        scene.add(helper);
      }
    }
  }

  return scene;
}

export function resolveObjectMaterial(
  object: SceneObject,
  theme: SceneVisualTheme = 'light',
): THREE.MeshStandardMaterial {
  const style = resolveSurfaceStyle(object);
  if (style === 'solid') {
    return createSolidMaterial(object.color ?? defaultSolidColorForObject(object));
  }
  if (style === 'checkerboard') {
    const primary = object.color ?? defaultSolidColorForObject(object);
    const secondary = object.secondaryColor ?? defaultSecondaryColor(primary);
    return createCheckerboardMaterial(primary, secondary);
  }
  if (object.type === 'floor') return theme === 'dark' ? darkFloorMaterial : lightFloorMaterial;
  return materialByTheme[theme][object.category];
}

/** Helpers, landmarks, and sun markers keep clay appearance; architecture receives projection. */
export function shouldReceiveProjectedStyle(object: SceneObject): boolean {
  if (object.category === 'helper' || object.category === 'landmark') return false;
  if (object.type === 'sun_marker' || object.type === 'human_dummy') return false;
  return true;
}

function applyProjectedStyleToObject(
  root: THREE.Object3D,
  object: SceneObject,
  theme: SceneVisualTheme,
  projected: ProjectedSceneOptions,
) {
  const clay = resolveObjectMaterial(object, theme);
  const fallbackColor = clay.color?.clone?.() ?? new THREE.Color(0xc8cdc8);
  const projectedMaterial = createProjectedStyleMaterial({
    texture: projected.texture,
    origin: projected.origin,
    rotation: projected.rotation,
    panoramaWidth: projected.panoramaWidth,
    panoramaHeight: projected.panoramaHeight,
    settings: projected.settings,
    fallbackColor: projected.settings.fallbackMode === 'neutral' ? 0xb0b6b2 : fallbackColor,
    disposable: projected.disposableMaterials ?? true,
    occlusionTexture: projected.occlusionTexture,
    occlusionNearMeters: projected.occlusionNearMeters,
    occlusionFarMeters: projected.occlusionFarMeters,
    occlusionFaceSize: projected.occlusionFaceSize,
    secondaryTexture: projected.secondaryTexture,
    secondaryOrigin: projected.secondaryOrigin,
    secondaryRotation: projected.secondaryRotation,
    secondaryPanoramaWidth: projected.secondaryPanoramaWidth,
    secondaryPanoramaHeight: projected.secondaryPanoramaHeight,
    secondaryOcclusionTexture: projected.secondaryOcclusionTexture,
    secondaryOcclusionNearMeters: projected.secondaryOcclusionNearMeters,
    secondaryOcclusionFarMeters: projected.secondaryOcclusionFarMeters,
    secondaryOcclusionFaceSize: projected.secondaryOcclusionFaceSize,
  });
  // Keep a tiny emissive edge so selection remains readable under projection.
  if (root.userData?.sceneObjectId && projected.disposableMaterials === false) {
    projectedMaterial.emissive = new THREE.Color(0x0a2a24);
    projectedMaterial.emissiveIntensity = 0.04;
  }
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = projectedMaterial;
  });
}

export function createObject3D(
  object: SceneObject,
  _selected = false,
  theme: SceneVisualTheme = 'light',
  assets?: AssetRegistry,
): THREE.Object3D {
  let node: THREE.Object3D;
  let character: ReturnType<typeof resolvePoseableCharacterForObject>;
  const material = resolveObjectMaterial(object, theme);
  const style = resolveSurfaceStyle(object);
  const [w, h, d] = object.dimensions;

  switch (object.type) {
    case 'floor':
    case 'wall':
    case 'box':
    case 'background_card':
      node = new THREE.Mesh(
        getSharedPrimitiveGeometry(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d)),
        material,
      );
      break;
    case 'column':
      node = new THREE.Mesh(
        getSharedPrimitiveGeometry(
          `column:${w}:${h}:${d}`,
          () => new THREE.CylinderGeometry(w / 2, d / 2, h, 24),
        ),
        material,
      );
      break;
    case 'arch':
      node = createArch(object, material);
      break;
    case 'doorway':
      node = createDoorway(object, material);
      break;
    case 'stairs':
      node = createStairs(object, material);
      break;
    case 'tree_blob':
      node = style === 'default' ? createTreeBlob(object, theme) : createTreeBlob(object, theme, material);
      break;
    case 'terrain_mass':
      node = new THREE.Mesh(
        getSharedPrimitiveGeometry('terrain_mass:1:0', () => new THREE.DodecahedronGeometry(1, 0)),
        material,
      );
      break;
    case 'human_dummy': {
      const poseMaterial = style === 'default' ? mannequinMaterialByTheme[theme] : material;
      character = resolvePoseableCharacterForObject(object, assets);
      node = character
        ? character.createInstance(object, poseMaterial)
        : createHumanMannequinObject(object, poseMaterial);
      break;
    }
    case 'sun_marker':
      node = createSunMarker(object, theme, style === 'default' ? undefined : material);
      break;
    case 'imported_model':
      node = createImportedMeshNode(object, assets, material);
      break;
    default:
      node = new THREE.Mesh(
        getSharedPrimitiveGeometry(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d)),
        material,
      );
  }

  node.name = object.name;
  applySceneObjectTransform(node, object.transform, {
    applyScale: !sceneObjectUsesProceduralScale(object.type),
  });
  applyHumanPoseToObject3D(node, object, assets);
  if (character) {
    registerPoseableCharacterInstance(object.id, character, node, { object, assets });
  }
  return node;
}

/** Apply a staged/interpolated object transform onto a built scene object node. */
export function applySceneObjectTransform(
  node: THREE.Object3D,
  transform: Transform,
  options: { applyScale?: boolean; visible?: boolean } = {},
) {
  node.position.fromArray(transform.position);
  node.rotation.set(
    degreesToRadians(transform.rotation[0]),
    degreesToRadians(transform.rotation[1]),
    degreesToRadians(transform.rotation[2]),
  );
  if (options.applyScale !== false) {
    node.scale.fromArray(transform.scale);
  }
  if (options.visible !== undefined) {
    node.visible = options.visible;
  }
}

const PROCEDURAL_SCALE_TYPES = new Set<SceneObjectType>([
  'arch', 'doorway', 'stairs', 'tree_blob', 'human_dummy', 'sun_marker', 'imported_model',
]);

export function sceneObjectUsesProceduralScale(type: SceneObjectType): boolean {
  return PROCEDURAL_SCALE_TYPES.has(type);
}

function createArch(object: SceneObject, material: THREE.Material): THREE.Group {
  const [w, h, d] = object.dimensions;
  const group = new THREE.Group();
  const postWidth = w * 0.22;
  const headerHeight = h * 0.22;
  const sideHeight = h - headerHeight;
  const left = new THREE.Mesh(
    getSharedPrimitiveGeometry(
      `arch_post:${postWidth}:${sideHeight}:${d}`,
      () => new THREE.BoxGeometry(postWidth, sideHeight, d),
    ),
    material,
  );
  left.position.set(-w / 2 + postWidth / 2, -headerHeight / 2, 0);
  const right = left.clone();
  right.position.x = w / 2 - postWidth / 2;
  const header = new THREE.Mesh(
    getSharedPrimitiveGeometry(
      `arch_header:${w}:${headerHeight}:${d}`,
      () => new THREE.BoxGeometry(w, headerHeight, d),
    ),
    material,
  );
  header.position.set(0, sideHeight / 2, 0);
  group.add(left, right, header);
  return group;
}

function createDoorway(object: SceneObject, material: THREE.Material): THREE.Group {
  const [w, h, d] = object.dimensions;
  const group = new THREE.Group();
  const rail = w * 0.16;
  const left = new THREE.Mesh(
    getSharedPrimitiveGeometry(
      `doorway_rail:${rail}:${h}:${d}`,
      () => new THREE.BoxGeometry(rail, h, d),
    ),
    material,
  );
  left.position.x = -w / 2 + rail / 2;
  const right = left.clone();
  right.position.x = w / 2 - rail / 2;
  const top = new THREE.Mesh(
    getSharedPrimitiveGeometry(
      `doorway_top:${w}:${rail}:${d}`,
      () => new THREE.BoxGeometry(w, rail, d),
    ),
    material,
  );
  top.position.y = h / 2 - rail / 2;
  group.add(left, right, top);
  return group;
}

function createStairs(object: SceneObject, material: THREE.Material): THREE.Group {
  const [w, h, d] = object.dimensions;
  const group = new THREE.Group();
  const steps = 5;
  const stepGeometry = getSharedPrimitiveGeometry(
    `stairs_step:${w}:${h / steps}:${d / steps}`,
    () => new THREE.BoxGeometry(w, h / steps, d / steps),
  );
  for (let i = 0; i < steps; i += 1) {
    const step = new THREE.Mesh(stepGeometry, material);
    step.position.set(0, -h / 2 + (i + 0.5) * (h / steps), -d / 2 + (i + 0.5) * (d / steps));
    group.add(step);
  }
  return group;
}

function createTreeBlob(
  object: SceneObject,
  theme: SceneVisualTheme,
  overrideMaterial?: THREE.Material,
): THREE.Group {
  const [w, h, d] = object.dimensions;
  const group = new THREE.Group();
  const trunkMaterial = overrideMaterial ?? treeTrunkMaterialByTheme[theme];
  const crownMaterial = overrideMaterial ?? treeCrownMaterialByTheme[theme];
  const trunk = new THREE.Mesh(
    getSharedPrimitiveGeometry(
      `tree_trunk:${w}:${h}`,
      () => new THREE.CylinderGeometry(w * 0.12, w * 0.16, h * 0.45, 12),
    ),
    trunkMaterial,
  );
  trunk.position.y = -h * 0.18;
  const crown = new THREE.Mesh(
    getSharedPrimitiveGeometry(
      `tree_crown:${w}:${d}`,
      () => new THREE.SphereGeometry(Math.max(w, d) * 0.48, 20, 14),
    ),
    crownMaterial,
  );
  crown.scale.y = 0.85;
  crown.position.y = h * 0.18;
  group.add(trunk, crown);
  return group;
}

function createSunMarker(
  _object: SceneObject,
  theme: SceneVisualTheme,
  overrideMaterial?: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  const material = overrideMaterial ?? materialByTheme[theme].helper;
  const sphere = new THREE.Mesh(
    getSharedPrimitiveGeometry('sun_marker_sphere', () => new THREE.SphereGeometry(0.18, 16, 12)),
    material,
  );
  const ray = new THREE.Mesh(
    getSharedPrimitiveGeometry('sun_marker_ray', () => new THREE.CylinderGeometry(0.025, 0.025, 1.4, 8)),
    material,
  );
  ray.rotation.z = Math.PI / 2;
  ray.position.x = -0.65;
  group.add(sphere, ray);
  return group;
}

function createPanoOrigin(origin: [number, number, number]) {
  const group = new THREE.Group();
  group.name = 'Pano Origin';
  group.userData.panoOriginMarker = true;
  const sphere = new THREE.Mesh(
    getSharedPrimitiveGeometry('pano_origin_sphere', () => new THREE.SphereGeometry(0.14, 16, 12)),
    panoOriginMaterial,
  );
  const ring = new THREE.Mesh(
    getSharedPrimitiveGeometry('pano_origin_ring', () => new THREE.TorusGeometry(0.34, 0.01, 8, 32)),
    panoOriginRingMaterial,
  );
  ring.rotation.x = Math.PI / 2;
  group.add(sphere, ring);
  group.position.fromArray(origin);
  group.traverse((node) => {
    node.userData.panoOrigin = true;
  });
  return group;
}

function createLandmarkMarker(landmark: Landmark) {
  const group = new THREE.Group();
  group.name = landmark.displayName;
  group.userData.landmarkId = landmark.id;
  const sphere = new THREE.Mesh(
    getSharedPrimitiveGeometry('landmark_sphere', () => new THREE.SphereGeometry(0.12, 16, 12)),
    landmarkMaterial,
  );
  const stem = new THREE.Mesh(
    getSharedPrimitiveGeometry('landmark_stem', () => new THREE.CylinderGeometry(0.018, 0.018, 0.5, 8)),
    landmarkMaterial,
  );
  stem.position.y = -0.25;
  group.add(sphere, stem);
  group.position.fromArray(landmark.position);
  return group;
}

export function createPreviewMesh(object: SceneObject, theme: SceneVisualTheme = 'light'): THREE.Object3D {
  const preview = createObject3D(object, false, theme);
  preview.name = 'Placement Preview';
  preview.userData.previewObject = true;
  applyPreviewMaterial(preview);
  return preview;
}

export function disposePreviewMesh(node: THREE.Object3D) {
  const disposedMaterials = new Set<THREE.Material>();
  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && !SHARED_GEOMETRIES.has(mesh.geometry)) mesh.geometry.dispose();
    disposeOwnedMaterials(mesh.material, disposedMaterials);
  });
}

export function disposeScene(scene: THREE.Scene) {
  const disposedMaterials = new Set<THREE.Material>();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (
      mesh.geometry
      && !SHARED_GEOMETRIES.has(mesh.geometry)
      // Autorig skinned prototypes share BufferGeometry across clones.
      && mesh.geometry.userData?.panorefSharedSkinnedGeometry !== true
      && !releaseImportedGeometry(mesh.geometry)
    ) mesh.geometry.dispose();
    disposeOwnedMaterials(mesh.material, disposedMaterials);
  });
}

function isSharedSkinnedPrototypeMaterial(material: THREE.Material): boolean {
  return material.userData?.panorefSharedSkinnedMaterial === true;
}

function disposeOwnedMaterials(
  material: THREE.Material | THREE.Material[] | undefined,
  disposed: Set<THREE.Material>,
) {
  if (!material) return;
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((item) => {
    if (SHARED_MATERIALS.has(item) || disposed.has(item)) return;
    // SkeletonUtils-shared autorig prototype materials must survive scene rebuilds.
    if (isSharedSkinnedPrototypeMaterial(item)) return;
    disposed.add(item);
    item.dispose();
  });
}

function applyPreviewMaterial(node: THREE.Object3D) {
  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const material = mesh.material;
    if (!material) return;
    const materials = Array.isArray(material) ? material : [material];
    mesh.material = materials.length === 1
      ? createPreviewMaterial(materials[0])
      : materials.map((item) => createPreviewMaterial(item));
    mesh.renderOrder = 10;
  });
}

function createPreviewMaterial(source: THREE.Material): THREE.Material {
  const clone = source.clone();
  clone.transparent = true;
  clone.opacity = 0.42;
  clone.depthWrite = false;
  clone.side = THREE.DoubleSide;
  if ('color' in clone && clone.color instanceof THREE.Color) {
    clone.color.lerp(new THREE.Color(0x14b8a6), 0.28);
  }
  if (clone instanceof THREE.MeshStandardMaterial) {
    clone.emissive.setHex(0x0a2d28);
    clone.emissiveIntensity = 0.18;
  }
  return clone;
}
