import { getCanonicalPano, getPanoAsset } from './selectors';
import { LocationProject, ProjectAsset, Shot } from './types';
import { resolvePrimaryStillPreviewAssetId } from '../engine/stillArtifactRuntime';

export type ShotThumbnailSource =
  | 'materialized_primary'
  | 'materialized_primary_stale'
  | 'ai_result'
  | 'final_frame'
  | 'viewport_render'
  | 'pano_crop'
  | 'linked_pano'
  | 'canonical_pano';

export interface ShotThumbnailResolution {
  asset?: ProjectAsset;
  source?: ShotThumbnailSource;
  label: string;
  /** True when showing a previous materialized still after a failed/stale refresh. */
  stale?: boolean;
}

const shotAssetPriority: Array<{
  key: keyof Shot['assets'];
  source: ShotThumbnailSource;
  label: string;
}> = [
  { key: 'aiResultFrameAssetId', source: 'ai_result', label: 'AI result' },
  { key: 'finalBaseFrameAssetId', source: 'final_frame', label: 'Final frame' },
  { key: 'viewportRenderAssetId', source: 'viewport_render', label: 'Viewport render' },
  { key: 'panoCropAssetId', source: 'pano_crop', label: 'Pano crop' },
];

export function resolveShotThumbnail(project: LocationProject, shot: Shot): ShotThumbnailResolution {
  // Fingerprint-aware primary: current vs stale after camera/scene/pano edits.
  const primary = resolvePrimaryStillPreviewAssetId(project, shot);
  if (primary.assetId && primary.source === 'materialized') {
    const asset = project.assets.assets[primary.assetId];
    if (asset) {
      return {
        asset,
        source: primary.stale ? 'materialized_primary_stale' : 'materialized_primary',
        label: primary.stale ? 'Prepared still (updating…)' : 'Prepared still',
        stale: primary.stale,
      };
    }
  }

  for (const candidate of shotAssetPriority) {
    const assetId = shot.assets[candidate.key];
    const asset = assetId ? project.assets.assets[assetId] : undefined;
    if (asset) {
      return {
        asset,
        source: candidate.source,
        label: candidate.label,
      };
    }
  }

  const linkedPano = shot.linkedPanoId
    ? project.panoRefs.find((pano) => pano.id === shot.linkedPanoId)
    : undefined;
  const linkedPanoAsset = getPanoAsset(project, linkedPano);
  if (linkedPanoAsset) {
    return {
      asset: linkedPanoAsset,
      source: 'linked_pano',
      label: linkedPano?.isCanonical ? 'Linked reference' : 'Linked pano',
    };
  }

  const canonicalPano = getCanonicalPano(project);
  const canonicalPanoAsset = getPanoAsset(project, canonicalPano);
  if (canonicalPanoAsset) {
    return {
      asset: canonicalPanoAsset,
      source: 'canonical_pano',
      label: 'Canonical reference',
    };
  }

  return {
    label: 'No image yet',
  };
}
