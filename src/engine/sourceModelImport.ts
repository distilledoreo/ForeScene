import type { ProjectAsset, SceneObject, Vec3 } from '../domain/types';
import { createTransform } from '../domain/defaults';
import { createId } from '../utils/ids';
import { sha256Digest } from './binaryIntegrity';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { putModelAsset, deleteModelAsset } from './modelAssetStore';
import {
  detectImportDeviceProfile, IMPORT_BUDGET_POLICY, type ModelImportTier,
} from './modelImportBudget';
import {
  MAX_SEPARATE_IMPORT_OBJECTS, ModelImportConsentRequiredError,
  type ModelImportAnalysis, type ModelImportBatchResult, type ModelImportJob, type ModelImportOptions,
} from './modelImport';
import { checkSourceImportAbort, prepareSourceModelPackage, type SourceModelPackage } from './sourceModelPackage';
import { disposeSourceResources, loadSourceModel, sourceDescriptor, type LoadedSourceModel } from './sourceModelLoader';
import { primeSourceModel } from './sourceModelRuntime';

/** Byte estimates include decoded textures; source file size alone is not a VRAM estimate. */
export function estimatePreservedSourceBudget(input: SourceModelPackage, loaded: LoadedSourceModel, options: ModelImportOptions): ModelImportAnalysis {
  const device = detectImportDeviceProfile();
  const budget = Math.min(device.deviceMemoryGb * 1024 ** 3 * IMPORT_BUDGET_POLICY.installedMemoryFraction,
    device.isMobile ? IMPORT_BUDGET_POLICY.mobileBudgetCapBytes : IMPORT_BUDGET_POLICY.desktopBudgetCapBytes);
  const sourceBytes = [...input.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const objectCount = options.mode === 'combined' ? 1 : loaded.nodes.length;
  const nodeOverhead = objectCount * 4096 + loaded.nodes.reduce((sum, node) => sum + node.path.length * 512, 0);
  // Original input, persistent-store copy and recovery/package staging can coexist.
  const peak = sourceBytes * 2 + input.bytes.byteLength * 3 + loaded.geometryBytes * 2 + loaded.textureBytes * 2 + nodeOverhead;
  const projectStorageBytes = input.bytes.byteLength + objectCount * 1024;
  const exceeded: string[] = [];
  if (peak > budget) exceeded.push('estimated peak memory (including decoded textures)');
  if (projectStorageBytes > IMPORT_BUDGET_POLICY.maxProjectAssetBytes) exceeded.push('project asset storage size');
  let tier: ModelImportTier = exceeded.length ? 'reject'
    : peak <= budget * IMPORT_BUDGET_POLICY.standardFraction ? 'standard'
      : peak <= budget * IMPORT_BUDGET_POLICY.heavyFraction ? 'heavy' : 'extreme';
  if (tier === 'extreme' && device.isMobile && !device.developerOverride) { tier = 'reject'; exceeded.push('mobile memory safety'); }
  const vertices = loaded.nodes.reduce((sum, node) => sum + node.vertexCount, 0);
  const triangles = loaded.nodes.reduce((sum, node) => sum + node.triangleCount, 0);
  return {
    sourceFilename: input.sourceName, fileSize: input.bytes.byteLength, sourcePreserved: true,
    instancesExpanded: false, textureBytes: loaded.textureBytes,
    topMeshes: [...loaded.nodes].sort((a, b) => b.vertexCount - a.vertexCount).slice(0, 10)
      .map((node) => ({ name: node.name, path: '/' + node.path.join('/'), vertices: node.vertexCount, triangles: node.triangleCount })),
    warnings: [...loaded.warnings], loadedVertexCount: vertices, triangleCount: triangles,
    meshNodeCount: loaded.nodes.length, instanceCount: loaded.nodes.reduce((sum, node) => sum + node.instanceCount, 0),
    expandedInstanceCount: 0, uniquePositionBytes: loaded.geometryBytes, uniqueIndexBytes: 0,
    outputPositionBytes: 0, outputIndexBytes: 0, mode: options.mode, normalBytes: 0,
    transformationBytes: 0, combinedTemporaryBytes: 0, packedBytes: input.bytes.byteLength,
    base64Bytes: 0, gpuBytes: loaded.geometryBytes + loaded.textureBytes,
    projectStorageBytes, estimatedPeakHeapBytes: peak, safetyBudgetBytes: budget, tier, exceeded,
  };
}

export async function importPreservedSource(job: ModelImportJob, options: ModelImportOptions): Promise<ModelImportBatchResult> {
  const progress = options.onProgress ?? (() => undefined);
  checkSourceImportAbort(options.signal);
  progress({ stage: 'reading', message: `Reading original source ${job.file.name}` });
  const input = await prepareSourceModelPackage(job, options.signal);
  checkSourceImportAbort(options.signal);
  progress({ stage: 'parsing', message: 'Loading source geometry, materials, textures, and hierarchy' });
  const loaded = await loadSourceModel(input, options.signal);
  let adopted = false;
  let storedKey: string | undefined;
  try {
    if (options.mode === 'separate' && loaded.nodes.length > MAX_SEPARATE_IMPORT_OBJECTS) {
      throw new Error(`Source contains ${loaded.nodes.length} selectable nodes, above the ${MAX_SEPARATE_IMPORT_OBJECTS} limit. Import as one scene instead; the original hierarchy will still be preserved.`);
    }
    progress({ stage: 'analyzing', message: 'Checking source and decoded-texture memory budgets' });
    const analysis = estimatePreservedSourceBudget(input, loaded, options);
    if (analysis.tier === 'reject') throw new Error(`Source import rejected: ${analysis.exceeded.join(', ')}. Use smaller textures or a lighter source; ForeScene will not silently strip or simplify it.`);
    if (analysis.tier !== 'standard' && !options.allowHeavy) throw new ModelImportConsentRequiredError(analysis);
    if (analysis.tier === 'extreme' && options.extremeConfirmation !== 'IMPORT') throw new ModelImportConsentRequiredError(analysis);
    checkSourceImportAbort(options.signal);
    const hash = await sha256Digest(input.bytes);
    const descriptor = sourceDescriptor(input, loaded, hash);
    const assetId = createId('asset');
    const importId = createId('import');
    const storageKey = `source/${assetId}`;
    const asset: ProjectAsset = {
      id: assetId, type: 'model', name: input.sourceName, createdAt: new Date().toISOString(),
      uri: `${MODEL_ASSET_URI_PREFIX}${storageKey}`, storageKey,
      mimeType: input.container === 'zip' ? 'application/zip'
        : input.format === 'glb' ? 'model/gltf-binary' : input.format === 'gltf' ? 'model/gltf+json' : 'application/octet-stream',
      originalFileName: job.file.name, contentHash: hash, byteSize: input.bytes.byteLength,
      resolutionStatus: 'available',
      dimensions: descriptor.bounds.min.map((value, i) => Math.max(0.001, descriptor.bounds.max[i] - value)) as Vec3,
      meshCount: loaded.nodes.length,
      metadata: { modelEncoding: 'source', sourceModel: descriptor, format: input.format, meshCount: loaded.nodes.length },
    };
    const nodes = options.mode === 'combined' ? [{
      name: input.sourceName.replace(/\.[^.]+$/, ''), path: undefined, bounds: loaded.bounds,
      vertexCount: analysis.loadedVertexCount, triangleCount: analysis.triangleCount,
      instanceCount: analysis.instanceCount,
    }] : loaded.nodes;
    const items = nodes.map((node) => {
      const center = node.bounds.min.map((value, i) => (value + node.bounds.max[i]) / 2) as Vec3;
      const dimensions = node.bounds.min.map((value, i) => Math.max(0.001, node.bounds.max[i] - value)) as Vec3;
      const object: SceneObject = {
        id: createId('obj'), name: node.name, type: 'imported_model', category: 'architecture',
        transform: createTransform(center), dimensions, locked: false, visible: true,
        modelAssetId: assetId, surfaceStyle: 'source',
        ...(node.path !== undefined ? { sourceModelNodePath: [...node.path] } : {}),
        importedModel: {
          sourceName: input.sourceName, sourceFormat: input.format,
          sourceKind: loaded.nodes.length > 1 || input.sourceApplication ? 'scene' : 'model',
          sourceApplication: input.sourceApplication, sourceSceneName: input.sourceSceneName,
          vertexCount: node.vertexCount, triangleCount: node.triangleCount,
          meshCount: options.mode === 'combined' ? loaded.nodes.reduce((sum, entry) => sum + (entry.renderablePaths?.length ?? 1), 0) : ('renderablePaths' in node ? node.renderablePaths?.length ?? 1 : 1),
          instanceCount: node.instanceCount, importMode: options.mode, sourceImportId: importId,
          sourceNodeName: node.name, sourceNodePath: node.path ? '/' + node.path.join('/') : undefined,
          geometrySimplified: false, hierarchyFlattened: false, sourcePreserved: true,
          warnings: loaded.warnings,
        },
      };
      return { asset, object };
    });
    progress({ stage: 'writing', message: 'Saving immutable source and companion files' });
    await putModelAsset(storageKey, input.bytes, options.signal);
    storedKey = storageKey;
    checkSourceImportAbort(options.signal);
    primeSourceModel(asset, loaded);
    adopted = true;
    progress({ stage: 'finalizing', message: 'Source import ready' });
    return { items, analysis, warnings: loaded.warnings, summary: {
      sourceName: input.sourceName, sourceFormat: input.format, mode: options.mode,
      totalObjects: items.length, totalVertices: analysis.loadedVertexCount, totalTriangles: analysis.triangleCount,
      sourceNodeCount: loaded.nodes.length, combined: options.mode === 'combined', sourcePreserved: true,
    } };
  } catch (error) {
    if (storedKey) await deleteModelAsset(storedKey);
    throw error;
  } finally {
    if (!adopted) disposeSourceResources(loaded.scenes);
  }
}
