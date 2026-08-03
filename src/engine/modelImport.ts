import * as THREE from 'three';
import {
  ImportedModelImportMode,
  ImportedModelSourceApplication,
  ProjectAsset,
  SceneObject,
  Vec3,
} from '../domain/types';
import { BRAND } from '../config/brand';
import { createTransform } from '../domain/defaults';
import { createId } from '../utils/ids';
import { encodeBinaryGrayboxMesh, MODEL_ASSET_URI_PREFIX } from './importedMesh';
import { deleteModelAsset, putModelAsset } from './modelAssetStore';
import {
  IMPORT_BUDGET_POLICY,
  ImportBudgetEstimate,
  detectImportDeviceProfile,
  estimateModelImportBudget,
  formatImportBytes,
} from './modelImportBudget';
export { formatImportBytes as formatBytes } from './modelImportBudget';

export const DIRECT_MODEL_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'] as const;
export type DirectModelFormat = typeof DIRECT_MODEL_EXTENSIONS[number];

export const NATIVE_SCENE_EXTENSIONS = ['blend', 'ma', 'mb', 'uproject', 'umap', 'uasset'] as const;

export const MODEL_IMPORT_ACCEPT = [
  ...DIRECT_MODEL_EXTENSIONS.map((extension) => `.${extension}`),
  '.panoscene',
  '.panoscene.zip',
].join(',');

export const MAX_SOURCE_MODEL_BYTES = IMPORT_BUDGET_POLICY.maxSourceFileBytes;
export const IMPORT_WARNING_BYTES = 50 * 1024 * 1024;
export const IMPORT_WARNING_TRIANGLES = 500_000;
export const IMPORT_WARNING_OBJECTS = 250;
export const MAX_SEPARATE_IMPORT_OBJECTS = 2000;
export const SCENE_BUNDLE_MANIFEST = BRAND.sceneManifest;
/** Pre-rebrand bundles shipped a PanoRef-named manifest; they stay importable. */
export const LEGACY_SCENE_BUNDLE_MANIFEST = BRAND.legacySceneManifest;

const MAX_BUNDLE_ENTRIES = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BUNDLE_COMPRESSION_RATIO = 200;
const EMPTY_TEXTURE_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

const TEXTURE_ONLY_GLTF_EXTENSIONS = new Set([
  'EXT_texture_avif',
  'EXT_texture_webp',
  'KHR_texture_basisu',
  'KHR_texture_transform',
]);

export interface ModelImportPlanIssue {
  fileName: string;
  tone: 'warning' | 'error';
  message: string;
}

export type ModelImportJob =
  | {
    kind: 'file';
    file: File;
    sourceApplication?: ImportedModelSourceApplication;
    sourceSceneName?: string;
  }
  | {
    kind: 'bundle';
    file: File;
  };

export interface ModelImportPlan {
  jobs: ModelImportJob[];
  issues: ModelImportPlanIssue[];
}

export type ModelImportMode = ImportedModelImportMode;

export interface ModelImportOptions {
  mode: ModelImportMode;
  allowHeavy?: boolean;
  extremeConfirmation?: string;
  signal?: AbortSignal;
  onProgress?: (stage: ModelImportProgress) => void;
}

export interface ModelImportProgress { stage: 'reading' | 'parsing' | 'analyzing' | 'bounds' | 'converting' | 'writing' | 'creating' | 'finalizing'; message: string; completed?: number; total?: number }

export interface ModelImportAnalysis extends ImportBudgetEstimate {
  sourceFilename: string;
  fileSize: number;
  instancesExpanded: boolean;
  topMeshes: Array<{ name: string; path: string; vertices: number; triangles: number }>;
  warnings: string[];
}

export class ModelImportConsentRequiredError extends Error {
  constructor(public readonly analysis: ModelImportAnalysis) {
    super(`${analysis.tier === 'extreme' ? 'Extreme' : 'Heavy'} import confirmation is required.`);
    this.name = 'ModelImportConsentRequiredError';
  }
}

export interface ModelImportResult {
  asset: ProjectAsset;
  object: SceneObject;
}

export interface ModelImportSummary {
  sourceName: string;
  sourceFormat: string;
  mode: ModelImportMode;
  totalObjects: number;
  totalVertices: number;
  totalTriangles: number;
  sourceNodeCount: number;
  combined: boolean;
}

export interface ModelImportBatchResult {
  items: ModelImportResult[];
  summary: ModelImportSummary;
  warnings: string[];
  analysis: ModelImportAnalysis;
}

interface LoadedModel {
  root: THREE.Object3D;
  materialCount: number;
  textureCount: number;
  animationCount: number;
  warnings: string[];
}

interface SourceMeshUnit {
  sourceNodeName: string | undefined;
  sourceNodePath: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** Center of world-space AABB for this unit. */
  center: Vec3;
  dimensions: Vec3;
  vertexCount: number;
  triangleCount: number;
  instanceCount: number;
  flipWinding: boolean;
  worldMatrix: THREE.Matrix4;
}

interface SceneBundleManifestData {
  schemaVersion: 1 | '1';
  entry: string;
  geometryOnly?: boolean;
  source?: {
    application?: ImportedModelSourceApplication;
    file?: string;
    version?: string;
  };
}

// ------------------------------------------------------------------
// Planning – direct workflow only, native files are errors
// ------------------------------------------------------------------

export function createModelImportPlan(files: readonly File[]): ModelImportPlan {
  const directFiles = files.filter((file) => directFormatForFile(file));
  const nativeFiles = files.filter((file) => nativeApplicationForFile(file));
  const bundleFiles = files.filter(isSceneBundleFile);
  const recognized = new Set<File>([...directFiles, ...nativeFiles, ...bundleFiles]);
  const jobs: ModelImportJob[] = [
    ...bundleFiles.map((file) => ({ kind: 'bundle', file } as ModelImportJob)),
    ...directFiles.map((file) => ({ kind: 'file', file } as ModelImportJob)),
  ];
  const issues: ModelImportPlanIssue[] = [];

  for (const nativeFile of nativeFiles) {
    const ext = fileExtension(nativeFile.name);
    issues.push({
      fileName: nativeFile.name,
      tone: 'error',
      message: nativeExportGuidance(ext),
    });
  }

  files.forEach((file) => {
    if (recognized.has(file)) return;
    const extension = fileExtension(file.name);
    if (extension === 'mtl' || extension === 'bin') {
      issues.push({
        fileName: file.name,
        tone: 'warning',
        message: extension === 'mtl'
          ? 'Material sidecars are ignored because imports are always texture-free graybox geometry.'
          : 'External .bin sidecars are not loaded yet. Export an embedded .gltf or, preferably, a single .glb.',
      });
      return;
    }
    issues.push({
      fileName: file.name,
      tone: 'error',
      message: 'This file type is not supported by the lightweight importer.',
    });
  });

  return { jobs, issues };
}

export function nativeExportGuidance(extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === 'blend') {
    return `${BRAND.name} cannot read Blender project files directly. In Blender, export the entire scene as a GLB and import that GLB.`;
  }
  if (ext === 'ma' || ext === 'mb') {
    return `${BRAND.name} cannot read Maya scene files directly. In Maya, use Export All to create an FBX and import that FBX.`;
  }
  if (['uproject', 'umap', 'uasset'].includes(ext)) {
    return `${BRAND.name} cannot read Unreal project or asset files directly. Export the current level as GLB and import that GLB.`;
  }
  return 'This file type is not supported for direct import. Export a GLB or FBX from your DCC and import that.';
}

export function nativeBridgeMessage(application: ImportedModelSourceApplication): string {
  // Back-compat export – delegate to new guidance
  if (application === 'blender') return nativeExportGuidance('blend');
  if (application === 'maya') return nativeExportGuidance('ma');
  return nativeExportGuidance('umap');
}

// ------------------------------------------------------------------
// Import engine
// ------------------------------------------------------------------

export async function importModelJob(
  job: ModelImportJob,
  options: ModelImportOptions,
): Promise<ModelImportBatchResult> {
  if (job.kind === 'bundle') {
    const bundled = await readSceneBundle(job.file);
    return importDirectModel(
      bundled.file,
      options,
      bundled.manifest.source?.application,
      bundled.manifest.source?.file,
      bundled.manifest.geometryOnly === false
        ? ['The bundle was not marked geometry-only; all materials and textures were stripped during import.']
        : [],
    );
  }
  return importDirectModel(job.file, options, job.sourceApplication, job.sourceSceneName);
}

async function importDirectModel(
  file: File,
  options: ModelImportOptions,
  sourceApplication?: ImportedModelSourceApplication,
  sourceSceneName?: string,
  initialWarnings: string[] = [],
): Promise<ModelImportBatchResult> {
  const progress = options.onProgress ?? (() => undefined);
  const abort = () => { if (options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError'); };
  progress({ stage: 'reading', message: `Reading ${file.name}` });
  abort();
  assertSourceFileSize(file);
  const format = directFormatForFile(file);
  if (!format) throw new Error(`Unsupported model format: ${file.name}`);

  progress({ stage: 'parsing', message: `Parsing ${format.toUpperCase()}` });
  const loaded = await loadModel(file, format);
  const sourceImportId = createId('import');
  try {
    abort();
    progress({ stage: 'analyzing', message: 'Analyzing geometry' });
    const sourceUnits = collectSourceMeshUnits(loaded.root);
    if (sourceUnits.length === 0) {
      throw new Error('No triangle meshes were found in this file.');
    }

    // Object-count safety
    if (options.mode === 'separate' && sourceUnits.length > MAX_SEPARATE_IMPORT_OBJECTS) {
      throw new Error(
        `This file contains ${sourceUnits.length} separate objects, above the limit of ${MAX_SEPARATE_IMPORT_OBJECTS}. Use Combine into one object to import it.`,
      );
    }

    const totalVertices = sourceUnits.reduce((sum, unit) => sum + unit.vertexCount, 0);
    const totalTriangles = sourceUnits.reduce((sum, unit) => sum + unit.triangleCount, 0);
    const outputPositionBytes = totalVertices * 3 * 4;
    const outputIndexBytes = totalTriangles * 3 * 4;
    const analysis: ModelImportAnalysis = {
      sourceFilename: file.name,
      fileSize: file.size,
      instancesExpanded: sourceUnits.some((unit) => unit.instanceCount > 1),
      topMeshes: sourceUnits.map((unit) => ({ name: unit.sourceNodeName ?? 'Unnamed mesh', path: unit.sourceNodePath, vertices: unit.vertexCount, triangles: unit.triangleCount }))
        .sort((a, b) => b.vertices - a.vertices || b.triangles - a.triangles).slice(0, 10),
      warnings: sourceUnits.some((unit) => unit.instanceCount > 1) ? ['Source instances are expanded by the current flattened graybox representation.'] : [],
      ...estimateModelImportBudget({
        loadedVertexCount: totalVertices,
        triangleCount: totalTriangles,
        meshNodeCount: sourceUnits.length,
        instanceCount: sourceUnits.reduce((sum, unit) => sum + unit.instanceCount, 0),
        expandedInstanceCount: sourceUnits.reduce((sum, unit) => sum + Math.max(0, unit.instanceCount - 1), 0),
        uniquePositionBytes: outputPositionBytes + file.size,
        uniqueIndexBytes: outputIndexBytes,
        outputPositionBytes,
        outputIndexBytes,
        mode: options.mode,
      }, detectImportDeviceProfile()),
    };
    if (analysis.tier === 'reject') {
      throw new Error(`Import rejected: ${analysis.exceeded.join(', ')}. Estimated peak memory is ${formatImportBytes(analysis.estimatedPeakHeapBytes)}, above the ${formatImportBytes(analysis.safetyBudgetBytes)} safety budget for this device. Loaded geometry contains ${totalVertices.toLocaleString()} vertices and ${totalTriangles.toLocaleString()} triangles.`);
    }
    if ((analysis.tier === 'heavy' || analysis.tier === 'extreme') && !options.allowHeavy) throw new ModelImportConsentRequiredError(analysis);
    if (analysis.tier === 'extreme' && options.extremeConfirmation !== 'IMPORT') throw new ModelImportConsentRequiredError(analysis);

    // Build warnings summary
    const warnings = uniqueWarnings([
      ...initialWarnings,
      ...loaded.warnings,
      // material/texture stripping
      ...(loaded.materialCount > 0 || loaded.textureCount > 0
        ? [`Removed ${loaded.materialCount} material${loaded.materialCount === 1 ? '' : 's'} and ${loaded.textureCount} texture reference${loaded.textureCount === 1 ? '' : 's'} for graybox rendering.`]
        : []),
      ...(loaded.animationCount > 0
        ? [`Ignored ${loaded.animationCount} animation clip${loaded.animationCount === 1 ? '' : 's'}; imported the static scene pose.`]
        : []),
      ...(['obj', 'stl', 'ply'].includes(format)
        ? ['This format has no reliable unit metadata; 1 source unit is treated as 1 meter.']
        : []),
      ...(file.size >= IMPORT_WARNING_BYTES
        ? [`Large source file (${formatBytes(file.size)}); initial conversion may take longer on low-power devices.`]
        : []),
      ...(totalTriangles >= IMPORT_WARNING_TRIANGLES
        ? [`Heavy geometry (${totalTriangles.toLocaleString()} triangles) was imported unchanged.`]
        : []),
      ...(options.mode === 'separate' && sourceUnits.length >= IMPORT_WARNING_OBJECTS
        ? [`Importing ${sourceUnits.length} separate objects may affect project performance.`]
        : []),
      // Generic stripped notices
      ...(() => {
        const sawSkinned = loaded.warnings.some((w) => w.toLowerCase().includes('skinned'));
        const sawMorph = loaded.warnings.some((w) => w.toLowerCase().includes('morph'));
        const extra: string[] = [];
        if (!sawSkinned || !sawMorph) {
          // collectSourceMeshUnits already pushes skinned/morph warnings into loaded.warnings if seen,
          // but we ensure they are present as dedicated warnings already – nothing extra needed here.
        }
        return extra;
      })(),
    ]);

    const sourceName = sourceSceneName ?? file.name;
    const sourceKind = sourceApplication || sourceUnits.length > 1 ? 'scene' : 'model';
    const baseName = fileStem(sourceName);

    if (options.mode === 'combined') {
      return await buildCombinedResult({
        file,
        format,
        sourceApplication,
        sourceSceneName,
        sourceName,
        sourceKind,
        baseName,
        sourceImportId,
        sourceUnits,
        totalVertices,
        totalTriangles,
        loaded,
        warnings, analysis, options,
      });
    }

    return await buildSeparateResult({
      file,
      format,
      sourceApplication,
      sourceSceneName,
      sourceName,
      sourceKind,
      baseName,
      sourceImportId,
      sourceUnits,
      totalVertices,
      totalTriangles,
      loaded,
      warnings, analysis, options,
    });
  } finally {
    disposeLoadedRoot(loaded.root);
  }
}

interface BuildArgs {
  file: File;
  format: string;
  sourceApplication?: ImportedModelSourceApplication;
  sourceSceneName?: string;
  sourceName: string;
  sourceKind: 'model' | 'scene';
  baseName: string;
  sourceImportId: string;
  sourceUnits: SourceMeshUnit[];
  totalVertices: number;
  totalTriangles: number;
  loaded: LoadedModel;
  warnings: string[];
  analysis: ModelImportAnalysis;
  options: ModelImportOptions;
}

async function buildSeparateResult(args: BuildArgs): Promise<ModelImportBatchResult> {
  const {
    format, sourceApplication, sourceSceneName, sourceName, sourceKind,
    baseName, sourceImportId, sourceUnits, totalVertices, totalTriangles, warnings,
  } = args;

  // Unique naming within the batch – preserve source names and only deduplicate
  // exact duplicates.
  const usedNames = new Set<string>();
  const baseCount = new Map<string, number>();
  function uniqueName(preferred: string): string {
    const trimmed = preferred.trim() || baseName;
    if (!usedNames.has(trimmed)) {
      usedNames.add(trimmed);
      baseCount.set(trimmed, 1);
      return trimmed;
    }
    let count = baseCount.get(trimmed) ?? 1;
    let candidate: string;
    do {
      count += 1;
      candidate = `${trimmed} (${count})`;
    } while (usedNames.has(candidate));
    usedNames.add(candidate);
    baseCount.set(trimmed, count);
    return candidate;
  }

  const items: ModelImportResult[] = [];
  const writtenKeys: string[] = [];
  try {
  for (let sourceIndex = 0; sourceIndex < sourceUnits.length; sourceIndex += 1) {
    if (args.options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    const source = sourceUnits[sourceIndex];
    args.options.onProgress?.({ stage: 'converting', message: `Converting mesh ${sourceIndex + 1} of ${sourceUnits.length}`, completed: sourceIndex, total: sourceUnits.length });
    const packed = encodeBinaryGrayboxMesh(source.positions, source.indices);
    const rawName = source.sourceNodeName?.trim() || baseName;
    const unique = uniqueName(rawName);
    const now = new Date().toISOString();
    const assetId = createId('model');
    const binaryKey = `${sourceImportId}/${assetId}`;
    args.options.onProgress?.({ stage: 'writing', message: `Writing mesh ${sourceIndex + 1} of ${sourceUnits.length}`, completed: sourceIndex, total: sourceUnits.length });
    try { await putModelAsset(binaryKey, packed.buffer, args.options.signal); } catch (error) { await deleteModelAsset(binaryKey); throw error; }
    writtenKeys.push(binaryKey);
    const objectId = createId('obj');

    const asset: ProjectAsset = {
      id: assetId,
      type: 'model',
      name: `${unique}.panoref-mesh`,
      uri: `${MODEL_ASSET_URI_PREFIX}${binaryKey}`,
      mimeType: 'application/vnd.panoref.graybox-mesh',
      createdAt: now,
      originalFileName: args.file.name,
      byteSize: args.file.size,
      resolutionStatus: 'available',
      dimensions: [...source.dimensions] as Vec3,
      bounds: {
        min: source.dimensions.map((value) => -value / 2) as Vec3,
        max: source.dimensions.map((value) => value / 2) as Vec3,
      },
      meshCount: 1,
      metadata: {
        sourceName,
        bridgeFileName: sourceSceneName ? args.file.name : undefined,
        sourceFormat: format,
        sourceApplication,
        sourceImportId,
        sourceNodeName: source.sourceNodeName,
        sourceNodePath: source.sourceNodePath,
        sourceNodeCount: sourceUnits.length,
        importMode: 'separate',
        vertexCount: source.vertexCount,
        triangleCount: source.triangleCount,
        instanceCount: source.instanceCount > 1 ? source.instanceCount : undefined,
        meshCount: 1,
        packedBytes: packed.byteLength,
        geometrySimplified: false,
        hierarchyFlattened: true,
      },
    };

    const object: SceneObject = {
      id: objectId,
      name: unique,
      type: 'imported_model',
      transform: createTransform(source.center),
      dimensions: source.dimensions,
      category: 'architecture',
      locked: false,
      visible: true,
      modelAssetId: assetId,
      importedModel: {
        sourceName,
        sourceFormat: format,
        sourceKind,
        sourceApplication,
        sourceSceneName,
        vertexCount: source.vertexCount,
        triangleCount: source.triangleCount,
        meshCount: 1,
        instanceCount: source.instanceCount > 1 ? source.instanceCount : undefined,
        importMode: 'separate',
        sourceImportId,
        sourceNodeName: source.sourceNodeName,
        sourceNodePath: source.sourceNodePath,
        geometrySimplified: false,
        hierarchyFlattened: true,
        warnings: warnings.length > 0 ? [...warnings] : undefined,
      },
    };

    items.push({ asset, object });
    await yieldToBrowser();
  }
  } catch (error) {
    await Promise.all(writtenKeys.map((key) => deleteModelAsset(key)));
    throw error;
  }

  return {
    items,
    summary: {
      sourceName,
      sourceFormat: format,
      mode: 'separate',
      totalObjects: items.length,
      totalVertices,
      totalTriangles,
      sourceNodeCount: sourceUnits.length,
      combined: false,
    },
    warnings, analysis: args.analysis,
  };
}

async function buildCombinedResult(args: BuildArgs): Promise<ModelImportBatchResult> {
  const { format, sourceApplication, sourceSceneName, sourceName, sourceKind, baseName, sourceImportId, sourceUnits, totalVertices, totalTriangles, warnings } = args;

  // Merge all units into one mesh set - world baked already per-unit (positions already centered per unit, but for combined
  // we need to re-center globally to preserve world-space layout relative to combined bounds center).
  // Strategy: collect all world-space positions before per-unit centering? Actually per SourceMeshUnit we already baked and centered per unit.
  // For combined, we need to encode a single mesh where each triangle is placed as per original world + offset adjustment to combined center.
  // So we reconstruct global positions: unit.positions (centered) + unit.center.
  // Compute global min/max of those global positions, then recenter to global center.

  args.options.onProgress?.({ stage: 'bounds', message: 'Calculating combined bounds' });
  let globalMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  let globalMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (const source of sourceUnits) {
    for (let i = 0; i < source.positions.length; i += 3) {
      const x = source.positions[i] + source.center[0];
      const y = source.positions[i + 1] + source.center[1];
      const z = source.positions[i + 2] + source.center[2];
      if (x < globalMin.x) globalMin.x = x;
      if (y < globalMin.y) globalMin.y = y;
      if (z < globalMin.z) globalMin.z = z;
      if (x > globalMax.x) globalMax.x = x;
      if (y > globalMax.y) globalMax.y = y;
      if (z > globalMax.z) globalMax.z = z;
    }
  }

  const globalCenterVec = globalMin.clone().add(globalMax).multiplyScalar(0.5);
  const globalCenter: Vec3 = globalCenterVec.toArray() as Vec3;
  const size = globalMax.clone().sub(globalMin);
  const dimensions: Vec3 = [
    Math.max(size.x, 0.001),
    Math.max(size.y, 0.001),
    Math.max(size.z, 0.001),
  ];

  let totalVertexCount = 0;
  let totalIndexCount = 0;
  for (const unit of sourceUnits) {
    totalVertexCount += unit.positions.length / 3;
    totalIndexCount += unit.indices.length;
  }

  const combinedPositions = new Float32Array(totalVertexCount * 3);
  const combinedIndices = new Uint32Array(totalIndexCount);
  let vertexOffset = 0;
  let indexOffset = 0;

  args.options.onProgress?.({ stage: 'converting', message: 'Writing combined geometry' });
  for (let unitIndex = 0; unitIndex < sourceUnits.length; unitIndex += 1) {
    if (args.options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    const { positions, indices, center } = sourceUnits[unitIndex];
    const vCount = positions.length / 3;
    for (let i = 0; i < positions.length; i += 3) {
      const dst = (vertexOffset + i / 3) * 3;
      combinedPositions[dst] = positions[i] + center[0] - globalCenterVec.x;
      combinedPositions[dst + 1] = positions[i + 1] + center[1] - globalCenterVec.y;
      combinedPositions[dst + 2] = positions[i + 2] + center[2] - globalCenterVec.z;
    }
    for (let i = 0; i < indices.length; i += 1) {
      combinedIndices[indexOffset + i] = indices[i] + vertexOffset;
    }
    vertexOffset += vCount;
    indexOffset += indices.length;
    if (unitIndex % 8 === 7) await yieldToBrowser();
  }

  const packed = encodeBinaryGrayboxMesh(combinedPositions, combinedIndices);

  const now = new Date().toISOString();
  const assetId = createId('model');
  const binaryKey = `${sourceImportId}/${assetId}`;
  args.options.onProgress?.({ stage: 'writing', message: 'Writing binary asset' });
  try { await putModelAsset(binaryKey, packed.buffer, args.options.signal); } catch (error) { await deleteModelAsset(binaryKey); throw error; }
  const asset: ProjectAsset = {
    id: assetId,
    type: 'model',
    name: `${baseName}.panoref-mesh`,
    uri: `${MODEL_ASSET_URI_PREFIX}${binaryKey}`,
    mimeType: 'application/vnd.panoref.graybox-mesh',
    createdAt: now,
    originalFileName: args.file.name,
    byteSize: args.file.size,
    resolutionStatus: 'available',
    dimensions: [...dimensions] as Vec3,
    meshCount: sourceUnits.length,
    metadata: {
      sourceName,
      bridgeFileName: sourceSceneName ? args.file.name : undefined,
      sourceFormat: format,
      sourceApplication,
      sourceImportId,
      sourceNodeCount: sourceUnits.length,
      importMode: 'combined',
      vertexCount: totalVertexCount,
      triangleCount: totalIndexCount / 3,
      meshCount: sourceUnits.length,
      packedBytes: packed.byteLength,
      geometrySimplified: false,
      hierarchyFlattened: true,
    },
  };

  const object: SceneObject = {
    id: createId('obj'),
    name: baseName,
    type: 'imported_model',
    transform: createTransform(globalCenter),
    dimensions,
    category: 'architecture',
    locked: false,
    visible: true,
    modelAssetId: assetId,
    importedModel: {
      sourceName,
      sourceFormat: format,
      sourceKind,
      sourceApplication,
      sourceSceneName,
      vertexCount: totalVertexCount,
      triangleCount: totalIndexCount / 3,
      meshCount: sourceUnits.length,
      importMode: 'combined',
      sourceImportId,
      geometrySimplified: false,
      hierarchyFlattened: true,
      warnings: warnings.length > 0 ? [...warnings] : undefined,
    },
  };

  return {
    items: [{ asset, object }],
    summary: {
      sourceName,
      sourceFormat: format,
      mode: 'combined',
      totalObjects: 1,
      totalVertices: totalVertexCount,
      totalTriangles: totalIndexCount / 3,
      sourceNodeCount: sourceUnits.length,
      combined: true,
    },
    warnings, analysis: args.analysis,
  };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ------------------------------------------------------------------
// Mesh extraction helpers – Section 9-12
// ------------------------------------------------------------------

function collectSourceMeshUnits(root: THREE.Object3D): SourceMeshUnit[] {
  root.updateMatrixWorld(true);

  // Gather candidate meshes in traversal order
  interface Candidate {
    mesh: THREE.Mesh;
    index: number;
  }
  const candidates: Candidate[] = [];
  let traverseIndex = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    const meshName = sourceMeshName(mesh) || 'unnamed';
    if (!mesh.geometry) {
      throw new Error(`Mesh "${meshName}" has no geometry.`);
    }
    const pos = mesh.geometry.getAttribute('position');
    if (!pos || pos.itemSize < 3 || pos.count === 0) {
      throw new Error(`Mesh "${meshName}" has no valid position geometry.`);
    }
    const indexCount = mesh.geometry.index?.count ?? pos.count;
    if (indexCount === 0 || indexCount % 3 !== 0) {
      throw new Error(`Mesh "${meshName}" is not triangle geometry.`);
    }
    candidates.push({ mesh, index: traverseIndex++ });
  });

  // Build deterministic node paths
  const paths = buildDeterministicPaths(candidates);

  const units: SourceMeshUnit[] = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const { mesh } = candidates[ci];
    const sourceNodePath = paths[ci];
    const rawName = sourceMeshName(mesh);
    const sourceNodeName = rawName || undefined;

    const isInstanced = (mesh as THREE.InstancedMesh).isInstancedMesh;
    if (isInstanced) {
      // One unit containing all instances per spec (10b)
      const instanced = mesh as THREE.InstancedMesh;
      const count = instanced.count;
      if (count === 0) continue;
      // Merge all instances into one buffer set
      const geometry = mesh.geometry;
      const srcPosAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const srcIndex = geometry.index;
      const indexCountPerInstance = srcIndex?.count ?? srcPosAttr.count;
      const vertexCountPerInstance = srcPosAttr.count;

      // Pre-count for safety counting duplicated vertices
      const expandedVertexCount = vertexCountPerInstance * count;
      const expandedTriangleCount = (indexCountPerInstance / 3) * count;

      const flipPerInstance: boolean[] = [];
      const matrixPerInstance: THREE.Matrix4[] = [];
      const instanceMatrix = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        instanced.getMatrixAt(i, instanceMatrix);
        const world = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        matrixPerInstance.push(world);
        flipPerInstance.push(world.determinant() < 0);
      }

      // Bounds calc: we need world-space min/max before centering
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      const tmpVertex = new THREE.Vector3();
      for (let inst = 0; inst < count; inst++) {
        const m = matrixPerInstance[inst];
        for (let v = 0; v < vertexCountPerInstance; v++) {
          tmpVertex.set(srcPosAttr.getX(v), srcPosAttr.getY(v), srcPosAttr.getZ(v));
          tmpVertex.applyMatrix4(m);
          if (!Number.isFinite(tmpVertex.x) || !Number.isFinite(tmpVertex.y) || !Number.isFinite(tmpVertex.z)) {
            throw new Error('Imported geometry contains a non-finite transformed vertex.');
          }
          min.min(tmpVertex);
          max.max(tmpVertex);
        }
      }

      const centerVec = min.clone().add(max).multiplyScalar(0.5);
      const center: Vec3 = centerVec.toArray() as Vec3;
      const sizeVec = max.clone().sub(min);
      const dimensions: Vec3 = [
        Math.max(sizeVec.x, 0.001),
        Math.max(sizeVec.y, 0.001),
        Math.max(sizeVec.z, 0.001),
      ];

      // Now build positions centered
      const positions = new Float32Array(expandedVertexCount * 3);
      const indices = new Uint32Array(expandedTriangleCount * 3);

      let vertexOffset = 0;
      let indexOffset = 0;
      for (let inst = 0; inst < count; inst++) {
        const m = matrixPerInstance[inst];
        const flip = flipPerInstance[inst];
        for (let v = 0; v < vertexCountPerInstance; v++) {
          tmpVertex.set(srcPosAttr.getX(v), srcPosAttr.getY(v), srcPosAttr.getZ(v));
          tmpVertex.applyMatrix4(m);
          const dst = (vertexOffset + v) * 3;
          positions[dst] = tmpVertex.x - centerVec.x;
          positions[dst + 1] = tmpVertex.y - centerVec.y;
          positions[dst + 2] = tmpVertex.z - centerVec.z;
        }
        for (let k = 0; k < indexCountPerInstance; k += 3) {
          const a = (srcIndex?.getX(k) ?? k) + vertexOffset;
          const b = (srcIndex?.getX(k + 1) ?? k + 1) + vertexOffset;
          const c = (srcIndex?.getX(k + 2) ?? k + 2) + vertexOffset;
          indices[indexOffset + k] = a;
          indices[indexOffset + k + 1] = flip ? c : b;
          indices[indexOffset + k + 2] = flip ? b : c;
        }
        vertexOffset += vertexCountPerInstance;
        indexOffset += indexCountPerInstance;
      }

      units.push({
        sourceNodeName,
        sourceNodePath,
        positions,
        indices,
        center,
        dimensions,
        vertexCount: expandedVertexCount,
        triangleCount: expandedTriangleCount,
        instanceCount: count,
        flipWinding: false, // already applied
        worldMatrix: new THREE.Matrix4(), // not meaningful after merge
      });
    } else {
      const geometry = mesh.geometry;
      const srcPosAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const srcIndex = geometry.index;
      const indexCount = srcIndex?.count ?? srcPosAttr.count;
      const vertexCount = srcPosAttr.count;

      const world = mesh.matrixWorld;
      const flipWinding = world.determinant() < 0;
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      const tmpVertex = new THREE.Vector3();
      // First pass bounds
      for (let v = 0; v < vertexCount; v++) {
        tmpVertex.set(srcPosAttr.getX(v), srcPosAttr.getY(v), srcPosAttr.getZ(v));
        tmpVertex.applyMatrix4(world);
        if (!Number.isFinite(tmpVertex.x) || !Number.isFinite(tmpVertex.y) || !Number.isFinite(tmpVertex.z)) {
          throw new Error('Imported geometry contains a non-finite transformed vertex.');
        }
        min.min(tmpVertex);
        max.max(tmpVertex);
      }
      const centerVec = min.clone().add(max).multiplyScalar(0.5);
      const center: Vec3 = centerVec.toArray() as Vec3;
      const sizeVec = max.clone().sub(min);
      const dimensions: Vec3 = [
        Math.max(sizeVec.x, 0.001),
        Math.max(sizeVec.y, 0.001),
        Math.max(sizeVec.z, 0.001),
      ];

      const positions = new Float32Array(vertexCount * 3);
      const indices = new Uint32Array(indexCount);
      for (let v = 0; v < vertexCount; v++) {
        tmpVertex.set(srcPosAttr.getX(v), srcPosAttr.getY(v), srcPosAttr.getZ(v));
        tmpVertex.applyMatrix4(world);
        const dst = v * 3;
        positions[dst] = tmpVertex.x - centerVec.x;
        positions[dst + 1] = tmpVertex.y - centerVec.y;
        positions[dst + 2] = tmpVertex.z - centerVec.z;
      }
      for (let k = 0; k < indexCount; k += 3) {
        const a = srcIndex?.getX(k) ?? k;
        const b = srcIndex?.getX(k + 1) ?? k + 1;
        const c = srcIndex?.getX(k + 2) ?? k + 2;
        indices[k] = a;
        indices[k + 1] = flipWinding ? c : b;
        indices[k + 2] = flipWinding ? b : c;
      }

      units.push({
        sourceNodeName,
        sourceNodePath,
        positions,
        indices,
        center,
        dimensions,
        vertexCount,
        triangleCount: indexCount / 3,
        instanceCount: 1,
        flipWinding,
        worldMatrix: world.clone(),
      });
    }
  }

  return units;
}

function sourceMeshName(mesh: THREE.Mesh): string {
  const originalName = mesh.userData?.name;
  if (typeof originalName === 'string' && originalName.trim()) return originalName.trim();
  return (mesh.name || '').trim();
}

function buildDeterministicPaths(candidates: Array<{ mesh: THREE.Mesh }>): string[] {
  // For each candidate mesh, walk ancestors up to root (stop at the glTF scene root's parent chain)
  // Build path segment as trimmed name or mesh type + child index.
  // Child index: position among siblings (filtered to same parent's children order). We use parent.children index.

  const paths: string[] = [];
  for (const { mesh } of candidates) {
    const segments: string[] = [];
    let current: THREE.Object3D | null = mesh;
    const chain: THREE.Object3D[] = [];
    while (current) {
      chain.push(current);
      // Stop when parent is null or parent is Scene-like and not needed to go further? We'll go up until root parent is null
      // But skip the root itself if it's the loaded root (we want children from top)
      current = current.parent;
    }
    // chain is leaf->root, reverse to root->leaf
    chain.reverse();
    // Remove the topmost root if it's the imported root (usually named something generic). Keep all.
    for (let i = 0; i < chain.length; i++) {
      const obj = chain[i];
      // Skip if this is the absolute scene root (first) and it has no name? Keep still but produce deterministic segment.
      // To match spec Environment[0]/Furniture[3]/Chair[2], we need per parent child index.
      const parent = obj.parent;
      let childIndex = 0;
      if (parent) {
        childIndex = parent.children.indexOf(obj);
      }
      const trimmed = obj.name.trim();
      let segment: string;
      if (trimmed) {
        segment = trimmed;
      } else {
        const type = (obj.type || 'Node').replace(/[^A-Za-z0-9]/g, '') || 'Node';
        segment = `${type}[${childIndex}]`;
      }
      // Append [index] if needed? Spec example shows Name[index] ? Actually example shows Environment[0] etc – suggests including index for disambiguation.
      // We'll produce: if name present, append [childIndex] to ensure determinism: Name[childIndex]
      // However spec says "trimmed name or type + child index" – suggests if name missing, use type + index.
      // To satisfy both, use for named: keep name plus [childIndex] if we are to disambiguate? Let's follow simple rule:
      // If name present, use Name[index] pattern similar to example (Chair[2]). So include index.
      // If name missing, use Type[index].
      // Exception: to keep paths readable, always include [childIndex].
      const base = trimmed || (obj.type || 'Node').replace(/[^A-Za-z0-9]/g, '') || 'Node';
      segment = `${base}[${childIndex}]`;
      segments.push(segment);
    }
    // Join with '/'
    paths.push(segments.join('/'));
  }
  return paths;
}

// ------------------------------------------------------------------
// Loaders
// ------------------------------------------------------------------

async function loadModel(file: File, format: DirectModelFormat): Promise<LoadedModel> {
  if (format === 'glb' || format === 'gltf') return loadGltf(file, format);
  if (format === 'obj') {
    const [{ OBJLoader }, text] = await Promise.all([
      import('three/addons/loaders/OBJLoader.js'),
      file.text(),
    ]);
    return describeLoadedRoot(new OBJLoader().parse(text));
  }
  if (format === 'stl') {
    const [{ STLLoader }, buffer] = await Promise.all([
      import('three/addons/loaders/STLLoader.js'),
      file.arrayBuffer(),
    ]);
    const geometry = new STLLoader().parse(buffer);
    return describeLoadedRoot(new THREE.Mesh(geometry));
  }
  if (format === 'ply') {
    const [{ PLYLoader }, buffer] = await Promise.all([
      import('three/addons/loaders/PLYLoader.js'),
      file.arrayBuffer(),
    ]);
    const geometry = new PLYLoader().parse(buffer);
    return describeLoadedRoot(new THREE.Mesh(geometry));
  }

  const [{ FBXLoader }, buffer] = await Promise.all([
    import('three/addons/loaders/FBXLoader.js'),
    file.arrayBuffer(),
  ]);
  const manager = textureBlockingManager();
  const root = new FBXLoader(manager).parse(buffer, '');
  return describeLoadedRoot(root);
}

async function loadGltf(file: File, format: 'glb' | 'gltf'): Promise<LoadedModel> {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader(textureBlockingManager());
  let sanitized: string | ArrayBuffer;
  let strippedMaterialCount = 0;
  let strippedTextureCount = 0;

  if (format === 'glb') {
    const result = sanitizeGlb(await file.arrayBuffer());
    sanitized = result.buffer;
    strippedMaterialCount = result.materialCount;
    strippedTextureCount = result.textureCount;
  } else {
    const document = parseGltfJson(await file.text());
    assertEmbeddedGltfBuffers(document);
    const result = sanitizeGltfDocument(document);
    sanitized = JSON.stringify(result.document);
    strippedMaterialCount = result.materialCount;
    strippedTextureCount = result.textureCount;
  }

  let gltf: Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>;
  try {
    gltf = await loader.parseAsync(sanitized, '');
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not parse ${file.name}: ${error.message}`
        : `Could not parse ${file.name}.`,
    );
  }
  const described = describeLoadedRoot(gltf.scene);
  described.materialCount += strippedMaterialCount;
  described.textureCount += strippedTextureCount;
  described.animationCount = gltf.animations.length;
  return described;
}

function describeLoadedRoot(root: THREE.Object3D): LoadedModel {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const warnings: string[] = [];
  let sawSkinned = false;
  let sawMorph = false;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      meshMaterials.forEach((material) => {
        materials.add(material);
        Object.values(material).forEach((value) => {
          if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
            textures.add(value as THREE.Texture);
          }
        });
      });
    }
    if ((mesh as any).isSkinnedMesh) sawSkinned = true;
    if (mesh.isMesh && mesh.geometry && Object.keys(mesh.geometry.morphAttributes).length > 0) {
      sawMorph = true;
    }
  });
  if (sawSkinned) warnings.push('This file contains a rigged character. Use “Import poseable character” to preserve its skeleton and skin weights; ordinary model import keeps static geometry only.');
  if (sawMorph) warnings.push('Morph target animation was ignored; base geometry was imported.');
  return {
    root,
    materialCount: materials.size,
    textureCount: textures.size,
    animationCount: 0,
    warnings,
  };
}

function sanitizeGlb(buffer: ArrayBuffer): {
  buffer: ArrayBuffer;
  materialCount: number;
  textureCount: number;
} {
  if (buffer.byteLength < 20) throw new Error('GLB file is too small.');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error('Only valid glTF 2.0 GLB files are supported.');
  }
  if (view.getUint32(8, true) !== buffer.byteLength) throw new Error('GLB file length is invalid.');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== GLB_JSON_CHUNK || 20 + jsonLength > buffer.byteLength) {
    throw new Error('GLB JSON chunk is invalid.');
  }

  const jsonBytes = new Uint8Array(buffer, 20, jsonLength);
  const document = parseGltfJson(new TextDecoder().decode(jsonBytes).replace(/[\u0000\s]+$/g, ''));
  const sanitized = sanitizeGltfDocument(document);
  const encoded = new TextEncoder().encode(JSON.stringify(sanitized.document));
  const paddedJsonLength = (encoded.byteLength + 3) & ~3;
  const oldRestOffset = 20 + jsonLength;
  const rest = new Uint8Array(buffer, oldRestOffset);
  const output = new ArrayBuffer(20 + paddedJsonLength + rest.byteLength);
  const outputView = new DataView(output);
  outputView.setUint32(0, GLB_MAGIC, true);
  outputView.setUint32(4, 2, true);
  outputView.setUint32(8, output.byteLength, true);
  outputView.setUint32(12, paddedJsonLength, true);
  outputView.setUint32(16, GLB_JSON_CHUNK, true);
  const outputBytes = new Uint8Array(output);
  outputBytes.fill(0x20, 20, 20 + paddedJsonLength);
  outputBytes.set(encoded, 20);
  outputBytes.set(rest, 20 + paddedJsonLength);
  return {
    buffer: output,
    materialCount: sanitized.materialCount,
    textureCount: sanitized.textureCount,
  };
}

function sanitizeGltfDocument(document: Record<string, unknown>): {
  document: Record<string, unknown>;
  materialCount: number;
  textureCount: number;
} {
  assertSupportedGltfFeatures(document);
  const materials = Array.isArray(document.materials) ? document.materials : [];
  const textures = Array.isArray(document.textures) ? document.textures : [];
  const images = Array.isArray(document.images) ? document.images : [];
  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  meshes.forEach((mesh) => {
    if (!mesh || typeof mesh !== 'object') return;
    const primitives = Array.isArray((mesh as { primitives?: unknown[] }).primitives)
      ? (mesh as { primitives: Array<Record<string, unknown>> }).primitives
      : [];
    primitives.forEach((primitive) => {
      delete primitive.material;
      const extensions = primitive.extensions as Record<string, unknown> | undefined;
      if (extensions) delete extensions.KHR_materials_variants;
    });
  });
  delete document.materials;
  delete document.textures;
  delete document.images;
  delete document.samplers;
  document.extensionsUsed = filterGltfExtensions(document.extensionsUsed);
  document.extensionsRequired = filterGltfExtensions(document.extensionsRequired);
  return {
    document,
    materialCount: materials.length,
    textureCount: Math.max(textures.length, images.length),
  };
}

function assertSupportedGltfFeatures(document: Record<string, unknown>) {
  const required = Array.isArray(document.extensionsRequired) ? document.extensionsRequired : [];
  const compressed = required.filter((extension) => (
    extension === 'KHR_draco_mesh_compression' || extension === 'EXT_meshopt_compression'
  ));
  if (compressed.length > 0) {
    throw new Error(
      `Compressed glTF geometry (${compressed.join(', ')}) is not enabled in the lightweight importer. Export an uncompressed geometry-only GLB.`,
    );
  }
}

function assertEmbeddedGltfBuffers(document: Record<string, unknown>) {
  const buffers = Array.isArray(document.buffers) ? document.buffers : [];
  const external = buffers.some((buffer) => {
    const uri = buffer && typeof buffer === 'object' ? (buffer as { uri?: unknown }).uri : undefined;
    return typeof uri === 'string' && !uri.startsWith('data:');
  });
  if (external) {
    throw new Error('External .gltf buffer files are not loaded yet. Export an embedded .gltf or a single .glb.');
  }
}

function filterGltfExtensions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((extension): extension is string => (
    typeof extension === 'string'
    && !TEXTURE_ONLY_GLTF_EXTENSIONS.has(extension)
    && extension !== 'KHR_materials_variants'
  ));
}

function parseGltfJson(text: string): Record<string, unknown> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('glTF JSON is invalid.');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('glTF JSON root is invalid.');
  }
  const asset = (document as { asset?: { version?: unknown } }).asset;
  if (!asset || asset.version !== '2.0') throw new Error('Only glTF 2.0 is supported.');
  return document as Record<string, unknown>;
}

async function readSceneBundle(file: File): Promise<{ file: File; manifest: SceneBundleManifestData }> {
  assertSourceFileSize(file);
  const { default: JSZip } = await import('jszip');
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name} is not a valid ${BRAND.name} scene bundle.`);
  }
  const entries = Object.keys(zip.files);
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error(`Scene bundle contains more than ${MAX_BUNDLE_ENTRIES} entries.`);
  }
  const manifestEntry = zip.file(SCENE_BUNDLE_MANIFEST) ?? zip.file(LEGACY_SCENE_BUNDLE_MANIFEST);
  if (!manifestEntry) throw new Error(`Scene bundle is missing ${SCENE_BUNDLE_MANIFEST}.`);
  const manifestSizes = zipEntrySizes(manifestEntry);
  if (manifestSizes.uncompressed > MAX_MANIFEST_BYTES) {
    throw new Error('Scene bundle manifest is too large.');
  }
  const manifestText = await manifestEntry.async('string');
  if (new TextEncoder().encode(manifestText).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Scene bundle manifest is too large.');
  }
  const manifest = parseSceneBundleManifest(manifestText);
  const modelEntry = zip.file(manifest.entry);
  if (!modelEntry) throw new Error(`Scene bundle entry ${manifest.entry} is missing.`);
  const entrySizes = zipEntrySizes(modelEntry);
  if (entrySizes.uncompressed > MAX_SOURCE_MODEL_BYTES) {
    throw new Error(`Bundled model is above the ${formatBytes(MAX_SOURCE_MODEL_BYTES)} safety limit.`);
  }
  if (entrySizes.compressed > 0 && entrySizes.uncompressed / entrySizes.compressed > MAX_BUNDLE_COMPRESSION_RATIO) {
    throw new Error('Scene bundle entry has an unsafe compression ratio.');
  }
  const bytes = await modelEntry.async('uint8array');
  if (bytes.byteLength > MAX_SOURCE_MODEL_BYTES) {
    throw new Error(`Bundled model is above the ${formatBytes(MAX_SOURCE_MODEL_BYTES)} safety limit.`);
  }
  const name = manifest.entry.split('/').at(-1) ?? manifest.entry;
  const modelFile = new File([bytes], name);
  if (!directFormatForFile(modelFile)) {
    throw new Error('Scene bundle entry must be GLB, embedded glTF, OBJ, STL, PLY, or FBX.');
  }
  return { file: modelFile, manifest };
}

function parseSceneBundleManifest(text: string): SceneBundleManifestData {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('Scene bundle manifest is not valid JSON.');
  }
  if (!manifest || typeof manifest !== 'object') throw new Error('Scene bundle manifest is invalid.');
  const value = manifest as SceneBundleManifestData;
  if (String(value.schemaVersion) !== '1') throw new Error('Unsupported scene bundle schema version.');
  if (!isSafeBundlePath(value.entry)) throw new Error('Scene bundle entry path is unsafe or missing.');
  if (value.source?.application && !['blender', 'maya', 'unreal'].includes(value.source.application)) {
    throw new Error('Scene bundle source application is invalid.');
  }
  return value;
}

function textureBlockingManager() {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:application/') || url.startsWith('data:application/octet-stream')) return url;
    return EMPTY_TEXTURE_DATA_URL;
  });
  return manager;
}

function disposeLoadedRoot(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (!mesh.material) return;
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    meshMaterials.forEach((material) => {
      materials.add(material);
      Object.values(material).forEach((value) => {
        if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
          textures.add(value as THREE.Texture);
        }
      });
    });
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

function directFormatForFile(file: Pick<File, 'name'>): DirectModelFormat | undefined {
  const extension = fileExtension(file.name);
  return DIRECT_MODEL_EXTENSIONS.find((format) => format === extension);
}

function nativeApplicationForFile(file: Pick<File, 'name'>): ImportedModelSourceApplication | undefined {
  const extension = fileExtension(file.name);
  if (extension === 'blend') return 'blender';
  if (extension === 'ma' || extension === 'mb') return 'maya';
  if (extension === 'uproject' || extension === 'umap' || extension === 'uasset') return 'unreal';
  return undefined;
}

function isSceneBundleFile(file: Pick<File, 'name'>) {
  const lower = file.name.toLowerCase();
  return lower.endsWith('.panoscene') || lower.endsWith('.panoscene.zip');
}

function isSafeBundlePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.split(/[\\/]/).includes('..');
}

function zipEntrySizes(entry: unknown): { compressed: number; uncompressed: number } {
  const data = (entry as {
    _data?: { compressedSize?: unknown; uncompressedSize?: unknown };
  })._data;
  return {
    compressed: typeof data?.compressedSize === 'number' ? data.compressedSize : 0,
    uncompressed: typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0,
  };
}

function assertSourceFileSize(file: File) {
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  if (file.size > MAX_SOURCE_MODEL_BYTES) {
    throw new Error(
      `${file.name} is ${formatBytes(file.size)}, above the ${formatBytes(MAX_SOURCE_MODEL_BYTES)} safety limit. No geometry was simplified.`,
    );
  }
}

function fileExtension(name: string) {
  return name.toLowerCase().split('.').at(-1) ?? '';
}

function fileStem(name: string) {
  return name.replace(/\.(panoscene\.zip|[^.]+)$/i, '') || 'Imported model';
}

function uniqueWarnings(warnings: string[]) {
  return [...new Set(warnings.filter(Boolean))];
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
