/** Stage timings for camera-move render + encode. */

export interface VideoRenderTiming {
  /** Scene / WebGL / projector setup before the first frame. */
  setupMs: number;
  /** Wall time spent inside per-frame scene renders. */
  renderMs: number;
  /** Wall time spent submitting frames to the encoder / muxer. */
  encodeMs: number;
  /** Finalization (muxer close / buffer assembly). */
  finalizeMs: number;
  /** End-to-end wall time for the prepare→encode operation. */
  totalMs: number;
  frameCount: number;
  width: number;
  height: number;
  /** True when the result was served from the fingerprinted cache. */
  cacheHit: boolean;
}

export interface VideoRenderTimingBuilder {
  markSetupStart(): void;
  markSetupEnd(): void;
  addRenderMs(ms: number): void;
  addEncodeMs(ms: number): void;
  /** Accumulate muxer finalize wall time (measured around output.finalize()). */
  addFinalizeMs(ms: number): void;
  finish(options?: { cacheHit?: boolean; frameCount?: number; width?: number; height?: number }): VideoRenderTiming;
}

export function createVideoRenderTimingBuilder(): VideoRenderTimingBuilder {
  const started = performance.now();
  let setupStart = started;
  let setupMs = 0;
  let renderMs = 0;
  let encodeMs = 0;
  let finalizeMs = 0;
  let frameCount = 0;
  let width = 0;
  let height = 0;

  return {
    markSetupStart() {
      setupStart = performance.now();
    },
    markSetupEnd() {
      setupMs += Math.max(0, performance.now() - setupStart);
    },
    addRenderMs(ms: number) {
      if (Number.isFinite(ms) && ms > 0) renderMs += ms;
    },
    addEncodeMs(ms: number) {
      if (Number.isFinite(ms) && ms > 0) encodeMs += ms;
    },
    addFinalizeMs(ms: number) {
      if (Number.isFinite(ms) && ms > 0) finalizeMs += ms;
    },
    finish(options = {}) {
      frameCount = options.frameCount ?? frameCount;
      width = options.width ?? width;
      height = options.height ?? height;
      return {
        setupMs: Math.round(setupMs),
        renderMs: Math.round(renderMs),
        encodeMs: Math.round(encodeMs),
        finalizeMs: Math.round(finalizeMs),
        totalMs: Math.round(Math.max(0, performance.now() - started)),
        frameCount,
        width,
        height,
        cacheHit: options.cacheHit === true,
      };
    },
  };
}

export function createCacheHitTiming(params: {
  frameCount: number;
  width: number;
  height: number;
  totalMs?: number;
}): VideoRenderTiming {
  const totalMs = params.totalMs ?? 0;
  return {
    setupMs: 0,
    renderMs: 0,
    encodeMs: 0,
    finalizeMs: 0,
    totalMs,
    frameCount: params.frameCount,
    width: params.width,
    height: params.height,
    cacheHit: true,
  };
}

export function formatVideoRenderTiming(timing: VideoRenderTiming): string {
  if (timing.cacheHit) {
    return `cache hit · ${timing.totalMs}ms · ${timing.frameCount} frames · ${timing.width}×${timing.height}`;
  }
  return [
    `total ${timing.totalMs}ms`,
    `setup ${timing.setupMs}ms`,
    `render ${timing.renderMs}ms`,
    `encode ${timing.encodeMs}ms`,
    `finalize ${timing.finalizeMs}ms`,
    `${timing.frameCount} frames`,
    `${timing.width}×${timing.height}`,
  ].join(' · ');
}
