import {
  CAMERA_MOVE_CUBEMAP_FACES,
  CameraMoveCubemapFaceId,
  CameraMoveCubemapPixelCrop,
} from './cameraMoveCubemap';
import type { BlobImageRenderResult, ImageRenderResult } from './renderers';

/**
 * Standard cubemap cross layout aligned with renderPanoCubemapFace UV conventions.
 *
 *       [py]
 * [nx] [pz] [px] [nz]
 *       [ny]
 *
 * Adjacent tiles share edges so pixels along each seam stay continuous.
 */
export const CUBEMAP_CROSS_COLUMNS = 4;
export const CUBEMAP_CROSS_ROWS = 3;

export const CUBEMAP_CROSS_FACE_ORIGINS: Record<CameraMoveCubemapFaceId, { column: number; row: number }> = {
  nx: { column: 0, row: 1 },
  pz: { column: 1, row: 1 },
  px: { column: 2, row: 1 },
  nz: { column: 3, row: 1 },
  py: { column: 1, row: 0 },
  ny: { column: 1, row: 2 },
};

export interface CubemapCrossPixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CubemapVisibleStitchEntry {
  face: CameraMoveCubemapFaceId;
  dataUrl: string;
  crop: CameraMoveCubemapPixelCrop;
}

export function getCubemapCrossCanvasSize(faceSize: number): { width: number; height: number } {
  return {
    width: CUBEMAP_CROSS_COLUMNS * faceSize,
    height: CUBEMAP_CROSS_ROWS * faceSize,
  };
}

export function getCubemapCrossFaceRect(face: CameraMoveCubemapFaceId, faceSize: number): CubemapCrossPixelRect {
  const origin = CUBEMAP_CROSS_FACE_ORIGINS[face];
  return {
    x: origin.column * faceSize,
    y: origin.row * faceSize,
    width: faceSize,
    height: faceSize,
  };
}

export function getCubemapCrossCropRect(
  face: CameraMoveCubemapFaceId,
  crop: CameraMoveCubemapPixelCrop,
  faceSize: number,
): CubemapCrossPixelRect {
  const faceRect = getCubemapCrossFaceRect(face, faceSize);
  return {
    x: faceRect.x + crop.x,
    y: faceRect.y + crop.y,
    width: crop.width,
    height: crop.height,
  };
}

export function unionPixelRects(rects: CubemapCrossPixelRect[]): CubemapCrossPixelRect | undefined {
  if (rects.length === 0) return undefined;

  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Stitches all six cubemap faces into a continuous cross unfold on a transparent canvas.
 */
export async function stitchCubemapFacesCrossAsync(
  faces: Record<CameraMoveCubemapFaceId, ImageRenderResult>,
  faceSize: number,
): Promise<ImageRenderResult> {
  const { width, height } = getCubemapCrossCanvasSize(faceSize);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create canvas context.');
  context.clearRect(0, 0, width, height);

  for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
    const rect = getCubemapCrossFaceRect(face, faceSize);
    const image = await loadDataUrlImage(faces[face].dataUrl);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  }

  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/**
 * Blob equivalent of the master stitch. It keeps the source faces binary and
 * releases each temporary object URL immediately after it has been drawn.
 */
export async function stitchCubemapFaceBlobsCrossAsync(
  faces: Record<CameraMoveCubemapFaceId, BlobImageRenderResult>,
  faceSize: number,
): Promise<BlobImageRenderResult> {
  const { width, height } = getCubemapCrossCanvasSize(faceSize);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create canvas context.');
  context.clearRect(0, 0, width, height);

  for (const face of CAMERA_MOVE_CUBEMAP_FACES) {
    const rect = getCubemapCrossFaceRect(face, faceSize);
    const image = await loadBlobImage(faces[face].blob);
    try {
      context.drawImage(image.element, rect.x, rect.y, rect.width, rect.height);
    } finally {
      URL.revokeObjectURL(image.url);
    }
  }

  return { blob: await canvasToBlob(canvas, 'image/png'), width, height };
}

/**
 * Places visible face crops into the same cross layout and trims to their combined bounds.
 * Shared seams stay aligned even when only a subset of faces is visible.
 */
export async function stitchCubemapVisibleFacesAsync(
  entries: CubemapVisibleStitchEntry[],
  faceSize: number,
): Promise<ImageRenderResult> {
  if (entries.length === 0) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return { dataUrl: canvas.toDataURL('image/png'), width: 1, height: 1 };
  }

  const placedRects = entries.map((entry) => getCubemapCrossCropRect(entry.face, entry.crop, faceSize));
  const bounds = unionPixelRects(placedRects);
  if (!bounds) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return { dataUrl: canvas.toDataURL('image/png'), width: 1, height: 1 };
  }

  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create canvas context.');
  context.clearRect(0, 0, bounds.width, bounds.height);

  for (const entry of entries) {
    const rect = getCubemapCrossCropRect(entry.face, entry.crop, faceSize);
    const image = await loadDataUrlImage(entry.dataUrl);
    context.drawImage(
      image,
      entry.crop.x,
      entry.crop.y,
      entry.crop.width,
      entry.crop.height,
      rect.x - bounds.x,
      rect.y - bounds.y,
      entry.crop.width,
      entry.crop.height,
    );
  }

  return { dataUrl: canvas.toDataURL('image/png'), width: bounds.width, height: bounds.height };
}

function loadDataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load image.'));
    image.src = dataUrl;
  });
}

function loadBlobImage(blob: Blob): Promise<{ element: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ element: image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load cubemap face.'));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode stitched cubemap.'));
    }, type);
  });
}
