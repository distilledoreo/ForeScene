import { getCanonicalPano, getPanoAsset } from './selectors';
import { LocationProject, ProjectAsset, Shot } from './types';

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

/**
 * Prefer clay/projected with-people primary materialized still for shot cards.
 * Domain-safe lookup (no engine fingerprint recompute) so legacy + prepared media coexist.
 */
function resolveMaterializedPrimaryAsset(
  project: LocationProject,
  shot: Shot,
): { asset?: ProjectAsset; stale: boolean } {
  const stills = shot.materializedMedia?.stills;
  if (!stills) return { stale: false };

  const preferredKeys = [
    'projected-viewport:projected:with_people',
    'clay-viewport:clay:with_people',
    'projected-viewport:projected:clean_plate',
    'clay-viewport:clay:clean_plate',
  ];
  for (const key of preferredKeys) {
    const record = stills[key];
    if (!record) continue;
    const asset = project.assets.assets[record.assetId];
    if (asset) return { asset, stale: false };
  }

  // Any remaining viewport still as last materialized fallback.
  for (const record of Object.values(stills)) {
    if (record.kind !== 'clay-viewport' && record.kind !== 'projected-viewport') continue;
    const asset = project.assets.assets[record.assetId];
    if (asset) return { asset, stale: true };
  }
  return { stale: false };
}

export function resolveShotThumbnail(project: LocationProject, shot: Shot): ShotThumbnailResolution {
  // Prefer first-class materialized primary still before legacy asset slots.
  const primary = resolveMaterializedPrimaryAsset(project, shot);
  if (primary.asset) {
    return {
      asset: primary.asset,
      source: primary.stale ? 'materialized_primary_stale' : 'materialized_primary',
      label: primary.stale ? 'Prepared still (updating…)' : 'Prepared still',
      stale: primary.stale,
    };
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
