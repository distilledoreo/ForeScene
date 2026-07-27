import type { Euler, LocationProject, PanoReference, Vec3 } from '../domain/types';

/** Styled / imported panos preferred for projection (not the graybox render by default). */
export function isEligibleProjectedStylePano(pano: Pick<PanoReference, 'type'>): boolean {
  return pano.type !== 'graybox_render';
}

/** True when moving the scene capture origin may desync projection from styled panos. */
export function shouldWarnOnOriginMove(project: Pick<LocationProject, 'panoRefs'>): boolean {
  return project.panoRefs.some((pano) => isEligibleProjectedStylePano(pano));
}

export function originMoveWarningMessage(styledCount: number): string {
  const n = Math.max(1, styledCount);
  return (
    `Moving the capture origin after ${n === 1 ? 'a reference panorama is' : `${n} reference panoramas are`} loaded `
    + 'does not move those panoramas — each stays locked to where it was captured. '
    + 'Use this when you want a second vantage to fill weak areas, then import that second panorama in Reference to blend.'
  );
}

export function countStyledPanoramas(project: Pick<LocationProject, 'panoRefs'>): number {
  return project.panoRefs.filter(isEligibleProjectedStylePano).length;
}

/** Capture origin is treated as "same spot" as a pano when within this distance (meters). */
export const CAPTURE_ORIGIN_NEAR_METERS = 0.25;

export type StyledImportMode = 'first' | 'replace' | 'add_secondary';

export function primaryStyledPano(
  project: Pick<LocationProject, 'panoRefs' | 'settings'>,
): PanoReference | undefined {
  const requestedPanoId = project.settings?.projectedStyle?.panoId;
  const panoId = typeof requestedPanoId === 'string' && requestedPanoId.length > 0
    ? requestedPanoId
    : undefined;
  if (panoId) {
    const explicit = project.panoRefs.find(
      (pano) => pano.id === panoId && isEligibleProjectedStylePano(pano),
    );
    if (explicit) return explicit;
  }
  return project.panoRefs.find((pano) => pano.isCanonical && isEligibleProjectedStylePano(pano))
    ?? project.panoRefs.find((pano) => isEligibleProjectedStylePano(pano));
}

export function isCaptureOriginNearPano(
  captureOrigin: Vec3,
  pano: Pick<PanoReference, 'origin'>,
  nearMeters = CAPTURE_ORIGIN_NEAR_METERS,
): boolean {
  return Math.hypot(
    captureOrigin[0] - pano.origin[0],
    captureOrigin[1] - pano.origin[1],
    captureOrigin[2] - pano.origin[2],
  ) <= nearMeters;
}

/**
 * Frozen plan for the next secondary styled import.
 * Suggest path locks origin/rotation; manual place may set trackLiveOrigin so Build moves update the plan.
 */
export interface PendingSecondCapturePlan {
  primaryPanoId: string;
  origin: Vec3;
  rotation: Euler;
  createdAt: string;
  /** When true, setPanoOrigin / setPanoRotation keep this plan aligned with the live Build capture. */
  trackLiveOrigin?: boolean;
}

export function createPendingSecondCapturePlan(params: {
  primaryPanoId: string;
  origin: Vec3;
  rotation: Euler;
  trackLiveOrigin?: boolean;
}): PendingSecondCapturePlan {
  return {
    primaryPanoId: params.primaryPanoId,
    origin: [...params.origin] as Vec3,
    rotation: [...params.rotation] as Euler,
    createdAt: new Date().toISOString(),
    trackLiveOrigin: params.trackLiveOrigin,
  };
}

/**
 * Decide whether the next styled import replaces the reference or adds a blend partner.
 * Same capture origin as the primary styled pano → replace; moved → add secondary.
 * A latched pending second-capture plan always adds (survives undo / modal close races).
 */
export function resolveStyledImportMode(
  project: Pick<LocationProject, 'panoRefs' | 'settings' | 'scene'>,
  options?: { pendingSecondCapturePlan?: PendingSecondCapturePlan | null },
): StyledImportMode {
  const primary = primaryStyledPano(project);
  if (!primary) return 'first';
  if (options?.pendingSecondCapturePlan) return 'add_secondary';
  if (isCaptureOriginNearPano(project.scene.panoOrigin, primary)) return 'replace';
  return 'add_secondary';
}

export function styledImportActionLabel(mode: StyledImportMode): string {
  switch (mode) {
    case 'first':
      return 'Import styled pano';
    case 'replace':
      return 'Replace reference';
    case 'add_secondary':
      return 'Add second capture';
  }
}

export function styledImportActionHint(mode: StyledImportMode): string {
  switch (mode) {
    case 'first':
      return 'Import a styled 360 to use as your reference.';
    case 'replace':
      return 'Capture hasn’t moved — this import replaces the current reference.';
    case 'add_secondary':
      return 'Origin moved — this import adds a blend partner at the new capture point.';
  }
}
