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
  type ModelImportBatchResult,
  type ModelImportJob,
  type ModelImportOptions,
} from './modelImport';
import { deleteModelAsset } from './modelAssetStore';
import { useProjectSafetyStore } from '../state/useProjectSafetyStore';
import { useProjectStore } from '../state/useProjectStore';

export interface ProjectModelImportResult extends ModelImportBatchResult {
  verifiedRevisionId?: string;
}

/** Convert a model, then register all of its assets and objects atomically. */
export async function importModelIntoProject(
  job: ModelImportJob,
  options: ModelImportOptions,
): Promise<ProjectModelImportResult> {
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

  try {
    const verified = await runDestructiveProjectMutation('Before importing a model', () => {
      useProjectStore.getState().addImportedModels(batch.items);
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

async function discardImportedBinaryAssets(batch: ModelImportBatchResult): Promise<void> {
  await Promise.all(batch.items.map(async ({ asset }) => {
    if (!asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)) return;
    await deleteModelAsset(asset.uri.slice(MODEL_ASSET_URI_PREFIX.length));
  }));
}
