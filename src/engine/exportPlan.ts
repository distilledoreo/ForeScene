/**
 * Export planning layer: resolve settings, invent files, and preflight issues
 * before any rendering or ZIP writing. Preview and packageExport should share
 * the same ExportPlan so the UI and archive agree.
 */

import {
  normalizeCharacterPassExportSettings,
  normalizeShotExportSettings,
} from '../domain/defaults';
import type {
  ExportPackageFormat,
  ExportProfileId,
  LocationProject,
  Shot,
  ShotExportSettings,
  WarningItem,
} from '../domain/types';
import {
  getCameraMoveDurationSeconds,
  getCameraMoveReferenceFrames,
  hasRenderableCameraMove,
} from './cameraKeyframes';
import { CAMERA_MOVE_CUBEMAP_FACES, DEFAULT_CAMERA_MOVE_CUBEMAP_FACE_SIZE } from './cameraMoveCubemap';
import {
  assignSharedPanoramaFolders,
  remapLegacyShotPathToV2,
  v2SharedCubemapFace,
  v2SharedCubemapStitched,
  v2SharedGrayboxPng,
  v2SharedPanoramaPng,
} from './exportPaths';
import type { ProjectOpenWarning } from './projectAssetRecovery';
import {
  characterMotionMp4Path,
  characterPassIncludesGreenMp4,
  characterPassIncludesPngSequence,
  characterPassMetadataPath,
  characterSequenceDirPath,
  characterSequenceFrameFileName,
  characterStillPath,
  resolveCharacterMotionTiming,
  shotHasVisibleCharactersForPass,
  shouldWarnCharacterPngSequenceSize,
} from './characterPassExport';
import {
  resolveShotExportSettings,
  shotHasExportOverrides,
} from './exportConfiguration';
import {
  assignShotPackageRootFolders,
  findDuplicateProductionShotIds,
} from './exportNaming';
import {
  shouldExportAnyDepth,
  shouldExportCameraMoveDepth,
  shouldExportDepthReferenceFrames,
  shouldExportViewportDepth,
} from './depthRender';
import { getPeopleRenderVariants, getPeopleVariantPath } from './peopleExport';
import { canUseProjectedAppearance } from './projectedStyle';
import {
  buildStillArtifactSpecificationsForShot,
} from './stillArtifactPlanning';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import { stillArtifactKey, type StillArtifactSpecification } from './stillArtifactTypes';
import {
  computePixelFrameCount,
  formatPixelFrameWorkload,
  resolveProjectVideoPerformance,
} from './videoPerformance';
import { computeCameraMoveFrameCount, DEFAULT_VIDEO_FRAME_RATE } from './videoPresets';
import { getExportSelectionWarnings, getShotWarnings } from './warnings';
import { shotExpectsNoPanorama } from './previs/shotEnvironment';

export const EXPORT_PLAN_SCHEMA_VERSION = 1 as const;

export type ExportPackageType =
  | 'scene'
  | 'selected-shots'
  | 'current-shot'
  | 'standalone-shots'
  | 'custom';

export type PlannedFileKind = 'image' | 'video' | 'json' | 'text';

export interface PlannedFile {
  path: string;
  kind: PlannedFileKind;
  /** Legacy manifest `required` flag (not preflight severity). */
  required: boolean;
  /** When false, file is in the ZIP but omitted from shot `manifest.json`. */
  manifestEntry: boolean;
}

export type PlannedArtifactKind =
  | 'clay-viewport'
  | 'projected-viewport'
  | 'depth-viewport'
  | 'ai-result-frame'
  | 'clay-camera-move'
  | 'projected-camera-move'
  | 'depth-camera-move'
  | 'clay-reference-frames'
  | 'projected-reference-frames'
  | 'depth-reference-frames'
  | 'pano-crop'
  | 'global-reference'
  | 'global-graybox'
  | 'cubemap'
  | 'character-still'
  | 'character-motion'
  | 'character-sequence'
  | 'character-metadata'
  | 'shot-metadata'
  | 'prompts'
  | 'shot-manifest'
  | 'package-root-manifest'
  | 'start-here';

export type PlannedArtifactDisposition = 'produce' | 'omit';

export type PlannedArtifactSource =
  | 'materialized-asset'
  | 'source-asset'
  | 'shared-preparation'
  | 'video-cache'
  | 'render-recovery';

export interface PlannedArtifact {
  id: string;
  shotId: string;
  kind: PlannedArtifactKind;
  disposition: PlannedArtifactDisposition;
  omissionCode?: string;
  variant?: 'with_people' | 'clean_plate';
  appearance?: 'clay' | 'projected' | 'depth';
  files: PlannedFile[];
  /** Progress-tracker work units for this artifact when produced. */
  workUnits: number;
  /** How packaging intends to obtain this artifact. */
  source?: PlannedArtifactSource;
  sourceAssetId?: string;
  expectedFingerprint?: string;
  materializedFingerprint?: string;
  readiness?: 'ready' | 'stale' | 'missing';
}

export type ExportPlanIssueSeverity = 'info' | 'warning' | 'error';

export interface ExportPlanIssue {
  id: string;
  code: string;
  severity: ExportPlanIssueSeverity;
  message: string;
  shotId?: string;
  artifactId?: string;
}

export interface PlannedShotExport {
  shotId: string;
  rootFolder: string;
  resolvedSettings: ShotExportSettings;
  /** True when the shot has at least two ordered camera keyframes. */
  renderableCameraMove?: boolean;
  /** True when the character pass contains at least one visible character. */
  hasVisibleCharacters?: boolean;
  hasOverrides: boolean;
  artifacts: PlannedArtifact[];
  workUnits: number;
  estimatedFileCount: number;
  /** forescene-v2 only: shared-reference artifact ids this shot's manifest should link to. */
  sharedReferenceIds: string[];
}

export interface ExportPlanSummary {
  shotCount: number;
  estimatedFileCount: number;
  estimatedWorkUnits: number;
  producedArtifactCounts: Partial<Record<PlannedArtifactKind, number>>;
  overrideShotCount: number;
  warningCount: number;
  errorCount: number;
}

/** Preflight estimate of motion-video work for the planned package. */
export interface ExportVideoWorkload {
  videoCount: number;
  totalFrames: number;
  totalPixelFrames: number;
  /** Human-readable pixel-frame product (e.g. `124.4M`). */
  totalPixelFramesLabel: string;
  resolutionPreset: string;
  frameRate: number;
  width: number;
  height: number;
  performanceProfileId: string;
  encoderMode: string;
  videos: Array<{
    shotId: string;
    kind: PlannedArtifactKind;
    appearance: 'clay' | 'projected' | 'depth';
    frameCount: number;
    pixelFrames: number;
  }>;
}

export interface ExportPlan {
  schemaVersion: typeof EXPORT_PLAN_SCHEMA_VERSION;
  projectId: string;
  projectName: string;
  packageType: ExportPackageType;
  /** Layout the writer will actually emit — matches `requestedPackageFormat` now that v2 is implemented. */
  packageFormat: ExportPackageFormat;
  requestedPackageFormat: ExportPackageFormat;
  profileId: ExportProfileId;
  archiveFileName: string;
  shots: PlannedShotExport[];
  /**
   * Unique shared reference preparations for this export (canonical / graybox / cubemap).
   * Under legacy-v1 the writer still copies outputs into each shot folder, but work units
   * and this list reflect one preparation per unique source configuration.
   */
  sharedArtifacts: PlannedArtifact[];
  issues: ExportPlanIssue[];
  estimatedFileCount: number;
  estimatedWorkUnits: number;
  summary: ExportPlanSummary;
  /** Motion video count / pixel-frame preflight for the selected shots. */
  videoWorkload: ExportVideoWorkload;
}

export interface CreateExportPlanOptions {
  packageType?: ExportPackageType;
}

function pushFile(
  files: PlannedFile[],
  path: string,
  kind: PlannedFileKind,
  required: boolean,
  manifestEntry = true,
): void {
  files.push({ path, kind, required, manifestEntry });
}

function artifactId(shotId: string, kind: PlannedArtifactKind, suffix = ''): string {
  return `${shotId}:${kind}${suffix ? `:${suffix}` : ''}`;
}

function produceArtifact(
  shotId: string,
  kind: PlannedArtifactKind,
  files: PlannedFile[],
  workUnits: number,
  extras: Partial<Pick<PlannedArtifact, 'variant' | 'appearance' | 'source' | 'sourceAssetId' | 'expectedFingerprint' | 'materializedFingerprint' | 'readiness'>> & { suffix?: string } = {},
): PlannedArtifact {
  return {
    id: artifactId(shotId, kind, extras.suffix),
    shotId,
    kind,
    disposition: 'produce',
    variant: extras.variant,
    appearance: extras.appearance,
    files,
    workUnits,
    source: extras.source,
    sourceAssetId: extras.sourceAssetId,
    expectedFingerprint: extras.expectedFingerprint,
    materializedFingerprint: extras.materializedFingerprint,
    readiness: extras.readiness,
  };
}

const STILL_PLAN_KINDS = new Set<PlannedArtifactKind>([
  'clay-viewport',
  'projected-viewport',
  'depth-viewport',
  'clay-reference-frames',
  'projected-reference-frames',
  'depth-reference-frames',
  'character-still',
]);

/**
 * Annotate produced still artifacts with fingerprint readiness from materializedMedia.
 * Does not read Blobs during planning.
 */
export function annotateStillArtifactReadiness(
  project: LocationProject,
  shot: Shot,
  artifact: PlannedArtifact,
  specification?: StillArtifactSpecification,
): PlannedArtifact {
  if (artifact.disposition !== 'produce' || !STILL_PLAN_KINDS.has(artifact.kind)) {
    return artifact;
  }
  if (!specification) {
    // Without a concrete spec we can only mark missing when no materialized media exists.
    const hasAny = Object.keys(shot.materializedMedia?.stills ?? {}).length > 0;
    return {
      ...artifact,
      readiness: hasAny ? artifact.readiness : 'missing',
      source: hasAny ? artifact.source : 'render-recovery',
    };
  }
  const expected = computeStillArtifactFingerprint(project, shot, specification);
  const key = stillArtifactKey(specification);
  const existing = shot.materializedMedia?.stills[key];
  if (!existing) {
    return {
      ...artifact,
      expectedFingerprint: expected.key,
      readiness: 'missing',
      source: 'render-recovery',
    };
  }
  if (existing.fingerprint !== expected.key) {
    return {
      ...artifact,
      expectedFingerprint: expected.key,
      materializedFingerprint: existing.fingerprint,
      sourceAssetId: existing.assetId,
      readiness: 'stale',
      source: 'render-recovery',
    };
  }
  const asset = project.assets.assets[existing.assetId];
  if (!asset) {
    return {
      ...artifact,
      expectedFingerprint: expected.key,
      materializedFingerprint: existing.fingerprint,
      sourceAssetId: existing.assetId,
      readiness: 'missing',
      source: 'render-recovery',
    };
  }
  return {
    ...artifact,
    expectedFingerprint: expected.key,
    materializedFingerprint: existing.fingerprint,
    sourceAssetId: existing.assetId,
    readiness: 'ready',
    source: 'materialized-asset',
  };
}

/**
 * Reference-frame groups span every start/middle/end frame × people variant.
 * A group is only `ready` when every expected spec is materialized, fresh, and
 * backed by a registry asset — never inferred from a single unrelated still.
 */
export function annotateReferenceFrameGroupReadiness(
  project: LocationProject,
  shot: Shot,
  artifact: PlannedArtifact,
): PlannedArtifact {
  if (
    artifact.disposition !== 'produce'
    || artifact.kind !== 'clay-reference-frames'
    && artifact.kind !== 'projected-reference-frames'
    && artifact.kind !== 'depth-reference-frames'
  ) {
    return artifact;
  }
  const specKind: StillArtifactSpecification['kind'] = artifact.kind === 'clay-reference-frames'
    ? 'clay-reference-frame'
    : artifact.kind === 'projected-reference-frames'
      ? 'projected-reference-frame'
      : 'depth-reference-frame';
  const expectedSpecs = buildStillArtifactSpecificationsForShot({
    project,
    shot,
    purpose: 'export',
  }).filter((spec) => spec.kind === specKind);
  if (expectedSpecs.length === 0) {
    return { ...artifact, readiness: 'missing', source: 'render-recovery' };
  }

  let fresh = 0;
  let present = 0;
  let expectedPrimary: string | undefined;
  for (const spec of expectedSpecs) {
    const key = stillArtifactKey(spec);
    const expected = computeStillArtifactFingerprint(project, shot, spec).key;
    expectedPrimary ??= expected;
    const existing = shot.materializedMedia?.stills[key];
    if (!existing) continue;
    present += 1;
    if (existing.fingerprint === expected && project.assets.assets[existing.assetId]) {
      fresh += 1;
    }
  }

  const ready = fresh === expectedSpecs.length;
  return {
    ...artifact,
    expectedFingerprint: expectedPrimary,
    sourceAssetId: ready
      ? shot.materializedMedia?.stills[stillArtifactKey(expectedSpecs[0]!)]?.assetId
      : undefined,
    readiness: ready ? 'ready' : present > 0 ? 'stale' : 'missing',
    source: ready ? 'materialized-asset' : 'render-recovery',
  };
}

function omitArtifact(
  shotId: string,
  kind: PlannedArtifactKind,
  omissionCode: string,
  extras: { suffix?: string; appearance?: PlannedArtifact['appearance'] } = {},
): PlannedArtifact {
  return {
    id: artifactId(shotId, kind, extras.suffix),
    shotId,
    kind,
    disposition: 'omit',
    omissionCode,
    appearance: extras.appearance,
    files: [],
    workUnits: 0,
  };
}

function warningToIssue(warning: WarningItem, shotId?: string): ExportPlanIssue {
  return {
    id: warning.id,
    code: warning.id,
    severity: warning.severity === 'danger' ? 'error' : warning.severity,
    message: warning.message,
    shotId,
  };
}

function planShotArtifacts(
  project: LocationProject,
  shot: Shot,
  rootFolder: string,
  settings: ShotExportSettings,
): { artifacts: PlannedArtifact[]; issues: ExportPlanIssue[]; hasVisibleCharacters: boolean } {
  const artifacts: PlannedArtifact[] = [];
  const issues: ExportPlanIssue[] = [];

  const canonical = project.panoRefs.find((pano) => pano.isCanonical);
  const graybox = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
  const canonicalAsset = canonical ? project.assets.assets[canonical.imageAssetId] : undefined;
  const grayboxAsset = graybox ? project.assets.assets[graybox.imageAssetId] : undefined;
  const linkedPanoAsset = linkedPano ? project.assets.assets[linkedPano.imageAssetId] : undefined;
  const omitPanoramaReferences = shotExpectsNoPanorama(project, shot);
  const aiResultAssetId = shot.assets.aiResultFrameAssetId ?? shot.assets.finalBaseFrameAssetId;
  const canProject = canUseProjectedAppearance(project);
  const peopleMode = settings.peopleExportMode;
  const peopleVariants = getPeopleRenderVariants(peopleMode);
  const hasMove = hasRenderableCameraMove(shot.cameraKeyframes);
  const clayMoveFrames = settings.includeCameraMoveReferenceFrames
    ? getCameraMoveReferenceFrames(shot.cameraKeyframes)
    : [];
  const projectedMoveFrames = (
    settings.includeProjectedCameraMoveReferenceFrames && canProject
  )
    ? getCameraMoveReferenceFrames(shot.cameraKeyframes)
    : [];
  const depthMoveFrames = shouldExportDepthReferenceFrames(settings.depth, true)
    ? getCameraMoveReferenceFrames(shot.cameraKeyframes)
    : [];
  // Writer requires a real registry asset — a pano record alone is not enough to produce.
  const hasCubemapSource = Boolean(
    !omitPanoramaReferences
    && settings.includeCubemap
    && ((canonical && canonicalAsset) || (linkedPano && linkedPanoAsset)),
  );
  const aiResultAsset = aiResultAssetId
    ? project.assets.assets[aiResultAssetId]
    : undefined;

  if (settings.includeViewport) {
    const files: PlannedFile[] = [];
    for (const variant of peopleVariants) {
      pushFile(
        files,
        getPeopleVariantPath(`${rootFolder}/inputs/viewport_clay.png`, variant, peopleMode),
        'image',
        true,
      );
    }
    artifacts.push(produceArtifact(shot.id, 'clay-viewport', files, peopleVariants.length, {
      appearance: 'clay',
    }));
  }

  if (shouldExportViewportDepth(settings.depth)) {
    const files: PlannedFile[] = [];
    for (const variant of peopleVariants) {
      pushFile(
        files,
        getPeopleVariantPath(`${rootFolder}/inputs/viewport_depth.png`, variant, peopleMode),
        'image',
        true,
      );
    }
    artifacts.push(produceArtifact(shot.id, 'depth-viewport', files, peopleVariants.length, {
      appearance: 'depth',
    }));
  }

  if (settings.includeProjectedViewport) {
    if (canProject) {
      const files: PlannedFile[] = [];
      for (const variant of peopleVariants) {
        pushFile(
          files,
          getPeopleVariantPath(`${rootFolder}/inputs/viewport_projected.png`, variant, peopleMode),
          'image',
          false,
        );
      }
      artifacts.push(produceArtifact(shot.id, 'projected-viewport', files, peopleVariants.length, {
        appearance: 'projected',
      }));
    } else {
      artifacts.push(omitArtifact(shot.id, 'projected-viewport', 'missing-projector', {
        appearance: 'projected',
      }));
    }
  }

  if (settings.includePanoCrop) {
    if (omitPanoramaReferences) {
      artifacts.push(omitArtifact(shot.id, 'pano-crop', 'production-contract-no-panorama'));
    } else if (linkedPano && shot.panoCrop && linkedPanoAsset) {
      artifacts.push(produceArtifact(
        shot.id,
        'pano-crop',
        [{ path: `${rootFolder}/inputs/pano_crop.png`, kind: 'image', required: true, manifestEntry: true }],
        1,
      ));
    } else {
      const omissionCode = !linkedPano
        ? 'missing-linked-pano'
        : !shot.panoCrop
          ? 'missing-pano-crop'
          : 'missing-pano-crop-asset';
      artifacts.push(omitArtifact(shot.id, 'pano-crop', omissionCode));
      if (linkedPano && shot.panoCrop && !linkedPanoAsset) {
        issues.push({
          id: `${shot.id}-pano-crop-missing-asset`,
          code: 'pano-crop-missing-asset',
          severity: 'warning',
          message: 'Panorama crop is enabled, but the linked panorama asset is missing from the project registry.',
          shotId: shot.id,
        });
      }
    }
  }

  if (settings.includeFullPano) {
    if (omitPanoramaReferences) {
      artifacts.push(omitArtifact(shot.id, 'global-reference', 'production-contract-no-panorama'));
    } else if (canonical && canonicalAsset) {
      artifacts.push(produceArtifact(
        shot.id,
        'global-reference',
        [{ path: `${rootFolder}/inputs/global_reference.png`, kind: 'image', required: true, manifestEntry: true }],
        1,
      ));
    } else if (canonical && !canonicalAsset) {
      artifacts.push(omitArtifact(shot.id, 'global-reference', 'missing-canonical-pano-asset'));
      issues.push({
        id: `${shot.id}-global-reference-missing-asset`,
        code: 'global-reference-missing-asset',
        severity: 'warning',
        message: 'Canonical panorama export is enabled, but its image asset is missing.',
        shotId: shot.id,
      });
    } else {
      artifacts.push(omitArtifact(shot.id, 'global-reference', 'missing-canonical-pano'));
    }
  }

  if (settings.includeCubemap) {
    if (omitPanoramaReferences) {
      artifacts.push(omitArtifact(shot.id, 'cubemap', 'production-contract-no-panorama'));
    } else if (hasCubemapSource) {
      const files: PlannedFile[] = [];
      for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
        pushFile(files, `${rootFolder}/inputs/cubemap/${face}.png`, 'image', false);
      }
      pushFile(files, `${rootFolder}/inputs/cubemap/cubemap_stitched.png`, 'image', false);
      artifacts.push(produceArtifact(
        shot.id,
        'cubemap',
        files,
        CAMERA_MOVE_CUBEMAP_FACES.length + 1,
      ));
    } else {
      const cubemapOmission = (canonical || linkedPano)
        ? 'missing-full-pano-asset'
        : 'missing-full-pano-source';
      artifacts.push(omitArtifact(shot.id, 'cubemap', cubemapOmission));
    }
  }

  if (settings.includeGrayboxPano) {
    if (omitPanoramaReferences) {
      artifacts.push(omitArtifact(shot.id, 'global-graybox', 'production-contract-no-panorama'));
    } else if (graybox && grayboxAsset) {
      artifacts.push(produceArtifact(
        shot.id,
        'global-graybox',
        [{ path: `${rootFolder}/inputs/global_graybox.png`, kind: 'image', required: false, manifestEntry: true }],
        1,
      ));
    } else if (graybox && !grayboxAsset) {
      artifacts.push(omitArtifact(shot.id, 'global-graybox', 'missing-graybox-pano-asset'));
      issues.push({
        id: `${shot.id}-graybox-missing-asset`,
        code: 'graybox-missing-asset',
        severity: 'warning',
        message: 'Graybox panorama export is enabled, but its image asset is missing.',
        shotId: shot.id,
      });
    } else {
      artifacts.push(omitArtifact(shot.id, 'global-graybox', 'missing-graybox-pano'));
    }
  }

  if (settings.includeAiResultFrame) {
    if (aiResultAssetId && aiResultAsset) {
      artifacts.push(produceArtifact(
        shot.id,
        'ai-result-frame',
        [{ path: `${rootFolder}/outputs/ai_result_frame.png`, kind: 'image', required: false, manifestEntry: true }],
        1,
      ));
    } else if (aiResultAssetId && !aiResultAsset) {
      artifacts.push(omitArtifact(shot.id, 'ai-result-frame', 'missing-ai-result-asset'));
      issues.push({
        id: `${shot.id}-ai-result-missing-asset`,
        code: 'ai-result-missing-asset',
        severity: 'warning',
        message: 'AI result frame export is enabled, but the referenced asset is missing from the project registry.',
        shotId: shot.id,
      });
    } else {
      artifacts.push(omitArtifact(shot.id, 'ai-result-frame', 'ai-result-not-attached'));
    }
  }

  if (settings.includeCameraMoveVideo) {
    const canProduce = Boolean(shot.assets.cameraMoveVideoAssetId || hasMove);
    if (canProduce) {
      const files: PlannedFile[] = [];
      for (const variant of peopleVariants) {
        if (variant === 'clean_plate' && !hasMove) continue;
        pushFile(
          files,
          getPeopleVariantPath(`${rootFolder}/inputs/viewport_clay_motion.mp4`, variant, peopleMode),
          'video',
          false,
        );
      }
      const units = hasMove
        ? peopleVariants.length
        : peopleVariants.filter((variant) => variant === 'with_people').length;
      artifacts.push(produceArtifact(shot.id, 'clay-camera-move', files, units, {
        appearance: 'clay',
      }));
    } else {
      artifacts.push(omitArtifact(shot.id, 'clay-camera-move', 'missing-camera-move', {
        appearance: 'clay',
      }));
    }
  }

  if (settings.includeProjectedCameraMoveVideo) {
    if (canProject && hasMove) {
      const files: PlannedFile[] = [];
      for (const variant of peopleVariants) {
        pushFile(
          files,
          getPeopleVariantPath(`${rootFolder}/inputs/viewport_projected_motion.mp4`, variant, peopleMode),
          'video',
          false,
        );
      }
      artifacts.push(produceArtifact(shot.id, 'projected-camera-move', files, peopleVariants.length, {
        appearance: 'projected',
      }));
    } else {
      artifacts.push(omitArtifact(
        shot.id,
        'projected-camera-move',
        !canProject ? 'missing-projector' : 'missing-camera-move',
        { appearance: 'projected' },
      ));
    }
  }

  if (settings.depth?.enabled) {
    if (shouldExportCameraMoveDepth(settings.depth, hasMove)) {
      const files: PlannedFile[] = [];
      for (const variant of peopleVariants) {
        pushFile(
          files,
          getPeopleVariantPath(`${rootFolder}/inputs/viewport_depth_motion.mp4`, variant, peopleMode),
          'video',
          false,
        );
      }
      artifacts.push(produceArtifact(shot.id, 'depth-camera-move', files, peopleVariants.length, {
        appearance: 'depth',
      }));
    } else if (settings.depth.includeCameraMoveVideo !== false) {
      artifacts.push(omitArtifact(shot.id, 'depth-camera-move', 'missing-camera-move', {
        appearance: 'depth',
      }));
    }
  }

  if (settings.includeCameraMoveReferenceFrames) {
    if (clayMoveFrames.length > 0) {
      const files: PlannedFile[] = [];
      for (const frame of clayMoveFrames) {
        for (const variant of peopleVariants) {
          pushFile(
            files,
            getPeopleVariantPath(`${rootFolder}/inputs/camera_move/clay_${frame.id}.png`, variant, peopleMode),
            'image',
            false,
          );
        }
      }
      artifacts.push(produceArtifact(
        shot.id,
        'clay-reference-frames',
        files,
        clayMoveFrames.length * peopleVariants.length,
        { appearance: 'clay' },
      ));
    } else {
      artifacts.push(omitArtifact(shot.id, 'clay-reference-frames', 'missing-camera-keyframes', {
        appearance: 'clay',
      }));
    }
  }

  if (settings.includeProjectedCameraMoveReferenceFrames) {
    if (canProject && projectedMoveFrames.length > 0) {
      const files: PlannedFile[] = [];
      for (const frame of projectedMoveFrames) {
        for (const variant of peopleVariants) {
          pushFile(
            files,
            getPeopleVariantPath(`${rootFolder}/inputs/camera_move/projected_${frame.id}.png`, variant, peopleMode),
            'image',
            false,
          );
        }
      }
      artifacts.push(produceArtifact(
        shot.id,
        'projected-reference-frames',
        files,
        projectedMoveFrames.length * peopleVariants.length,
        { appearance: 'projected' },
      ));
    } else {
      artifacts.push(omitArtifact(
        shot.id,
        'projected-reference-frames',
        !canProject ? 'missing-projector' : 'missing-camera-keyframes',
        { appearance: 'projected' },
      ));
    }
  }

  if (shouldExportDepthReferenceFrames(settings.depth, true) && depthMoveFrames.length > 0) {
    const files: PlannedFile[] = [];
    for (const frame of depthMoveFrames) {
      for (const variant of peopleVariants) {
        pushFile(
          files,
          getPeopleVariantPath(`${rootFolder}/inputs/camera_move/depth_${frame.id}.png`, variant, peopleMode),
          'image',
          false,
        );
      }
    }
    artifacts.push(produceArtifact(
      shot.id,
      'depth-reference-frames',
      files,
      depthMoveFrames.length * peopleVariants.length,
      { appearance: 'depth' },
    ));
  }

  if (settings.includeMetadata) {
    const files: PlannedFile[] = [];
    pushFile(files, `${rootFolder}/metadata/shot.json`, 'json', true);
    pushFile(files, `${rootFolder}/metadata/camera.json`, 'json', true);
    if (shot.cameraKeyframes.length > 0) {
      pushFile(files, `${rootFolder}/metadata/camera_keyframes.json`, 'json', false);
    }
    if (
      clayMoveFrames.length > 0
      || depthMoveFrames.length > 0
      || projectedMoveFrames.length > 0
    ) {
      pushFile(files, `${rootFolder}/metadata/camera_move_reference_frames.json`, 'json', false);
    }
    if (shouldExportAnyDepth(settings.depth, {
      hasReferenceFrames: depthMoveFrames.length > 0,
      hasRenderableMove: hasMove,
    })) {
      pushFile(files, `${rootFolder}/metadata/depth.json`, 'json', false);
    }
    pushFile(files, `${rootFolder}/metadata/landmarks.json`, 'json', true);
    pushFile(files, `${rootFolder}/metadata/location.json`, 'json', true);
    artifacts.push(produceArtifact(shot.id, 'shot-metadata', files, 1));
  }

  const characterPass = normalizeCharacterPassExportSettings(settings.characterPass);
  const hasCharacters = characterPass.enabled
    && shotHasVisibleCharactersForPass(project, shot, characterPass);
  if (characterPass.enabled) {
    if (!hasCharacters) {
      if (characterPass.includeStill) {
        const files: PlannedFile[] = [
          { path: characterStillPath(rootFolder, 'clay'), kind: 'image', required: true, manifestEntry: true },
        ];
        let units = 1;
        if (settings.includeProjectedViewport && canProject) {
          files.push({
            path: characterStillPath(rootFolder, 'projected'),
            kind: 'image',
            required: false,
            manifestEntry: true,
          });
          units += 1;
        }
        artifacts.push(produceArtifact(shot.id, 'character-still', files, units));
      }
      issues.push({
        id: `${shot.id}-character-pass-empty`,
        code: 'character-pass-empty',
        severity: 'warning',
        message: 'Character export is enabled, but this shot has no visible characters. Character still outputs will be transparent.',
        shotId: shot.id,
      });
    } else {
      if (characterPass.includeStill) {
        const files: PlannedFile[] = [
          { path: characterStillPath(rootFolder, 'clay'), kind: 'image', required: true, manifestEntry: true },
        ];
        let units = 1;
        if (settings.includeProjectedViewport && canProject) {
          files.push({
            path: characterStillPath(rootFolder, 'projected'),
            kind: 'image',
            required: false,
            manifestEntry: true,
          });
          units += 1;
        }
        artifacts.push(produceArtifact(shot.id, 'character-still', files, units));
      }

      if (characterPass.includeMotion) {
        if (!hasMove) {
          artifacts.push(omitArtifact(shot.id, 'character-motion', 'missing-camera-move'));
        } else {
          const timing = resolveCharacterMotionTiming(
            { ...shot, exportSettings: settings },
            DEFAULT_VIDEO_FRAME_RATE,
          );
          const motionAppearances: Array<'clay' | 'projected'> = ['clay'];
          if (settings.includeProjectedCameraMoveVideo && canProject) {
            motionAppearances.push('projected');
          }

          if (characterPassIncludesGreenMp4(characterPass.motionFormat)) {
            const files: PlannedFile[] = [];
            let units = 0;
            for (const appearance of motionAppearances) {
              pushFile(files, characterMotionMp4Path(rootFolder, appearance), 'video', false);
              units += 1;
            }
            artifacts.push(produceArtifact(shot.id, 'character-motion', files, units));
          }

          if (characterPassIncludesPngSequence(characterPass.motionFormat)) {
            const files: PlannedFile[] = [];
            let units = 0;
            for (const appearance of motionAppearances) {
              const sequenceDir = characterSequenceDirPath(rootFolder, appearance);
              for (let frame = 1; frame <= timing.frameCount; frame += 1) {
                pushFile(files, `${sequenceDir}/${characterSequenceFrameFileName(frame)}`, 'image', false);
              }
              pushFile(files, `${sequenceDir}/sequence.json`, 'json', false);
              units += 1;
            }
            artifacts.push(produceArtifact(shot.id, 'character-sequence', files, units));
            if (shouldWarnCharacterPngSequenceSize(timing.width, timing.height, timing.frameCount)) {
              issues.push({
                id: `${shot.id}-character-png-sequence-large`,
                code: 'character-png-sequence-large',
                severity: 'warning',
                message: `Transparent PNG sequence may generate ${timing.frameCount} frames at ${timing.width}×${timing.height} and use substantial browser memory.`,
                shotId: shot.id,
              });
            }
          }
        }
      }

      if (settings.includeMetadata) {
        artifacts.push(produceArtifact(
          shot.id,
          'character-metadata',
          [{
            path: characterPassMetadataPath(rootFolder),
            kind: 'json',
            required: false,
            manifestEntry: true,
          }],
          0,
        ));
      }
    }
  }

  if (settings.includePrompt) {
    artifacts.push(produceArtifact(shot.id, 'prompts', [
      { path: `${rootFolder}/prompts/image_gen_prompt.txt`, kind: 'text', required: true, manifestEntry: true },
      { path: `${rootFolder}/prompts/video_gen_prompt.txt`, kind: 'text', required: true, manifestEntry: true },
      { path: `${rootFolder}/prompts/negative_prompt.txt`, kind: 'text', required: false, manifestEntry: true },
    ], 1));
  }

  artifacts.push(produceArtifact(shot.id, 'shot-manifest', [
    {
      path: `${rootFolder}/manifest.json`,
      kind: 'json',
      required: true,
      manifestEntry: false,
    },
  ], 1));

  if (shotHasExportOverrides(shot)) {
    issues.push({
      id: `${shot.id}-has-export-overrides`,
      code: 'shot-has-export-overrides',
      severity: 'info',
      message: 'This shot uses settings that differ from the Scene Export Settings.',
      shotId: shot.id,
    });
  }

  return { artifacts, issues, hasVisibleCharacters: hasCharacters };
}

function inferPackageType(shotCount: number, projectShotCount: number): ExportPackageType {
  if (shotCount <= 0) return 'custom';
  if (shotCount === 1 && projectShotCount > 1) return 'current-shot';
  if (shotCount === projectShotCount) return 'scene';
  return 'selected-shots';
}

function buildArchiveFileName(
  project: LocationProject,
  shots: readonly Shot[],
  rootFolders: string[],
): string {
  if (shots.length === 1) {
    return `${rootFolders[0] ?? 'shot'}_package.zip`;
  }
  // Preserve case for project-name archives (legacy multi-shot ZIP naming).
  const safeName = (project.name || 'forescene')
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    || 'forescene';
  return `${safeName}_${shots.length}_shots_package.zip`;
}

function summarizePlan(
  shots: PlannedShotExport[],
  sharedArtifacts: PlannedArtifact[],
  issues: ExportPlanIssue[],
): ExportPlanSummary {
  const producedArtifactCounts: Partial<Record<PlannedArtifactKind, number>> = {};
  let estimatedFileCount = 0;
  let estimatedWorkUnits = 0;
  let overrideShotCount = 0;

  for (const shot of shots) {
    if (shot.hasOverrides) overrideShotCount += 1;
    estimatedFileCount += shot.estimatedFileCount;
    estimatedWorkUnits += shot.workUnits;
    for (const artifact of shot.artifacts) {
      if (artifact.disposition !== 'produce') continue;
      producedArtifactCounts[artifact.kind] = (producedArtifactCounts[artifact.kind] ?? 0) + 1;
    }
  }

  for (const artifact of sharedArtifacts) {
    if (artifact.disposition !== 'produce') continue;
    estimatedWorkUnits += artifact.workUnits;
    estimatedFileCount += artifact.files.length;
  }

  return {
    shotCount: shots.length,
    estimatedFileCount,
    estimatedWorkUnits,
    producedArtifactCounts,
    overrideShotCount,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
  };
}

export const SHARED_REFERENCE_KINDS = new Set<PlannedArtifactKind>([
  'global-reference',
  'global-graybox',
  'cubemap',
]);

export function sharedReferenceCacheKey(
  project: LocationProject,
  shot: Shot,
  settings: ShotExportSettings,
  kind: PlannedArtifactKind,
): string | null {
  if (shotExpectsNoPanorama(project, shot)) return null;
  const canonical = project.panoRefs.find((pano) => pano.isCanonical);
  const graybox = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);

  if (kind === 'global-reference') {
    if (!settings.includeFullPano || !canonical) return null;
    const asset = project.assets.assets[canonical.imageAssetId];
    if (!asset) return null;
    return [
      'global-reference',
      canonical.imageAssetId,
      canonical.width,
      canonical.height,
      project.settings.panoLetterboxExports169 ? 1 : 0,
      project.settings.defaultShotWidth,
      project.settings.defaultShotHeight,
    ].join('|');
  }

  if (kind === 'global-graybox') {
    if (!settings.includeGrayboxPano || !graybox) return null;
    const asset = project.assets.assets[graybox.imageAssetId];
    if (!asset) return null;
    return [
      'global-graybox',
      graybox.imageAssetId,
      graybox.width,
      graybox.height,
      project.settings.panoLetterboxExports169 ? 1 : 0,
      project.settings.defaultShotWidth,
      project.settings.defaultShotHeight,
    ].join('|');
  }

  if (kind === 'cubemap') {
    if (!settings.includeCubemap) return null;
    const source = (canonical && project.assets.assets[canonical.imageAssetId])
      ? canonical
      : (linkedPano && project.assets.assets[linkedPano.imageAssetId])
        ? linkedPano
        : undefined;
    if (!source) return null;
    return [
      'cubemap',
      source.imageAssetId,
      JSON.stringify(source.rotation),
      DEFAULT_CAMERA_MOVE_CUBEMAP_FACE_SIZE,
    ].join('|');
  }

  return null;
}

/**
 * Collapse duplicate shared-reference prep into `sharedArtifacts` and zero per-shot
 * work units for those kinds so multi-shot progress matches the cached writer.
 */
function attachSharedReferenceArtifacts(
  project: LocationProject,
  shots: readonly Shot[],
  plannedShots: PlannedShotExport[],
): PlannedArtifact[] {
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  const sharedByKey = new Map<string, PlannedArtifact>();

  for (const shotPlan of plannedShots) {
    const shot = shotById.get(shotPlan.shotId);
    if (!shot) continue;

    for (const artifact of shotPlan.artifacts) {
      if (artifact.disposition !== 'produce' || !SHARED_REFERENCE_KINDS.has(artifact.kind)) continue;
      const key = sharedReferenceCacheKey(
        project,
        shot,
        shotPlan.resolvedSettings,
        artifact.kind,
      );
      if (!key) continue;

      if (!sharedByKey.has(key)) {
        sharedByKey.set(key, {
          id: `shared:${key}`,
          shotId: '__shared__',
          kind: artifact.kind,
          disposition: 'produce',
          // Empty files: legacy-v1 still writes per-shot copies; forescene-v2 will own shared paths.
          files: [],
          workUnits: artifact.workUnits,
        });
      }
      // Per-shot copies are packaging only; unique prep work lives on sharedArtifacts.
      artifact.workUnits = 0;
    }

    const produced = shotPlan.artifacts.filter((artifact) => artifact.disposition === 'produce');
    let workUnits = produced.reduce((sum, artifact) => sum + artifact.workUnits, 0);
    const characterMeta = produced.find((artifact) => artifact.kind === 'character-metadata');
    if (characterMeta && shotPlan.resolvedSettings.includeMetadata) {
      workUnits += 1;
    }
    shotPlan.workUnits = workUnits;
  }

  return [...sharedByKey.values()];
}

interface SharedPanoSourceInfo {
  panoId: string;
  label: string;
}

/** Identify the underlying pano record behind a shared-reference kind (for v2 folder grouping). */
function resolveSharedPanoSource(
  project: LocationProject,
  shot: Shot,
  kind: PlannedArtifactKind,
): SharedPanoSourceInfo | null {
  const canonical = project.panoRefs.find((pano) => pano.isCanonical);
  const graybox = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);

  if (kind === 'global-reference') {
    return canonical ? { panoId: canonical.id, label: canonical.name || 'panorama' } : null;
  }
  if (kind === 'global-graybox') {
    return graybox ? { panoId: graybox.id, label: graybox.name || 'graybox' } : null;
  }
  if (kind === 'cubemap') {
    const canonicalAsset = canonical ? project.assets.assets[canonical.imageAssetId] : undefined;
    if (canonical && canonicalAsset) {
      return { panoId: canonical.id, label: canonical.name || 'panorama' };
    }
    const linkedAsset = linkedPano ? project.assets.assets[linkedPano.imageAssetId] : undefined;
    if (linkedPano && linkedAsset) {
      return { panoId: linkedPano.id, label: linkedPano.name || 'panorama' };
    }
  }
  return null;
}

/**
 * forescene-v2 equivalent of `attachSharedReferenceArtifacts`: shared panos/cubemaps
 * get real archive paths under `shared_references/panoramas/<folder>/` and are removed
 * entirely from per-shot artifacts (produced or omitted) since the writer never copies
 * them into shot folders under v2.
 */
function finalizeShotArtifactsForV2(
  project: LocationProject,
  shots: readonly Shot[],
  plannedShots: PlannedShotExport[],
): PlannedArtifact[] {
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  const sharedByCacheKey = new Map<string, {
    kind: PlannedArtifactKind;
    panoSource: SharedPanoSourceInfo;
    workUnits: number;
  }>();

  for (const shotPlan of plannedShots) {
    const shot = shotById.get(shotPlan.shotId);
    if (!shot) continue;

    const sharedIdsForShot: string[] = [];
    const keptArtifacts: PlannedArtifact[] = [];
    for (const artifact of shotPlan.artifacts) {
      if (SHARED_REFERENCE_KINDS.has(artifact.kind)) {
        if (artifact.disposition === 'produce') {
          const cacheKey = sharedReferenceCacheKey(project, shot, shotPlan.resolvedSettings, artifact.kind);
          if (cacheKey) {
            const panoSource = resolveSharedPanoSource(project, shot, artifact.kind);
            if (panoSource) {
              if (!sharedByCacheKey.has(cacheKey)) {
                sharedByCacheKey.set(cacheKey, { kind: artifact.kind, panoSource, workUnits: artifact.workUnits });
              }
              sharedIdsForShot.push(`shared:${cacheKey}`);
            }
          }
        }
        continue;
      }
      keptArtifacts.push({
        ...artifact,
        files: artifact.files.map((file) => ({
          ...file,
          path: remapLegacyShotPathToV2(shotPlan.rootFolder, file.path),
        })),
      });
    }

    shotPlan.artifacts = keptArtifacts;
    shotPlan.sharedReferenceIds = sharedIdsForShot;

    const produced = keptArtifacts.filter((artifact) => artifact.disposition === 'produce');
    let workUnits = produced.reduce((sum, artifact) => sum + artifact.workUnits, 0);
    const characterMeta = produced.find((artifact) => artifact.kind === 'character-metadata');
    if (characterMeta && shotPlan.resolvedSettings.includeMetadata) {
      workUnits += 1;
    }
    shotPlan.workUnits = workUnits;
    shotPlan.estimatedFileCount = produced.reduce((sum, artifact) => sum + artifact.files.length, 0);
  }

  const panoSourceByPanoId = new Map<string, SharedPanoSourceInfo>();
  for (const entry of sharedByCacheKey.values()) {
    panoSourceByPanoId.set(entry.panoSource.panoId, entry.panoSource);
  }
  const folderByPanoId = assignSharedPanoramaFolders(
    [...panoSourceByPanoId.values()].map((info) => ({ id: info.panoId, label: info.label })),
  );

  const sharedArtifacts: PlannedArtifact[] = [];
  for (const [cacheKey, entry] of sharedByCacheKey) {
    const folder = folderByPanoId.get(entry.panoSource.panoId);
    if (!folder) continue;
    const files: PlannedFile[] = [];
    if (entry.kind === 'global-reference') {
      pushFile(files, v2SharedPanoramaPng(folder), 'image', true);
    } else if (entry.kind === 'global-graybox') {
      pushFile(files, v2SharedGrayboxPng(folder), 'image', false);
    } else if (entry.kind === 'cubemap') {
      for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
        pushFile(files, v2SharedCubemapFace(folder, face), 'image', false);
      }
      pushFile(files, v2SharedCubemapStitched(folder), 'image', false);
    }
    sharedArtifacts.push({
      id: `shared:${cacheKey}`,
      shotId: '__shared__',
      kind: entry.kind,
      disposition: 'produce',
      files,
      workUnits: entry.workUnits,
    });
  }

  sharedArtifacts.push({
    id: 'shared:package-root-manifest',
    shotId: '__shared__',
    kind: 'package-root-manifest',
    disposition: 'produce',
    files: [{ path: 'manifest.json', kind: 'json', required: true, manifestEntry: false }],
    workUnits: 1,
  });
  sharedArtifacts.push({
    id: 'shared:start-here',
    shotId: '__shared__',
    kind: 'start-here',
    disposition: 'produce',
    files: [{ path: 'START_HERE.html', kind: 'text', required: true, manifestEntry: false }],
    workUnits: 1,
  });

  return sharedArtifacts;
}

/**
 * Build a complete export plan for the given shots without rendering.
 * Uses the same inclusion rules as the legacy package writer / manifest.
 */
export function createExportPlan(
  project: LocationProject,
  shots: readonly Shot[],
  options: CreateExportPlanOptions = {},
): ExportPlan {
  const config = project.exportConfiguration;
  const requestedPackageFormat = config?.packageFormat ?? 'legacy-v1';
  const packageFormat = requestedPackageFormat;
  const profileId = config?.activeProfileId ?? 'custom';
  const packageType = options.packageType
    ?? inferPackageType(shots.length, project.shots.length);

  const folderAssignments = assignShotPackageRootFolders([...shots]);
  const folderByShotId = new Map(
    folderAssignments.map((assignment) => [assignment.shotId, assignment.rootFolder]),
  );

  const plannedShots: PlannedShotExport[] = [];
  const issues: ExportPlanIssue[] = [];

  if (shots.length === 0) {
    issues.push({
      id: 'no-export-shots-selected',
      code: 'no-export-shots-selected',
      severity: 'error',
      message: 'Select at least one shot to export.',
    });
  }

  for (const warning of getExportSelectionWarnings(project, [...shots])) {
    if (warning.id === 'no-export-shots-selected') continue;
    issues.push(warningToIssue(warning));
  }

  for (const productionId of findDuplicateProductionShotIds([...shots])) {
    if (!issues.some((issue) => issue.id === `duplicate-production-shot-id-${productionId}`)) {
      issues.push({
        id: `duplicate-production-shot-id-${productionId}`,
        code: 'duplicate-production-shot-id',
        severity: 'warning',
        message: `Two selected shots use the production ID "${productionId}". Rename one before export.`,
      });
    }
  }

  for (const shot of shots) {
    const rootFolder = folderByShotId.get(shot.id) ?? shot.shotNumber;
    // Prefer the rematerialized snapshot exporters already read. When inheritance
    // is present, resolve() should match; fall back to normalize(exportSettings)
    // so legacy direct mutations (tests / older call sites) still plan correctly.
    const resolvedFromInheritance = project.exportConfiguration
      ? normalizeShotExportSettings(resolveShotExportSettings(project, shot))
      : undefined;
    const resolvedSettings = normalizeShotExportSettings(shot.exportSettings);
    const settingsForPlan = resolvedFromInheritance
      && JSON.stringify(resolvedFromInheritance) === JSON.stringify(resolvedSettings)
      ? resolvedFromInheritance
      : resolvedSettings;
    const planningShot: Shot = {
      ...shot,
      exportSettings: settingsForPlan,
    };
    const planned = planShotArtifacts(
      project,
      planningShot,
      rootFolder,
      settingsForPlan,
    );
    const hasVisibleCharacters = planned.hasVisibleCharacters;
    const shotIssues = planned.issues;
    // Annotate still readiness from materializedMedia (no Blob reads).
    const artifacts = planned.artifacts.map((artifact) => {
      if (!STILL_PLAN_KINDS.has(artifact.kind) || artifact.disposition !== 'produce') {
        return artifact;
      }
      // Build a representative specification for viewport stills (primary people variant).
      if (
        artifact.kind === 'clay-viewport'
        || artifact.kind === 'projected-viewport'
        || artifact.kind === 'depth-viewport'
      ) {
        const peopleVariant = artifact.variant
          ?? (settingsForPlan.peopleExportMode === 'clean_plate' ? 'clean_plate' : 'with_people');
        const appearance =
          artifact.kind === 'clay-viewport'
            ? 'clay' as const
            : artifact.kind === 'projected-viewport'
              ? 'projected' as const
              : 'depth' as const;
        const kind =
          artifact.kind === 'clay-viewport'
            ? 'clay-viewport' as const
            : artifact.kind === 'projected-viewport'
              ? 'projected-viewport' as const
              : 'depth-viewport' as const;
        return annotateStillArtifactReadiness(project, planningShot, artifact, {
          kind,
          appearance,
          peopleVariant,
          width: settingsForPlan.width,
          height: settingsForPlan.height,
        });
      }
      if (artifact.kind === 'character-still') {
        return annotateStillArtifactReadiness(project, planningShot, artifact, {
          kind: 'character-still',
          appearance: artifact.appearance === 'projected' ? 'projected' : 'clay',
          contentMode: 'characters_only',
          width: settingsForPlan.width,
          height: settingsForPlan.height,
        });
      }
      // Reference-frame groups: ready only when every start/middle/end frame and
      // people variant is materialized and fresh (never inferred from one still).
      if (
        artifact.kind === 'clay-reference-frames'
        || artifact.kind === 'projected-reference-frames'
        || artifact.kind === 'depth-reference-frames'
      ) {
        return annotateReferenceFrameGroupReadiness(project, planningShot, artifact);
      }
      return annotateStillArtifactReadiness(project, planningShot, artifact);
    });

    for (const warning of getShotWarnings(project, planningShot)) {
      issues.push(warningToIssue(warning, shot.id));
    }
    issues.push(...shotIssues);

    // Preflight: motion toggles enabled but no pass can be produced (e.g. Fast Control
    // projected-only without a styled projector, and no clay fallback applied yet).
    const wantsMotion = settingsForPlan.includeCameraMoveVideo
      || settingsForPlan.includeProjectedCameraMoveVideo
      || Boolean(settingsForPlan.depth?.enabled && settingsForPlan.depth.includeCameraMoveVideo !== false);
    if (wantsMotion && hasRenderableCameraMove(planningShot.cameraKeyframes)) {
      const motionProduced = artifacts.some((artifact) => (
        artifact.disposition === 'produce'
        && (
          artifact.kind === 'clay-camera-move'
          || artifact.kind === 'projected-camera-move'
          || artifact.kind === 'depth-camera-move'
        )
      ));
      if (!motionProduced) {
        issues.push({
          id: `${shot.id}-no-motion-video-pass`,
          code: 'no-motion-video-pass',
          severity: 'warning',
          message: 'Camera-move video is requested, but no clay/projected/depth motion pass can be produced for this shot. Enable clay motion or attach a styled panorama for projected motion.',
          shotId: shot.id,
        });
      }
    }

    const produced = artifacts.filter((artifact) => artifact.disposition === 'produce');
    const workUnits = produced.reduce((sum, artifact) => sum + artifact.workUnits, 0);
    const characterMeta = produced.find((artifact) => artifact.kind === 'character-metadata');
    const adjustedWorkUnits = characterMeta && settingsForPlan.includeMetadata
      ? workUnits + 1
      : workUnits;

    const estimatedFileCount = produced.reduce(
      (sum, artifact) => sum + artifact.files.length,
      0,
    );

    plannedShots.push({
      shotId: shot.id,
      rootFolder,
      resolvedSettings: settingsForPlan,
      renderableCameraMove: hasRenderableCameraMove(planningShot.cameraKeyframes),
      hasVisibleCharacters,
      hasOverrides: shotHasExportOverrides(shot),
      artifacts,
      workUnits: adjustedWorkUnits,
      estimatedFileCount,
      sharedReferenceIds: [],
    });
  }

  const rootFolders = plannedShots.map((shot) => shot.rootFolder);
  const sharedArtifacts = packageFormat === 'forescene-v2'
    ? finalizeShotArtifactsForV2(project, shots, plannedShots)
    : attachSharedReferenceArtifacts(project, shots, plannedShots);
  const summary = summarizePlan(plannedShots, sharedArtifacts, issues);
  const videoWorkload = estimateExportVideoWorkload(project, plannedShots);

  return {
    schemaVersion: EXPORT_PLAN_SCHEMA_VERSION,
    projectId: project.id,
    projectName: project.name,
    packageType,
    packageFormat,
    requestedPackageFormat,
    profileId,
    archiveFileName: buildArchiveFileName(project, shots, rootFolders),
    shots: plannedShots,
    sharedArtifacts,
    issues,
    estimatedFileCount: summary.estimatedFileCount,
    estimatedWorkUnits: summary.estimatedWorkUnits,
    summary,
    videoWorkload,
  };
}

function estimateExportVideoWorkload(
  project: LocationProject,
  plannedShots: readonly PlannedShotExport[],
): ExportVideoWorkload {
  const performance = resolveProjectVideoPerformance(project.exportConfiguration);
  const videos: ExportVideoWorkload['videos'] = [];
  const motionKinds = new Set<PlannedArtifactKind>([
    'clay-camera-move',
    'projected-camera-move',
    'depth-camera-move',
    'character-motion',
  ]);

  for (const planned of plannedShots) {
    const shot = project.shots.find((item) => item.id === planned.shotId);
    if (!shot) continue;
    const hasMove = hasRenderableCameraMove(shot.cameraKeyframes);
    if (!hasMove) continue;
    const durationSeconds = getCameraMoveDurationSeconds(shot.cameraKeyframes);
    const frameCount = computeCameraMoveFrameCount(durationSeconds, performance.frameRate);
    const pixelFrames = computePixelFrameCount(
      frameCount,
      performance.width,
      performance.height,
    );

    for (const artifact of planned.artifacts) {
      if (artifact.disposition !== 'produce') continue;
      if (!motionKinds.has(artifact.kind)) continue;
      // One planned video per produced motion artifact (people variants expand files).
      const fileVideos = artifact.files.filter((file) => file.kind === 'video').length;
      const count = Math.max(1, fileVideos);
      for (let index = 0; index < count; index += 1) {
        videos.push({
          shotId: planned.shotId,
          kind: artifact.kind,
          appearance: artifact.appearance
            ?? (artifact.kind === 'projected-camera-move'
              ? 'projected'
              : artifact.kind === 'depth-camera-move'
                ? 'depth'
                : 'clay'),
          frameCount,
          pixelFrames,
        });
      }
    }
  }

  const totalFrames = videos.reduce((sum, video) => sum + video.frameCount, 0);
  const totalPixelFrames = videos.reduce((sum, video) => sum + video.pixelFrames, 0);

  return {
    videoCount: videos.length,
    totalFrames,
    totalPixelFrames,
    totalPixelFramesLabel: formatPixelFrameWorkload(totalPixelFrames),
    resolutionPreset: performance.resolutionPreset,
    frameRate: performance.frameRate,
    width: performance.width,
    height: performance.height,
    performanceProfileId: performance.profileId,
    encoderMode: performance.encoderMode,
    videos,
  };
}

export function listPlannedFiles(
  plan: ExportPlan,
  options: { includeOmitted?: boolean; manifestEntriesOnly?: boolean } = {},
): PlannedFile[] {
  const files: PlannedFile[] = [];
  for (const shot of plan.shots) {
    for (const artifact of shot.artifacts) {
      if (artifact.disposition === 'omit' && !options.includeOmitted) continue;
      for (const file of artifact.files) {
        if (options.manifestEntriesOnly && !file.manifestEntry) continue;
        files.push(file);
      }
    }
  }
  for (const artifact of plan.sharedArtifacts) {
    if (artifact.disposition === 'omit' && !options.includeOmitted) continue;
    for (const file of artifact.files) {
      if (options.manifestEntriesOnly && !file.manifestEntry) continue;
      files.push(file);
    }
  }
  return files;
}

export function getPlannedShot(plan: ExportPlan, shotId: string): PlannedShotExport | undefined {
  return plan.shots.find((shot) => shot.shotId === shotId);
}

export interface ShotPackageManifest {
  rootFolder: string;
  files: Array<{
    path: string;
    kind: PlannedFileKind;
    required: boolean;
  }>;
  /** Non-blocking asset recovery warnings carried into shot handoff metadata. */
  missingAssets?: ProjectOpenWarning[];
}

/** Legacy shot manifest view of a planned shot (excludes manifest.json itself). */
export function createLegacyShotManifest(shotPlan: PlannedShotExport): ShotPackageManifest {
  return {
    rootFolder: shotPlan.rootFolder,
    files: shotPlan.artifacts
      .filter((artifact) => artifact.disposition === 'produce')
      .flatMap((artifact) => artifact.files)
      .filter((file) => file.manifestEntry)
      .map(({ path, kind, required }) => ({ path, kind, required })),
  };
}

export function planHasBlockingErrors(plan: ExportPlan): boolean {
  return plan.issues.some((issue) => issue.severity === 'error');
}

/** Human-readable blocking messages for export failure UI / thrown errors. */
export function formatPlanBlockingErrors(plan: ExportPlan): string {
  return plan.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message)
    .join('\n');
}

export function getPlanIssuesForShot(plan: ExportPlan, shotId: string): ExportPlanIssue[] {
  return plan.issues.filter((issue) => issue.shotId === shotId);
}

export function countProducedArtifacts(
  plan: ExportPlan,
  kind: PlannedArtifactKind,
): number {
  return plan.summary.producedArtifactCounts[kind] ?? 0;
}
