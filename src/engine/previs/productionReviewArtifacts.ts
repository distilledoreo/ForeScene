/**
 * Deterministic, project-wide review artifact planning.
 *
 * This module plans the metadata and grouping for review sheets. Image
 * composition remains an adapter concern (the existing contact-sheet renderer
 * consumes the returned ContactSheetSpec), so an external visual review can
 * never mutate project state merely by proposing a repair.
 */

import {
  buildContactSheetSpec,
  type ContactSheetShotEntry,
  type ContactSheetSpec,
} from './contactSheet';

export type ProductionReviewArtifactKind =
  | 'master_sequence'
  | 'location_sheet'
  | 'motion_triptych'
  | 'continuity_strip';

export type ProductionReviewStatus = 'pending' | 'approved' | 'failed' | 'needs_review';

export interface ProductionReviewSampleInput {
  timeSeconds: number;
  framePath: string;
  status?: ProductionReviewStatus;
  warningCount?: number;
  cacheHit?: boolean;
}

export interface ProductionReviewFrameInput {
  shotId: string;
  shotNumber: string;
  name: string;
  framePath: string;
  locationId?: string;
  cameraRecipe?: string;
  sampleTimeSeconds?: number;
  status?: ProductionReviewStatus;
  warningCount?: number;
  presenceStatus?: string;
  panoramaStatus?: string;
  compositionError?: number;
  reviewStatus?: ProductionReviewStatus;
  cacheHit?: boolean;
  fromCanonicalRenderer?: boolean;
  diagnosticCodes?: string[];
  motionSamples?: ProductionReviewSampleInput[];
}

export interface ProductionReviewTileMetadata {
  shotId: string;
  shotNumber: string;
  name: string;
  sampleTimeSeconds: number;
  locationId?: string;
  cameraRecipe?: string;
  presenceStatus: string;
  panoramaStatus: string;
  compositionError?: number;
  reviewStatus: ProductionReviewStatus;
  cacheHit?: boolean;
  fromCanonicalRenderer?: boolean;
  diagnosticCodes: string[];
}

export interface ProductionReviewTile {
  id: string;
  framePath: string;
  metadata: ProductionReviewTileMetadata;
}

export interface ProductionReviewArtifactPlan {
  id: string;
  kind: ProductionReviewArtifactKind;
  title: string;
  shotIds: string[];
  tiles: ProductionReviewTile[];
  contactSheet: ContactSheetSpec;
}

export interface ProductionReviewArtifactPlanResult {
  artifacts: ProductionReviewArtifactPlan[];
  shotIds: string[];
  locationIds: string[];
}

export interface ProductionVisualReview {
  approvedShotIds: string[];
  failedShots: Array<{
    shotId: string;
    category: string;
    reason: string;
    confidence: number;
  }>;
  systemicPatterns: Array<{
    category: string;
    affectedShotIds: string[];
  }>;
}

export interface ProductionRepairIntent {
  shotId: string;
  category: string;
  reason: string;
  confidence: number;
  /** Every intent must be routed through previewed, verified mutation APIs. */
  requiresVerifiedMutation: true;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function defaultReviewStatus(frame: ProductionReviewFrameInput): ProductionReviewStatus {
  return frame.reviewStatus ?? frame.status ?? 'pending';
}

function tileBadges(metadata: ProductionReviewTileMetadata): string[] {
  const badges: string[] = [];
  if (metadata.presenceStatus !== 'passed') badges.push(`presence:${metadata.presenceStatus}`);
  if (metadata.panoramaStatus !== 'passed') badges.push(`pano:${metadata.panoramaStatus}`);
  if (metadata.reviewStatus !== 'pending') badges.push(`review:${metadata.reviewStatus}`);
  if (metadata.cacheHit !== undefined) badges.push(metadata.cacheHit ? 'cache:hit' : 'cache:miss');
  badges.push(...metadata.diagnosticCodes.slice(0, 3).map((code) => `diag:${code}`));
  return badges;
}

function toContactSheetEntry(tile: ProductionReviewTile): ContactSheetShotEntry {
  const metadata = tile.metadata;
  return {
    shotNumber: metadata.shotNumber,
    name: metadata.name,
    framePath: tile.framePath,
    status: metadata.reviewStatus,
    warningCount: metadata.diagnosticCodes.length,
    fromCanonicalRenderer: metadata.fromCanonicalRenderer,
    sampleTimeSeconds: metadata.sampleTimeSeconds,
    locationId: metadata.locationId,
    cameraRecipe: metadata.cameraRecipe,
    presenceStatus: metadata.presenceStatus,
    panoramaStatus: metadata.panoramaStatus,
    compositionError: metadata.compositionError,
    reviewStatus: metadata.reviewStatus,
    cacheHit: metadata.cacheHit,
    badges: tileBadges(metadata),
  };
}

function createTile(
  frame: ProductionReviewFrameInput,
  sample: ProductionReviewSampleInput | undefined,
  suffix: string,
): ProductionReviewTile {
  const metadata: ProductionReviewTileMetadata = {
    shotId: frame.shotId,
    shotNumber: frame.shotNumber,
    name: frame.name,
    sampleTimeSeconds: sample?.timeSeconds ?? frame.sampleTimeSeconds ?? 0,
    ...(frame.locationId ? { locationId: frame.locationId } : {}),
    ...(frame.cameraRecipe ? { cameraRecipe: frame.cameraRecipe } : {}),
    presenceStatus: frame.presenceStatus ?? 'unknown',
    panoramaStatus: frame.panoramaStatus ?? 'unknown',
    ...(frame.compositionError === undefined ? {} : { compositionError: frame.compositionError }),
    reviewStatus: sample?.status ?? defaultReviewStatus(frame),
    ...(sample?.cacheHit ?? frame.cacheHit) === undefined
      ? {}
      : { cacheHit: sample?.cacheHit ?? frame.cacheHit },
    ...(frame.fromCanonicalRenderer === undefined ? {} : { fromCanonicalRenderer: frame.fromCanonicalRenderer }),
    diagnosticCodes: [...(frame.diagnosticCodes ?? [])],
  };
  return {
    id: `${frame.shotId}:${suffix}`,
    framePath: sample?.framePath ?? frame.framePath,
    metadata,
  };
}

function createArtifact(
  id: string,
  kind: ProductionReviewArtifactKind,
  title: string,
  tiles: ProductionReviewTile[],
  columns?: number,
): ProductionReviewArtifactPlan {
  return {
    id,
    kind,
    title,
    shotIds: sortedUnique(tiles.map((tile) => tile.metadata.shotId)),
    tiles,
    contactSheet: buildContactSheetSpec({
      title,
      columns,
      shots: tiles.map(toContactSheetEntry),
    }),
  };
}

/**
 * Build the master sheet, location sheets, motion triptychs, and adjacent
 * continuity strips from one ordered set of rendered review frames.
 */
export function buildProductionReviewArtifacts(params: {
  frames: ProductionReviewFrameInput[];
  continuityStripSize?: number;
}): ProductionReviewArtifactPlanResult {
  const frames = [...params.frames];
  const artifacts: ProductionReviewArtifactPlan[] = [];
  const primaryTiles = frames.map((frame) => createTile(frame, undefined, 'primary'));

  if (primaryTiles.length > 0) {
    artifacts.push(createArtifact('master-sequence', 'master_sequence', 'ForeScene — Master Sequence', primaryTiles));
  }

  const locationGroups = new Map<string, ProductionReviewTile[]>();
  for (const tile of primaryTiles) {
    const locationId = tile.metadata.locationId ?? '__unassigned__';
    const group = locationGroups.get(locationId) ?? [];
    group.push(tile);
    locationGroups.set(locationId, group);
  }
  for (const locationId of [...locationGroups.keys()].sort()) {
    const group = locationGroups.get(locationId)!;
    artifacts.push(createArtifact(
      `location-${safeId(locationId)}`,
      'location_sheet',
      `ForeScene — Location ${locationId === '__unassigned__' ? 'Unassigned' : locationId}`,
      group,
    ));
  }

  for (const frame of frames) {
    const samples = frame.motionSamples ?? [];
    if (samples.length < 2) continue;
    const ordered = [...samples].sort((a, b) => a.timeSeconds - b.timeSeconds);
    const triptychSamples = ordered.length <= 3
      ? ordered
      : [ordered[0]!, ordered[Math.floor(ordered.length / 2)]!, ordered[ordered.length - 1]!];
    const tiles = triptychSamples.map((sample, index) => createTile(frame, sample, `motion-${index}`));
    artifacts.push(createArtifact(
      `motion-triptych-${safeId(frame.shotId)}`,
      'motion_triptych',
      `ForeScene — Motion ${frame.shotNumber} ${frame.name}`,
      tiles,
      3,
    ));
  }

  const stripSize = Math.max(2, Math.floor(params.continuityStripSize ?? 4));
  for (let start = 0, stripIndex = 0; start < primaryTiles.length - 1; start += stripSize, stripIndex += 1) {
    const tiles = primaryTiles.slice(start, start + stripSize);
    if (tiles.length < 2) break;
    artifacts.push(createArtifact(
      `continuity-${stripIndex + 1}`,
      'continuity_strip',
      `ForeScene — Continuity ${tiles[0]!.metadata.shotNumber}–${tiles[tiles.length - 1]!.metadata.shotNumber}`,
      tiles,
    ));
  }

  return {
    artifacts,
    shotIds: frames.map((frame) => frame.shotId),
    locationIds: [...locationGroups.keys()].filter((id) => id !== '__unassigned__'),
  };
}

/** Normalize an external review proposal to known shots without mutating a project. */
export function normalizeProductionVisualReview(
  review: Partial<ProductionVisualReview>,
  knownShotIds: Iterable<string>,
): ProductionVisualReview {
  const known = new Set(knownShotIds);
  const failedShots = (review.failedShots ?? [])
    .filter((item) => known.has(item.shotId))
    .map((item) => ({
      shotId: item.shotId,
      category: item.category,
      reason: item.reason,
      confidence: Math.max(0, Math.min(1, item.confidence)),
    }));
  const failedIds = new Set(failedShots.map((item) => item.shotId));
  const approvedShotIds = sortedUnique((review.approvedShotIds ?? []).filter((shotId) => known.has(shotId) && !failedIds.has(shotId)));
  const systemicPatterns = (review.systemicPatterns ?? [])
    .map((pattern) => ({
      category: pattern.category,
      affectedShotIds: sortedUnique(pattern.affectedShotIds.filter((shotId) => known.has(shotId))),
    }))
    .filter((pattern) => pattern.affectedShotIds.length > 0);
  return { approvedShotIds, failedShots, systemicPatterns };
}

/** Convert review failures into non-mutating intents for verified repair APIs. */
export function createProductionRepairIntents(review: ProductionVisualReview): ProductionRepairIntent[] {
  return review.failedShots.map((failure) => ({
    shotId: failure.shotId,
    category: failure.category,
    reason: failure.reason,
    confidence: failure.confidence,
    requiresVerifiedMutation: true,
  }));
}
