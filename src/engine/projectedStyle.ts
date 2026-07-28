import {
  LocationProject,
  PanoReference,
  Vec3,
} from '../domain/types';
import { normalizeProjectedStyleSettings } from '../domain/defaults';
import { length, subtract } from './sync';

export type ViewportAppearanceMode = 'clay' | 'projected' | 'depth';
export { normalizeProjectedStyleSettings };

/**
 * Pure projected-appearance state computation.
 * projectedActive depends only on primary readiness; secondary failure
 * degrades to primary-only instead of falling back to clay.
 */
export function computeProjectedAppearanceState(params: {
  appearance: ViewportAppearanceMode;
  primaryTextureReady: boolean;
  primaryReadyUrl: string;
  primaryAssetKey: string;
  primaryPanoExists: boolean;
  blendMode: string;
  secondaryPanoIdExists: boolean;
  secondaryTextureReady: boolean;
  secondaryReadyUrl: string;
  secondaryAssetKey: string;
}): { projectedActive: boolean; dualActive: boolean } {
  const projectedActive = params.appearance === 'projected'
    && params.primaryTextureReady
    && params.primaryReadyUrl === params.primaryAssetKey
    && params.primaryPanoExists;

  const dualActive = projectedActive
    && params.blendMode !== 'primary_only'
    && params.secondaryPanoIdExists
    && params.secondaryTextureReady
    && params.secondaryReadyUrl === params.secondaryAssetKey;

  return { projectedActive, dualActive };
}

/** Styled / imported panos preferred for projection (not the graybox render by default). */
export function isEligibleProjectedStylePano(pano: PanoReference): boolean {
  return pano.type !== 'graybox_render';
}

export function listEligibleProjectedStylePanos(project: LocationProject): PanoReference[] {
  return project.panoRefs.filter(isEligibleProjectedStylePano);
}

/**
 * Resolve the panorama to project:
 * 1. Explicit projectedStyle.panoId when still present and eligible (or any present pano if user picked graybox).
 * 2. Canonical non-graybox styled pano.
 * 3. First eligible styled pano.
 */
export function resolveProjectedStylePano(project: LocationProject): PanoReference | undefined {
  const settings = normalizeProjectedStyleSettings(project.settings.projectedStyle);
  if (settings.panoId) {
    const explicit = project.panoRefs.find((pano) => pano.id === settings.panoId);
    if (explicit) return explicit;
  }
  const styledCanonical = project.panoRefs.find(
    (pano) => pano.isCanonical && isEligibleProjectedStylePano(pano),
  );
  if (styledCanonical) return styledCanonical;
  return listEligibleProjectedStylePanos(project)[0];
}

export function canUseProjectedAppearance(project: LocationProject): boolean {
  const pano = resolveProjectedStylePano(project);
  if (!pano) return false;
  return Boolean(project.assets.assets[pano.imageAssetId]?.uri);
}

export function getProjectedStyleAssetUri(
  project: LocationProject,
  pano = resolveProjectedStylePano(project),
): string | undefined {
  if (!pano) return undefined;
  return project.assets.assets[pano.imageAssetId]?.uri;
}

/** Distance from a world point to the projector origin (for diagnostics / near-origin checks). */
export function distanceToProjectorOrigin(worldPosition: Vec3, pano: PanoReference): number {
  return length(subtract(worldPosition, pano.origin));
}

export function projectedStyleStatusLabel(project: LocationProject): {
  available: boolean;
  panoName?: string;
  originLabel: string;
  reason?: string;
} {
  const pano = resolveProjectedStylePano(project);
  if (!pano) {
    return {
      available: false,
      originLabel: '—',
      reason: 'Import and align a styled panorama first.',
    };
  }
  if (!project.assets.assets[pano.imageAssetId]?.uri) {
    return {
      available: false,
      panoName: pano.name,
      originLabel: formatOrigin(pano.origin),
      reason: 'Projected panorama asset is missing.',
    };
  }
  return {
    available: true,
    panoName: pano.name,
    originLabel: formatOrigin(pano.origin),
  };
}

function formatOrigin(origin: Vec3): string {
  return `${origin[0].toFixed(2)}, ${origin[1].toFixed(2)}, ${origin[2].toFixed(2)} m`;
}
