/**
 * Store keyframe filmstrip stills as project binary assets (not JSON data URLs).
 */

import type { CameraKeyframe, LocationProject, ProjectAsset } from '../domain/types';
import { createId } from '../utils/ids';
import {
  createProjectAssetStorageKey,
  storeProjectAssetDataUrl,
} from './projectAssetStore';
import { pruneUnreferencedProjectAssets } from './projectAssets';
import { resolveKeyframePreviewUri } from '../domain/shotMedia';

export function createKeyframePreviewAssetFromDataUrl(params: {
  projectId: string;
  keyframeId: string;
  dataUrl: string;
  /** Reuse prior id/storage key so pose updates overwrite instead of leaking assets. */
  existingAssetId?: string;
  existingStorageKey?: string;
}): ProjectAsset {
  const assetId = params.existingAssetId ?? createId('asset');
  const storageKey = params.existingStorageKey
    ?? createProjectAssetStorageKey(params.projectId, assetId);
  return storeProjectAssetDataUrl(params.projectId, {
    id: assetId,
    type: 'image',
    name: `keyframe-preview-${params.keyframeId}`,
    mimeType: params.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png',
    uri: params.dataUrl,
    storageKey,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Attach a rendered still to a keyframe via project assets.
 * Reuses the keyframe's previous preview asset id/storage key when present so
 * repeated Recapture keyframe / thumbnail refresh does not accumulate dead assets.
 * Returns updated keyframes + asset registry entry (caller merges into project).
 */
export function commitKeyframePreviewAsset(params: {
  project: LocationProject;
  shotId: string;
  keyframeId: string;
  dataUrl: string;
}): {
  project: LocationProject;
  previewAssetId: string;
  previewStorageKey?: string;
} | undefined {
  const shot = params.project.shots.find((item) => item.id === params.shotId);
  if (!shot) return undefined;
  const existing = shot.cameraKeyframes.find((keyframe) => keyframe.id === params.keyframeId);
  if (!existing) return undefined;

  const previousAssetId = existing.previewAssetId;
  const previousStorageKey = existing.previewStorageKey
    ?? (previousAssetId ? params.project.assets.assets[previousAssetId]?.storageKey : undefined);

  const asset = createKeyframePreviewAssetFromDataUrl({
    projectId: params.project.id,
    keyframeId: params.keyframeId,
    dataUrl: params.dataUrl,
    existingAssetId: previousAssetId,
    existingStorageKey: previousStorageKey,
  });

  const nextKeyframes = shot.cameraKeyframes.map((keyframe) => {
    if (keyframe.id !== params.keyframeId) return keyframe;
    const { previewUri: _drop, ...rest } = keyframe;
    return {
      ...rest,
      previewAssetId: asset.id,
      previewStorageKey: asset.storageKey,
      // Session-local display URI (blob URL after store); stripped on serialize when asset id present.
      previewUri: asset.uri,
    };
  });

  const nextAssets = {
    ...params.project.assets.assets,
    [asset.id]: asset,
  };
  // Drop the prior preview record when the id changed (defensive; reuse path keeps one).
  if (previousAssetId && previousAssetId !== asset.id) {
    delete nextAssets[previousAssetId];
  }

  const project = pruneUnreferencedProjectAssets({
    ...params.project,
    shots: params.project.shots.map((item) => (
      item.id === params.shotId
        ? { ...item, cameraKeyframes: nextKeyframes }
        : item
    )),
    assets: {
      ...params.project.assets,
      assets: nextAssets,
    },
  });

  return {
    project,
    previewAssetId: asset.id,
    previewStorageKey: asset.storageKey,
  };
}

export function keyframePreviewDisplayUri(
  project: LocationProject | undefined,
  keyframe: CameraKeyframe | undefined,
  localThumb?: string,
): string | undefined {
  if (localThumb) return localThumb;
  if (!keyframe) return undefined;
  return resolveKeyframePreviewUri(project, keyframe);
}
