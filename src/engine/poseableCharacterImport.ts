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
} from './poseableRigNormalize';

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

function axisToVector(axis: PoseableAxisHint): THREE.Vector3 {
  switch (axis) {
    case '+x': return new THREE.Vector3(1, 0, 0);
    case '-x': return new THREE.Vector3(-1, 0, 0);
    case '+y': return new THREE.Vector3(0, 1, 0);
    case '-y': return new THREE.Vector3(0, -1, 0);
    case '+z': return new THREE.Vector3(0, 0, 1);
    case '-z': return new THREE.Vector3(0, 0, -1);
  }
}

/** Build a rotation that maps source front/up axes onto Continuity Stage +Z / +Y. */
export function orientationQuaternion(orientation: PoseableCharacterOrientation): THREE.Quaternion {
  const front = axisToVector(orientation.frontAxis).normalize();
  const up = axisToVector(orientation.upAxis).normalize();
  if (Math.abs(front.dot(up)) > 0.999) {
    return new THREE.Quaternion();
  }
  const targetFront = new THREE.Vector3(0, 0, 1);
  const targetUp = new THREE.Vector3(0, 1, 0);
  const basisFrom = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(up, front).normalize(),
    up.clone(),
    front.clone(),
  );
  const basisTo = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(targetUp, targetFront).normalize(),
    targetUp.clone(),
    targetFront.clone(),
  );
  const fromQuat = new THREE.Quaternion().setFromRotationMatrix(basisFrom);
  const toQuat = new THREE.Quaternion().setFromRotationMatrix(basisTo);
  return toQuat.multiply(fromQuat.invert());
}

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
  const oriented = new THREE.Group();
  oriented.add(root);
  oriented.quaternion.copy(orientationQuaternion(orientation));
  oriented.updateMatrixWorld(true);

  const { size } = measureObjectSize(oriented);
  const heightAxis = size[1] > 1e-6 ? size[1] : Math.max(size[0], size[2], 1);
  const scale = approximateHeightMeters / heightAxis;
  oriented.scale.setScalar(scale);
  oriented.updateMatrixWorld(true);

  const scaledBox = new THREE.Box3().setFromObject(oriented);
  const minY = scaledBox.min.y;
  const centerX = (scaledBox.min.x + scaledBox.max.x) / 2;
  const centerZ = (scaledBox.min.z + scaledBox.max.z) / 2;
  oriented.position.x -= centerX;
  oriented.position.z -= centerZ;
  oriented.position.y += orientation.groundLevelMeters - minY;
  oriented.updateMatrixWorld(true);

  const finalBox = new THREE.Box3().setFromObject(oriented);
  const finalSize = new THREE.Vector3();
  finalBox.getSize(finalSize);

  const euler = new THREE.Euler().setFromQuaternion(oriented.quaternion, 'XYZ');
  const restTransform: PoseableRestTransform = {
    position: [oriented.position.x, oriented.position.y, oriented.position.z],
    rotation: [
      (euler.x * 180) / Math.PI,
      (euler.y * 180) / Math.PI,
      (euler.z * 180) / Math.PI,
    ],
    scale: [oriented.scale.x, oriented.scale.y, oriented.scale.z],
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
    rigGenerationVersion: 1,
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
