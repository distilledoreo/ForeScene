/**
 * Deterministic canvas → H.264 → MP4 encoding via Mediabunny.
 *
 * Mediabunny is loaded on demand so opening Shots (which pulls renderers → this
 * module) does not evaluate the encoder library at workspace import time.
 * Safari/WebKit can open Shots even when WebCodecs MP4 export is unavailable.
 */

import type { VideoEncodingConfig } from 'mediabunny';
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
}

export interface DeterministicEncodeResult {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  codecString: string;
}

/**
 * Shared AVC encode options for capability checks and CanvasSource.
 * Variable bitrate fits offline camera-move renders better than CBR.
 */
export function buildDeterministicAvcEncodingConfig(
  preset: VideoResolutionPreset,
): VideoEncodingConfig {
  return {
    codec: 'avc',
    bitrate: preset.bitrate,
    fullCodecString: preset.avcCodecString,
    hardwareAcceleration: 'no-preference',
    latencyMode: 'quality',
    bitrateMode: 'variable',
    keyFrameInterval: 2,
  };
}

/** VideoEncoder.isConfigSupported payload mirroring {@link buildDeterministicAvcEncodingConfig}. */
export function buildDeterministicVideoEncoderSupportConfig(
  preset: VideoResolutionPreset,
): VideoEncoderConfig {
  const encoding = buildDeterministicAvcEncodingConfig(preset);
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
): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  const encoding = buildDeterministicAvcEncodingConfig(preset);
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
      buildDeterministicVideoEncoderSupportConfig(preset),
    );
    return Boolean(support.supported);
  } catch {
    return false;
  }
}

/**
 * Fixed-step canvas → WebCodecs H.264 → Mediabunny MP4.
 * Awaits CanvasSource.add for encoder/muxer backpressure.
 */
export async function encodeCanvasFramesToMp4(
  options: DeterministicEncodeOptions,
): Promise<DeterministicEncodeResult> {
  const { canvas, preset, totalFrames, renderFrame, signal, onFrameEncoded } = options;
  if (totalFrames < 1) {
    throw new Error('Camera move export requires at least one frame.');
  }
  if (signal?.aborted) {
    throw new Error('MP4 export was cancelled.');
  }

  const supported = await canUseDeterministicMp4Export(preset);
  if (!supported) {
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
  const encodingConfig = buildDeterministicAvcEncodingConfig(preset);
  const videoSource = new CanvasSource(canvas, encodingConfig);

  output.addVideoTrack(videoSource, { frameRate: preset.frameRate });
  await output.start();

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
  };
  signal?.addEventListener('abort', onAbort);

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (cancelled || signal?.aborted) {
        throw new Error('MP4 export was cancelled.');
      }

      await renderFrame(frameIndex);
      const timestamp = frameIndex * frameDuration;
      // Await add() so muxer/encoder backpressure stalls the render loop
      // instead of buffering unbounded VideoFrames in memory.
      await videoSource.add(timestamp, frameDuration);
      onFrameEncoded?.(frameIndex + 1, totalFrames);
    }

    videoSource.close();
    await output.finalize();
  } catch (error) {
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
  };
}
