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
import { getCameraMoveReferenceFrames, hasRenderableCameraMove } from './cameraKeyframes';
import { CAMERA_MOVE_CUBEMAP_FACES } from './cameraMoveCubemap';
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
import { DEFAULT_VIDEO_FRAME_RATE } from './videoPresets';
import { getExportSelectionWarnings, getShotWarnings } from './warnings';

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
  | 'shot-manifest';

export type PlannedArtifactDisposition = 'produce' | 'omit';

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
  hasOverrides: boolean;
  artifacts: PlannedArtifact[];
  workUnits: number;
  estimatedFileCount: number;
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

export interface ExportPlan {
  schemaVersion: typeof EXPORT_PLAN_SCHEMA_VERSION;
  projectId: string;
  projectName: string;
  packageType: ExportPackageType;
  /** Layout the writer will actually emit. */
  packageFormat: 'legacy-v1';
  requestedPackageFormat: ExportPackageFormat;
  profileId: ExportProfileId;
  archiveFileName: string;
  shots: PlannedShotExport[];
  /** Shared artifacts (empty for legacy-v1; reserved for forescene-v2). */
  sharedArtifacts: PlannedArtifact[];
  issues: ExportPlanIssue[];
  estimatedFileCount: number;
  estimatedWorkUnits: number;
  summary: ExportPlanSummary;
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
  extras: Partial<Pick<PlannedArtifact, 'variant' | 'appearance'>> & { suffix?: string } = {},
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
): { artifacts: PlannedArtifact[]; issues: ExportPlanIssue[] } {
  const artifacts: PlannedArtifact[] = [];
  const issues: ExportPlanIssue[] = [];

  const canonical = project.panoRefs.find((pano) => pano.isCanonical);
  const graybox = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
  const canonicalAsset = canonical ? project.assets.assets[canonical.imageAssetId] : undefined;
  const grayboxAsset = graybox ? project.assets.assets[graybox.imageAssetId] : undefined;
  const linkedPanoAsset = linkedPano ? project.assets.assets[linkedPano.imageAssetId] : undefined;
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
  const hasCubemapSource = Boolean(settings.includeFullPano && (canonical || linkedPano));

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
    if (linkedPano && shot.panoCrop) {
      artifacts.push(produceArtifact(
        shot.id,
        'pano-crop',
        [{ path: `${rootFolder}/inputs/pano_crop.png`, kind: 'image', required: true, manifestEntry: true }],
        1,
      ));
      if (!linkedPanoAsset) {
        issues.push({
          id: `${shot.id}-pano-crop-missing-asset`,
          code: 'pano-crop-missing-asset',
          severity: 'warning',
          message: 'Panorama crop is enabled, but the linked panorama asset is missing from the project registry.',
          shotId: shot.id,
        });
      }
    } else {
      artifacts.push(omitArtifact(shot.id, 'pano-crop', linkedPano ? 'missing-pano-crop' : 'missing-linked-pano'));
    }
  }

  if (settings.includeFullPano) {
    if (canonical) {
      artifacts.push(produceArtifact(
        shot.id,
        'global-reference',
        [{ path: `${rootFolder}/inputs/global_reference.png`, kind: 'image', required: true, manifestEntry: true }],
        1,
      ));
      if (!canonicalAsset) {
        issues.push({
          id: `${shot.id}-global-reference-missing-asset`,
          code: 'global-reference-missing-asset',
          severity: 'warning',
          message: 'Canonical panorama export is enabled, but its image asset is missing.',
          shotId: shot.id,
        });
      }
    }
    if (hasCubemapSource) {
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
      artifacts.push(omitArtifact(shot.id, 'cubemap', 'missing-full-pano-source'));
      if (!canonical) {
        artifacts.push(omitArtifact(shot.id, 'global-reference', 'missing-canonical-pano'));
      }
    }
  }

  if (settings.includeGrayboxPano) {
    if (graybox) {
      artifacts.push(produceArtifact(
        shot.id,
        'global-graybox',
        [{ path: `${rootFolder}/inputs/global_graybox.png`, kind: 'image', required: false, manifestEntry: true }],
        1,
      ));
      if (!grayboxAsset) {
        issues.push({
          id: `${shot.id}-graybox-missing-asset`,
          code: 'graybox-missing-asset',
          severity: 'warning',
          message: 'Graybox panorama export is enabled, but its image asset is missing.',
          shotId: shot.id,
        });
      }
    } else {
      artifacts.push(omitArtifact(shot.id, 'global-graybox', 'missing-graybox-pano'));
    }
  }

  if (settings.includeAiResultFrame) {
    if (aiResultAssetId) {
      artifacts.push(produceArtifact(
        shot.id,
        'ai-result-frame',
        [{ path: `${rootFolder}/outputs/ai_result_frame.png`, kind: 'image', required: false, manifestEntry: true }],
        1,
      ));
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
  if (characterPass.enabled) {
    const hasCharacters = shotHasVisibleCharactersForPass(project, shot, characterPass);
    if (!hasCharacters) {
      artifacts.push(omitArtifact(shot.id, 'character-still', 'no-visible-characters'));
      issues.push({
        id: `${shot.id}-character-pass-empty`,
        code: 'character-pass-empty',
        severity: 'warning',
        message: 'Character export is enabled, but this shot has no visible characters. Character outputs will be omitted.',
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

  return { artifacts, issues };
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

  if (requestedPackageFormat === 'forescene-v2') {
    issues.push({
      id: 'package-format-v2-unsupported',
      code: 'package-format-v2-unsupported',
      severity: 'info',
      message: 'ForeScene package v2 is configured but not implemented yet. This export will use the legacy v1 layout.',
    });
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
    const { artifacts, issues: shotIssues } = planShotArtifacts(
      project,
      planningShot,
      rootFolder,
      settingsForPlan,
    );

    for (const warning of getShotWarnings(project, planningShot)) {
      issues.push(warningToIssue(warning, shot.id));
    }
    issues.push(...shotIssues);

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
      hasOverrides: shotHasExportOverrides(shot),
      artifacts,
      workUnits: adjustedWorkUnits,
      estimatedFileCount,
    });
  }

  const rootFolders = plannedShots.map((shot) => shot.rootFolder);
  const summary = summarizePlan(plannedShots, issues);

  return {
    schemaVersion: EXPORT_PLAN_SCHEMA_VERSION,
    projectId: project.id,
    projectName: project.name,
    packageType,
    packageFormat: 'legacy-v1',
    requestedPackageFormat,
    profileId,
    archiveFileName: buildArchiveFileName(project, shots, rootFolders),
    shots: plannedShots,
    sharedArtifacts: [],
    issues,
    estimatedFileCount: summary.estimatedFileCount,
    estimatedWorkUnits: summary.estimatedWorkUnits,
    summary,
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

export function getPlanIssuesForShot(plan: ExportPlan, shotId: string): ExportPlanIssue[] {
  return plan.issues.filter((issue) => issue.shotId === shotId);
}

export function countProducedArtifacts(
  plan: ExportPlan,
  kind: PlannedArtifactKind,
): number {
  return plan.summary.producedArtifactCounts[kind] ?? 0;
}
