/**
 * Shared writer infrastructure used by both the legacy-v1 and forescene-v2 package
 * writers: progress tracking, cancellation, and low-level ZIP payload helpers.
 * Kept in its own module so `packageExport.ts` and `packageExportV2.ts` can both
 * depend on it without importing each other.
 */

import JSZip from 'jszip';
import type { ProjectAsset, Shot } from '../domain/types';
import { getShotExportProgressLabel } from './exportNaming';
import type { ExportPlan } from './exportPlan';
import { getProjectAssetBlob } from './projectAssetStore';
import type { CameraMoveExportProgress } from './renderers';

export type PackageExportPhase =
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'packaging'
  | 'compressing'
  | 'complete';

export interface PackageExportProgress {
  phase: PackageExportPhase;
  /** Overall 0–1 when determinate; ignored when `indeterminate` is true. */
  progress: number;
  currentShot: number;
  totalShots: number;
  shotId?: string;
  shotName?: string;
  message: string;
  /** Prefer a moving bar + message when true (e.g. early prep with no reliable %). */
  indeterminate?: boolean;
}

export class ShotPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShotPackageError';
  }
}

export function isPackageExportCancelled(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && /cancelled/i.test(error.message)) return true;
  return false;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Export cancelled.', 'AbortError');
  }
}

export interface PackageExportOptions {
  onProgress?: (progress: PackageExportProgress) => void;
  signal?: AbortSignal;
  /** Optional precomputed plan; when omitted, packaging builds one. */
  plan?: ExportPlan;
}

export interface ShotPackageResult {
  blob: Blob;
  fileName: string;
  manifestPaths: string[];
}

export interface ProgressTracker {
  report(partial: {
    phase: PackageExportPhase;
    message: string;
    shotIndex: number;
    shot?: Shot;
    completedUnits: number;
    unitFraction?: number;
    indeterminate?: boolean;
  }): void;
  advance(units?: number): void;
  readonly completedUnits: number;
  readonly totalUnits: number;
}

export function createProgressTracker(args: {
  shots: Shot[];
  totalUnits: number;
  onProgress?: (progress: PackageExportProgress) => void;
}): ProgressTracker {
  let completedUnits = 0;
  const totalUnits = Math.max(1, args.totalUnits);

  const report: ProgressTracker['report'] = (partial) => {
    const unitFraction = Math.min(1, Math.max(0, partial.unitFraction ?? 0));
    const progress = Math.min(1, (partial.completedUnits + unitFraction) / totalUnits);
    args.onProgress?.({
      phase: partial.phase,
      progress: partial.indeterminate ? 0 : progress,
      currentShot: partial.shotIndex + 1,
      totalShots: args.shots.length,
      shotId: partial.shot?.id,
      shotName: partial.shot ? getShotExportProgressLabel(partial.shot) : undefined,
      message: partial.message,
      indeterminate: partial.indeterminate,
    });
  };

  return {
    get completedUnits() {
      return completedUnits;
    },
    get totalUnits() {
      return totalUnits;
    },
    report,
    advance(units = 1) {
      completedUnits += units;
    },
  };
}

export async function compressZip(
  zip: JSZip,
  args: {
    tracker: ProgressTracker;
    shotIndex: number;
    shot?: Shot;
    signal?: AbortSignal;
  },
): Promise<Blob> {
  throwIfAborted(args.signal);
  args.tracker.report({
    phase: 'compressing',
    message: 'Compressing ZIP…',
    shotIndex: args.shotIndex,
    shot: args.shot,
    completedUnits: args.tracker.completedUnits,
    indeterminate: true,
  });

  const blob = await zip.generateAsync(
    { type: 'blob' },
    (metadata) => {
      // Cooperative: JSZip may still finish the current chunk before rejecting.
      if (args.signal?.aborted) {
        throw new DOMException('Export cancelled.', 'AbortError');
      }
      const fraction = Math.min(1, Math.max(0, (metadata.percent ?? 0) / 100));
      args.tracker.report({
        phase: 'compressing',
        message: fraction > 0 ? `Compressing ZIP… ${Math.round(fraction * 100)}%` : 'Compressing ZIP…',
        shotIndex: args.shotIndex,
        shot: args.shot,
        completedUnits: args.tracker.completedUnits,
        unitFraction: fraction,
        indeterminate: fraction <= 0,
      });
    },
  );

  throwIfAborted(args.signal);
  args.tracker.advance(1);
  return blob;
}

export function normalizeCameraMoveProgress(
  progress: number | CameraMoveExportProgress,
): {
  progress: number;
  message: string;
  completedFrames?: number;
  totalFrames?: number;
} {
  if (typeof progress === 'number') {
    return {
      progress: Math.min(1, Math.max(0, progress)),
      message: 'Encoding camera move…',
    };
  }
  return {
    progress: Math.min(1, Math.max(0, progress.progress)),
    message: progress.message || 'Encoding camera move…',
    completedFrames: progress.completedFrames,
    totalFrames: progress.totalFrames,
  };
}

export function addDataUrl(zip: JSZip, path: string, dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  zip.file(path, payload, { base64: /;base64/i.test(dataUrl.slice(0, Math.max(0, comma))) });
}

/** Add binary image/video data without materializing an inflated base64 string. */
export async function addBlobToZip(zip: JSZip, path: string, blob: Blob) {
  zip.file(path, await blob.arrayBuffer());
}

/** STORE compression for already-compressed PNG/MP4 payloads. */
export async function addBlobToZipStore(zip: JSZip, path: string, blob: Blob) {
  zip.file(path, await blob.arrayBuffer(), { compression: 'STORE' });
}

export async function addProjectAssetToZip(zip: JSZip, path: string, asset: ProjectAsset) {
  if (asset.storageKey) {
    const blob = await getProjectAssetBlob(asset.storageKey);
    if (!blob) throw new Error(`Local asset ${asset.name} is missing.`);
    zip.file(path, await blob.arrayBuffer());
    return;
  }
  await addBinaryToZip(zip, path, asset.uri);
}

/** Add a data URL or blob URL to the zip as binary. */
export async function addBinaryToZip(zip: JSZip, path: string, uri: string) {
  if (uri.startsWith('data:')) {
    addDataUrl(zip, path, uri);
    return;
  }
  if (uri.startsWith('blob:')) {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`Could not read local binary asset for ${path}.`);
    zip.file(path, await response.arrayBuffer());
    return;
  }
  // Opaque non-local URIs are not expected for in-app assets; retain the path for diagnostics.
  zip.file(path, uri);
}
