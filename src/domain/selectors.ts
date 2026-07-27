import { LocationProject, PanoReference, ProjectAsset, Vec3 } from './types';
import {
  CAPTURE_ORIGIN_NEAR_METERS,
  isCaptureOriginNearPano,
} from '../engine/panoProjectionCore';

export function getLatestGrayboxPano(project: LocationProject): PanoReference | undefined {
  return [...project.panoRefs]
    .reverse()
    .find((pano) => pano.type === 'graybox_render');
}

export function listGrayboxPanos(project: LocationProject): PanoReference[] {
  return project.panoRefs.filter((pano) => pano.type === 'graybox_render');
}

/** Newest graybox whose frozen origin is near the given capture point. */
export function findGrayboxNearOrigin(
  project: LocationProject,
  origin: Vec3,
  nearMeters = CAPTURE_ORIGIN_NEAR_METERS,
): PanoReference | undefined {
  return [...project.panoRefs]
    .reverse()
    .find(
      (pano) => pano.type === 'graybox_render'
        && isCaptureOriginNearPano(origin, pano, nearMeters),
    );
}

/**
 * Resolve the graybox used for Reference compare/alignment:
 * sourcePanoId → nearest matching-origin graybox → none.
 */
export function resolveCompareGraybox(
  project: LocationProject,
  activePano: PanoReference | undefined,
): PanoReference | undefined {
  if (!activePano || activePano.type === 'graybox_render') return undefined;
  if (activePano.sourcePanoId) {
    const linked = project.panoRefs.find(
      (pano) => pano.id === activePano.sourcePanoId && pano.type === 'graybox_render',
    );
    if (linked) return linked;
  }
  return findGrayboxNearOrigin(project, activePano.origin);
}

export function getCanonicalPano(project: LocationProject): PanoReference | undefined {
  return project.panoRefs.find((pano) => pano.isCanonical);
}

export function getPanoAsset(project: LocationProject, pano?: PanoReference): ProjectAsset | undefined {
  if (!pano) return undefined;
  return project.assets.assets[pano.imageAssetId];
}
