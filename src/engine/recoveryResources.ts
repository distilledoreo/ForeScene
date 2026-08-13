/**
 * Reconcile and verify project recovery resources before export/backup.
 * Missing recovery PNGs/binaries are diagnosed and, when possible, rematerialized
 * from live project assets. Historical revision manifests are pruned of blobs
 * that are no longer present so later verify/save does not hang or fail opaquely.
 */

import type { LocationProject, ProjectAsset } from '../domain/types';
import { MODEL_ASSET_URI_PREFIX } from './importedMeshConstants';
import { getModelAsset, putModelAssets } from './modelAssetStore';
import {
  assetStatusIsMissing,
  createProjectOpenWarning,
} from './projectAssetRecovery';
import { getReferencedProjectAssetIds } from './projectAssets';
import {
  PROJECT_ASSET_URI_PREFIX,
  getProjectAssetBlob,
  putProjectAssetBlobs,
} from './projectAssetStore';
import {
  getAllRetainedBinaryResources,
  verifyRetainedModelResource,
  verifyRetainedProjectAssetResource,
} from './projectSafety';
import {
  listAllProjectRevisions,
  writeProjectRevision,
  type ProjectRevisionBinaryResource,
  type ProjectRevisionRecord,
} from './projectRevisionStore';
import { dataUrlToBlob } from './fileTransfers';

export interface RecoveryResourceIssue {
  key: string;
  kind: 'projectAsset' | 'model';
  code: 'missing-recovery-resource' | 'corrupt-recovery-resource';
  message: string;
  currentProject: boolean;
}

export interface RecoveryResourceVerification {
  ok: boolean;
  rematerialized: number;
  prunedHistoricalResources: number;
  issues: RecoveryResourceIssue[];
}

function storageKeyFromAsset(asset: Pick<ProjectAsset, 'storageKey' | 'uri'>): string | undefined {
  return asset.storageKey ?? (asset.uri.startsWith(PROJECT_ASSET_URI_PREFIX)
    ? asset.uri.slice(PROJECT_ASSET_URI_PREFIX.length)
    : undefined);
}

function modelKeyFromAsset(asset: ProjectAsset): string | undefined {
  return asset.uri.startsWith(MODEL_ASSET_URI_PREFIX)
    ? asset.uri.slice(MODEL_ASSET_URI_PREFIX.length)
    : undefined;
}

function isRasterOrVideo(asset: ProjectAsset): boolean {
  return asset.type === 'image' || asset.type === 'video';
}

async function rematerializeProjectAsset(asset: ProjectAsset, key: string): Promise<boolean> {
  const existing = await getProjectAssetBlob(key);
  if (existing && existing.size > 0) return true;
  try {
    if (asset.uri.startsWith('data:')) {
      const blob = dataUrlToBlob(asset.uri);
      if (blob.size <= 0) return false;
      await putProjectAssetBlobs([{ key, blob, evictable: false }]);
      return true;
    }
    if (asset.uri.startsWith('blob:')) {
      const response = await fetch(asset.uri);
      if (!response.ok) return false;
      const blob = await response.blob();
      if (blob.size <= 0) return false;
      await putProjectAssetBlobs([{ key, blob, evictable: false }]);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function rematerializeModelAsset(asset: ProjectAsset, key: string): Promise<boolean> {
  const existing = await getModelAsset(key);
  if (existing && existing.byteLength > 0) return true;
  try {
    if (asset.uri.startsWith('data:')) {
      const bytes = await dataUrlToBlob(asset.uri).arrayBuffer();
      if (bytes.byteLength <= 0) return false;
      await putModelAssets([{ key, bytes }]);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function currentProjectResourceKeys(project: LocationProject): {
  projectAssetKeys: Set<string>;
  modelKeys: Set<string>;
} {
  const projectAssetKeys = new Set<string>();
  const modelKeys = new Set<string>();
  const referenced = getReferencedProjectAssetIds(project);
  for (const asset of Object.values(project.assets.assets)) {
    const unavailable = Boolean(asset.resolutionStatus && asset.resolutionStatus !== 'available');
    // Available registry entries stay current even before a revision lists them.
    // Non-available entries stay current only when the live project still references them.
    if (unavailable && !referenced.has(asset.id)) continue;
    if (isRasterOrVideo(asset)) {
      const key = storageKeyFromAsset(asset);
      if (key) projectAssetKeys.add(key);
    } else if (asset.type === 'model') {
      const key = modelKeyFromAsset(asset);
      if (key) modelKeys.add(key);
    }
  }
  return { projectAssetKeys, modelKeys };
}

async function pruneMissingFromRevision(
  revision: ProjectRevisionRecord,
  missingProjectKeys: Set<string>,
  missingModelKeys: Set<string>,
): Promise<number> {
  const nextProjectKeys = revision.resources.projectAssetKeys.filter((key) => !missingProjectKeys.has(key));
  const nextModelKeys = revision.resources.modelAssetKeys.filter((key) => !missingModelKeys.has(key));
  const nextProjectAssets = (revision.resources.projectAssets ?? []).filter((resource) => !missingProjectKeys.has(resource.key));
  const nextModels = (revision.resources.models ?? []).filter((resource) => !missingModelKeys.has(resource.key));
  const pruned = (revision.resources.projectAssetKeys.length - nextProjectKeys.length)
    + (revision.resources.modelAssetKeys.length - nextModelKeys.length);
  if (pruned === 0) return 0;
  await writeProjectRevision({
    ...revision,
    resources: {
      projectAssetKeys: nextProjectKeys,
      modelAssetKeys: nextModelKeys,
      projectAssets: nextProjectAssets,
      models: nextModels,
    },
  }, { activate: false });
  return pruned;
}

async function inspectResource(
  resource: ProjectRevisionBinaryResource,
  kind: 'projectAsset' | 'model',
  current: boolean,
): Promise<RecoveryResourceIssue | undefined> {
  try {
    if (kind === 'projectAsset') await verifyRetainedProjectAssetResource(resource);
    else await verifyRetainedModelResource(resource);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : `Recovery ${kind} ${resource.key} failed verification.`;
    const missing = /missing/i.test(message);
    return {
      key: resource.key,
      kind,
      code: missing ? 'missing-recovery-resource' : 'corrupt-recovery-resource',
      message,
      currentProject: current,
    };
  }
}

/**
 * Rematerialize live project recovery binaries when possible, diagnose remaining
 * missing/corrupt payloads, and prune historical revision manifests that still
 * point at vanished blobs.
 */
export async function reconcileAndVerifyRecoveryResources(
  project: LocationProject,
): Promise<RecoveryResourceVerification> {
  const current = currentProjectResourceKeys(project);
  let rematerialized = 0;

  for (const asset of Object.values(project.assets.assets)) {
    if (asset.resolutionStatus && asset.resolutionStatus !== 'available') continue;
    if (isRasterOrVideo(asset)) {
      const key = storageKeyFromAsset(asset);
      if (!key) continue;
      const before = await getProjectAssetBlob(key);
      if (before && before.size > 0) continue;
      if (await rematerializeProjectAsset(asset, key)) rematerialized += 1;
    } else if (asset.type === 'model') {
      const key = modelKeyFromAsset(asset);
      if (!key) continue;
      const before = await getModelAsset(key);
      if (before && before.byteLength > 0) continue;
      if (await rematerializeModelAsset(asset, key)) rematerialized += 1;
    }
  }

  const retained = await getAllRetainedBinaryResources();
  const issues: RecoveryResourceIssue[] = [];
  const missingHistoricalProject = new Set<string>();
  const missingHistoricalModel = new Set<string>();

  for (const resource of retained.projectAssets) {
    const isCurrent = current.projectAssetKeys.has(resource.key);
    const blob = await getProjectAssetBlob(resource.key);
    if (!blob && !isCurrent) missingHistoricalProject.add(resource.key);
    const issue = await inspectResource(resource, 'projectAsset', isCurrent);
    if (issue) issues.push(issue);
  }
  for (const resource of retained.models) {
    const isCurrent = current.modelKeys.has(resource.key);
    const bytes = await getModelAsset(resource.key);
    if (!bytes && !isCurrent) missingHistoricalModel.add(resource.key);
    const issue = await inspectResource(resource, 'model', isCurrent);
    if (issue) issues.push(issue);
  }

  let prunedHistoricalResources = 0;
  if (missingHistoricalProject.size + missingHistoricalModel.size > 0) {
    const revisions = await listAllProjectRevisions();
    for (const revision of revisions) {
      prunedHistoricalResources += await pruneMissingFromRevision(
        revision,
        missingHistoricalProject,
        missingHistoricalModel,
      );
    }
  }

  for (const key of current.projectAssetKeys) {
    if (issues.some((issue) => issue.key === key && issue.kind === 'projectAsset')) continue;
    const blob = await getProjectAssetBlob(key);
    if (!blob || blob.size <= 0) {
      issues.push({
        key,
        kind: 'projectAsset',
        code: 'missing-recovery-resource',
        message: `Current project asset "${key}" is missing from recovery storage.`,
        currentProject: true,
      });
    }
  }
  for (const key of current.modelKeys) {
    if (issues.some((issue) => issue.key === key && issue.kind === 'model')) continue;
    const bytes = await getModelAsset(key);
    if (!bytes || bytes.byteLength <= 0) {
      issues.push({
        key,
        kind: 'model',
        code: 'missing-recovery-resource',
        message: `Current project model "${key}" is missing from recovery storage.`,
        currentProject: true,
      });
    }
  }

  const referenced = getReferencedProjectAssetIds(project);
  for (const asset of Object.values(project.assets.assets)) {
    if (!referenced.has(asset.id) || !assetStatusIsMissing(asset)) continue;
    const key = isRasterOrVideo(asset)
      ? storageKeyFromAsset(asset)
      : asset.type === 'model'
        ? modelKeyFromAsset(asset)
        : undefined;
    if (key) continue;
    const warning = createProjectOpenWarning(project, asset, asset.resolutionStatus!);
    issues.push({
      key: asset.id,
      kind: asset.type === 'model' ? 'model' : 'projectAsset',
      code: 'missing-recovery-resource',
      message: warning.message,
      currentProject: true,
    });
  }

  const blocking = issues.filter((issue) => issue.currentProject);
  return {
    ok: blocking.length === 0,
    rematerialized,
    prunedHistoricalResources,
    issues,
  };
}

export function recoveryIssuesToDiagnostics(
  issues: RecoveryResourceIssue[],
): Array<{ code: string; message: string; severity: 'error' | 'warning' }> {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: issue.currentProject ? 'error' as const : 'warning' as const,
  }));
}
