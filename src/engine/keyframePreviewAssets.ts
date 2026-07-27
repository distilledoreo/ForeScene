/**
 * Store keyframe filmstrip stills as project binary assets (not JSON data URLs).
 */

import type { CameraKeyframe, LocationProject, ProjectAsset } from '../domain/types';
import { createId } from '../utils/ids';
import {
  createProjectAssetStorageKey,
  storeProjectAssetDataUrl,
} from './projectAssetStore';
import { resolveKeyframePreviewUri } from '../domain/shotMedia';

export function createKeyframePreviewAssetFromDataUrl(params: {
  projectId: string;
  keyframeId: string;
  dataUrl: string;
}): ProjectAsset {
  const assetId = createId('asset');
  const storageKey = createProjectAssetStorageKey(params.projectId, assetId);
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
  const asset = createKeyframePreviewAssetFromDataUrl({
    projectId: params.project.id,
    keyframeId: params.keyframeId,
    dataUrl: params.dataUrl,
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
  const project: LocationProject = {
    ...params.project,
    shots: params.project.shots.map((item) => (
      item.id === params.shotId
        ? { ...item, cameraKeyframes: nextKeyframes }
        : item
    )),
    assets: {
      ...params.project.assets,
      assets: {
        ...params.project.assets.assets,
        [asset.id]: asset,
      },
    },
  };
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
