/**
 * forescene-v2 package writer.
 *
 * Shared panoramas/cubemaps are written once under `shared_references/panoramas/`
 * using the same `SharedExportMediaCache` render/cache path as legacy-v1, then each
 * shot's own generation/prompts/technical content is written under `shots/<folder>/`.
 * Every path comes from the precomputed `ExportPlan` (via `exportPaths.ts` helpers) —
 * this writer never invents ad-hoc strings. Per-shot paths are derived by remapping
 * the same legacy-style path strings the plan itself remaps in `finalizeShotArtifactsForV2`,
 * so the ZIP always matches `plan.shots[].artifacts[].files[].path` exactly.
 */

import JSZip from 'jszip';
import type { LocationProject, PanoReference, ProjectAsset, Shot } from '../domain/types';
import { normalizeCharacterPassExportSettings } from '../domain/defaults';
import { getCameraMoveReferenceFrames, hasRenderableCameraMove } from './cameraKeyframes';
import { CAMERA_MOVE_CUBEMAP_FACES, DEFAULT_CAMERA_MOVE_CUBEMAP_FACE_SIZE } from './cameraMoveCubemap';
import { buildShotMetadata } from './exportManifest';
import {
  buildForeSceneV2RootManifest,
  buildForeSceneV2ShotManifest,
  buildStartHereHtml,
} from './exportManifestV2';
import {
  createExportPlan,
  formatPlanBlockingErrors,
  getPlannedShot,
  listPlannedFiles,
  planHasBlockingErrors,
  sharedReferenceCacheKey,
  SHARED_REFERENCE_KINDS,
  type ExportPlan,
  type PlannedArtifact,
  type PlannedShotExport,
} from './exportPlan';
import {
  createSharedExportMediaCache,
  cubemapCacheKey,
  preparedPanoCacheKey,
  type SharedExportMediaCache,
} from './exportMediaCache';
import { getShotExportProgressLabel } from './exportNaming';
import { remapLegacyShotPathToV2, V2_ROOT_MANIFEST_PATH, V2_START_HERE_PATH } from './exportPaths';
import {
  addBlobToZip,
  addBlobToZipStore,
  addDataUrl,
  addProjectAssetToZip,
  compressZip,
  createProgressTracker,
  isPackageExportCancelled,
  normalizeCameraMoveProgress,
  runPackageTasksWithConcurrency,
  ShotPackageError,
  throwIfAborted,
  type PackageExportOptions,
  type PackageExportPhase,
  type ProgressTracker,
  type ShotPackageResult,
} from './packageExportCore';
import { generateImagePrompt, generateVideoPrompt } from './prompts';
import { preparePanoExportDataUrl } from './panoImage';
import { stitchCubemapFaceBlobsCrossAsync } from './cubemapStitch';
import { canUseProjectedAppearance } from './projectedStyle';
import {
  renderPanoCubemapFacesAsBlobs,
  renderPanoPerspectiveCrop,
  renderShotCharacterMotion,
} from './renderers';
import {
  cleanupTemporaryExportStill,
  ensureStillArtifactForExport,
} from './ensureStillArtifactForExport';
import { recordPreparedMediaMetric } from './preparedMediaMetrics';
import type { StillArtifactSpecification } from './stillArtifactTypes';
import { getPeopleRenderVariants, getPeopleVariantPath, peopleVariantLabel } from './peopleExport';
import type { PeopleRenderVariant } from './peopleExport';
import {
  buildCharacterPassMetadata,
  buildCharacterSequenceMeta,
  characterMotionMp4Path,
  characterPassIncludesGreenMp4,
  characterPassIncludesPngSequence,
  characterPassMetadataPath,
  characterSequenceDirPath,
  characterSequenceFrameFileName,
  characterStillPath,
} from './characterPassExport';
import { resolveProjectForShot } from './shotSceneState';
import {
  buildDepthMetadata,
  resolveShotDepthRangeForExport,
  resolveShotDepthSettings,
  shouldExportAnyDepth,
  shouldExportCameraMoveDepth,
  shouldExportDepthReferenceFrames,
  shouldExportViewportDepth,
} from './depthRender';
import { prepareVideoArtifact } from './prepareVideoArtifact';
import { renderWorkCoordinator } from './renderWorkCoordinator';
import {
  createEmptyPackageVideoPerformanceStats,
  resolveProjectVideoPerformance,
  type PackageVideoPerformanceStats,
  type ResolvedVideoPerformance,
} from './videoPerformance';

/**
 * Local mirror of `resolveClayCameraMovePackageSource` (packageExport.ts) — duplicated
 * here so this module never imports from `packageExport.ts` (which imports this module).
 */
function resolveClayCameraMoveSourceV2(
  shot: Shot,
  asset?: { uri?: string } | null,
): 'encode' | 'copy' | 'skip' {
  if (!shot.exportSettings.includeCameraMoveVideo) return 'skip';
  if (hasRenderableCameraMove(shot.cameraKeyframes)) return 'encode';
  if (asset?.uri) return 'copy';
  return 'skip';
}

async function prepareV2CameraMoveVideo(params: {
  project: LocationProject;
  shotId: string;
  appearance: 'clay' | 'projected' | 'depth';
  peopleVariant: PeopleRenderVariant;
  performance: ResolvedVideoPerformance;
  depthRange?: { nearMeters: number; farMeters: number };
  depthInvert?: boolean;
  signal?: AbortSignal;
  onProgress?: Parameters<typeof prepareVideoArtifact>[0]['onProgress'];
  stats?: PackageVideoPerformanceStats;
  contentMode?: Parameters<typeof prepareVideoArtifact>[0]['specification']['contentMode'];
  backgroundColor?: string;
  includeCharacterAttachments?: boolean;
  transparent?: boolean;
  onFrameRendered?: Parameters<typeof prepareVideoArtifact>[0]['onFrameRendered'];
}) {
  const startedAt = performance.now();
  const result = await renderWorkCoordinator.schedule(
    'foreground-export-video',
    () => prepareVideoArtifact({
      project: params.project,
      shotId: params.shotId,
      specification: {
        appearance: params.appearance,
        peopleVariant: params.peopleVariant,
        contentMode: params.contentMode,
        mode: 'render',
        resolutionPreset: params.performance.resolutionPreset,
        frameRate: params.performance.frameRate,
        encoderMode: params.performance.encoderMode,
        occlusionFilter: params.appearance === 'projected' ? 'fast' : undefined,
        depthRange: params.depthRange,
        depthInvert: params.depthInvert,
        backgroundColor: params.backgroundColor,
        includeCharacterAttachments: params.includeCharacterAttachments,
        transparent: params.transparent,
      },
      performance: params.performance,
      priority: 'foreground',
      signal: params.signal,
      onProgress: params.onProgress,
      onFrameRendered: params.onFrameRendered,
      stats: params.stats,
    }),
    {
      ownerId: params.shotId,
      jobId: `package-video:${params.shotId}:${params.appearance}:${params.peopleVariant}:${params.contentMode ?? 'full_scene'}`,
      signal: params.signal,
    },
  );
  recordPreparedMediaMetric('exportVideoWaitMs', Math.round(performance.now() - startedAt));
  if (result.cacheStatus === 'hit') recordPreparedMediaMetric('videoCacheHits');
  else if (result.cacheStatus === 'joined') recordPreparedMediaMetric('videoJobsJoined');
  return result;
}

interface SharedPanoSource {
  canonicalAsset?: ProjectAsset;
  canonicalPano?: PanoReference;
  grayboxAsset?: ProjectAsset;
  grayboxPano?: PanoReference;
  cubemapSource?: { pano: PanoReference; asset: ProjectAsset };
}

/** Re-derive which pano/asset a shared artifact renders from, by matching its plan cache key. */
function findSharedArtifactSource(
  project: LocationProject,
  shots: readonly Shot[],
  plan: ExportPlan,
  artifact: PlannedArtifact,
): SharedPanoSource | undefined {
  const cacheKey = artifact.id.startsWith('shared:') ? artifact.id.slice('shared:'.length) : artifact.id;
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));

  for (const shotPlan of plan.shots) {
    const shot = shotById.get(shotPlan.shotId);
    if (!shot) continue;
    const key = sharedReferenceCacheKey(project, shot, shotPlan.resolvedSettings, artifact.kind);
    if (key !== cacheKey) continue;

    const canonical = project.panoRefs.find((pano) => pano.isCanonical);
    const graybox = project.panoRefs.find((pano) => pano.type === 'graybox_render');
    const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
    const canonicalAsset = canonical ? project.assets.assets[canonical.imageAssetId] : undefined;
    const grayboxAsset = graybox ? project.assets.assets[graybox.imageAssetId] : undefined;
    const linkedAsset = linkedPano ? project.assets.assets[linkedPano.imageAssetId] : undefined;

    if (artifact.kind === 'global-reference' && canonical && canonicalAsset) {
      return { canonicalAsset, canonicalPano: canonical };
    }
    if (artifact.kind === 'global-graybox' && graybox && grayboxAsset) {
      return { grayboxAsset, grayboxPano: graybox };
    }
    if (artifact.kind === 'cubemap') {
      if (canonical && canonicalAsset) return { cubemapSource: { pano: canonical, asset: canonicalAsset } };
      if (linkedPano && linkedAsset) return { cubemapSource: { pano: linkedPano, asset: linkedAsset } };
    }
  }
  return undefined;
}

async function writeSharedPreparedPano(
  zip: JSZip,
  project: LocationProject,
  sharedMedia: SharedExportMediaCache,
  args: { asset: ProjectAsset; pano: PanoReference; path: string },
): Promise<void> {
  const panoKey = preparedPanoCacheKey(
    args.asset.id,
    args.pano.width,
    args.pano.height,
    project.settings.panoLetterboxExports169,
    project.settings.defaultShotWidth,
    project.settings.defaultShotHeight,
  );
  let exportUrl = sharedMedia.preparedPanos.get(panoKey);
  if (exportUrl === undefined) {
    let pending = sharedMedia.pendingPreparedPanos.get(panoKey);
    if (!pending) {
      pending = preparePanoExportDataUrl(
        args.asset.uri,
        args.pano.width,
        args.pano.height,
        {
          letterboxEnabled: project.settings.panoLetterboxExports169,
          targetWidth: project.settings.defaultShotWidth,
          targetHeight: project.settings.defaultShotHeight,
        },
      );
      sharedMedia.pendingPreparedPanos.set(panoKey, pending);
    }
    try {
      exportUrl = await pending;
      sharedMedia.preparedPanos.set(panoKey, exportUrl);
    } finally {
      if (sharedMedia.pendingPreparedPanos.get(panoKey) === pending) {
        sharedMedia.pendingPreparedPanos.delete(panoKey);
      }
    }
  }
  if (exportUrl === args.asset.uri) {
    await addProjectAssetToZip(zip, args.path, args.asset);
  } else {
    addDataUrl(zip, args.path, exportUrl);
  }
}

async function writeSharedArtifactsV2(
  zip: JSZip,
  project: LocationProject,
  shots: readonly Shot[],
  plan: ExportPlan,
  sharedMedia: SharedExportMediaCache,
  args: { tracker: ProgressTracker; signal?: AbortSignal },
): Promise<void> {
  const { tracker, signal } = args;

  for (const artifact of plan.sharedArtifacts) {
    if (artifact.disposition !== 'produce' || !SHARED_REFERENCE_KINDS.has(artifact.kind)) continue;
    throwIfAborted(signal);

    const source = findSharedArtifactSource(project, shots, plan, artifact);
    if (!source) {
      tracker.advance(artifact.workUnits);
      continue;
    }

    if (artifact.kind === 'global-reference' && source.canonicalAsset && source.canonicalPano) {
      const path = artifact.files[0]?.path;
      if (path) {
        tracker.report({
          phase: 'packaging',
          message: 'Preparing shared styled panorama…',
          shotIndex: 0,
          completedUnits: tracker.completedUnits,
          indeterminate: true,
        });
        await writeSharedPreparedPano(zip, project, sharedMedia, {
          asset: source.canonicalAsset,
          pano: source.canonicalPano,
          path,
        });
      }
      tracker.advance(artifact.workUnits);
      continue;
    }

    if (artifact.kind === 'global-graybox' && source.grayboxAsset && source.grayboxPano) {
      const path = artifact.files[0]?.path;
      if (path) {
        tracker.report({
          phase: 'packaging',
          message: 'Preparing shared graybox panorama…',
          shotIndex: 0,
          completedUnits: tracker.completedUnits,
          indeterminate: true,
        });
        await writeSharedPreparedPano(zip, project, sharedMedia, {
          asset: source.grayboxAsset,
          pano: source.grayboxPano,
          path,
        });
      }
      tracker.advance(artifact.workUnits);
      continue;
    }

    if (artifact.kind === 'cubemap' && source.cubemapSource) {
      const faceSize = DEFAULT_CAMERA_MOVE_CUBEMAP_FACE_SIZE;
      const cacheKey = cubemapCacheKey(source.cubemapSource.asset.id, source.cubemapSource.pano.rotation, faceSize);
      const faceFiles = artifact.files.filter((file) => !file.path.endsWith('cubemap_stitched.png'));
      const stitchedFile = artifact.files.find((file) => file.path.endsWith('cubemap_stitched.png'));
      let cached = sharedMedia.cubemaps.get(cacheKey);
      if (!cached) {
        tracker.report({
          phase: 'rendering',
          message: 'Rendering shared cubemap faces…',
          shotIndex: 0,
          completedUnits: tracker.completedUnits,
          indeterminate: true,
        });
        const cubemap = await renderPanoCubemapFacesAsBlobs(source.cubemapSource.asset.uri, {
          faceSize,
          panoRotation: source.cubemapSource.pano.rotation,
          onFaceRendered: async (face, rendered) => {
            throwIfAborted(signal);
            const facePath = faceFiles.find((file) => file.path.endsWith(`/${face}.png`))?.path;
            if (facePath) await addBlobToZip(zip, facePath, rendered.blob);
            tracker.advance(1);
          },
        });
        tracker.report({
          phase: 'packaging',
          message: 'Stitching shared cubemap…',
          shotIndex: 0,
          completedUnits: tracker.completedUnits,
          indeterminate: true,
        });
        const stitched = await stitchCubemapFaceBlobsCrossAsync(cubemap.faces, cubemap.faceSize);
        if (stitchedFile) await addBlobToZip(zip, stitchedFile.path, stitched.blob);
        tracker.advance(1);
        cached = { faceSize: cubemap.faceSize, faces: cubemap.faces, stitched: stitched.blob };
        sharedMedia.cubemaps.set(cacheKey, cached);
      } else {
        for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
          throwIfAborted(signal);
          const facePath = faceFiles.find((file) => file.path.endsWith(`/${face}.png`))?.path;
          if (facePath) await addBlobToZip(zip, facePath, cached.faces[face].blob);
        }
        if (stitchedFile) await addBlobToZip(zip, stitchedFile.path, cached.stitched);
        tracker.advance(artifact.workUnits);
      }
      continue;
    }

    tracker.advance(artifact.workUnits);
  }
}

async function appendShotPackageToZipV2(
  zip: JSZip,
  project: LocationProject,
  shot: Shot,
  shotPlan: PlannedShotExport,
  args: {
    shotIndex: number;
    tracker: ProgressTracker;
    signal?: AbortSignal;
    videoPerformanceStats?: PackageVideoPerformanceStats;
    getLiveProject?: PackageExportOptions['getLiveProject'];
    commitLiveProject?: PackageExportOptions['commitLiveProject'];
  },
): Promise<string[]> {
  const {
    shotIndex,
    tracker,
    signal,
    videoPerformanceStats,
    getLiveProject,
    commitLiveProject,
  } = args;
  const rootFolder = shotPlan.rootFolder;
  /** Remap a legacy-style `${rootFolder}/...` path (same strings the legacy writer uses) to its v2 archive path. */
  const v2 = (legacyPath: string) => remapLegacyShotPathToV2(rootFolder, legacyPath);

  let frozenProjectForPacking: LocationProject = project;
  const temporaryExportAssetIds: string[] = [];
  const shotProject = resolveProjectForShot(project, shot);
  const peopleMode = shot.exportSettings.peopleExportMode;
  const peopleVariants = getPeopleRenderVariants(peopleMode);
  const emit = (
    phase: PackageExportPhase,
    message: string,
    extras?: { unitFraction?: number; indeterminate?: boolean },
  ) => {
    tracker.report({
      phase,
      message,
      shotIndex,
      shot,
      completedUnits: tracker.completedUnits,
      unitFraction: extras?.unitFraction,
      indeterminate: extras?.indeterminate,
    });
  };
  const finishUnit = (phase: PackageExportPhase, message: string) => {
    tracker.advance(1);
    emit(phase, message);
  };
  const packageStill = async (
    specification: StillArtifactSpecification,
    zipPath: string,
    progressLabel: string,
  ) => {
    throwIfAborted(signal);
    emit('rendering', progressLabel, { indeterminate: true });
    const ensured = await ensureStillArtifactForExport({
      frozenProject: frozenProjectForPacking,
      shotId: shot.id,
      specification,
      signal,
      getLiveProject,
      commitLiveProject,
    });
    frozenProjectForPacking = ensured.frozenProject;
    if (ensured.temporaryAssetId) temporaryExportAssetIds.push(ensured.temporaryAssetId);
    await addBlobToZip(zip, zipPath, ensured.blob);
  };

  throwIfAborted(signal);
  emit('preparing', `Preparing ${getShotExportProgressLabel(shot)}…`, { indeterminate: true });

  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
  const linkedPanoAsset = linkedPano ? project.assets.assets[linkedPano.imageAssetId] : undefined;
  const aiResultAssetId = shot.assets.aiResultFrameAssetId ?? shot.assets.finalBaseFrameAssetId;
  const cameraMoveVideoAsset = shot.assets.cameraMoveVideoAssetId
    ? project.assets.assets[shot.assets.cameraMoveVideoAssetId]
    : undefined;

  if (shot.exportSettings.includeViewport) {
    for (const variant of peopleVariants) {
      try {
        await packageStill(
          {
            kind: 'clay-viewport',
            appearance: 'clay',
            peopleVariant: variant,
            width: shot.exportSettings.width,
            height: shot.exportSettings.height,
          },
          v2(getPeopleVariantPath(`${rootFolder}/inputs/viewport_clay.png`, variant, peopleMode)),
          `Packaging clay viewport (${peopleVariantLabel(variant)})…`,
        );
        finishUnit('rendering', `Clay viewport (${peopleVariantLabel(variant)}) ready`);
      } catch (error) {
        if (isPackageExportCancelled(error)) throw error;
        throw new ShotPackageError(
          error instanceof Error ? error.message : 'Clay viewport export failed.',
        );
      }
    }
  }

  if (shouldExportViewportDepth(shot.exportSettings.depth)) {
    for (const variant of peopleVariants) {
      try {
        await packageStill(
          {
            kind: 'depth-viewport',
            appearance: 'depth',
            peopleVariant: variant,
            width: shot.exportSettings.width,
            height: shot.exportSettings.height,
          },
          v2(getPeopleVariantPath(`${rootFolder}/inputs/viewport_depth.png`, variant, peopleMode)),
          `Packaging depth viewport (${peopleVariantLabel(variant)})…`,
        );
        finishUnit('rendering', `Depth viewport (${peopleVariantLabel(variant)}) ready`);
      } catch (error) {
        if (isPackageExportCancelled(error)) throw error;
        throw new ShotPackageError(
          error instanceof Error ? error.message : 'Depth viewport export failed.',
        );
      }
    }
  }

  if (shot.exportSettings.includeProjectedViewport && canUseProjectedAppearance(shotProject)) {
    for (const variant of peopleVariants) {
      try {
        await packageStill(
          {
            kind: 'projected-viewport',
            appearance: 'projected',
            peopleVariant: variant,
            width: shot.exportSettings.width,
            height: shot.exportSettings.height,
          },
          v2(getPeopleVariantPath(`${rootFolder}/inputs/viewport_projected.png`, variant, peopleMode)),
          `Packaging projected viewport (${peopleVariantLabel(variant)})…`,
        );
        finishUnit('rendering', `Projected viewport (${peopleVariantLabel(variant)}) ready`);
      } catch (error) {
        if (isPackageExportCancelled(error)) throw error;
        throw new ShotPackageError(
          error instanceof Error
            ? error.message
            : 'Projected viewport export failed. Import a styled panorama or disable projected export.',
        );
      }
    }
  }

  if (shot.exportSettings.includeAiResultFrame && aiResultAssetId) {
    throwIfAborted(signal);
    const aiResultAsset = project.assets.assets[aiResultAssetId];
    if (aiResultAsset) {
      emit('packaging', 'Adding AI result frame…');
      await addProjectAssetToZip(zip, v2(`${rootFolder}/outputs/ai_result_frame.png`), aiResultAsset);
      finishUnit('packaging', 'AI result frame added');
    }
  }

  const videoPerformance = resolveProjectVideoPerformance(project.exportConfiguration);

  if (shot.exportSettings.includeCameraMoveVideo) {
    const clayMotionSource = resolveClayCameraMoveSourceV2(shot, cameraMoveVideoAsset);
    if (clayMotionSource === 'encode') {
      for (const variant of peopleVariants) {
        throwIfAborted(signal);
        emit('encoding', `Encoding clay camera move (${peopleVariantLabel(variant)})…`, { indeterminate: true });
        try {
          const video = await prepareV2CameraMoveVideo({
            project,
            shotId: shot.id,
            appearance: 'clay',
            peopleVariant: variant,
            performance: videoPerformance,
            stats: videoPerformanceStats,
            signal,
            onProgress: (progress) => {
              const info = normalizeCameraMoveProgress(progress);
              emit('encoding', info.message || `Encoding clay camera move (${peopleVariantLabel(variant)})…`, {
                unitFraction: info.progress,
              });
            },
          });
          await addBlobToZipStore(
            zip,
            v2(getPeopleVariantPath(`${rootFolder}/inputs/viewport_clay_motion.mp4`, variant, peopleMode)),
            video.blob,
          );
          finishUnit(
            'encoding',
            video.cacheStatus === 'hit' || video.cacheStatus === 'joined'
              ? `Clay camera move (${peopleVariantLabel(variant)}) from cache`
              : `Clay camera move (${peopleVariantLabel(variant)}) ready`,
          );
        } catch (error) {
          if (isPackageExportCancelled(error)) throw error;
          throw new ShotPackageError(
            error instanceof Error
              ? error.message
              : 'Camera move MP4 export failed. Try Chrome or Edge, or disable Camera move MP4.',
          );
        }
      }
    } else if (
      clayMotionSource === 'copy'
      && cameraMoveVideoAsset?.uri
      && peopleVariants.includes('with_people')
    ) {
      throwIfAborted(signal);
      emit('packaging', 'Adding clay camera-move video…');
      await addProjectAssetToZip(
        zip,
        v2(getPeopleVariantPath(`${rootFolder}/inputs/viewport_clay_motion.mp4`, 'with_people', peopleMode)),
        cameraMoveVideoAsset,
      );
      finishUnit('packaging', 'Clay camera-move video added');
    }
  }

  if (
    shot.exportSettings.includeProjectedCameraMoveVideo
    && canUseProjectedAppearance(shotProject)
    && hasRenderableCameraMove(shot.cameraKeyframes)
  ) {
    for (const variant of peopleVariants) {
      throwIfAborted(signal);
      emit('encoding', `Encoding projected camera move (${peopleVariantLabel(variant)})…`, { indeterminate: true });
      try {
        const video = await prepareV2CameraMoveVideo({
          project,
          shotId: shot.id,
          appearance: 'projected',
          peopleVariant: variant,
          performance: videoPerformance,
          stats: videoPerformanceStats,
          signal,
          onProgress: (progress) => {
            const info = normalizeCameraMoveProgress(progress);
            emit('encoding', info.message || `Encoding projected camera move (${peopleVariantLabel(variant)})…`, {
              unitFraction: info.progress,
            });
          },
        });
        await addBlobToZipStore(
          zip,
          v2(getPeopleVariantPath(`${rootFolder}/inputs/viewport_projected_motion.mp4`, variant, peopleMode)),
          video.blob,
        );
        finishUnit(
          'encoding',
          video.cacheStatus === 'hit' || video.cacheStatus === 'joined'
            ? `Projected camera move (${peopleVariantLabel(variant)}) from cache`
            : `Projected camera move (${peopleVariantLabel(variant)}) ready`,
        );
      } catch (error) {
        if (isPackageExportCancelled(error)) throw error;
        throw new ShotPackageError(
          error instanceof Error
            ? error.message
            : 'Projected camera-move MP4 failed. Import a styled panorama or disable projected motion.',
        );
      }
    }
  }

  if (shouldExportCameraMoveDepth(shot.exportSettings.depth, hasRenderableCameraMove(shot.cameraKeyframes))) {
    const depthSettings = resolveShotDepthSettings(shot);
    const sharedRange = await resolveShotDepthRangeForExport(project, shot);
    for (const variant of peopleVariants) {
      throwIfAborted(signal);
      emit('encoding', `Encoding depth camera move (${peopleVariantLabel(variant)})…`, { indeterminate: true });
      try {
        const video = await prepareV2CameraMoveVideo({
          project,
          shotId: shot.id,
          appearance: 'depth',
          peopleVariant: variant,
          performance: videoPerformance,
          depthRange: sharedRange,
          depthInvert: depthSettings.invert === true,
          stats: videoPerformanceStats,
          signal,
          onProgress: (progress) => {
            const info = normalizeCameraMoveProgress(progress);
            emit('encoding', info.message || `Encoding depth camera move (${peopleVariantLabel(variant)})…`, {
              unitFraction: info.progress,
            });
          },
        });
        await addBlobToZipStore(
          zip,
          v2(getPeopleVariantPath(`${rootFolder}/inputs/viewport_depth_motion.mp4`, variant, peopleMode)),
          video.blob,
        );
        finishUnit(
          'encoding',
          video.cacheStatus === 'hit' || video.cacheStatus === 'joined'
            ? `Depth camera move (${peopleVariantLabel(variant)}) from cache`
            : `Depth camera move (${peopleVariantLabel(variant)}) ready`,
        );
      } catch (error) {
        if (isPackageExportCancelled(error)) throw error;
        throw new ShotPackageError(
          error instanceof Error
            ? error.message
            : 'Depth camera-move MP4 failed. Disable depth motion or try Chrome/Edge.',
        );
      }
    }
  }

  const frameRole = (id: 'start' | 'mid' | 'end'): 'start' | 'middle' | 'end' =>
    (id === 'start' ? 'start' : id === 'mid' ? 'middle' : 'end');

  const cameraMoveReferenceFrames = shot.exportSettings.includeCameraMoveReferenceFrames
    ? getCameraMoveReferenceFrames(shot.cameraKeyframes)
    : [];
  if (cameraMoveReferenceFrames.length > 0) {
    for (let index = 0; index < cameraMoveReferenceFrames.length; index += 1) {
      const frame = cameraMoveReferenceFrames[index];
      for (const variant of peopleVariants) {
        try {
          await packageStill(
            {
              kind: 'clay-reference-frame',
              appearance: 'clay',
              peopleVariant: variant,
              width: shot.exportSettings.width,
              height: shot.exportSettings.height,
              timeSeconds: frame.timeSeconds,
              frameRole: frameRole(frame.id),
            },
            v2(getPeopleVariantPath(`${rootFolder}/inputs/camera_move/clay_${frame.id}.png`, variant, peopleMode)),
            `Packaging clay reference frame ${index + 1} of ${cameraMoveReferenceFrames.length} (${peopleVariantLabel(variant)})…`,
          );
          finishUnit(
            'rendering',
            `Clay reference frame ${index + 1} of ${cameraMoveReferenceFrames.length} (${peopleVariantLabel(variant)}) ready`,
          );
        } catch (error) {
          if (isPackageExportCancelled(error)) throw error;
          throw new ShotPackageError(
            error instanceof Error ? error.message : 'Clay reference frame export failed.',
          );
        }
      }
    }
  }

  const projectedMoveFrames = (
    shot.exportSettings.includeProjectedCameraMoveReferenceFrames
    && canUseProjectedAppearance(shotProject)
  )
    ? getCameraMoveReferenceFrames(shot.cameraKeyframes)
    : [];
  if (projectedMoveFrames.length > 0) {
    for (let index = 0; index < projectedMoveFrames.length; index += 1) {
      const frame = projectedMoveFrames[index];
      for (const variant of peopleVariants) {
        try {
          await packageStill(
            {
              kind: 'projected-reference-frame',
              appearance: 'projected',
              peopleVariant: variant,
              width: shot.exportSettings.width,
              height: shot.exportSettings.height,
              timeSeconds: frame.timeSeconds,
              frameRole: frameRole(frame.id),
            },
            v2(getPeopleVariantPath(`${rootFolder}/inputs/camera_move/projected_${frame.id}.png`, variant, peopleMode)),
            `Packaging projected reference frame ${index + 1} of ${projectedMoveFrames.length} (${peopleVariantLabel(variant)})…`,
          );
          finishUnit(
            'rendering',
            `Projected reference frame ${index + 1} of ${projectedMoveFrames.length} (${peopleVariantLabel(variant)}) ready`,
          );
        } catch (error) {
          if (isPackageExportCancelled(error)) throw error;
          throw new ShotPackageError(
            error instanceof Error
              ? error.message
              : 'Projected camera-move frames failed. Disable projected move frames or import a styled panorama.',
          );
        }
      }
    }
  }

  const depthMoveFrames = shouldExportDepthReferenceFrames(shot.exportSettings.depth, true)
    ? getCameraMoveReferenceFrames(shot.cameraKeyframes)
    : [];
  if (depthMoveFrames.length > 0) {
    for (let index = 0; index < depthMoveFrames.length; index += 1) {
      const frame = depthMoveFrames[index];
      for (const variant of peopleVariants) {
        try {
          await packageStill(
            {
              kind: 'depth-reference-frame',
              appearance: 'depth',
              peopleVariant: variant,
              width: shot.exportSettings.width,
              height: shot.exportSettings.height,
              timeSeconds: frame.timeSeconds,
              frameRole: frameRole(frame.id),
            },
            v2(getPeopleVariantPath(`${rootFolder}/inputs/camera_move/depth_${frame.id}.png`, variant, peopleMode)),
            `Packaging depth reference frame ${index + 1} of ${depthMoveFrames.length} (${peopleVariantLabel(variant)})…`,
          );
          finishUnit(
            'rendering',
            `Depth reference frame ${index + 1} of ${depthMoveFrames.length} (${peopleVariantLabel(variant)}) ready`,
          );
        } catch (error) {
          if (isPackageExportCancelled(error)) throw error;
          throw new ShotPackageError(
            error instanceof Error ? error.message : 'Depth reference frame export failed.',
          );
        }
      }
    }
  }

  if (shot.exportSettings.includePanoCrop && linkedPano && shot.panoCrop && linkedPanoAsset) {
    throwIfAborted(signal);
    emit('rendering', 'Rendering pano crop…', { indeterminate: true });
    const crop = await renderPanoPerspectiveCrop(linkedPanoAsset.uri, shot.panoCrop, linkedPano.rotation);
    addDataUrl(zip, v2(`${rootFolder}/inputs/pano_crop.png`), crop.dataUrl);
    finishUnit('rendering', 'Pano crop ready');
  }

  const characterPass = normalizeCharacterPassExportSettings(shot.exportSettings.characterPass);
  if (characterPass.enabled) {
    const canProjectCharacters = canUseProjectedAppearance(shotProject);
    const hasVisibleCharacters = shotPlan.hasVisibleCharacters ?? false;

    if (characterPass.includeStill) {
      const stillAppearances: Array<'clay' | 'projected'> = ['clay'];
      if (shot.exportSettings.includeProjectedViewport && canProjectCharacters) {
        stillAppearances.push('projected');
      }
      for (const appearance of stillAppearances) {
        try {
          await packageStill(
            {
              kind: 'character-still',
              appearance,
              contentMode: 'characters_only',
              includeCharacterAttachments: characterPass.includeAttachedProps,
              width: shot.exportSettings.width,
              height: shot.exportSettings.height,
              backgroundColor: characterPass.backgroundColor,
            },
            v2(characterStillPath(rootFolder, appearance)),
            `Packaging transparent character still (${appearance})…`,
          );
          finishUnit('rendering', `Character still (${appearance}) ready`);
        } catch (error) {
          if (isPackageExportCancelled(error)) throw error;
          throw new ShotPackageError(
            error instanceof Error ? error.message : `Character still (${appearance}) failed.`,
          );
        }
      }
    }

    if (
      characterPass.includeMotion
      && hasVisibleCharacters
      && hasRenderableCameraMove(shot.cameraKeyframes)
    ) {
      const motionAppearances: Array<'clay' | 'projected'> = ['clay'];
      if (shot.exportSettings.includeProjectedCameraMoveVideo && canProjectCharacters) {
        motionAppearances.push('projected');
      }
      for (const appearance of motionAppearances) {
        const wantsMp4 = characterPassIncludesGreenMp4(characterPass.motionFormat);
        const wantsPng = characterPassIncludesPngSequence(characterPass.motionFormat);
        const sequenceDir = v2(characterSequenceDirPath(rootFolder, appearance));

        throwIfAborted(signal);
        emit(
          'encoding',
          wantsMp4 && wantsPng
            ? `Encoding character motion (${appearance})…`
            : wantsMp4
              ? `Encoding character green-screen MP4 (${appearance})…`
              : `Rendering transparent character sequence (${appearance})…`,
          { indeterminate: true },
        );

        try {
          const motion = await renderShotCharacterMotion(project, shot, {
            appearance,
            motionFormat: characterPass.motionFormat,
            backgroundColor: characterPass.backgroundColor,
            includeAttachedProps: characterPass.includeAttachedProps,
            frameRate: videoPerformance.frameRate,
            resolutionPreset: videoPerformance.resolutionPreset,
            encoderMode: videoPerformance.encoderMode,
            signal,
            onProgress: (progress) => {
              const info = normalizeCameraMoveProgress(progress);
              const label = wantsPng && !wantsMp4
                ? `Rendering transparent character frame ${info.completedFrames ?? 0} of ${info.totalFrames ?? '?'}`
                : info.message || `Encoding character motion (${appearance})…`;
              emit('encoding', label, { unitFraction: info.progress });
            },
            onPngFrame: wantsPng
              ? async (frameIndex, blob) => {
                const framePath = `${sequenceDir}/${characterSequenceFrameFileName(frameIndex + 1)}`;
                await addBlobToZipStore(zip, framePath, blob);
              }
              : undefined,
          });

          if (wantsPng) {
            zip.file(
              `${sequenceDir}/sequence.json`,
              JSON.stringify(
                buildCharacterSequenceMeta({
                  width: motion.width,
                  height: motion.height,
                  frameRate: motion.frameRate,
                  frameCount: motion.frameCount,
                  durationSeconds: motion.durationSeconds,
                }),
                null,
                2,
              ),
            );
            finishUnit('encoding', `Character PNG sequence (${appearance}) ready`);
          }

          if (wantsMp4 && motion.mp4) {
            await addBlobToZipStore(zip, v2(characterMotionMp4Path(rootFolder, appearance)), motion.mp4.blob);
            finishUnit('encoding', `Character green-screen MP4 (${appearance}) ready`);
          } else if (wantsMp4) {
            finishUnit('encoding', `Character MP4 (${appearance}) skipped`);
          }
        } catch (error) {
          if (isPackageExportCancelled(error)) throw error;
          throw new ShotPackageError(
            error instanceof Error ? error.message : `Character motion (${appearance}) failed.`,
          );
        }
      }
    }

    if (shot.exportSettings.includeMetadata && hasVisibleCharacters) {
      throwIfAborted(signal);
      emit('packaging', 'Writing character pass metadata…');
      zip.file(
        v2(characterPassMetadataPath(rootFolder)),
        JSON.stringify(buildCharacterPassMetadata(project, shot, characterPass), null, 2),
      );
      finishUnit('packaging', 'Character pass metadata written');
    }
  }

  if (shot.exportSettings.includeMetadata) {
    throwIfAborted(signal);
    emit('packaging', 'Writing metadata…');
    const metadata = buildShotMetadata(shotProject, shot, linkedPano);
    zip.file(v2(`${rootFolder}/metadata/shot.json`), JSON.stringify(shot, null, 2));
    zip.file(v2(`${rootFolder}/metadata/camera.json`), JSON.stringify(shot.camera, null, 2));
    if (shot.cameraKeyframes.length > 0) {
      zip.file(v2(`${rootFolder}/metadata/camera_keyframes.json`), JSON.stringify(shot.cameraKeyframes, null, 2));
    }
    const referenceFrameMeta = cameraMoveReferenceFrames.length > 0
      ? cameraMoveReferenceFrames
      : depthMoveFrames.length > 0
        ? depthMoveFrames
        : projectedMoveFrames;
    if (referenceFrameMeta.length > 0) {
      zip.file(v2(`${rootFolder}/metadata/camera_move_reference_frames.json`), JSON.stringify(referenceFrameMeta, null, 2));
    }
    if (shouldExportAnyDepth(shot.exportSettings.depth, {
      hasReferenceFrames: depthMoveFrames.length > 0,
      hasRenderableMove: hasRenderableCameraMove(shot.cameraKeyframes),
    })) {
      const depthSettings = resolveShotDepthSettings(shot);
      const sharedRange = await resolveShotDepthRangeForExport(project, shot);
      zip.file(
        v2(`${rootFolder}/metadata/depth.json`),
        JSON.stringify(
          buildDepthMetadata(
            depthSettings,
            sharedRange,
            shouldExportCameraMoveDepth(depthSettings, hasRenderableCameraMove(shot.cameraKeyframes))
              ? { frameRate: 30 }
              : {},
          ),
          null,
          2,
        ),
      );
    }
    zip.file(v2(`${rootFolder}/metadata/landmarks.json`), JSON.stringify(metadata.landmarks, null, 2));
    zip.file(v2(`${rootFolder}/metadata/location.json`), JSON.stringify(metadata.project, null, 2));
    finishUnit('packaging', 'Metadata written');
  }

  if (shot.exportSettings.includePrompt) {
    throwIfAborted(signal);
    emit('packaging', 'Writing prompts…');
    zip.file(v2(`${rootFolder}/prompts/image_gen_prompt.txt`), generateImagePrompt(shotProject, shot));
    zip.file(v2(`${rootFolder}/prompts/video_gen_prompt.txt`), generateVideoPrompt(shot));
    zip.file(v2(`${rootFolder}/prompts/negative_prompt.txt`), shot.promptOverrides.negativePrompt || '');
    finishUnit('packaging', 'Prompts written');
  }

  throwIfAborted(signal);
  emit('packaging', 'Writing manifest…');
  const shotManifest = buildForeSceneV2ShotManifest(shotPlan, shot);
  zip.file(v2(`${rootFolder}/manifest.json`), JSON.stringify(shotManifest, null, 2));
  finishUnit('packaging', `${getShotExportProgressLabel(shot)} packaged`);

  for (const temporaryId of temporaryExportAssetIds) {
    await cleanupTemporaryExportStill(project.id, temporaryId);
  }

  return shotManifest.files.map((file) => file.path);
}

function writeRootManifestAndStartHere(
  zip: JSZip,
  plan: ExportPlan,
  project: LocationProject,
  shots: readonly Shot[],
  tracker: ProgressTracker,
): void {
  const rootManifest = buildForeSceneV2RootManifest(plan, project, shots);
  zip.file(V2_ROOT_MANIFEST_PATH, JSON.stringify(rootManifest, null, 2));
  tracker.advance(1);

  const startHere = buildStartHereHtml(plan, project, shots);
  zip.file(V2_START_HERE_PATH, startHere);
  tracker.advance(1);
}

export async function buildForeSceneV2Package(
  project: LocationProject,
  shots: Shot[],
  options: PackageExportOptions = {},
): Promise<ShotPackageResult> {
  if (shots.length === 0) {
    throw new ShotPackageError('Select at least one shot before exporting.');
  }

  throwIfAborted(options.signal);
  const plan = options.plan ?? createExportPlan(project, shots, {
    packageType: shots.length === 1 ? 'current-shot' : 'selected-shots',
  });
  if (planHasBlockingErrors(plan)) {
    throw new ShotPackageError(formatPlanBlockingErrors(plan) || 'Export blocked by preflight errors.');
  }
  if (plan.packageFormat !== 'forescene-v2') {
    throw new ShotPackageError(
      `ForeScene v2 writer received a ${plan.packageFormat} export plan.`,
    );
  }

  const totalUnits = plan.estimatedWorkUnits + 1; // + compress
  const tracker = createProgressTracker({ shots, totalUnits, onProgress: options.onProgress });

  tracker.report({
    phase: 'preparing',
    message: 'Preparing ForeScene v2 package…',
    shotIndex: 0,
    shot: shots[0],
    completedUnits: 0,
    indeterminate: true,
  });

  const zip = new JSZip();
  const sharedMedia = createSharedExportMediaCache();
  const videoPerformanceStats = options.videoPerformanceStats
    ?? createEmptyPackageVideoPerformanceStats();

  await writeSharedArtifactsV2(zip, project, shots, plan, sharedMedia, { tracker, signal: options.signal });

  await runPackageTasksWithConcurrency(
    shots,
    options.packageConcurrency ?? 2,
    async (shot, shotIndex) => {
      throwIfAborted(options.signal);
      const shotPlan = getPlannedShot(plan, shot.id);
      if (!shotPlan) return;
      await appendShotPackageToZipV2(zip, project, shot, shotPlan, {
        shotIndex,
        tracker,
        signal: options.signal,
        videoPerformanceStats,
        getLiveProject: options.getLiveProject,
        commitLiveProject: options.commitLiveProject,
      });
    },
  );

  throwIfAborted(options.signal);
  writeRootManifestAndStartHere(zip, plan, project, shots, tracker);

  const blob = await compressZip(zip, {
    tracker,
    shotIndex: shots.length - 1,
    shot: shots[shots.length - 1],
    signal: options.signal,
  });

  tracker.report({
    phase: 'complete',
    message: 'Package ready',
    shotIndex: shots.length - 1,
    shot: shots[shots.length - 1],
    completedUnits: tracker.totalUnits,
  });

  return {
    blob,
    fileName: plan.archiveFileName,
    manifestPaths: listPlannedFiles(plan).map((file) => file.path),
    videoPerformance: { ...videoPerformanceStats },
  };
}
