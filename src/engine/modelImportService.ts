/**
 * Project-aware model import service.
 *
 * Conversion remains in `modelImport.ts`; this module is the one shared
 * commit boundary for the manual dialog and Agent API.  It keeps the binary
 * payload and project document in lockstep with the local recovery layer.
 */

import { MODEL_ASSET_URI_PREFIX } from './importedMesh';
import {
  importModelJob,
  type ModelImportAnalysis,
  type ModelImportBatchResult,
  type ModelImportJob,
  type ModelImportOptions,
} from './modelImport';
import { deleteModelAsset } from './modelAssetStore';
import { sha256Digest } from './binaryIntegrity';
import { touchProject } from '../state/slices/touchProject';
import { useProjectSafetyStore } from '../state/useProjectSafetyStore';
import { useProjectStore } from '../state/useProjectStore';
import type { ProjectAsset, SceneObject } from '../domain/types';

export interface ProjectModelImportResult extends ModelImportBatchResult {
  verifiedRevisionId?: string;
  reused?: boolean;
}

function findExistingModelImportByContentHash(contentHash: string): { asset: ProjectAsset; object: SceneObject } | undefined {
  const project = useProjectStore.getState().project;
  const asset = Object.values(project.assets.assets).find((entry) => (
    entry.type === 'model'
    && entry.contentHash === contentHash
    && entry.resolutionStatus === 'available'
  ));
  if (!asset) return undefined;
  const object = project.scene.objects.find((entry) => (
    entry.type === 'imported_model' && entry.modelAssetId === asset.id
  ));
  if (!object) return undefined;
  return { asset, object };
}

function reusedImportAnalysis(
  sourceFile: File,
  options: ModelImportOptions,
  triangleCount: number,
  vertexCount: number,
): ModelImportAnalysis {
  const mode = options.mode ?? 'separate';
  return {
    sourceFilename: sourceFile.name,
    fileSize: sourceFile.size,
    instancesExpanded: false,
    topMeshes: [],
    warnings: [],
    loadedVertexCount: vertexCount,
    triangleCount,
    meshNodeCount: 1,
    instanceCount: 1,
    expandedInstanceCount: 1,
    uniquePositionBytes: 0,
    uniqueIndexBytes: 0,
    outputPositionBytes: 0,
    outputIndexBytes: 0,
    mode,
    normalBytes: 0,
    transformationBytes: 0,
    combinedTemporaryBytes: 0,
    packedBytes: 0,
    base64Bytes: 0,
    gpuBytes: 0,
    projectStorageBytes: 0,
    estimatedPeakHeapBytes: 0,
    safetyBudgetBytes: 0,
    tier: 'standard',
    exceeded: [],
  };
}

function reusedImportBatch(
  existing: { asset: ProjectAsset; object: SceneObject },
  sourceFile: File,
  options: ModelImportOptions,
): ModelImportBatchResult {
  const imported = existing.object.importedModel;
  const triangleCount = imported?.triangleCount ?? 0;
  const vertexCount = imported?.vertexCount ?? 0;
  return {
    items: [{ asset: existing.asset, object: existing.object }],
    summary: {
      sourceName: sourceFile.name,
      sourceFormat: sourceFile.name.split('.').pop()?.toLowerCase() ?? 'glb',
      mode: options.mode ?? 'separate',
      totalObjects: 1,
      totalVertices: vertexCount,
      totalTriangles: triangleCount,
      sourceNodeCount: 1,
      combined: (options.mode ?? 'separate') === 'combined',
    },
    warnings: [],
    analysis: reusedImportAnalysis(sourceFile, options, triangleCount, vertexCount),
  };
}

/** Convert a model, then register all of its assets and objects atomically. */
export async function importModelIntoProject(
  job: ModelImportJob,
  options: ModelImportOptions,
): Promise<ProjectModelImportResult> {
  if (job.kind === 'file') {
    const contentHash = await sha256Digest(await job.file.arrayBuffer());
    const existing = findExistingModelImportByContentHash(contentHash);
    if (existing) {
      useProjectStore.setState((state) => ({
        ...state,
        selectedObjectIds: [existing.object.id],
        buildMode: 'select',
      }));
      return {
        ...reusedImportBatch(existing, job.file, options),
        reused: true,
      };
    }
  }

  const batch = await importModelJob(job, options);
  const runDestructiveProjectMutation = useProjectSafetyStore
    .getState().runDestructiveProjectMutation;

  if (!runDestructiveProjectMutation) {
    await discardImportedBinaryAssets(batch);
    throw new Error('Local recovery is still starting. Please wait before importing a model.');
  }

  const projectStateBefore = useProjectStore.getState();
  const projectBefore = structuredClone(projectStateBefore.project);
  const selectionBefore = [...projectStateBefore.selectedObjectIds];
  const enriched = await enrichImportedAssets(batch, job.kind === 'file' ? job.file : undefined);

  try {
    const verified = await runDestructiveProjectMutation('Before importing a model', () => {
      useProjectStore.getState().addImportedModels(enriched.items);
    });
    return { ...batch, verifiedRevisionId: verified?.revision.id };
  } catch (error) {
    // A persistence failure can occur after its callback ran. Restore the exact
    // pre-import document before deleting the binary payloads, so no project can
    // retain an asset URI whose payload was cleaned up.
    const live = useProjectStore.getState().project;
    const importedObjectIds = new Set(batch.items.map((item) => item.object.id));
    if (live.scene.objects.some((object) => importedObjectIds.has(object.id))) {
      useProjectStore.setState({
        project: projectBefore,
        selectedObjectIds: selectionBefore,
        buildHistoryPast: [],
        buildHistoryFuture: [],
        buildHistoryBatchDepth: 0,
        buildHistoryBatchCaptured: false,
        buildHistoryCoalesceActive: false,
      });
    }
    await discardImportedBinaryAssets(batch);
    throw error;
  }
}

export async function relinkModelAssetIntoProject(
  file: File,
  targetAssetId: string,
  options: { mode?: 'locate' | 'replace' } = {},
): Promise<{ verifiedRevisionId?: string; assetId: string }> {
  const current = useProjectStore.getState().project;
  const target = current.assets.assets[targetAssetId];
  if (!target || target.type !== 'model') throw new Error('The selected missing asset is no longer in this project.');
  const contentHash = await sha256Digest(await file.arrayBuffer());
  if (options.mode === 'locate' && target.contentHash && target.contentHash !== contentHash) {
    throw new Error('This file does not match the original asset. Use Replace Asset to intentionally substitute it.');
  }
  const batch = await importModelJob({ kind: 'file', file }, { mode: 'combined' });
  const runDestructiveProjectMutation = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructiveProjectMutation) {
    await discardImportedBinaryAssets(batch);
    throw new Error('Local recovery is still starting. Please wait before relinking an asset.');
  }
  const before = structuredClone(current);
  try {
    const enriched = await enrichImportedAssets(batch, file);
    const replacement = enriched.items[0]?.asset;
    if (!replacement) throw new Error('The replacement file did not produce a model asset.');
    const verified = await runDestructiveProjectMutation(
      `${options.mode === 'locate' ? 'Locate' : 'Replace'} missing asset`,
      () => {
        useProjectStore.setState((state) => {
          const nextAsset = {
            ...replacement,
            id: targetAssetId,
            name: target.name,
            resolutionStatus: 'available' as const,
          };
          const nextAssets = { ...state.project.assets.assets, [targetAssetId]: nextAsset };
          delete nextAssets[replacement.id];
          return { project: touchProject({ ...state.project, assets: { assets: nextAssets } }) };
        });
      },
    );
    return { verifiedRevisionId: verified?.revision.id, assetId: targetAssetId };
  } catch (error) {
    useProjectStore.setState({ project: before });
    await discardImportedBinaryAssets(batch);
    throw error;
  }
}

async function enrichImportedAssets(
  batch: ModelImportBatchResult,
  sourceFile: File | undefined,
): Promise<ModelImportBatchResult> {
  const contentHash = sourceFile ? await sha256Digest(await sourceFile.arrayBuffer()) : undefined;
  return {
    ...batch,
    items: batch.items.map(({ asset, object }) => ({
      asset: {
        ...asset,
        originalFileName: sourceFile?.name ?? asset.name,
        byteSize: sourceFile?.size,
        contentHash,
        resolutionStatus: 'available' as const,
        dimensions: [...object.dimensions] as [number, number, number],
        meshCount: typeof asset.metadata?.meshCount === 'number' ? asset.metadata.meshCount : undefined,
      },
      object,
    })),
  };
}

async function discardImportedBinaryAssets(batch: ModelImportBatchResult): Promise<void> {
  await Promise.all(batch.items.map(async ({ asset }) => {
    if (!asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) return;
    await deleteModelAsset(asset.uri.slice(MODEL_ASSET_URI_PREFIX.length));
  }));
}
