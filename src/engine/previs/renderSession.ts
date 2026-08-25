/**
 * Persistent render session contract — one browser load per production run.
 */

import type { RenderProfile } from './renderProfiles';

export interface RenderSessionShotJob {
  shotId: string;
  shotNumber: string;
  framePath: string;
  locationId?: string;
  timeSeconds?: number;
  appearance?: RenderProfile['appearance'];
  debugUiPath?: string;
  /** Capture a successful UI screenshot only when an operator explicitly asks. */
  captureDebugUi?: boolean;
  /** Content-addressed render inputs for resumable/cache-aware runs. */
  renderFingerprint?: string;
}

export interface RenderSessionFrameResult {
  ok: boolean;
  shotId: string;
  shotNumber: string;
  framePath: string;
  width: number;
  height: number;
  pixelStats?: {
    width: number;
    height: number;
    opaquePixelRatio: number;
    luminanceMean: number;
    luminanceVariance: number;
    sampledUniqueColorCount: number;
  };
  revisionId?: string;
  error?: string;
  fromCanonicalRenderer: boolean;
  source?: 'canonical_clay_renderer' | 'canonical_projected_renderer';
  renderProfileId: string;
  renderFingerprint?: string;
}

export interface RenderSessionBatchResult {
  results: RenderSessionFrameResult[];
  renderedCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface RenderSessionStats {
  shotsRendered: number;
  shotsFailed: number;
  shotsSkipped: number;
  projectLoaded: boolean;
  startedAt: string;
  lastRenderAt?: string;
}

/** Engine-level session descriptor persisted alongside run-state. */
export interface RenderSessionDescriptor {
  sessionId: string;
  renderProfileId: string;
  renderProfileFingerprint: string;
  revisionId?: string;
  projectId?: string;
  createdAt: string;
  closedAt?: string;
}

export function groupJobsByLocation<T extends { locationId?: string }>(
  jobs: T[],
  locationOrder?: string[],
): Array<{ locationId: string; jobs: T[] }> {
  const groups = new Map<string, T[]>();
  for (const job of jobs) {
    const key = job.locationId ?? '__default__';
    const list = groups.get(key) ?? [];
    list.push(job);
    groups.set(key, list);
  }

  const orderedKeys = locationOrder?.length
    ? [
      ...locationOrder.filter((id) => groups.has(id)),
      ...[...groups.keys()].filter((id) => !locationOrder.includes(id)),
    ]
    : [...groups.keys()];

  return orderedKeys.map((locationId) => ({
    locationId,
    jobs: groups.get(locationId) ?? [],
  }));
}

export function buildRenderInputFromProfile(
  profile: RenderProfile,
  shotId: string,
  timeSeconds?: number,
  appearance: RenderProfile['appearance'] = profile.appearance,
): {
  shotId: string;
  timeSeconds?: number;
  appearance: RenderProfile['appearance'];
  peopleVariant?: RenderProfile['peopleVariant'];
  content?: RenderProfile['content'];
  width?: number;
  height?: number;
} {
  return {
    shotId,
    timeSeconds,
    appearance,
    peopleVariant: profile.peopleVariant,
    content: profile.content,
    ...(profile.overrideDimensions
      ? { width: profile.width, height: profile.height }
      : {}),
  };
}
