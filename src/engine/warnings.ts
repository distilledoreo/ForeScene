import { STYLED_PANO } from '../domain/copy';
import { LocationProject, Shot, WarningItem } from '../domain/types';
import { findDuplicateProductionShotIds } from './exportNaming';
import { canUseProjectedAppearance } from './projectedStyle';
import { getPanoMatchQuality } from './sync';

export type ShotReadinessLevel = 'ready' | 'notes' | 'attention';

export function getProjectWarnings(project: LocationProject): WarningItem[] {
  const warnings: WarningItem[] = [];
  const grayboxPano = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const canonicalPano = project.panoRefs.find((pano) => pano.isCanonical);

  if (!grayboxPano) {
    warnings.push({
      id: 'missing-graybox-pano',
      severity: 'warning',
      message: 'No graybox 360 panorama has been rendered from the Build workspace.',
    });
  }

  if (!canonicalPano) {
    warnings.push({
      id: 'missing-canonical-pano',
      severity: 'warning',
      message: STYLED_PANO.missing,
    });
  }

  if (project.shots.length === 0) {
    warnings.push({
      id: 'no-shots',
      severity: 'info',
      message: 'No shots have been created yet.',
    });
  }

  return warnings;
}

/**
 * Export package readiness for the current multi-select.
 * Only reports gaps that selected shots actually request — clay-only packages stay quiet.
 */
export function getExportSelectionWarnings(
  project: LocationProject,
  shots: Shot[],
): WarningItem[] {
  const warnings: WarningItem[] = [];
  if (shots.length === 0) {
    return [{
      id: 'no-export-shots-selected',
      severity: 'info',
      message: 'Select at least one shot to export.',
    }];
  }

  const grayboxPano = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const canonicalPano = project.panoRefs.find((pano) => pano.isCanonical);
  const canProject = canUseProjectedAppearance(project);

  const wantsGraybox = shots.some((shot) => shot.exportSettings.includeGrayboxPano);
  const wantsProjected = shots.some((shot) => (
    Boolean(shot.exportSettings.includeProjectedViewport)
    || Boolean(shot.exportSettings.includeProjectedCameraMoveVideo)
    || Boolean(shot.exportSettings.includeProjectedCameraMoveReferenceFrames)
  ));
  const wantsFullPanoWithoutSource = shots.some((shot) => {
    if (!shot.exportSettings.includeFullPano) return false;
    const linked = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
    return !linked && !canonicalPano;
  });
  const wantsCubemapWithoutSource = shots.some((shot) => {
    if (!shot.exportSettings.includeCubemap) return false;
    const linked = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
    return !linked && !canonicalPano;
  });

  if (wantsGraybox && !grayboxPano) {
    warnings.push({
      id: 'selection-missing-graybox-pano',
      severity: 'warning',
      message: 'Graybox panorama export is enabled for a selected shot, but no graybox 360 has been rendered from Build.',
    });
  }

  if (wantsProjected && !canProject) {
    warnings.push({
      id: 'selection-missing-projector',
      severity: 'warning',
      message: 'Projected exports are enabled for a selected shot, but no usable styled panorama projector is available.',
    });
  }

  if (wantsFullPanoWithoutSource) {
    warnings.push({
      id: 'selection-missing-full-pano',
      severity: 'warning',
      message: 'Canonical panorama export is enabled for a selected shot, but no canonical or linked panorama is available.',
    });
  }

  if (wantsCubemapWithoutSource) {
    warnings.push({
      id: 'selection-missing-cubemap-source',
      severity: 'warning',
      message: 'Cubemap export is enabled for a selected shot, but no canonical or linked panorama is available.',
    });
  }

  for (const productionId of findDuplicateProductionShotIds(shots)) {
    warnings.push({
      id: `duplicate-production-shot-id-${productionId}`,
      severity: 'warning',
      message: `Two selected shots use the production ID "${productionId}". Rename one before export.`,
    });
  }

  return warnings;
}

/** Ready / Ready with notes / Needs attention — from check severities. */
export function getShotReadinessLevel(warnings: WarningItem[]): ShotReadinessLevel {
  if (warnings.some((item) => item.severity === 'warning' || item.severity === 'danger')) {
    return 'attention';
  }
  if (warnings.some((item) => item.severity === 'info')) {
    return 'notes';
  }
  return 'ready';
}

/**
 * Compact readiness label for export / shot status controls.
 * Uses notes/checks language; reserves stronger wording only when a blocking
 * (`danger`) condition is present.
 */
export function formatWarningSummary(warnings: WarningItem[]): string {
  const level = getShotReadinessLevel(warnings);
  if (level === 'ready') return 'Ready';
  if (level === 'notes') return 'Ready with notes';

  const blocking = warnings.filter((item) => item.severity === 'danger').length;
  if (blocking > 0) {
    return blocking === 1 ? '1 blocking check' : `${blocking} blocking checks`;
  }
  return 'Needs attention';
}

/**
 * Quiet prompt-authoring hint — not an export readiness failure.
 * Matches generateImagePrompt: only promptCritical landmarks count.
 */
export function shouldShowMissingLandmarkPromptNote(
  project: LocationProject,
  shot: Shot,
): boolean {
  if (!shot.exportSettings.includePrompt) return false;
  const pinnedCritical = project.landmarks.some(
    (landmark) => landmark.promptCritical && shot.landmarkIds.includes(landmark.id),
  );
  return !pinnedCritical;
}

/**
 * Export-oriented shot checks.
 * `info` = optional context (Ready with notes).
 * `warning` / `danger` = requested deliverable incomplete, mismatched, or likely to fail.
 */
export function getShotWarnings(project: LocationProject, shot: Shot): WarningItem[] {
  const warnings: WarningItem[] = [];
  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
  const canonicalPano = project.panoRefs.find((pano) => pano.isCanonical);
  const grayboxPano = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const settings = shot.exportSettings;
  const canProject = canUseProjectedAppearance(project);

  const wantsProjected = Boolean(
    settings.includeProjectedViewport
    || settings.includeProjectedCameraMoveVideo
    || settings.includeProjectedCameraMoveReferenceFrames,
  );
  const wantsPanoCrop = Boolean(settings.includePanoCrop);
  const wantsFullPano = Boolean(settings.includeFullPano);
  const wantsCubemap = Boolean(settings.includeCubemap);

  if (settings.includeGrayboxPano && !grayboxPano) {
    warnings.push({
      id: `${shot.id}-missing-graybox-pano`,
      severity: 'warning',
      message: 'Graybox panorama export is enabled, but no graybox 360 has been rendered from Build.',
    });
  }

  if (wantsProjected && !canProject) {
    warnings.push({
      id: `${shot.id}-missing-projector`,
      severity: 'warning',
      message: 'Projected exports are enabled, but no usable styled panorama projector is available. Those outputs will be omitted from the package.',
    });
  }

  if (wantsPanoCrop && !linkedPano) {
    warnings.push({
      id: `${shot.id}-missing-pano-for-crop`,
      severity: 'warning',
      message: 'Panorama crop is enabled, but this shot is not linked to a panorama.',
    });
  }

  if (wantsFullPano && !linkedPano && !canonicalPano) {
    warnings.push({
      id: `${shot.id}-missing-full-pano`,
      severity: 'warning',
      message: 'Canonical panorama export is enabled, but no canonical or linked panorama is available.',
    });
  }

  if (wantsCubemap && !linkedPano && !canonicalPano) {
    warnings.push({
      id: `${shot.id}-missing-cubemap-source`,
      severity: 'warning',
      message: 'Cubemap export is enabled, but no canonical or linked panorama is available.',
    });
  }

  // Origin distance is contextual only for crop (and similar pano-viewpoint exports).
  // Projected textures on 3D geometry routinely leave the capture origin — that is not a fault.
  if (wantsPanoCrop && linkedPano) {
    const match = getPanoMatchQuality(shot.camera, linkedPano, project.settings);
    if (match.quality !== 'good') {
      warnings.push({
        id: `${shot.id}-pano-origin-distance`,
        severity: 'info',
        message: `Reference origin distance: ${match.distanceMeters.toFixed(1)} m. The panorama crop may have different perspective from the shot camera.`,
      });
    }
  }

  const exportAspect = settings.width / settings.height;
  if (Math.abs(exportAspect - shot.camera.aspectRatio) > 0.02) {
    warnings.push({
      id: `${shot.id}-aspect-mismatch`,
      severity: 'warning',
      message: 'Export aspect ratio differs from the intended camera frame. Deliverables may not match the framing you composed.',
    });
  }

  return warnings;
}
