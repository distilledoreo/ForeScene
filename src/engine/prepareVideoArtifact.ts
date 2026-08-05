/**
 * Shared video artifact preparation for package export and (later) background prep.
 *
 * Flow:
 *   fingerprint → cache hit → return
 *   join in-progress job with the same fingerprint
 *   otherwise render → store → return
 */

import type { LocationProject, VideoEncoderMode } from '../domain/types';
import {
  renderShotCameraMoveMp4,
  type CameraMoveVideoOptions,
  type VideoRenderResult,
} from './renderers';
import {
  computeVideoArtifactFingerprint,
  type VideoArtifactFingerprint,
  type VideoArtifactSpecification,
} from './videoArtifactFingerprint';
import {
  getVideoArtifactFromCache,
  putVideoArtifactInCache,
} from './videoArtifactCache';
import {
  accumulatePackageVideoPerformanceStats,
  createEmptyPackageVideoPerformanceStats,
  resolveProjectVideoPerformance,
  type PackageVideoPerformanceStats,
  type ResolvedVideoPerformance,
} from './videoPerformance';
import {
  createCacheHitTiming,
  createVideoRenderTimingBuilder,
  type VideoRenderTiming,
} from './videoRenderTiming';
import type { VideoResolutionPresetId } from './videoPresets';
import { resolveVideoPreset } from './videoPresets';

export type VideoArtifactPriority = 'foreground' | 'background';

export interface PrepareVideoArtifactParams {
  project: LocationProject;
  shotId: string;
  specification: VideoArtifactSpecification;
  /** Reserved for PR2 background scheduler; ignored for rendering priority today. */
  priority?: VideoArtifactPriority;
  signal?: AbortSignal;
  includeDataUrl?: boolean;
  onProgress?: CameraMoveVideoOptions['onProgress'];
  /** Fork transparent PNG frames during the WebGL pass (character "both" format). */
  onFrameRendered?: CameraMoveVideoOptions['onFrameRendered'];
  /** Skip cache read/write (tests / force re-render). */
  bypassCache?: boolean;
  /**
   * Optional resolved performance override. When omitted, project export
   * configuration is used for resolution / fps / encoder defaults.
   */
  performance?: ResolvedVideoPerformance;
  /** Optional package-level stats accumulator. */
  stats?: PackageVideoPerformanceStats;
}

export interface PreparedVideoArtifact {
  fingerprint: VideoArtifactFingerprint;
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  frameCount: number;
  codecString?: string;
  encodeMode: 'render' | 'quickPreview';
  actualEncoderMode: VideoEncoderMode;
  encoderModeFallback: boolean;
  cacheStatus: 'hit' | 'miss' | 'joined' | 'bypass';
  timing: VideoRenderTiming;
  dataUrl?: string;
}

const inflightJobs = new Map<string, Promise<PreparedVideoArtifact>>();

function resolveShot(project: LocationProject, shotId: string) {
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error(`Unknown shot '${shotId}'.`);
  return shot;
}

function resolveSpecificationDimensions(
  project: LocationProject,
  specification: VideoArtifactSpecification,
  performance?: ResolvedVideoPerformance,
): {
  resolutionPreset: VideoResolutionPresetId;
  frameRate: number;
  width: number;
  height: number;
  encoderMode: VideoEncoderMode;
} {
  const perf = performance ?? resolveProjectVideoPerformance(project.exportConfiguration);
  const resolutionPreset = specification.resolutionPreset ?? perf.resolutionPreset;
  const preset = resolveVideoPreset(resolutionPreset);
  const frameRate = specification.frameRate ?? perf.frameRate;
  const width = specification.width ?? preset.width;
  const height = specification.height ?? preset.height;
  const encoderMode = specification.encoderMode ?? perf.encoderMode;
  return {
    resolutionPreset,
    frameRate,
    width,
    height,
    encoderMode,
  };
}

function toPreparedFromRender(
  fingerprint: VideoArtifactFingerprint,
  video: VideoRenderResult,
  options: {
    cacheStatus: PreparedVideoArtifact['cacheStatus'];
    timing: VideoRenderTiming;
    actualEncoderMode: VideoEncoderMode;
    encoderModeFallback: boolean;
  },
): PreparedVideoArtifact {
  return {
    fingerprint,
    blob: video.blob,
    mimeType: video.mimeType,
    width: video.width,
    height: video.height,
    durationSeconds: video.durationSeconds,
    frameRate: video.frameRate,
    frameCount: video.frameCount ?? 0,
    codecString: video.codecString,
    encodeMode: video.encodeMode ?? 'render',
    actualEncoderMode: options.actualEncoderMode,
    encoderModeFallback: options.encoderModeFallback,
    cacheStatus: options.cacheStatus,
    timing: options.timing,
    dataUrl: video.dataUrl,
  };
}

function recordStats(
  stats: PackageVideoPerformanceStats | undefined,
  result: PreparedVideoArtifact,
): void {
  if (!stats) return;
  accumulatePackageVideoPerformanceStats(stats, result);
}

async function renderAndStore(
  params: PrepareVideoArtifactParams,
  fingerprint: VideoArtifactFingerprint,
  resolved: ReturnType<typeof resolveSpecificationDimensions>,
): Promise<PreparedVideoArtifact> {
  const shot = resolveShot(params.project, params.shotId);
  const timingBuilder = createVideoRenderTimingBuilder();
  timingBuilder.markSetupStart();

  const video = await renderShotCameraMoveMp4(params.project, shot, {
    mode: params.specification.mode ?? 'render',
    resolutionPreset: resolved.resolutionPreset,
    frameRate: resolved.frameRate,
    width: resolved.width,
    height: resolved.height,
    encoderMode: resolved.encoderMode,
    appearance: params.specification.appearance,
    peopleVariant: params.specification.peopleVariant,
    contentMode: params.specification.contentMode,
    occlusionFilter: params.specification.occlusionFilter
      ?? (params.specification.appearance === 'projected' ? 'fast' : undefined),
    depthRange: params.specification.depthRange,
    depthInvert: params.specification.depthInvert,
    backgroundColor: params.specification.backgroundColor,
    includeCharacterAttachments: params.specification.includeCharacterAttachments,
    transparent: params.specification.transparent,
    includeDataUrl: params.includeDataUrl === true,
    signal: params.signal,
    onProgress: params.onProgress,
    onFrameRendered: params.onFrameRendered,
    onTiming: (event) => {
      if (event.stage === 'setup-end') timingBuilder.markSetupEnd();
      else if (event.stage === 'render') timingBuilder.addRenderMs(event.ms);
      else if (event.stage === 'encode') timingBuilder.addEncodeMs(event.ms);
      else if (event.stage === 'finalize') timingBuilder.addFinalizeMs(event.ms);
    },
  });

  const actualEncoderMode = video.actualEncoderMode ?? resolved.encoderMode;
  const encoderModeFallback = video.encoderModeFallback === true;
  const timing = timingBuilder.finish({
    cacheHit: false,
    frameCount: video.frameCount ?? 0,
    width: video.width,
    height: video.height,
  });

  const prepared = toPreparedFromRender(fingerprint, video, {
    cacheStatus: params.bypassCache ? 'bypass' : 'miss',
    timing,
    actualEncoderMode,
    encoderModeFallback,
  });

  if (!params.bypassCache && (video.encodeMode ?? 'render') === 'render') {
    await putVideoArtifactInCache(fingerprint, {
      blob: video.blob,
      mimeType: video.mimeType,
      width: video.width,
      height: video.height,
      durationSeconds: video.durationSeconds,
      frameRate: video.frameRate,
      frameCount: video.frameCount ?? 0,
      codecString: video.codecString,
      encodeMode: video.encodeMode ?? 'render',
      actualEncoderMode,
      encoderModeFallback,
      timing,
    });
  }

  return prepared;
}

/**
 * Prepare a deterministic video artifact, reusing cache and in-progress jobs.
 */
export async function prepareVideoArtifact(
  params: PrepareVideoArtifactParams,
): Promise<PreparedVideoArtifact> {
  const shot = resolveShot(params.project, params.shotId);
  const resolved = resolveSpecificationDimensions(
    params.project,
    params.specification,
    params.performance,
  );
  const fingerprint = computeVideoArtifactFingerprint(
    params.project,
    shot,
    params.specification,
    resolved,
  );

  // Frame-fork callbacks (e.g. character PNG sequences) need a live render pass;
  // cached MP4 blobs cannot reconstruct those side-products.
  const allowCache = !params.bypassCache && !params.onFrameRendered;

  if (allowCache) {
    const cached = await getVideoArtifactFromCache(fingerprint);
    if (cached) {
      let dataUrl: string | undefined;
      if (params.includeDataUrl) {
        dataUrl = await blobToDataUrl(cached.blob);
      }
      const timing = createCacheHitTiming({
        frameCount: cached.frameCount,
        width: cached.width,
        height: cached.height,
        totalMs: 0,
      });
      const prepared: PreparedVideoArtifact = {
        fingerprint,
        blob: cached.blob,
        mimeType: cached.mimeType,
        width: cached.width,
        height: cached.height,
        durationSeconds: cached.durationSeconds,
        frameRate: cached.frameRate,
        frameCount: cached.frameCount,
        codecString: cached.codecString,
        encodeMode: cached.encodeMode,
        actualEncoderMode: cached.actualEncoderMode,
        encoderModeFallback: cached.encoderModeFallback === true,
        cacheStatus: 'hit',
        timing,
        dataUrl,
      };
      recordStats(params.stats, prepared);
      return prepared;
    }

    const existing = inflightJobs.get(fingerprint.key);
    if (existing) {
      const joined = await existing;
      if (params.signal?.aborted) {
        throw new Error('MP4 export was cancelled.');
      }
      const prepared: PreparedVideoArtifact = {
        ...joined,
        cacheStatus: 'joined',
        dataUrl: params.includeDataUrl
          ? (joined.dataUrl ?? await blobToDataUrl(joined.blob))
          : undefined,
      };
      recordStats(params.stats, prepared);
      return prepared;
    }
  }

  const job = renderAndStore(
    { ...params, bypassCache: params.bypassCache || Boolean(params.onFrameRendered) },
    fingerprint,
    resolved,
  );
  if (allowCache) {
    inflightJobs.set(fingerprint.key, job);
  }

  try {
    const prepared = await job;
    recordStats(params.stats, prepared);
    return prepared;
  } finally {
    if (inflightJobs.get(fingerprint.key) === job) {
      inflightJobs.delete(fingerprint.key);
    }
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === 'undefined') {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]!);
    }
    const base64 = typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
    return `data:${blob.type || 'video/mp4'};base64,${base64}`;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read video blob.'));
    reader.readAsDataURL(blob);
  });
}

/** Test helper. */
export function resetPrepareVideoArtifactInflightForTests(): void {
  inflightJobs.clear();
}

export { createEmptyPackageVideoPerformanceStats };
