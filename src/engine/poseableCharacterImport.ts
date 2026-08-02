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
  ImportedHumanoidRigBinding,
  HumanJointId,
} from '../domain/types';
import { createTransform } from '../domain/defaults';
import { createId } from '../utils/ids';
import { HUMAN_JOINT_IDS } from './humanPose';
import { MODEL_ASSET_URI_PREFIX } from './importedMesh';
import { deleteModelAsset, putModelAsset } from './modelAssetStore';
import { registerAutoriggedPoseableCharacter } from './poseableCharacter';
import { createAutoriggedPoseableCharacterShell } from './autoriggedPoseableCharacter';
import {
  MAX_POSEABLE_HEIGHT_METERS,
  MIN_POSEABLE_HEIGHT_METERS,
  CURRENT_AUTORIG_RIG_GENERATION_VERSION,
} from './poseableRigNormalize';
import { prepareCanonicalAutorigMesh } from './autorigCanonicalMesh';
import { loadPoseableSource, type LoadedPoseableSource } from './poseableSourceLoader';
import { analyzeHumanoidSkeleton, type HumanoidMappingAnalysis } from './importedRig/analyzeSkeleton';
import { validateHumanoidMapping } from './importedRig/mappingValidation';
import { calculateCanonicalPoseBases, validateCanonicalPoseBases } from './importedRig/canonicalFrames';
import { fingerprintImportedRestPose, fingerprintImportedSkeleton } from './importedRig/fingerprints';
import { buildBonePathMap } from './importedRig/bonePaths';
import { buildCanonicalAutorigTopology } from './autorig/topology';
import {
  canApplyPoseableRigPackage,
  cleanupImportedPoseableRigPackage,
  mergeImportedRigOntoTarget,
  parsePoseableRigPackageFile,
  resolvePoseableRigPackageVertexCount,
  type ImportedPoseableRigPackage,
  type PoseableRigPackageManifest,
} from './poseableRigPackage';
import { DEFAULT_POSEABLE_HEIGHT_METERS, defaultPoseableOrientation } from './poseableRigNormalize';

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

export const POSEABLE_CHARACTER_IMPORT_ACCEPT = '.glb,.gltf,.fbx';
export const POSEABLE_CHARACTER_IMPORT_EXTENSIONS = ['glb', 'gltf', 'fbx'] as const;
export type PoseableCharacterImportFormat = typeof POSEABLE_CHARACTER_IMPORT_EXTENSIONS[number];

export interface PoseableCharacterImportPreview {
  root: THREE.Object3D;
  size: Vec3;
  suggestedHeightMeters: number;
  meshCount: number;
  hasSkinnedMeshes: boolean;
  warnings: string[];
  rigAnalysis?: HumanoidMappingAnalysis;
  animationCount?: number;
  boneCount?: number;
  skinnedMeshCount?: number;
  boneOptions?: Array<{ path: string; name: string }>;
}

export interface PoseableCharacterImportOptions {
  file: File;
  orientation: PoseableCharacterOrientation;
  approximateHeightMeters: number;
  poseHint?: 'a-pose' | 't-pose';
  mode?: 'autorig' | 'preserveExistingRig';
  mappingOverrides?: Partial<Record<HumanJointId, string>>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface PoseableCharacterImportResult {
  sourceAsset: ProjectAsset;
  rigAsset: ProjectAsset;
  object: SceneObject;
  rig: PoseableRigAsset;
  warnings: string[];
  /** Oriented/canonical mesh vertex count — used to validate attached .fsrig / legacy .panorig packages. */
  vertexCount: number;
}

export interface SavedRigCharacterImportOptions {
  sourceFile: File;
  rigPackageFile: File;
  name: string;
  approximateHeightMeters?: number;
  orientation?: PoseableCharacterOrientation;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface CharacterImportDiagnostic {
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface SavedRigCompatibilityAnalysis {
  ok: boolean;
  sourceFileName: string;
  rigPackageFileName: string;
  characterName?: string;
  sourceVertexCount: number;
  packageVertexCount?: number;
  topologyVerified: boolean;
  skeletonVerified?: boolean;
  warnings: string[];
  diagnostics: CharacterImportDiagnostic[];
}

export interface SavedRigCharacterImportResult extends PoseableCharacterImportResult {
  appliedSavedRig: true;
  topologyVerified: boolean;
  packageManifest: PoseableRigPackageManifest;
  packageAssets: {
    sourceAsset?: ProjectAsset;
    skinAsset?: ProjectAsset;
    regionAsset?: ProjectAsset;
  };
}

export interface RiggedCharacterImportAnalysis {
  sourceFormat: PoseableCharacterImportFormat;
  sourceBytes: ArrayBuffer;
  source: LoadedPoseableSource;
  mapping: HumanoidMappingAnalysis;
  canonicalPoseBases: ImportedHumanoidRigBinding['canonicalPoseBases'];
  skeletonHash: string;
  restPoseHash: string;
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

function countMeshVertices(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) count += mesh.geometry?.getAttribute('position')?.count ?? 0;
  });
  return count;
}

function temporarySourceAsset(file: File, format: PoseableCharacterImportFormat): ProjectAsset {
  return {
    id: 'pending-poseable-source',
    type: 'model',
    name: file.name,
    uri: 'panoref-model:pending',
    createdAt: new Date(0).toISOString(),
    metadata: { format },
  };
}

export async function analyzeRiggedCharacterImport(params: {
  file: File;
  orientation?: PoseableCharacterOrientation;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<RiggedCharacterImportAnalysis> {
  const format = extensionOf(params.file.name) as PoseableCharacterImportFormat;
  if (!isPoseableCharacterImportFile(params.file)) throw new Error('Poseable character import accepts GLB, embedded glTF, or FBX.');
  params.onProgress?.('Reading source file…');
  const sourceBytes = await params.file.arrayBuffer();
  if (params.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  params.onProgress?.('Analyzing deformation rig…');
  const source = await loadPoseableSource(temporarySourceAsset(params.file, format), sourceBytes, params.signal);
  const mapping = analyzeHumanoidSkeleton(source);
  const canonicalPoseBases = calculateCanonicalPoseBases({ root: source.root, boneMap: mapping.boneMap });
  const mappingValidation = validateHumanoidMapping({ root: source.root, boneMap: mapping.boneMap });
  const canonicalWarnings = validateCanonicalPoseBases(canonicalPoseBases);
  const [skeletonHash, restPoseHash] = await Promise.all([
    fingerprintImportedSkeleton(source.root, source.bones),
    fingerprintImportedRestPose(source.root, source.bones),
  ]);
  const warnings = [
    ...source.warnings,
    ...mapping.warnings,
    ...mappingValidation.warnings,
    ...canonicalWarnings,
  ];
  if (!mappingValidation.ok) warnings.push('Automatic mapping cannot be used until required joints are corrected.');
  return {
    sourceFormat: format,
    sourceBytes,
    source,
    mapping,
    canonicalPoseBases,
    skeletonHash,
    restPoseHash,
    warnings: [...new Set(warnings)],
  };
}

/** Build a rotation that maps source front/up axes onto ForeScene +Z / +Y. */
export { canonicalOrientationQuaternion as orientationQuaternion } from './autorigCanonicalMesh';

function measureObjectSize(root: THREE.Object3D): { size: Vec3; box: THREE.Box3 } {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { size: [size.x, size.y, size.z], box };
}

/** Load a GLB/glTF/FBX for poseable preview without stripping materials or textures. */
export async function loadPoseableCharacterPreview(
  file: File,
  signal?: AbortSignal,
): Promise<PoseableCharacterImportPreview> {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  if (!isPoseableCharacterImportFile(file)) {
    throw new Error('Poseable character import accepts GLB, embedded glTF, or FBX.');
  }
  const format = extensionOf(file.name) as PoseableCharacterImportFormat;
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const buffer = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');

  let root: THREE.Object3D;
  let animationCount = 0;
  let sourceLoaded: LoadedPoseableSource | undefined;
  if (format === 'fbx') {
    sourceLoaded = await loadPoseableSource(temporarySourceAsset(file, format), buffer, signal);
    root = sourceLoaded.root;
    animationCount = sourceLoaded.animationClips.length;
  } else {
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

  root = gltf.scene;
  animationCount = gltf.animations.length;
  }
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
  const sourceBones = sourceLoaded?.bones ?? (() => {
    const bones = new Set<THREE.Bone>();
    root.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) mesh.skeleton.bones.forEach((bone) => bones.add(bone));
    });
    return [...bones];
  })();
  const warnings: string[] = [...(sourceLoaded?.warnings ?? [])];
  const rigAnalysis = hasSkinnedMeshes && sourceBones.length > 0
    ? analyzeHumanoidSkeleton({ root, bones: sourceBones })
    : undefined;
  const boneOptions = sourceBones.length > 0
    ? [...buildBonePathMap(root, sourceBones).entries()].map(([path, bone]) => ({ path, name: bone.name }))
    : undefined;
  if (meshCount > 1) {
    warnings.push('Multiple meshes detected. The first import treats them as one primary humanoid asset.');
  }

  return {
    root,
    size,
    suggestedHeightMeters: Math.min(MAX_POSEABLE_HEIGHT_METERS, suggestedHeightMeters),
    meshCount,
    hasSkinnedMeshes,
    warnings: [...new Set(warnings)],
    ...(rigAnalysis ? { rigAnalysis } : {}),
    animationCount,
    boneCount: sourceBones.length,
    skinnedMeshCount: sourceLoaded?.skinnedMeshes.length ?? (hasSkinnedMeshes ? 1 : 0),
    ...(boneOptions ? { boneOptions } : {}),
  };
}

function applyOrientationAndHeight(
  root: THREE.Object3D,
  orientation: PoseableCharacterOrientation,
  approximateHeightMeters: number,
): {
  restTransform: PoseableRestTransform;
  dimensions: Vec3;
  warnings: string[];
  vertexCount: number;
} {
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

  let vertexCount = 0;
  canonical.root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    vertexCount += mesh.geometry.getAttribute('position')?.count ?? 0;
  });

  return {
    restTransform,
    dimensions: [finalSize.x, finalSize.y, finalSize.z],
    warnings,
    vertexCount,
  };
}

async function importExistingRigCharacter(
  options: PoseableCharacterImportOptions & { approximateHeightMeters: number },
): Promise<PoseableCharacterImportResult> {
  const { file, orientation, signal, onProgress } = options;
  const analysis = await analyzeRiggedCharacterImport({ file, orientation, signal, onProgress });
  const boneMap = { ...analysis.mapping.boneMap, ...(options.mappingOverrides ?? {}) };
  const validation = validateHumanoidMapping({ root: analysis.source.root, boneMap });
  if (!validation.ok) throw new Error(`The existing rig mapping is incomplete: ${validation.warnings.join(' ')}`);
  const canonicalPoseBases = calculateCanonicalPoseBases({ root: analysis.source.root, boneMap });
  const sourceAssetId = createId('poseable_source');
  const sourceKey = `poseable-source-${sourceAssetId}`;
  const format = extensionOf(file.name) as PoseableCharacterImportFormat;
  const sourceAsset: ProjectAsset = {
    id: sourceAssetId,
    type: 'model',
    name: file.name,
    uri: `${MODEL_ASSET_URI_PREFIX}${sourceKey}`,
    storageKey: sourceKey,
    mimeType: format === 'fbx' ? 'application/octet-stream' : format === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary',
    createdAt: new Date().toISOString(),
    metadata: {
      poseableSource: true,
      preservesRig: true,
      originalFileName: file.name,
      format,
    },
  };
  const rigId = createId('poseable_rig');
  const rigAssetId = createId('asset_poseable_rig');
  const pathMap = buildBonePathMap(analysis.source.root, analysis.source.bones);
  const rootBone = analysis.source.bones.find((bone) => !(bone.parent instanceof THREE.Bone));
  const rootBonePath = [...pathMap.entries()].find(([, bone]) => bone === rootBone)?.[0];
  const requiredCount = analysis.mapping.requiredMapped.length;
  const optionalCount = analysis.mapping.optionalMapped.length;
  const binding: ImportedHumanoidRigBinding = {
    version: 1,
    id: rigId,
    sourceAssetId,
    sourceFormat: format,
    profile: analysis.mapping.detectedProfile,
    boneMap,
    canonicalPoseBases,
    skeletonHash: analysis.skeletonHash,
    restPoseHash: analysis.restPoseHash,
    ...(rootBonePath ? { rootBonePath } : {}),
    hipsBonePath: boneMap.hips ?? boneMap.chest!,
    orientation: { ...orientation },
    approximateHeightMeters: options.approximateHeightMeters,
    requiredJointCoverage: requiredCount / 15,
    optionalJointCoverage: optionalCount / Math.max(1, HUMAN_JOINT_IDS.length - 15),
    ...(analysis.source.animationClips.length > 0
      ? { sourceAnimationClips: analysis.source.animationClips.map((clip) => ({ name: clip.name, durationSeconds: clip.duration })) }
      : {}),
    warnings: analysis.warnings,
  };
  const fitted = prepareCanonicalAutorigMesh({
    source: analysis.source.root,
    orientation,
    targetHeightMeters: options.approximateHeightMeters,
  });
  const rig: PoseableRigAsset = {
    version: 1,
    id: rigId,
    skeletonJoints: Object.keys(boneMap) as HumanJointId[],
    rigGenerationVersion: CURRENT_AUTORIG_RIG_GENERATION_VERSION,
    requiresRerigging: false,
    originalSourceAssetId: sourceAssetId,
    sourceMeshAssetId: sourceAssetId,
    orientation: { ...orientation },
    restTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    generationSettings: {
      approximateHeightMeters: options.approximateHeightMeters,
      ...(options.poseHint ? { poseHint: options.poseHint } : {}),
      notes: ['Existing deformation skeleton, skin weights, inverse bind matrices, and source meshes are preserved.'],
    },
    importedRigBinding: binding,
  };
  const rigAsset: ProjectAsset = {
    id: rigAssetId,
    type: 'poseable_rig',
    name: `${file.name.replace(/\.(glb|gltf|fbx)$/i, '') || 'Poseable character'} preserved rig`,
    uri: `data:application/json,${encodeURIComponent(JSON.stringify({ poseableRigId: rigId }))}`,
    mimeType: 'application/json',
    createdAt: new Date().toISOString(),
    metadata: { poseableRig: rig },
  };
  const height = fitted.size[1] || options.approximateHeightMeters;
  const object: SceneObject = {
    id: createId('obj'),
    type: 'human_dummy',
    name: file.name.replace(/\.(glb|gltf|fbx)$/i, '') || 'Poseable character',
    category: 'helper',
    transform: createTransform([0, Math.max(orientation.groundLevelMeters + height / 2, height / 2), 0]),
    dimensions: fitted.size[0] > 0 ? fitted.size : [0.55, options.approximateHeightMeters, 0.55],
    visible: true,
    locked: false,
    stagingRole: 'person',
    poseableCharacter: { kind: 'importedRig', assetId: rigAssetId, rigId },
  };
  onProgress?.('Writing original rigged source asset…');
  try {
    await putModelAsset(sourceKey, analysis.sourceBytes, signal);
  } catch (error) {
    await deleteModelAsset(sourceKey).catch(() => undefined);
    throw error;
  }
  return {
    sourceAsset,
    rigAsset,
    object,
    rig,
    warnings: analysis.warnings,
    vertexCount: countMeshVertices(fitted.root),
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
    throw new Error('Poseable character import accepts GLB, embedded glTF, or FBX.');
  }
  if (options.mode === 'preserveExistingRig') {
    return importExistingRigCharacter({ ...options, approximateHeightMeters });
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
  await putModelAsset(sourceKey, sourceBytes, signal);
  const format = extensionOf(file.name);
  const sourceAsset: ProjectAsset = {
    id: sourceAssetId,
    type: 'model',
    name: file.name,
    uri: `${MODEL_ASSET_URI_PREFIX}${sourceKey}`,
    storageKey: sourceKey,
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
    vertexCount: fitted.vertexCount,
  };
}

function compatibilityDiagnostic(
  code: string,
  message: string,
): CharacterImportDiagnostic {
  return { code, message, severity: 'error' };
}

/**
 * Read-only validation for an explicit source + .fsrig/.panorig pair.
 * Package parsing is deliberately run with persistence disabled so this can be
 * called before a project reset without leaving IndexedDB payloads behind.
 */
export async function analyzeSavedRigCompatibility(params: {
  sourceFile: File;
  rigPackageFile: File;
  approximateHeightMeters?: number;
  signal?: AbortSignal;
}): Promise<SavedRigCompatibilityAnalysis> {
  const diagnostics: CharacterImportDiagnostic[] = [];
  const warnings: string[] = [];
  let packageData: ImportedPoseableRigPackage | undefined;
  let sourceVertexCount = 0;
  let packageVertexCount: number | undefined;
  let characterName: string | undefined;

  try {
    packageData = await parsePoseableRigPackageFile(params.rigPackageFile, {
      signal: params.signal,
      persistAssets: false,
    });
    characterName = packageData.manifest.characterName;
  } catch (error) {
    if (params.signal?.aborted) throw error;
    diagnostics.push(compatibilityDiagnostic(
      'corrupt_rig_package',
      error instanceof Error ? error.message : 'Rig package could not be parsed.',
    ));
  }

  let sourceAnalysis: RiggedCharacterImportAnalysis | undefined;
  try {
    sourceAnalysis = await analyzeRiggedCharacterImport({ file: params.sourceFile, signal: params.signal });
    sourceVertexCount = countMeshVertices(sourceAnalysis.source.root);
    warnings.push(...sourceAnalysis.warnings);
  } catch (error) {
    if (params.signal?.aborted) throw error;
    diagnostics.push(compatibilityDiagnostic(
      'invalid_character_source',
      error instanceof Error ? error.message : 'Character source could not be parsed.',
    ));
  }

  if (packageData) {
    packageVertexCount = await resolvePoseableRigPackageVertexCount(packageData);
    const packageHasSkinAndBind = Boolean(
      packageData.rig.importedRigBinding
      || (packageData.rig.bindMatrices && packageData.rig.skin),
    );
    if (!packageHasSkinAndBind) {
      diagnostics.push(compatibilityDiagnostic(
        'missing_skin_or_bind_information',
        'Rig package lacks skin weights and bind matrices for the imported source.',
      ));
    }
    if (typeof packageVertexCount !== 'number') {
      warnings.push('Rig package did not publish a readable vertex count.');
    }
  }

  let topologyVerified = false;
  let skeletonVerified: boolean | undefined;
  if (sourceAnalysis && packageData) {
    const sourceTopologyHash = buildCanonicalAutorigTopology(sourceAnalysis.source.root).topologyHash;
    const packageTopologyHash = packageData.manifest.topologyHash ?? packageData.rig.regionMap?.topologyHash;
    if (packageTopologyHash) {
      topologyVerified = sourceTopologyHash === packageTopologyHash;
      if (!topologyVerified) {
        diagnostics.push(compatibilityDiagnostic(
          'topology_mismatch',
          `Package topology ${packageTopologyHash} does not match source topology ${sourceTopologyHash}.`,
        ));
      }
    } else if (typeof packageVertexCount === 'number') {
      topologyVerified = sourceVertexCount === packageVertexCount;
    }

    if (typeof packageVertexCount === 'number' && packageVertexCount !== sourceVertexCount) {
      diagnostics.push(compatibilityDiagnostic(
        'vertex_count_mismatch',
        `Package contains ${packageVertexCount} vertices, but the source contains ${sourceVertexCount}.`,
      ));
    }

    if (packageData.rig.importedRigBinding) {
      skeletonVerified = Boolean(
        sourceAnalysis.skeletonHash === packageData.rig.importedRigBinding.skeletonHash,
      );
      if (!skeletonVerified) {
        diagnostics.push(compatibilityDiagnostic(
          'source_skeleton_mismatch',
          'Package was authored for a different source skeleton.',
        ));
      }
    }
  }

  return {
    ok: diagnostics.length === 0,
    sourceFileName: params.sourceFile.name,
    rigPackageFileName: params.rigPackageFile.name,
    ...(characterName ? { characterName } : {}),
    sourceVertexCount,
    ...(typeof packageVertexCount === 'number' ? { packageVertexCount } : {}),
    topologyVerified,
    ...(skeletonVerified !== undefined ? { skeletonVerified } : {}),
    warnings: [...new Set(warnings)],
    diagnostics,
  };
}

/**
 * Shared manual/autonomous saved-rig import path. It owns all temporary
 * binary writes and cleans them when compatibility, cancellation, or parsing
 * fails before the caller commits the returned project assets.
 */
export async function importPoseableCharacterWithSavedRig(
  options: SavedRigCharacterImportOptions,
): Promise<SavedRigCharacterImportResult> {
  let importedPackage: ImportedPoseableRigPackage | undefined;
  let result: PoseableCharacterImportResult | undefined;
  const writtenPackageKeys: string[] = [];
  const orientation = options.orientation ?? defaultPoseableOrientation();
  const approximateHeightMeters = options.approximateHeightMeters ?? DEFAULT_POSEABLE_HEIGHT_METERS;
  try {
    options.onProgress?.('Reading saved rig package…');
    importedPackage = await parsePoseableRigPackageFile(options.rigPackageFile, {
      signal: options.signal,
      persistAssets: true,
      onAssetWritten: (storageKey) => writtenPackageKeys.push(storageKey),
    });
    const analysis = await analyzeSavedRigCompatibility({
      sourceFile: options.sourceFile,
      rigPackageFile: options.rigPackageFile,
      approximateHeightMeters,
      signal: options.signal,
    });
    if (!analysis.ok) {
      throw new Error(analysis.diagnostics.map((item) => item.message).join(' '));
    }

    options.onProgress?.('Importing source character…');
    const mode = importedPackage.rig.importedRigBinding ? 'preserveExistingRig' : 'autorig';
    result = await importPoseableCharacter({
      file: options.sourceFile,
      orientation,
      approximateHeightMeters,
      mode,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const packageVertexCount = await resolvePoseableRigPackageVertexCount(importedPackage);
    const importedForCheck: ImportedPoseableRigPackage = {
      ...importedPackage,
      rig: {
        ...importedPackage.rig,
        regionMap: importedPackage.rig.regionMap ?? (
          typeof packageVertexCount === 'number'
            ? {
              version: 1,
              regionAssetId: 'package',
              vertexCount: packageVertexCount,
              topologyHash: importedPackage.manifest.topologyHash ?? 'unknown',
              sourceAssetId: 'package',
            }
            : undefined
        ),
      },
    };
    const compatibility = canApplyPoseableRigPackage({
      targetRig: result.rig,
      imported: importedForCheck,
      meshVertexCount: result.vertexCount,
    });
    if (!compatibility.ok) throw new Error(compatibility.reason);

    const merged = mergeImportedRigOntoTarget({
      targetRig: result.rig,
      imported: importedForCheck,
    });
    merged.orientation = orientation;
    merged.generationSettings = {
      ...merged.generationSettings,
      approximateHeightMeters,
    };
    const object = options.name.trim() ? { ...result.object, name: options.name.trim() } : result.object;
    const rigAsset: ProjectAsset = {
      ...result.rigAsset,
      metadata: { ...result.rigAsset.metadata, poseableRig: merged },
    };
    options.onProgress?.('Saved rig applied.');
    return {
      ...result,
      object,
      rig: merged,
      rigAsset,
      appliedSavedRig: true,
      topologyVerified: analysis.topologyVerified,
      packageManifest: importedPackage.manifest,
      packageAssets: {
        ...(importedPackage.sourceAsset ? { sourceAsset: importedPackage.sourceAsset } : {}),
        ...(importedPackage.skinAsset ? { skinAsset: importedPackage.skinAsset } : {}),
        ...(importedPackage.regionAsset ? { regionAsset: importedPackage.regionAsset } : {}),
      },
    };
  } catch (error) {
    await cleanupImportedPoseableRigPackage(importedPackage);
    await Promise.all(writtenPackageKeys.map((key) => deleteModelAsset(key).catch(() => undefined)));
    if (result?.sourceAsset.storageKey) await deleteModelAsset(result.sourceAsset.storageKey).catch(() => undefined);
    throw error;
  }
}

/** Cleanup helper for callers that fail while committing a successful result. */
export async function cleanupPoseableCharacterImportResult(
  result: Pick<SavedRigCharacterImportResult, 'sourceAsset' | 'packageAssets'> | undefined,
): Promise<void> {
  const keys = [
    result?.sourceAsset.storageKey,
    result?.packageAssets.sourceAsset?.storageKey,
    result?.packageAssets.skinAsset?.storageKey,
    result?.packageAssets.regionAsset?.storageKey,
  ].filter((key): key is string => Boolean(key));
  await Promise.all(keys.map((key) => deleteModelAsset(key).catch(() => undefined)));
}
