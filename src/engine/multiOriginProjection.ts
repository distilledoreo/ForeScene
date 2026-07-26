import {
  Euler,
  LocationProject,
  PanoReference,
  ProjectedStyleSettings,
  Vec3,
} from '../domain/types';
import { normalizeProjectedStyleSettings } from '../domain/defaults';
import { listEligibleProjectedStylePanos } from './projectedStyle';
import { isEligibleProjectedStylePano } from './panoProjectionCore';
import { length, subtract } from './sync';

export {
  CAPTURE_ORIGIN_NEAR_METERS,
  countStyledPanoramas,
  createPendingSecondCapturePlan,
  isCaptureOriginNearPano,
  originMoveWarningMessage,
  primaryStyledPano,
  resolveStyledImportMode,
  shouldWarnOnOriginMove,
  styledImportActionHint,
  styledImportActionLabel,
} from './panoProjectionCore';
export type { PendingSecondCapturePlan, StyledImportMode } from './panoProjectionCore';

/**
 * Multi-origin projector blend modes.
 * Live projection uses quality-based winner-takes-most ownership
 * (see resolveQualityConflictOwnership in projectedStyleMath). Preference modes
 * only nudge near-equal seams; they are not broad distance dominance.
 */
export type ProjectorBlendMode =
  | 'primary_only'
  | 'secondary_only'
  | 'primary_dominant'
  | 'secondary_dominant';

export const PROJECTOR_BLEND_MODE_LABELS: Record<ProjectorBlendMode, string> = {
  primary_only: 'Only primary panorama',
  secondary_only: 'Only secondary panorama',
  primary_dominant: 'Primary preferred in close overlaps',
  secondary_dominant: 'Secondary preferred in close overlaps',
};

export const DEFAULT_PROJECTOR_BLEND_MODE: ProjectorBlendMode = 'primary_only';

const BLEND_MODES = new Set<ProjectorBlendMode>([
  'primary_only',
  'secondary_only',
  'primary_dominant',
  'secondary_dominant',
]);

export function normalizeProjectorBlendMode(
  mode: string | undefined | null,
): ProjectorBlendMode {
  if (mode && BLEND_MODES.has(mode as ProjectorBlendMode)) {
    return mode as ProjectorBlendMode;
  }
  return DEFAULT_PROJECTOR_BLEND_MODE;
}

export interface ProjectorPose {
  panoId: string;
  origin: Vec3;
  rotation: Euler;
}

/** Resolve frozen projector pose from the pano reference itself (never scene origin). */
export function resolveProjectorPose(pano: PanoReference): ProjectorPose {
  return {
    panoId: pano.id,
    origin: [...pano.origin] as Vec3,
    rotation: [...pano.rotation] as Euler,
  };
}

/**
 * Inverse-distance confidence for a world sample relative to a projector origin.
 * Near origin → ~1; far → approaches 0. Deterministic, depth-free proxy for “usable from this pano.”
 */
export function projectorConfidence(
  worldPosition: Vec3,
  origin: Vec3,
  falloffMeters = 6,
): number {
  const distance = length(subtract(worldPosition, origin));
  const falloff = Math.max(0.25, falloffMeters);
  // Soft falloff: 1 at 0m, ~0.5 at falloff, approaches 0 far away.
  return falloff / (falloff + distance);
}

/**
 * Coarse inverse-distance blend weights for planning / interaction tests.
 * Not the live projected-style shader contract — that uses quality conflict
 * resolution in projectedStyleMath.computeProjectedStyleCoverageBlend.
 */
export function computeProjectorBlendWeights(params: {
  worldPosition: Vec3;
  primaryOrigin: Vec3;
  secondaryOrigin?: Vec3;
  mode: ProjectorBlendMode;
  falloffMeters?: number;
}): { wPrimary: number; wSecondary: number } {
  const mode = normalizeProjectorBlendMode(params.mode);
  if (mode === 'primary_only' || !params.secondaryOrigin) {
    return { wPrimary: 1, wSecondary: 0 };
  }
  if (mode === 'secondary_only') {
    return { wPrimary: 0, wSecondary: 1 };
  }

  const confPrimary = projectorConfidence(
    params.worldPosition,
    params.primaryOrigin,
    params.falloffMeters,
  );
  const confSecondary = projectorConfidence(
    params.worldPosition,
    params.secondaryOrigin,
    params.falloffMeters,
  );
  const total = confPrimary + confSecondary;
  if (total <= 1e-8) {
    return mode === 'primary_dominant'
      ? { wPrimary: 1, wSecondary: 0 }
      : { wPrimary: 0, wSecondary: 1 };
  }

  // Base inverse-confidence mix, then bias toward the dominant projector.
  let wPrimary = confPrimary / total;
  if (mode === 'primary_dominant') {
    // When primary is strong, use it almost exclusively; fill with secondary only when primary is weak.
    wPrimary = confPrimary >= confSecondary
      ? Math.min(1, 0.55 + confPrimary * 0.55)
      : confPrimary / total;
  } else {
    // secondary_dominant
    wPrimary = confSecondary >= confPrimary
      ? Math.max(0, 0.45 - confSecondary * 0.45)
      : confPrimary / total;
  }
  wPrimary = Math.min(1, Math.max(0, wPrimary));
  return { wPrimary, wSecondary: 1 - wPrimary };
}

export interface ResolvedProjectors {
  primary?: PanoReference;
  secondary?: PanoReference;
  blendMode: ProjectorBlendMode;
}

/**
 * Resolve primary/secondary projectors from settings.
 * Primary defaults to explicit panoId / canonical styled / first eligible.
 * Secondary is explicit secondaryPanoId when different from primary and present.
 */
export function resolveProjectors(
  project: LocationProject,
  settings?: Partial<ProjectedStyleSettings> | null,
): ResolvedProjectors {
  const blendMode = normalizeProjectorBlendMode(settings?.blendMode);
  const eligible = listEligibleProjectedStylePanos(project);
  const all = project.panoRefs;

  const findPano = (id?: string) => (id ? all.find((pano) => pano.id === id) : undefined);

  let primary = findPano(settings?.panoId);
  if (!primary) {
    primary = all.find((pano) => pano.isCanonical && isEligibleProjectedStylePano(pano))
      ?? eligible[0]
      ?? all[0];
  }

  let secondary = findPano(settings?.secondaryPanoId);
  if (secondary && primary && secondary.id === primary.id) {
    secondary = undefined;
  }
  // Auto-pick a secondary when using a dual mode and none set (never auto-pick graybox).
  if (!secondary && primary && (blendMode === 'primary_dominant' || blendMode === 'secondary_dominant' || blendMode === 'secondary_only')) {
    secondary = eligible.find((pano) => pano.id !== primary!.id);
  }

  if (blendMode === 'secondary_only' && !secondary) {
    return { primary, secondary: undefined, blendMode: 'primary_only' };
  }

  return { primary, secondary, blendMode };
}

/** Whether dual-projector blending can run (two distinct panos with assets). */
export function canUseDualProjectorBlend(project: LocationProject, settings?: Partial<ProjectedStyleSettings> | null): boolean {
  const resolved = resolveProjectors(project, settings);
  if (!resolved.primary || !resolved.secondary) return false;
  const a = project.assets.assets[resolved.primary.imageAssetId]?.uri;
  const b = project.assets.assets[resolved.secondary.imageAssetId]?.uri;
  return Boolean(a && b);
}

/**
 * Resolve projector assets for viewport/export projected appearance.
 * Secondary is only included when the blend mode needs it and the asset URI exists.
 */
export function resolveProjectedProjectorAssets(
  project: LocationProject,
  settings?: Partial<ProjectedStyleSettings> | null,
): {
  primary: PanoReference;
  primaryUrl: string;
  secondary?: PanoReference;
  secondaryUrl?: string;
  blendMode: ProjectorBlendMode;
  settings: ProjectedStyleSettings;
} | undefined {
  const normalized = normalizeProjectedStyleSettings(settings ?? project.settings.projectedStyle);
  const resolved = resolveProjectors(project, normalized);
  if (!resolved.primary) return undefined;
  const primaryUrl = project.assets.assets[resolved.primary.imageAssetId]?.uri;
  if (!primaryUrl) return undefined;

  const needsSecondary = resolved.blendMode !== 'primary_only' && Boolean(resolved.secondary);
  let secondaryUrl: string | undefined;
  if (needsSecondary && resolved.secondary) {
    secondaryUrl = project.assets.assets[resolved.secondary.imageAssetId]?.uri;
  }

  return {
    primary: resolved.primary,
    primaryUrl,
    secondary: secondaryUrl ? resolved.secondary : undefined,
    secondaryUrl,
    blendMode: resolved.blendMode,
    settings: {
      ...normalized,
      panoId: resolved.primary.id,
      secondaryPanoId: secondaryUrl && resolved.secondary ? resolved.secondary.id : undefined,
      blendMode: secondaryUrl ? resolved.blendMode : 'primary_only',
    },
  };
}
