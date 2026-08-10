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

type VideoProgressCallback = NonNullable<CameraMoveVideoOptions['onProgress']>;
type VideoProgressEvent = Parameters<VideoProgressCallback>[0];

interface InflightVideoSubscriber {
  onProgress?: VideoProgressCallback;
}

interface InflightVideoJob {
  key: string;
  controller: AbortController;
  subscribers: Map<symbol, InflightVideoSubscriber>;
  promise: Promise<PreparedVideoArtifact>;
  settled: boolean;
}

const inflightJobs = new Map<string, InflightVideoJob>();

function cancellationError(): Error {
  const error = new Error('MP4 export was cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

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

function emitInflightProgress(job: InflightVideoJob, progress: VideoProgressEvent): void {
  for (const subscriber of job.subscribers.values()) {
    try {
      subscriber.onProgress?.(progress);
    } catch {
      // One observer must not break a shared render for the other subscribers.
    }
  }
}

function createInflightJob(
  params: PrepareVideoArtifactParams,
  fingerprint: VideoArtifactFingerprint,
  resolved: ReturnType<typeof resolveSpecificationDimensions>,
): InflightVideoJob {
  const controller = new AbortController();
  const job: InflightVideoJob = {
    key: fingerprint.key,
    controller,
    subscribers: new Map(),
    promise: Promise.resolve(undefined as unknown as PreparedVideoArtifact),
    settled: false,
  };

  const sharedParams: PrepareVideoArtifactParams = {
    ...params,
    signal: controller.signal,
    includeDataUrl: false,
    onFrameRendered: undefined,
    onProgress: (progress) => emitInflightProgress(job, progress),
    stats: undefined,
    bypassCache: false,
  };

  // Start in a microtask so the originating caller is subscribed before the
  // renderer can emit progress or observe cancellation.
  job.promise = Promise.resolve()
    .then(() => renderAndStore(sharedParams, fingerprint, resolved))
    .finally(() => {
      job.settled = true;
      if (inflightJobs.get(job.key) === job) inflightJobs.delete(job.key);
    });
  inflightJobs.set(job.key, job);
  return job;
}

function releaseInflightSubscriber(job: InflightVideoJob, token: symbol): void {
  if (!job.subscribers.delete(token)) return;
  if (job.settled || job.subscribers.size > 0) return;

  // Remove the abandoned job immediately so a new caller does not join a
  // render that is already being aborted.
  if (inflightJobs.get(job.key) === job) inflightJobs.delete(job.key);
  job.controller.abort();
}

async function prepareResultForCaller(
  result: PreparedVideoArtifact,
  params: PrepareVideoArtifactParams,
  cacheStatus: 'miss' | 'joined',
): Promise<PreparedVideoArtifact> {
  throwIfCancelled(params.signal);
  const dataUrl = params.includeDataUrl
    ? (result.dataUrl ?? await blobToDataUrl(result.blob))
    : undefined;
  throwIfCancelled(params.signal);
  return {
    ...result,
    cacheStatus,
    dataUrl,
  };
}

function awaitInflightJob(
  job: InflightVideoJob,
  params: PrepareVideoArtifactParams,
  cacheStatus: 'miss' | 'joined',
): Promise<PreparedVideoArtifact> {
  const token = Symbol('video-artifact-subscriber');
  job.subscribers.set(token, { onProgress: params.onProgress });

  return new Promise((resolve, reject) => {
    let active = true;
    const signal = params.signal;

    const cleanup = () => {
      if (!active) return;
      active = false;
      signal?.removeEventListener('abort', onAbort);
      releaseInflightSubscriber(job, token);
    };

    const onAbort = () => {
      cleanup();
      reject(cancellationError());
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    job.promise.then(
      (result) => {
        if (!active) return;
        void prepareResultForCaller(result, params, cacheStatus).then(
          (prepared) => {
            if (!active) return;
            cleanup();
            resolve(prepared);
          },
          (error) => {
            if (!active) return;
            cleanup();
            reject(error);
          },
        );
      },
      (error) => {
        if (!active) return;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Prepare a deterministic video artifact, reusing cache and in-progress jobs.
 */
export async function prepareVideoArtifact(
  params: PrepareVideoArtifactParams,
): Promise<PreparedVideoArtifact> {
  throwIfCancelled(params.signal);
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
    throwIfCancelled(params.signal);
    if (cached) {
      let dataUrl: string | undefined;
      if (params.includeDataUrl) {
        dataUrl = await blobToDataUrl(cached.blob);
        throwIfCancelled(params.signal);
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

    let job = inflightJobs.get(fingerprint.key);
    const cacheStatus: 'miss' | 'joined' = job ? 'joined' : 'miss';
    if (!job) job = createInflightJob(params, fingerprint, resolved);

    const prepared = await awaitInflightJob(job, params, cacheStatus);
    recordStats(params.stats, prepared);
    return prepared;
  }

  const prepared = await renderAndStore(
    { ...params, bypassCache: params.bypassCache || Boolean(params.onFrameRendered) },
    fingerprint,
    resolved,
  );
  recordStats(params.stats, prepared);
  return prepared;
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
export function inspectPrepareVideoArtifactInflightForTests(): {
  jobs: number;
  subscribers: number;
  abortedJobs: number;
} {
  const jobs = [...inflightJobs.values()];
  return {
    jobs: jobs.length,
    subscribers: jobs.reduce((sum, job) => sum + job.subscribers.size, 0),
    abortedJobs: jobs.filter((job) => job.controller.signal.aborted).length,
  };
}

/** Test helper. */
export function resetPrepareVideoArtifactInflightForTests(): void {
  for (const job of inflightJobs.values()) job.controller.abort();
  inflightJobs.clear();
}

export { createEmptyPackageVideoPerformanceStats };
