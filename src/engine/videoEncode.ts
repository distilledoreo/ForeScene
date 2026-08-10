/**
 * Deterministic canvas → H.264 → MP4 encoding via Mediabunny.
 *
 * Mediabunny is loaded on demand so opening Shots (which pulls renderers → this
 * module) does not evaluate the encoder library at workspace import time.
 * Safari/WebKit can open Shots even when WebCodecs MP4 export is unavailable.
 */

import type { VideoEncodingConfig } from 'mediabunny';
import type { VideoEncoderMode } from '../domain/types';
import type { VideoResolutionPreset } from './videoPresets';

type MediabunnyModule = typeof import('mediabunny');

let mediabunnyPromise: Promise<MediabunnyModule> | undefined;

function loadMediabunny(): Promise<MediabunnyModule> {
  mediabunnyPromise ??= import('mediabunny');
  return mediabunnyPromise;
}

export interface DeterministicEncodeOptions {
  canvas: HTMLCanvasElement;
  preset: VideoResolutionPreset;
  totalFrames: number;
  /** Render the canvas for the given frame index before encoding. */
  renderFrame: (frameIndex: number) => void | Promise<void>;
  signal?: AbortSignal;
  onFrameEncoded?: (completedFrames: number, totalFrames: number) => void;
  /**
   * Requested encoder mode. `fast` prefers hardware + realtime and falls back
   * to quality when unsupported.
   */
  encoderMode?: VideoEncoderMode;
  /** Optional per-stage timing hooks (render / encode / mux finalize). */
  onStageTiming?: (stage: 'render' | 'encode' | 'finalize', ms: number) => void;
  /** Bounded number of encoder writes allowed to overlap canvas rendering. */
  encodeQueueDepth?: number;
}

export interface DeterministicEncodeResult {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  codecString: string;
  /** Encoder mode actually used after capability negotiation. */
  actualEncoderMode: VideoEncoderMode;
  /** True when fast mode was requested but quality was used instead. */
  encoderModeFallback: boolean;
}

type HardwareAcceleration = NonNullable<VideoEncodingConfig['hardwareAcceleration']>;
type LatencyMode = NonNullable<VideoEncodingConfig['latencyMode']>;

interface EncoderModeParams {
  hardwareAcceleration: HardwareAcceleration;
  latencyMode: LatencyMode;
}

function encoderModeParams(mode: VideoEncoderMode): EncoderModeParams {
  if (mode === 'fast') {
    return {
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'realtime',
    };
  }
  return {
    hardwareAcceleration: 'no-preference',
    latencyMode: 'quality',
  };
}

function cancellationError(): Error {
  const error = new Error('MP4 export was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Shared AVC encode options for capability checks and CanvasSource.
 * Variable bitrate fits offline camera-move renders better than CBR.
 */
export function buildDeterministicAvcEncodingConfig(
  preset: VideoResolutionPreset,
  encoderMode: VideoEncoderMode = 'quality',
): VideoEncodingConfig {
  const mode = encoderModeParams(encoderMode);
  return {
    codec: 'avc',
    bitrate: preset.bitrate,
    fullCodecString: preset.avcCodecString,
    hardwareAcceleration: mode.hardwareAcceleration,
    latencyMode: mode.latencyMode,
    bitrateMode: 'variable',
    keyFrameInterval: 2,
  };
}

/** VideoEncoder.isConfigSupported payload mirroring {@link buildDeterministicAvcEncodingConfig}. */
export function buildDeterministicVideoEncoderSupportConfig(
  preset: VideoResolutionPreset,
  encoderMode: VideoEncoderMode = 'quality',
): VideoEncoderConfig {
  const encoding = buildDeterministicAvcEncodingConfig(preset, encoderMode);
  return {
    codec: preset.avcCodecString,
    width: preset.width,
    height: preset.height,
    framerate: preset.frameRate,
    bitrate: typeof encoding.bitrate === 'number' ? encoding.bitrate : preset.bitrate,
    hardwareAcceleration: encoding.hardwareAcceleration ?? 'no-preference',
    bitrateMode: encoding.bitrateMode ?? 'variable',
    latencyMode: encoding.latencyMode ?? 'quality',
    avc: { format: 'avc' },
  };
}

export async function canUseDeterministicMp4Export(
  preset: VideoResolutionPreset,
  encoderMode: VideoEncoderMode = 'quality',
): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  const encoding = buildDeterministicAvcEncodingConfig(preset, encoderMode);
  try {
    const { canEncodeVideo } = await loadMediabunny();
    const mediabunnyOk = await canEncodeVideo('avc', {
      width: preset.width,
      height: preset.height,
      bitrate: encoding.bitrate,
      bitrateMode: encoding.bitrateMode,
      fullCodecString: encoding.fullCodecString,
      hardwareAcceleration: encoding.hardwareAcceleration,
      latencyMode: encoding.latencyMode,
    });
    if (!mediabunnyOk) return false;
  } catch {
    return false;
  }

  try {
    const support = await VideoEncoder.isConfigSupported(
      buildDeterministicVideoEncoderSupportConfig(preset, encoderMode),
    );
    return Boolean(support.supported);
  } catch {
    return false;
  }
}

/**
 * Negotiate the encoder mode: try fast when requested, fall back to quality.
 * Returns undefined when neither mode is supported.
 */
export async function resolveDeterministicEncoderMode(
  preset: VideoResolutionPreset,
  requested: VideoEncoderMode = 'quality',
): Promise<{ mode: VideoEncoderMode; fallback: boolean } | undefined> {
  if (requested === 'fast') {
    if (await canUseDeterministicMp4Export(preset, 'fast')) {
      return { mode: 'fast', fallback: false };
    }
    if (await canUseDeterministicMp4Export(preset, 'quality')) {
      return { mode: 'quality', fallback: true };
    }
    return undefined;
  }
  if (await canUseDeterministicMp4Export(preset, 'quality')) {
    return { mode: 'quality', fallback: false };
  }
  // Last resort: some devices only advertise prefer-hardware configs.
  if (await canUseDeterministicMp4Export(preset, 'fast')) {
    return { mode: 'fast', fallback: false };
  }
  return undefined;
}

/**
 * Fixed-step canvas → WebCodecs H.264 → Mediabunny MP4.
 * Awaits CanvasSource.add for encoder/muxer backpressure.
 */
export async function encodeCanvasFramesToMp4(
  options: DeterministicEncodeOptions,
): Promise<DeterministicEncodeResult> {
  const {
    canvas,
    preset,
    totalFrames,
    renderFrame,
    signal,
    onFrameEncoded,
    encoderMode = 'quality',
    onStageTiming,
    encodeQueueDepth = 2,
  } = options;
  if (totalFrames < 1) {
    throw new Error('Camera move export requires at least one frame.');
  }
  if (signal?.aborted) {
    throw cancellationError();
  }

  const negotiated = await resolveDeterministicEncoderMode(preset, encoderMode);
  if (!negotiated) {
    throw new Error(
      `H.264 ${preset.label} (${preset.avcCodecString}) is not supported in this browser.`,
    );
  }

  const {
    BufferTarget,
    CanvasSource,
    Mp4OutputFormat,
    Output,
  } = await loadMediabunny();

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  const frameDuration = 1 / preset.frameRate;
  const encodingConfig = buildDeterministicAvcEncodingConfig(preset, negotiated.mode);
  const videoSource = new CanvasSource(canvas, encodingConfig);

  output.addVideoTrack(videoSource, { frameRate: preset.frameRate });
  await output.start();

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
  };
  signal?.addEventListener('abort', onAbort);

  const pendingEncodes: Array<{
    frameIndex: number;
    startedAt: number;
    promise: Promise<void>;
  }> = [];
  const requestedQueueDepth = Number.isFinite(encodeQueueDepth) ? Math.floor(encodeQueueDepth) : 2;
  const queueDepth = Math.max(1, Math.min(4, requestedQueueDepth));
  const settleOneEncode = async (entry: (typeof pendingEncodes)[number]) => {
    await entry.promise;
    onStageTiming?.('encode', performance.now() - entry.startedAt);
    onFrameEncoded?.(entry.frameIndex + 1, totalFrames);
  };

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (cancelled || signal?.aborted) {
        throw cancellationError();
      }

      const renderStarted = performance.now();
      await renderFrame(frameIndex);
      onStageTiming?.('render', performance.now() - renderStarted);

      const timestamp = frameIndex * frameDuration;
      // Await add() so muxer/encoder backpressure stalls the render loop
      // instead of buffering unbounded VideoFrames in memory. A small bounded
      // queue lets the next GPU frame render while the encoder drains the
      // previous sample without allowing memory to grow with the timeline.
      const encodeStarted = performance.now();
      pendingEncodes.push({
        frameIndex,
        startedAt: encodeStarted,
        promise: videoSource.add(timestamp, frameDuration),
      });
      if (pendingEncodes.length >= queueDepth) {
        const oldest = pendingEncodes.shift();
        if (oldest) await settleOneEncode(oldest);
      }
    }

    while (pendingEncodes.length > 0) {
      const next = pendingEncodes.shift();
      if (next) await settleOneEncode(next);
    }

    videoSource.close();
    const finalizeStarted = performance.now();
    await output.finalize();
    onStageTiming?.('finalize', performance.now() - finalizeStarted);
  } catch (error) {
    await Promise.allSettled(pendingEncodes.map((entry) => entry.promise));
    try {
      videoSource.close();
    } catch {
      // ignore
    }
    try {
      await output.cancel();
    } catch {
      // ignore
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const buffer = target.buffer;
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('MP4 encoding produced an empty file.');
  }

  const blob = new Blob([buffer], { type: 'video/mp4' });
  return {
    blob,
    mimeType: 'video/mp4',
    width: preset.width,
    height: preset.height,
    frameRate: preset.frameRate,
    frameCount: totalFrames,
    codecString: preset.avcCodecString,
    actualEncoderMode: negotiated.mode,
    encoderModeFallback: negotiated.fallback,
  };
}
