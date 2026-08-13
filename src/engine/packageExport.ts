import JSZip from 'jszip';
import { LocationProject, PanoReference, ProjectAsset, Shot } from '../domain/types';
import { normalizeCharacterPassExportSettings } from '../domain/defaults';
import { getCameraMoveReferenceFrames, hasRenderableCameraMove } from './cameraKeyframes';
import {
  CAMERA_MOVE_CUBEMAP_FACES,
  DEFAULT_CAMERA_MOVE_CUBEMAP_FACE_SIZE,
} from './cameraMoveCubemap';
import { buildShotMetadata, createShotPackageManifest } from './exportManifest';
import {
  createExportPlan,
  formatPlanBlockingErrors,
  getPlannedShot,
  planHasBlockingErrors,
} from './exportPlan';
import {
  createSharedExportMediaCache,
  cubemapCacheKey,
  preparedPanoCacheKey,
  type SharedExportMediaCache,
} from './exportMediaCache';
import {
  addBinaryToZip,
  addBlobToZip,
  addBlobToZipStore,
  addDataUrl,
  addProjectAssetToZip,
  compressZip,
  createProgressTracker,
  isPackageExportCancelled,
  normalizeCameraMoveProgress,
  resolvePackageConcurrency,
  runPackageTasksWithConcurrency,
  ShotPackageError,
  throwIfAborted,
  type PackageExportOptions,
  type PackageExportPhase,
  type PackageExportProgress,
  type ProgressTracker,
  type ShotPackageResult,
} from './packageExportCore';
import { buildForeSceneV2Package } from './packageExportV2';
import { getShotExportProgressLabel, getShotPackageBaseName } from './exportNaming';
import { generateImagePrompt, generateVideoPrompt } from './prompts';
import { preparePanoExportDataUrl } from './panoImage';
import { stitchCubemapFaceBlobsCrossAsync } from './cubemapStitch';
import { downloadBlob } from './fileTransfers';
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
import {
  getPeopleRenderVariants,
  getPeopleVariantPath,
  peopleVariantLabel,
  type PeopleRenderVariant,
} from './peopleExport';
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
  shotHasVisibleCharactersForPass,
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
} from './videoPerformance';

export { downloadBlob };
export {
  createSharedExportMediaCache,
  cubemapCacheKey,
  preparedPanoCacheKey,
  type SharedExportMediaCache,
};
export {
  isPackageExportCancelled,
  ShotPackageError,
  type PackageExportPhase,
  type PackageExportProgress,
};
export { buildForeSceneV2Package };
export { type PackageExportOptions, type ShotPackageResult };

/**
 * Resolve-safe packages always re-encode clay motion when keyframes exist.
 * Stored assets are only copied when rerendering is impossible (no keyframes).
 */
export type ClayCameraMovePackageSource = 'encode' | 'copy' | 'skip';

export function resolveClayCameraMovePackageSource(
  shot: Shot,
  asset?: { uri?: string } | null,
): ClayCameraMovePackageSource {
  if (!shot.exportSettings.includeCameraMoveVideo) return 'skip';
  if (hasRenderableCameraMove(shot.cameraKeyframes)) return 'encode';
  if (asset?.uri) return 'copy';
  return 'skip';
}

/** Package-path camera-move encode via the shared prepareVideoArtifact entry point. */
export async function preparePackageCameraMoveVideo(params: {
  project: LocationProject;
  shotId: string;
  appearance: 'clay' | 'projected' | 'depth';
  peopleVariant: PeopleRenderVariant;
  performance: ReturnType<typeof resolveProjectVideoPerformance>;
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

/** Discrete work units for one shot — used to weight multi-shot progress. */
export function countShotPackageUnits(project: LocationProject, shot: Shot): number {
  const plan = createExportPlan(project, [shot], { packageType: 'current-shot' });
  return Math.max(1, plan.estimatedWorkUnits);
}

export async function buildShotPackage(
  project: LocationProject,
  shot?: Shot,
  options: PackageExportOptions = {},
): Promise<ShotPackageResult> {
  if (!shot) {
    throw new ShotPackageError('Select a shot before exporting a package.');
  }

  throwIfAborted(options.signal);
  const plan = options.plan ?? createExportPlan(project, [shot], { packageType: 'current-shot' });
  if (planHasBlockingErrors(plan)) {
    throw new ShotPackageError(formatPlanBlockingErrors(plan) || 'Export blocked by preflight errors.');
  }
  if (plan.packageFormat === 'forescene-v2') {
    return buildForeSceneV2Package(project, [shot], { ...options, plan });
  }
  return buildLegacyShotPackage(project, shot, { ...options, plan });
}

/** Legacy-v1 single-shot writer (`rootFolder/inputs/...`, `metadata/`, etc). */
export async function buildLegacyShotPackage(
  project: LocationProject,
  shot: Shot,
  options: PackageExportOptions = {},
): Promise<ShotPackageResult> {
  throwIfAborted(options.signal);
  const plan = options.plan ?? createExportPlan(project, [shot], { packageType: 'current-shot' });
  if (planHasBlockingErrors(plan)) {
    throw new ShotPackageError(formatPlanBlockingErrors(plan) || 'Export blocked by preflight errors.');
  }
  if (plan.packageFormat !== 'legacy-v1') {
    throw new ShotPackageError(
      `Legacy v1 writer received a ${plan.packageFormat} export plan.`,
    );
  }
  const shotPlan = getPlannedShot(plan, shot.id);
  const totalUnits = plan.estimatedWorkUnits + 1; // + compress
  const tracker = createProgressTracker({
    shots: [shot],
    totalUnits,
    onProgress: options.onProgress,
  });

  tracker.report({
    phase: 'preparing',
    message: 'Preparing package…',
    shotIndex: 0,
    shot,
    completedUnits: tracker.completedUnits,
    indeterminate: true,
  });

  const zip = new JSZip();
  const sharedMedia = createSharedExportMediaCache();
  const videoPerformanceStats = options.videoPerformanceStats
    ?? createEmptyPackageVideoPerformanceStats();
  const rootFolder = shotPlan?.rootFolder ?? getShotPackageBaseName(shot);
  const manifestPaths = await appendShotPackageToZip(zip, project, shot, {
    shotIndex: 0,
    tracker,
    signal: options.signal,
    rootFolder,
    sharedMedia,
    videoPerformanceStats,
    getLiveProject: options.getLiveProject,
    commitLiveProject: options.commitLiveProject,
  });
  const blob = await compressZip(zip, {
    tracker,
    shotIndex: 0,
    shot,
    signal: options.signal,
  });

  tracker.report({
    phase: 'complete',
    message: 'Package ready',
    shotIndex: 0,
    shot,
    completedUnits: tracker.totalUnits,
  });

  return {
    blob,
    fileName: plan.archiveFileName || `${rootFolder}_package.zip`,
    manifestPaths,
    videoPerformance: { ...videoPerformanceStats },
  };
}

/**
 * Single download for multiple shots — one outer ZIP with each shot folder inside.
 * Avoids browser multi-download blocking that hits sequential per-shot downloads.
 */
export async function buildMultiShotPackage(
  project: LocationProject,
  shots: Shot[],
  options: PackageExportOptions = {},
): Promise<ShotPackageResult> {
  if (shots.length === 0) {
    throw new ShotPackageError('Select at least one shot before exporting.');
  }
  if (shots.length === 1) {
    return buildShotPackage(project, shots[0], options);
  }

  throwIfAborted(options.signal);
  const plan = options.plan ?? createExportPlan(project, shots, { packageType: 'selected-shots' });
  if (planHasBlockingErrors(plan)) {
    throw new ShotPackageError(formatPlanBlockingErrors(plan) || 'Export blocked by preflight errors.');
  }
  if (plan.packageFormat === 'forescene-v2') {
    return buildForeSceneV2Package(project, shots, { ...options, plan });
  }
  return buildLegacyMultiShotPackage(project, shots, { ...options, plan });
}

/** Legacy-v1 multi-shot writer: one outer ZIP with each shot folder inside. */
export async function buildLegacyMultiShotPackage(
  project: LocationProject,
  shots: Shot[],
  options: PackageExportOptions = {},
): Promise<ShotPackageResult> {
  throwIfAborted(options.signal);
  const plan = options.plan ?? createExportPlan(project, shots, { packageType: 'selected-shots' });
  if (planHasBlockingErrors(plan)) {
    throw new ShotPackageError(formatPlanBlockingErrors(plan) || 'Export blocked by preflight errors.');
  }
  if (plan.packageFormat !== 'legacy-v1') {
    throw new ShotPackageError(
      `Legacy v1 writer received a ${plan.packageFormat} export plan.`,
    );
  }
  const shotUnits = plan.estimatedWorkUnits;
  const tracker = createProgressTracker({
    shots,
    totalUnits: shotUnits + 1,
    onProgress: options.onProgress,
  });

  tracker.report({
    phase: 'preparing',
    message: 'Preparing multi-shot package…',
    shotIndex: 0,
    shot: shots[0],
    completedUnits: 0,
    indeterminate: true,
  });

  const zip = new JSZip();
  const sharedMedia = createSharedExportMediaCache();
  const videoPerformanceStats = options.videoPerformanceStats
    ?? createEmptyPackageVideoPerformanceStats();
  const manifestPaths: string[] = [];
  const folderByShotId = new Map(
    plan.shots.map((shotPlan) => [shotPlan.shotId, shotPlan.rootFolder]),
  );
  const shotPaths = await runPackageTasksWithConcurrency(
    shots,
    resolvePackageConcurrency(options.packageConcurrency),
    async (shot, shotIndex) => {
      throwIfAborted(options.signal);
      return appendShotPackageToZip(zip, project, shot, {
        shotIndex,
        tracker,
        signal: options.signal,
        rootFolder: folderByShotId.get(shot.id),
        sharedMedia,
        videoPerformanceStats,
        getLiveProject: options.getLiveProject,
        commitLiveProject: options.commitLiveProject,
      });
    },
  );
  for (const paths of shotPaths) manifestPaths.push(...paths);

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
    manifestPaths,
    videoPerformance: { ...videoPerformanceStats },
  };
}

async function appendShotPackageToZip(
  zip: JSZip,
  project: LocationProject,
  shot: Shot,
  args: {
    shotIndex: number;
    tracker: ProgressTracker;
    signal?: AbortSignal;
    rootFolder?: string;
    sharedMedia: SharedExportMediaCache;
    videoPerformanceStats?: PackageVideoPerformanceStats;
    getLiveProject?: PackageExportOptions['getLiveProject'];
    commitLiveProject?: PackageExportOptions['commitLiveProject'];
  },
): Promise<string[]> {
  const {
    shotIndex,
    tracker,
    signal,
    rootFolder,
    sharedMedia,
    videoPerformanceStats,
    getLiveProject,
    commitLiveProject,
  } = args;
  let frozenProjectForPacking: LocationProject = project;
  const temporaryExportAssetIds: string[] = [];
  try {
  return await appendShotPackageToZipBody();
  } finally {
    for (const temporaryId of temporaryExportAssetIds) {
      await cleanupTemporaryExportStill(project.id, temporaryId);
    }
  }

  async function appendShotPackageToZipBody(): Promise<string[]> {
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
  const prepareSharedPano = async (
    asset: ProjectAsset,
    pano: PanoReference,
  ): Promise<{ exportUrl: string; produced: boolean }> => {
    const panoKey = preparedPanoCacheKey(
      asset.id,
      pano.width,
      pano.height,
      project.settings.panoLetterboxExports169,
      project.settings.defaultShotWidth,
      project.settings.defaultShotHeight,
    );
    const cached = sharedMedia.preparedPanos.get(panoKey);
    if (cached !== undefined) return { exportUrl: cached, produced: false };

    let pending = sharedMedia.pendingPreparedPanos.get(panoKey);
    let produced = false;
    if (!pending) {
      produced = true;
      pending = preparePanoExportDataUrl(
        asset.uri,
        pano.width,
        pano.height,
        {
          letterboxEnabled: project.settings.panoLetterboxExports169,
          targetWidth: project.settings.defaultShotWidth,
          targetHeight: project.settings.defaultShotHeight,
        },
      );
      sharedMedia.pendingPreparedPanos.set(panoKey, pending);
    }
    try {
      const exportUrl = await pending;
      sharedMedia.preparedPanos.set(panoKey, exportUrl);
      return { exportUrl, produced };
    } finally {
      if (sharedMedia.pendingPreparedPanos.get(panoKey) === pending) {
        sharedMedia.pendingPreparedPanos.delete(panoKey);
      }
    }
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
      liveProject: getLiveProject?.(),
      getLiveProject,
      commitLiveProject,
      shotId: shot.id,
      specification,
      signal,
    });
    frozenProjectForPacking = ensured.frozenProject;
    if (ensured.temporaryAssetId) temporaryExportAssetIds.push(ensured.temporaryAssetId);
    await addBlobToZip(zip, zipPath, ensured.blob);
  };

  throwIfAborted(signal);
  emit('preparing', `Preparing ${getShotExportProgressLabel(shot)}…`, { indeterminate: true });

  const manifestPreview = createShotPackageManifest(shotProject, shot, rootFolder);
  const resolvedRootFolder = manifestPreview.rootFolder;
  const linkedPano = project.panoRefs.find((pano) => pano.id === shot.linkedPanoId);
  const canonicalPano = project.panoRefs.find((pano) => pano.isCanonical);
  const grayboxPano = project.panoRefs.find((pano) => pano.type === 'graybox_render');
  const canonicalAsset = canonicalPano ? project.assets.assets[canonicalPano.imageAssetId] : undefined;
  const grayboxAsset = grayboxPano ? project.assets.assets[grayboxPano.imageAssetId] : undefined;
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
          getPeopleVariantPath(`${resolvedRootFolder}/inputs/viewport_clay.png`, variant, peopleMode),
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
          getPeopleVariantPath(`${resolvedRootFolder}/inputs/viewport_depth.png`, variant, peopleMode),
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

  // Dual clay + projected when requested and a styled projector exists.
  // Soft-skip projected when no eligible pano so clay-only packages still succeed.
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
          getPeopleVariantPath(`${resolvedRootFolder}/inputs/viewport_projected.png`, variant, peopleMode),
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
      await addProjectAssetToZip(zip, `${resolvedRootFolder}/outputs/ai_result_frame.png`, aiResultAsset);
      finishUnit('packaging', 'AI result frame added');
    }
  }

  const videoPerformance = resolveProjectVideoPerformance(project.exportConfiguration);

  if (shot.exportSettings.includeCameraMoveVideo) {
    const clayMotionSource = resolveClayCameraMovePackageSource(shot, cameraMoveVideoAsset);
    if (clayMotionSource === 'encode') {
      for (const variant of peopleVariants) {
        throwIfAborted(signal);
        emit('encoding', `Encoding clay camera move (${peopleVariantLabel(variant)})…`, { indeterminate: true });
        try {
          const video = await preparePackageCameraMoveVideo({
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
            getPeopleVariantPath(`${resolvedRootFolder}/inputs/viewport_clay_motion.mp4`, variant, peopleMode),
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
    // Legacy fallback only when rerendering is impossible; a stored people render cannot create a clean plate.
    } else if (
      clayMotionSource === 'copy'
      && cameraMoveVideoAsset?.uri
      && peopleVariants.includes('with_people')
    ) {
      throwIfAborted(signal);
      emit('packaging', 'Adding clay camera-move video…');
      await addProjectAssetToZip(
        zip,
        getPeopleVariantPath(`${resolvedRootFolder}/inputs/viewport_clay_motion.mp4`, 'with_people', peopleMode),
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
        const video = await preparePackageCameraMoveVideo({
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
          getPeopleVariantPath(`${resolvedRootFolder}/inputs/viewport_projected_motion.mp4`, variant, peopleMode),
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

  if (shouldExportCameraMoveDepth(
    shot.exportSettings.depth,
    hasRenderableCameraMove(shot.cameraKeyframes),
  )) {
    const depthSettings = resolveShotDepthSettings(shot);
    const sharedRange = await resolveShotDepthRangeForExport(project, shot);
    for (const variant of peopleVariants) {
      throwIfAborted(signal);
      emit('encoding', `Encoding depth camera move (${peopleVariantLabel(variant)})…`, { indeterminate: true });
      try {
        const video = await preparePackageCameraMoveVideo({
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
          getPeopleVariantPath(`${resolvedRootFolder}/inputs/viewport_depth_motion.mp4`, variant, peopleMode),
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
            getPeopleVariantPath(`${resolvedRootFolder}/inputs/camera_move/clay_${frame.id}.png`, variant, peopleMode),
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
            getPeopleVariantPath(`${resolvedRootFolder}/inputs/camera_move/projected_${frame.id}.png`, variant, peopleMode),
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

  const depthMoveFrames = shouldExportDepthReferenceFrames(
    shot.exportSettings.depth,
    true,
  )
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
            getPeopleVariantPath(`${resolvedRootFolder}/inputs/camera_move/depth_${frame.id}.png`, variant, peopleMode),
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

  // Cubemap is independently gated (includeCubemap); canonical preferred, else linked.
  const cubemapSourcePano = (shot.exportSettings.includeCubemap && canonicalPano && canonicalAsset)
    ? { pano: canonicalPano, asset: canonicalAsset }
    : (shot.exportSettings.includeCubemap && linkedPano && linkedPanoAsset)
      ? { pano: linkedPano, asset: linkedPanoAsset }
      : undefined;
  if (cubemapSourcePano) {
    throwIfAborted(signal);
    const faceSize = DEFAULT_CAMERA_MOVE_CUBEMAP_FACE_SIZE;
    const cacheKey = cubemapCacheKey(
      cubemapSourcePano.asset.id,
      cubemapSourcePano.pano.rotation,
      faceSize,
    );
    let cached = sharedMedia.cubemaps.get(cacheKey);
    if (!cached) {
      let pending = sharedMedia.pendingCubemaps.get(cacheKey);
      if (!pending) {
        emit('rendering', 'Rendering cubemap faces…', { indeterminate: true });
        pending = (async () => {
          const cubemap = await renderPanoCubemapFacesAsBlobs(cubemapSourcePano.asset.uri, {
            faceSize,
            panoRotation: cubemapSourcePano.pano.rotation,
          });
          emit('packaging', 'Stitching cubemap…', { indeterminate: true });
          const stitchedCubemap = await stitchCubemapFaceBlobsCrossAsync(cubemap.faces, cubemap.faceSize);
          return {
            faceSize: cubemap.faceSize,
            faces: cubemap.faces,
            stitched: stitchedCubemap.blob,
          };
        })();
        sharedMedia.pendingCubemaps.set(cacheKey, pending);
      }
      try {
        cached = await pending;
        sharedMedia.cubemaps.set(cacheKey, cached);
      } finally {
        if (sharedMedia.pendingCubemaps.get(cacheKey) === pending) sharedMedia.pendingCubemaps.delete(cacheKey);
      }
      for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
        throwIfAborted(signal);
        await addBlobToZip(zip, `${resolvedRootFolder}/inputs/cubemap/${face}.png`, cached.faces[face].blob);
        const faceIndex = CAMERA_MOVE_CUBEMAP_FACES.indexOf(face);
        finishUnit('rendering', `Cubemap face ${faceIndex + 1} of ${CAMERA_MOVE_CUBEMAP_FACES.length}`);
      }
      await addBlobToZip(zip, `${resolvedRootFolder}/inputs/cubemap/cubemap_stitched.png`, cached.stitched);
      finishUnit('packaging', 'Cubemap stitch ready');
    } else {
      emit('packaging', 'Reusing shared cubemap…', { indeterminate: true });
      for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
        throwIfAborted(signal);
        await addBlobToZip(zip, `${resolvedRootFolder}/inputs/cubemap/${face}.png`, cached.faces[face].blob);
      }
      await addBlobToZip(zip, `${resolvedRootFolder}/inputs/cubemap/cubemap_stitched.png`, cached.stitched);
    }
  }

  if (shot.exportSettings.includePanoCrop && linkedPano && shot.panoCrop) {
    if (linkedPanoAsset) {
      throwIfAborted(signal);
      emit('rendering', 'Rendering pano crop…', { indeterminate: true });
      const crop = await renderPanoPerspectiveCrop(linkedPanoAsset.uri, shot.panoCrop, linkedPano.rotation);
      addDataUrl(zip, `${resolvedRootFolder}/inputs/pano_crop.png`, crop.dataUrl);
      finishUnit('rendering', 'Pano crop ready');
    }
  }

  if (shot.exportSettings.includeFullPano && canonicalAsset && canonicalPano) {
    throwIfAborted(signal);
    emit('packaging', 'Preparing styled reference panorama…', { indeterminate: true });
    const prepared = await prepareSharedPano(canonicalAsset, canonicalPano);
    const exportUrl = prepared.exportUrl;
    if (exportUrl === canonicalAsset.uri) {
      await addProjectAssetToZip(zip, `${resolvedRootFolder}/inputs/global_reference.png`, canonicalAsset);
    } else {
      addDataUrl(zip, `${resolvedRootFolder}/inputs/global_reference.png`, exportUrl);
    }
    if (prepared.produced) {
      finishUnit('packaging', 'Styled reference panorama added');
    }
  }

  if (shot.exportSettings.includeGrayboxPano && grayboxAsset && grayboxPano) {
    throwIfAborted(signal);
    emit('packaging', 'Preparing graybox panorama…', { indeterminate: true });
    const prepared = await prepareSharedPano(grayboxAsset, grayboxPano);
    const exportUrl = prepared.exportUrl;
    if (exportUrl === grayboxAsset.uri) {
      await addProjectAssetToZip(zip, `${resolvedRootFolder}/inputs/global_graybox.png`, grayboxAsset);
    } else {
      addDataUrl(zip, `${resolvedRootFolder}/inputs/global_graybox.png`, exportUrl);
    }
    if (prepared.produced) {
      finishUnit('packaging', 'Graybox panorama added');
    }
  }

  const characterPass = normalizeCharacterPassExportSettings(shot.exportSettings.characterPass);
  if (characterPass.enabled) {
    const canProjectCharacters = canUseProjectedAppearance(shotProject);
    const hasVisibleCharacters = shotHasVisibleCharactersForPass(project, shot, characterPass);

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
            characterStillPath(resolvedRootFolder, appearance),
            `Packaging transparent character still (${appearance})…`,
          );
          finishUnit('rendering', `Character still (${appearance}) ready`);
        } catch (error) {
          if (isPackageExportCancelled(error)) throw error;
          throw new ShotPackageError(
            error instanceof Error
              ? error.message
              : `Character still (${appearance}) failed.`,
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
        const sequenceDir = characterSequenceDirPath(resolvedRootFolder, appearance);

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
          // Prefer prepareVideoArtifact so green character MP4s share the fingerprinted cache.
          // PNG-only still uses the dedicated path (no MP4 identity).
          if (wantsMp4) {
            const artifact = await preparePackageCameraMoveVideo({
              project,
              shotId: shot.id,
              appearance,
              peopleVariant: 'with_people',
              performance: videoPerformance,
              contentMode: 'characters_only',
              backgroundColor: characterPass.backgroundColor,
              includeCharacterAttachments: characterPass.includeAttachedProps,
              transparent: wantsPng,
              stats: videoPerformanceStats,
              signal,
              onProgress: (progress) => {
                const info = normalizeCameraMoveProgress(progress);
                emit('encoding', info.message || `Encoding character motion (${appearance})…`, {
                  unitFraction: info.progress,
                });
              },
              onFrameRendered: wantsPng
                ? async (canvas, frameIndex, timeSeconds) => {
                  const blob = await new Promise<Blob>((resolve, reject) => {
                    canvas.toBlob(
                      (value) => (value ? resolve(value) : reject(new Error('PNG frame failed.'))),
                      'image/png',
                    );
                  });
                  const framePath = `${sequenceDir}/${characterSequenceFrameFileName(frameIndex + 1)}`;
                  await addBlobToZipStore(zip, framePath, blob);
                  void timeSeconds;
                }
                : undefined,
            });

            if (wantsPng) {
              zip.file(
                `${sequenceDir}/sequence.json`,
                JSON.stringify(
                  buildCharacterSequenceMeta({
                    width: artifact.width,
                    height: artifact.height,
                    frameRate: artifact.frameRate,
                    frameCount: artifact.frameCount,
                    durationSeconds: artifact.durationSeconds,
                  }),
                  null,
                  2,
                ),
              );
              finishUnit('encoding', `Character PNG sequence (${appearance}) ready`);
            }

            await addBlobToZipStore(
              zip,
              characterMotionMp4Path(resolvedRootFolder, appearance),
              artifact.blob,
            );
            finishUnit(
              'encoding',
              artifact.cacheStatus === 'hit' || artifact.cacheStatus === 'joined'
                ? `Character green-screen MP4 (${appearance}) from cache`
                : `Character green-screen MP4 (${appearance}) ready`,
            );
          } else {
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
                emit('encoding', info.message || `Rendering transparent character sequence (${appearance})…`, {
                  unitFraction: info.progress,
                });
              },
              onPngFrame: async (frameIndex, blob) => {
                const framePath = `${sequenceDir}/${characterSequenceFrameFileName(frameIndex + 1)}`;
                await addBlobToZipStore(zip, framePath, blob);
              },
            });
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
        } catch (error) {
          if (isPackageExportCancelled(error)) throw error;
          throw new ShotPackageError(
            error instanceof Error
              ? error.message
              : `Character motion (${appearance}) failed.`,
          );
        }
      }
    }

    if (shot.exportSettings.includeMetadata && hasVisibleCharacters) {
      throwIfAborted(signal);
      emit('packaging', 'Writing character pass metadata…');
      zip.file(
        characterPassMetadataPath(resolvedRootFolder),
        JSON.stringify(buildCharacterPassMetadata(project, shot, characterPass), null, 2),
      );
      finishUnit('packaging', 'Character pass metadata written');
    }
  }

  if (shot.exportSettings.includeMetadata) {
    throwIfAborted(signal);
    emit('packaging', 'Writing metadata…');
    const metadata = buildShotMetadata(shotProject, shot, linkedPano);
    zip.file(`${resolvedRootFolder}/metadata/shot.json`, JSON.stringify(shot, null, 2));
    zip.file(`${resolvedRootFolder}/metadata/camera.json`, JSON.stringify(shot.camera, null, 2));
    if (shot.cameraKeyframes.length > 0) {
      zip.file(`${resolvedRootFolder}/metadata/camera_keyframes.json`, JSON.stringify(shot.cameraKeyframes, null, 2));
    }
    const referenceFrameMeta = cameraMoveReferenceFrames.length > 0
      ? cameraMoveReferenceFrames
      : depthMoveFrames.length > 0
        ? depthMoveFrames
        : projectedMoveFrames;
    if (referenceFrameMeta.length > 0) {
      zip.file(
        `${resolvedRootFolder}/metadata/camera_move_reference_frames.json`,
        JSON.stringify(referenceFrameMeta, null, 2),
      );
    }
    if (shouldExportAnyDepth(shot.exportSettings.depth, {
      hasReferenceFrames: depthMoveFrames.length > 0,
      hasRenderableMove: hasRenderableCameraMove(shot.cameraKeyframes),
    })) {
      const depthSettings = resolveShotDepthSettings(shot);
      const sharedRange = await resolveShotDepthRangeForExport(project, shot);
      zip.file(
        `${resolvedRootFolder}/metadata/depth.json`,
        JSON.stringify(
          buildDepthMetadata(
            depthSettings,
            sharedRange,
            shouldExportCameraMoveDepth(
              depthSettings,
              hasRenderableCameraMove(shot.cameraKeyframes),
            ) ? { frameRate: 30 } : {},
          ),
          null,
          2,
        ),
      );
    }
    zip.file(`${resolvedRootFolder}/metadata/landmarks.json`, JSON.stringify(metadata.landmarks, null, 2));
    zip.file(`${resolvedRootFolder}/metadata/location.json`, JSON.stringify(metadata.project, null, 2));
    finishUnit('packaging', 'Metadata written');
  }

  if (shot.exportSettings.includePrompt) {
    throwIfAborted(signal);
    emit('packaging', 'Writing prompts…');
    zip.file(`${resolvedRootFolder}/prompts/image_gen_prompt.txt`, generateImagePrompt(shotProject, shot));
    zip.file(`${resolvedRootFolder}/prompts/video_gen_prompt.txt`, generateVideoPrompt(shot));
    zip.file(`${resolvedRootFolder}/prompts/negative_prompt.txt`, shot.promptOverrides.negativePrompt || '');
    finishUnit('packaging', 'Prompts written');
  }

  throwIfAborted(signal);
  emit('packaging', 'Writing manifest…');
  const manifest = createShotPackageManifest(shotProject, shot, resolvedRootFolder);
  zip.file(`${resolvedRootFolder}/manifest.json`, JSON.stringify(manifest, null, 2));
  finishUnit('packaging', `${getShotExportProgressLabel(shot)} packaged`);
  return manifest.files.map((file) => file.path);
  } // appendShotPackageToZipBody
}
