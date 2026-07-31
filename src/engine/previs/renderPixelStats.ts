/**
 * Pixel-level sanity checks for clean clay frames.
 * Rejects blank, transparent, and zero-variance canvases without OCR.
 */

export interface RenderPixelStats {
  width: number;
  height: number;
  opaquePixelRatio: number;
  luminanceMean: number;
  luminanceVariance: number;
  sampledUniqueColorCount: number;
}

export interface PixelStatsRejection {
  code: 'frame_blank' | 'frame_transparent' | 'frame_zero_variance' | 'frame_zero_size' | 'frame_not_produced';
  message: string;
}

const SAMPLE_STRIDE = 8;
const MIN_OPAQUE_RATIO = 0.02;
const MIN_LUMINANCE_VARIANCE = 1e-6;
const MIN_UNIQUE_COLORS = 3;

/**
 * Sample RGBA pixel buffer (row-major, 4 bytes per pixel).
 * Stride sampling keeps cost low for large export frames.
 */
export function computeRenderPixelStats(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): RenderPixelStats {
  if (width <= 0 || height <= 0 || data.length < 4) {
    return {
      width,
      height,
      opaquePixelRatio: 0,
      luminanceMean: 0,
      luminanceVariance: 0,
      sampledUniqueColorCount: 0,
    };
  }

  let opaque = 0;
  let sampled = 0;
  let sumL = 0;
  let sumL2 = 0;
  const unique = new Set<number>();

  for (let y = 0; y < height; y += SAMPLE_STRIDE) {
    for (let x = 0; x < width; x += SAMPLE_STRIDE) {
      const i = (y * width + x) * 4;
      if (i + 3 >= data.length) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;
      sampled += 1;
      if (a > 8) opaque += 1;
      // Rec. 601 luminance, normalized 0–1.
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      sumL += l;
      sumL2 += l * l;
      // Quantize to reduce noise-driven unique counts.
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      unique.add(key);
    }
  }

  const mean = sampled > 0 ? sumL / sampled : 0;
  const variance = sampled > 0 ? Math.max(0, sumL2 / sampled - mean * mean) : 0;

  return {
    width,
    height,
    opaquePixelRatio: sampled > 0 ? opaque / sampled : 0,
    luminanceMean: mean,
    luminanceVariance: variance,
    sampledUniqueColorCount: unique.size,
  };
}

/** Read pixel stats from a canvas (or OffscreenCanvas with 2d fallback via WebGL readback). */
export function computeCanvasPixelStats(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): RenderPixelStats {
  const width = canvas.width;
  const height = canvas.height;
  if (width <= 0 || height <= 0) {
    return computeRenderPixelStats(new Uint8Array(0), width, height);
  }

  // Prefer 2d getImageData when available (WebGL canvases often reject 2d context).
  try {
    if ('getContext' in canvas) {
      const existing = (canvas as HTMLCanvasElement).getContext?.('2d');
      if (existing) {
        const image = existing.getImageData(0, 0, width, height);
        return computeRenderPixelStats(image.data, width, height);
      }
    }
  } catch {
    // Fall through to WebGL readback.
  }

  try {
    const gl = (canvas as HTMLCanvasElement).getContext?.('webgl2')
      ?? (canvas as HTMLCanvasElement).getContext?.('webgl');
    if (gl) {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return computeRenderPixelStats(pixels, width, height);
    }
  } catch {
    // Fall through.
  }

  return {
    width,
    height,
    opaquePixelRatio: 0,
    luminanceMean: 0,
    luminanceVariance: 0,
    sampledUniqueColorCount: 0,
  };
}

/**
 * Decode a PNG data URL and sample pixels via an Image + canvas.
 * Browser-only; used by the Agent API after clean clay encoding.
 */
export async function computePixelStatsFromDataUrl(
  dataUrl: string,
): Promise<RenderPixelStats> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return {
      width: 0,
      height: 0,
      opaquePixelRatio: 0,
      luminanceMean: 0,
      luminanceVariance: 0,
      sampledUniqueColorCount: 0,
    };
  }

  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width <= 0 || canvas.height <= 0) {
    return computeRenderPixelStats(new Uint8Array(0), canvas.width, canvas.height);
  }
  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return computeRenderPixelStats(imageData.data, canvas.width, canvas.height);
}

export function rejectRenderPixelStats(
  stats: RenderPixelStats | undefined,
): PixelStatsRejection | null {
  if (!stats) {
    return {
      code: 'frame_not_produced',
      message: 'Clean render canvas has not produced a frame.',
    };
  }
  if (stats.width <= 0 || stats.height <= 0) {
    return {
      code: 'frame_zero_size',
      message: `Frame dimensions are zero (${stats.width}×${stats.height}).`,
    };
  }
  if (stats.opaquePixelRatio < MIN_OPAQUE_RATIO) {
    return {
      code: 'frame_transparent',
      message: `Nearly all pixels are transparent (opaque ratio ${stats.opaquePixelRatio.toFixed(4)}).`,
    };
  }
  if (
    stats.luminanceVariance < MIN_LUMINANCE_VARIANCE
    || stats.sampledUniqueColorCount < MIN_UNIQUE_COLORS
  ) {
    return {
      code: 'frame_zero_variance',
      message: `Pixel variance is effectively zero (var=${stats.luminanceVariance.toExponential(2)}, unique=${stats.sampledUniqueColorCount}).`,
    };
  }
  return null;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode PNG data URL.'));
    image.src = dataUrl;
  });
}
