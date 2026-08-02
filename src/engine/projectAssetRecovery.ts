import type { LocationProject, ProjectAsset, SceneObject, Vec3 } from '../domain/types';
import { MISSING_ASSET_URI_PREFIX } from './importedMeshConstants';

export type AssetResolutionStatus = NonNullable<ProjectAsset['resolutionStatus']>;

export interface ProjectOpenWarning {
  code: 'ASSET_MISSING' | 'ASSET_CORRUPTED' | 'ASSET_UNSUPPORTED' | 'ASSET_CHANGED';
  assetId: string;
  assetName: string;
  message: string;
  affectedInstanceIds: string[];
  /** Compatibility alias for callers that modeled scene instances as objects. */
  affectedObjectIds: string[];
  affectedShotIds: string[];
}

export interface ProjectOpenResult {
  project: LocationProject;
  warnings: ProjectOpenWarning[];
}

export function assetStatusIsMissing(asset: Pick<ProjectAsset, 'resolutionStatus'>): boolean {
  return asset.resolutionStatus === 'missing'
    || asset.resolutionStatus === 'corrupt'
    || asset.resolutionStatus === 'unsupported';
}

export function getAssetInstanceIds(project: LocationProject, assetId: string): string[] {
  return project.scene.objects
    .filter((object) => object.modelAssetId === assetId)
    .map((object) => object.id);
}

export function getAssetShotIds(project: LocationProject, assetId: string): string[] {
  return project.shots
    .filter((shot) => {
      const assetIds = Object.values(shot.assets ?? {}) as unknown[];
      if (assetIds.includes(assetId)) return true;
      return (shot.cameraKeyframes ?? []).some((keyframe) => keyframe.previewAssetId === assetId);
    })
    .map((shot) => shot.id);
}

export function createProjectOpenWarning(
  project: LocationProject,
  asset: ProjectAsset,
  status: AssetResolutionStatus,
  detail?: string,
): ProjectOpenWarning {
  const code = status === 'corrupt'
    ? 'ASSET_CORRUPTED'
    : status === 'unsupported'
      ? 'ASSET_UNSUPPORTED'
      : 'ASSET_MISSING';
  const affectedInstanceIds = getAssetInstanceIds(project, asset.id);
  const noun = status === 'corrupt' ? 'corrupted' : status === 'unsupported' ? 'unsupported' : 'missing';
  return {
    code,
    assetId: asset.id,
    assetName: asset.originalFileName ?? asset.name,
    message: detail ?? `${asset.name} has a ${noun} binary. Its project references and instances were preserved.`,
    affectedInstanceIds,
    affectedObjectIds: affectedInstanceIds,
    affectedShotIds: getAssetShotIds(project, asset.id),
  };
}

export function markProjectAssetUnavailable(
  project: LocationProject,
  assetId: string,
  status: Exclude<AssetResolutionStatus, 'available'>,
): ProjectOpenWarning | undefined {
  const asset = project.assets.assets[assetId];
  if (!asset) return undefined;
  asset.resolutionStatus = status;
  asset.uri = `${MISSING_ASSET_URI_PREFIX}${asset.id}`;
  return createProjectOpenWarning(project, asset, status);
}

export function listMissingProjectAssets(project: LocationProject): ProjectAsset[] {
  return Object.values(project.assets.assets).filter(assetStatusIsMissing);
}

export function listMissingProjectAssetWarnings(project: LocationProject): ProjectOpenWarning[] {
  return listMissingProjectAssets(project).map((asset) => createProjectOpenWarning(
    project,
    asset,
    asset.resolutionStatus!,
  ));
}

export function normalizeAssetDimensions(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
    return fallback;
  }
  return [Math.max(Math.abs(value[0] as number), 0.001), Math.max(Math.abs(value[1] as number), 0.001), Math.max(Math.abs(value[2] as number), 0.001)];
}

export function isMissingSceneObject(object: SceneObject, project: LocationProject): boolean {
  return object.type === 'imported_model'
    && Boolean(!object.modelAssetId || !project.assets.assets[object.modelAssetId] || assetStatusIsMissing(project.assets.assets[object.modelAssetId]!));
}
