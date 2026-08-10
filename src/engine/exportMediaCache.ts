import type { CAMERA_MOVE_CUBEMAP_FACES } from './cameraMoveCubemap';

/** Per-export cache so shared panoramas / cubemaps are prepared once across shots. */
export type SharedCubemapCacheEntry = {
  faceSize: number;
  faces: Record<(typeof CAMERA_MOVE_CUBEMAP_FACES)[number], { blob: Blob; width: number; height: number }>;
  stitched: Blob;
};

export type SharedExportMediaCache = {
  preparedPanos: Map<string, string>;
  cubemaps: Map<string, SharedCubemapCacheEntry>;
  /** In-flight promises prevent duplicate GPU work when shot packaging overlaps. */
  pendingCubemaps: Map<string, Promise<SharedCubemapCacheEntry>>;
  pendingPreparedPanos: Map<string, Promise<string>>;
};

export function createSharedExportMediaCache(): SharedExportMediaCache {
  return {
    preparedPanos: new Map(),
    cubemaps: new Map(),
    pendingCubemaps: new Map(),
    pendingPreparedPanos: new Map(),
  };
}

export function cubemapCacheKey(
  assetId: string,
  rotation: unknown,
  faceSize: number,
): string {
  return `${assetId}|${JSON.stringify(rotation)}|${faceSize}`;
}

export function preparedPanoCacheKey(
  assetId: string,
  width: number,
  height: number,
  letterboxEnabled: boolean,
  targetWidth: number,
  targetHeight: number,
): string {
  return [
    assetId,
    width,
    height,
    letterboxEnabled ? 1 : 0,
    targetWidth,
    targetHeight,
  ].join('|');
}
