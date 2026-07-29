import * as THREE from 'three';
import {
  PoseableAxisHint,
  PoseableCharacterOrientation,
  PoseableRestTransform,
  PoseableRigAsset,
  PoseableRigGenerationSettings,
  ProjectAsset,
  SceneObject,
  Vec3,
} from '../domain/types';
import { createTransform } from '../domain/defaults';
import { createId } from '../utils/ids';
import { HUMAN_JOINT_IDS } from './humanPose';
import { MODEL_ASSET_URI_PREFIX } from './importedMesh';
import { putModelAsset } from './modelAssetStore';
import { registerAutoriggedPoseableCharacter } from './poseableCharacter';
import { createAutoriggedPoseableCharacterShell } from './autoriggedPoseableCharacter';
import {
  MAX_POSEABLE_HEIGHT_METERS,
  MIN_POSEABLE_HEIGHT_METERS,
  CURRENT_AUTORIG_RIG_GENERATION_VERSION,
} from './poseableRigNormalize';
import { prepareCanonicalAutorigMesh } from './autorigCanonicalMesh';

export {
  DEFAULT_POSEABLE_HEIGHT_METERS,
  MAX_POSEABLE_HEIGHT_METERS,
  MIN_POSEABLE_HEIGHT_METERS,
  defaultPoseableOrientation,
  normalizePoseableAxisHint,
  normalizePoseableCharacterOrientation,
  normalizePoseableRestTransform,
  normalizePoseableRigGenerationSettings,
  normalizePoseableRigAsset,
} from './poseableRigNormalize';

export const POSEABLE_CHARACTER_IMPORT_ACCEPT = '.glb,.gltf';
export const POSEABLE_CHARACTER_IMPORT_EXTENSIONS = ['glb', 'gltf'] as const;
export type PoseableCharacterImportFormat = typeof POSEABLE_CHARACTER_IMPORT_EXTENSIONS[number];

export interface PoseableCharacterImportPreview {
  root: THREE.Object3D;
  size: Vec3;
  suggestedHeightMeters: number;
  meshCount: number;
  hasSkinnedMeshes: boolean;
  warnings: string[];
}

export interface PoseableCharacterImportOptions {
  file: File;
  orientation: PoseableCharacterOrientation;
  approximateHeightMeters: number;
  poseHint?: 'a-pose' | 't-pose';
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface PoseableCharacterImportResult {
  sourceAsset: ProjectAsset;
  rigAsset: ProjectAsset;
  object: SceneObject;
  rig: PoseableRigAsset;
  warnings: string[];
}

function extensionOf(fileName: string): string {
  const parts = fileName.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1]! : '';
}

export function isPoseableCharacterImportFile(file: File): boolean {
  const extension = extensionOf(file.name);
  return (POSEABLE_CHARACTER_IMPORT_EXTENSIONS as readonly string[]).includes(extension);
}

/** Build a rotation that maps source front/up axes onto Continuity Stage +Z / +Y. */
export { canonicalOrientationQuaternion as orientationQuaternion } from './autorigCanonicalMesh';

function measureObjectSize(root: THREE.Object3D): { size: Vec3; box: THREE.Box3 } {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { size: [size.x, size.y, size.z], box };
}

/** Load a GLB/glTF for poseable preview without stripping materials or textures. */
export async function loadPoseableCharacterPreview(
  file: File,
  signal?: AbortSignal,
): Promise<PoseableCharacterImportPreview> {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  if (!isPoseableCharacterImportFile(file)) {
    throw new Error('Poseable character import accepts GLB or embedded glTF only.');
  }
  const format = extensionOf(file.name) as PoseableCharacterImportFormat;
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const buffer = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');

  let gltf: Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>;
  try {
    if (format === 'gltf') {
      const text = new TextDecoder().decode(buffer);
      if (/"uri"\s*:\s*"[^"]+\.bin"/i.test(text) && !/"uri"\s*:\s*"data:/i.test(text)) {
        throw new Error('External .bin sidecars are not supported. Use a single GLB or embedded glTF.');
      }
      gltf = await loader.parseAsync(text, '');
    } else {
      gltf = await loader.parseAsync(buffer, '');
    }
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not parse ${file.name}: ${error.message}`
        : `Could not parse ${file.name}.`,
    );
  }

  const root = gltf.scene;
  let meshCount = 0;
  let hasSkinnedMeshes = false;
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) meshCount += 1;
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) hasSkinnedMeshes = true;
  });
  if (meshCount === 0) {
    throw new Error('No mesh geometry found in the selected file.');
  }

  const { size } = measureObjectSize(root);
  const suggestedHeightMeters = Math.max(size[0], size[1], size[2], MIN_POSEABLE_HEIGHT_METERS);
  const warnings: string[] = [];
  if (hasSkinnedMeshes) {
    warnings.push('Existing skinning/animation will be ignored. Autorigging starts from the rest mesh.');
  }
  if (meshCount > 1) {
    warnings.push('Multiple meshes detected. The first import treats them as one primary humanoid asset.');
  }

  return {
    root,
    size,
    suggestedHeightMeters: Math.min(MAX_POSEABLE_HEIGHT_METERS, suggestedHeightMeters),
    meshCount,
    hasSkinnedMeshes,
    warnings,
  };
}

function applyOrientationAndHeight(
  root: THREE.Object3D,
  orientation: PoseableCharacterOrientation,
  approximateHeightMeters: number,
): { restTransform: PoseableRestTransform; dimensions: Vec3; warnings: string[] } {
  const canonical = prepareCanonicalAutorigMesh({
    source: root,
    orientation,
    targetHeightMeters: approximateHeightMeters,
  });
  const finalSize = new THREE.Vector3(...canonical.size);

  const euler = new THREE.Euler().setFromQuaternion(canonical.root.quaternion, 'XYZ');
  const restTransform: PoseableRestTransform = {
    position: [canonical.root.position.x, canonical.root.position.y, canonical.root.position.z],
    rotation: [
      (euler.x * 180) / Math.PI,
      (euler.y * 180) / Math.PI,
      (euler.z * 180) / Math.PI,
    ],
    scale: [canonical.root.scale.x, canonical.root.scale.y, canonical.root.scale.z],
  };

  const warnings: string[] = [];
  if (finalSize.y < approximateHeightMeters * 0.5 || finalSize.y > approximateHeightMeters * 1.5) {
    warnings.push('Oriented height differs from the requested height; check Front / Up axes.');
  }

  return {
    restTransform,
    dimensions: [finalSize.x, finalSize.y, finalSize.z],
    warnings,
  };
}

/**
 * Import a poseable character shell: preserve original source bytes, write a
 * poseable_rig asset, and create a scene object. Skin weights are deferred.
 */
export async function importPoseableCharacter(
  options: PoseableCharacterImportOptions,
): Promise<PoseableCharacterImportResult> {
  const { file, orientation, poseHint, signal, onProgress } = options;
  const approximateHeightMeters = Math.min(
    MAX_POSEABLE_HEIGHT_METERS,
    Math.max(MIN_POSEABLE_HEIGHT_METERS, options.approximateHeightMeters),
  );
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  if (!isPoseableCharacterImportFile(file)) {
    throw new Error('Poseable character import accepts GLB or embedded glTF only.');
  }

  onProgress?.('Reading source file…');
  const sourceBytes = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');

  onProgress?.('Loading mesh preview…');
  const preview = await loadPoseableCharacterPreview(file, signal);
  const fitted = applyOrientationAndHeight(preview.root.clone(true), orientation, approximateHeightMeters);

  onProgress?.('Writing original source asset…');
  const sourceAssetId = createId('poseable_source');
  const sourceKey = `poseable-source-${sourceAssetId}`;
  await putModelAsset(sourceKey, sourceBytes);
  const format = extensionOf(file.name);
  const sourceAsset: ProjectAsset = {
    id: sourceAssetId,
    type: 'model',
    name: file.name,
    uri: `${MODEL_ASSET_URI_PREFIX}${sourceKey}`,
    mimeType: format === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary',
    createdAt: new Date().toISOString(),
    metadata: {
      poseableSource: true,
      originalFileName: file.name,
      format,
    },
  };

  const rigId = createId('poseable_rig');
  const rigAssetId = createId('asset_poseable_rig');
  const generationSettings: PoseableRigGenerationSettings = {
    approximateHeightMeters,
    ...(poseHint ? { poseHint } : {}),
    notes: [
      ...preview.warnings,
      ...fitted.warnings,
      'Skin weights are not generated yet. Markers and weighting land in later milestones.',
    ],
  };

  const rig: PoseableRigAsset = {
    version: 1,
    id: rigId,
    skeletonJoints: [...HUMAN_JOINT_IDS],
    rigGenerationVersion: CURRENT_AUTORIG_RIG_GENERATION_VERSION,
    requiresRerigging: true,
    originalSourceAssetId: sourceAssetId,
    sourceMeshAssetId: sourceAssetId,
    orientation: { ...orientation },
    restTransform: fitted.restTransform,
    generationSettings,
  };

  const rigAsset: ProjectAsset = {
    id: rigAssetId,
    type: 'poseable_rig',
    name: `${file.name.replace(/\.(glb|gltf)$/i, '') || 'Poseable character'} rig`,
    uri: `data:application/json,${encodeURIComponent(JSON.stringify({ poseableRigId: rigId }))}`,
    mimeType: 'application/json',
    createdAt: new Date().toISOString(),
    metadata: { poseableRig: rig },
  };

  const height = fitted.dimensions[1] || approximateHeightMeters;
  const object: SceneObject = {
    id: createId('obj'),
    type: 'human_dummy',
    name: file.name.replace(/\.(glb|gltf)$/i, '') || 'Poseable character',
    category: 'helper',
    transform: createTransform([
      fitted.restTransform.position[0],
      Math.max(orientation.groundLevelMeters + height / 2, height / 2),
      fitted.restTransform.position[2],
    ]),
    dimensions: fitted.dimensions[0] > 0
      ? fitted.dimensions
      : [0.55, approximateHeightMeters, 0.55],
    visible: true,
    locked: false,
    stagingRole: 'person',
    poseableCharacter: {
      kind: 'autorigged',
      assetId: rigAssetId,
      rigId,
    },
  };

  registerAutoriggedPoseableCharacter(
    rigAssetId,
    rigId,
    createAutoriggedPoseableCharacterShell({
      assetId: rigAssetId,
      rigId,
      sourceAssetId,
      orientation,
      approximateHeightMeters,
    }),
  );

  onProgress?.('Poseable character ready.');
  return {
    sourceAsset,
    rigAsset,
    object,
    rig,
    warnings: [...preview.warnings, ...fitted.warnings],
  };
}
