/**
 * Runtime (non-persisted) prepared-artifact status for UI and agent inspection.
 */

import type { LocationProject, Shot } from '../domain/types';
import { createProjectAssetStorageKey, getProjectAssetBlob } from './projectAssetStore';
import { computeStillArtifactFingerprint } from './stillArtifactFingerprint';
import {
  buildStillArtifactSpecificationsForShot,
  selectPrimaryStillSpecification,
} from './stillArtifactPlanning';
import { stillArtifactKey, type StillArtifactSpecification } from './stillArtifactTypes';

export type PreparedArtifactRuntimeStatus =
  | 'ready'
  | 'queued'
  | 'rendering'
  | 'stale'
  | 'missing'
  | 'failed';

export interface StillArtifactRuntimeEntry {
  key: string;
  specification: StillArtifactSpecification;
  status: PreparedArtifactRuntimeStatus;
  expectedFingerprint: string;
  materializedFingerprint?: string;
  assetId?: string;
  lastError?: string;
  isPrimary: boolean;
}

export interface ShotStillRuntimeStatus {
  shotId: string;
  overall: PreparedArtifactRuntimeStatus | 'partial';
  primary?: StillArtifactRuntimeEntry;
  artifacts: StillArtifactRuntimeEntry[];
  readyCount: number;
  totalCount: number;
  label: string;
}

/** A shot has entered prepared-media lifecycle when it has a materialized or legacy prepared still. */
export function shotHasPreparedMediaLifecycle(shot: Shot): boolean {
  if (Object.keys(shot.materializedMedia?.stills ?? {}).length > 0) return true;
  return Boolean(
    shot.assets.viewportRenderAssetId
    || shot.assets.viewportCleanPlateAssetId
    || shot.assets.viewportProjectedAssetId
    || shot.assets.viewportProjectedCleanPlateAssetId,
  );
}

/** Per-shot ephemeral job/error state (not written into project JSON). */
const shotRuntime = new Map<string, {
  jobs: Map<string, PreparedArtifactRuntimeStatus>;
  errors: Map<string, string>;
}>();
const runtimeListeners = new Set<() => void>();
const shotRuntimeListeners = new Map<string, Set<() => void>>();
const shotRuntimeVersions = new Map<string, number>();
let runtimeVersion = 0;

function notifyRuntimeListeners(shotId?: string): void {
  runtimeVersion += 1;
  if (shotId) shotRuntimeVersions.set(shotId, (shotRuntimeVersions.get(shotId) ?? 0) + 1);
  for (const listener of runtimeListeners) listener();
  if (shotId) {
    for (const listener of shotRuntimeListeners.get(shotId) ?? []) listener();
  }
}

/** Subscribe to actual prepared-still runtime transitions; no polling required. */
export function subscribeStillArtifactRuntime(listener: () => void): () => void;
export function subscribeStillArtifactRuntime(shotId: string, listener: () => void): () => void;
export function subscribeStillArtifactRuntime(
  shotIdOrListener: string | (() => void),
  maybeListener?: () => void,
): () => void {
  if (typeof shotIdOrListener === 'function') {
    runtimeListeners.add(shotIdOrListener);
    return () => runtimeListeners.delete(shotIdOrListener);
  }
  const listeners = shotRuntimeListeners.get(shotIdOrListener) ?? new Set<() => void>();
  listeners.add(maybeListener ?? (() => undefined));
  shotRuntimeListeners.set(shotIdOrListener, listeners);
  const listener = maybeListener;
  return () => {
    if (listener) listeners.delete(listener);
    if (listeners.size === 0) shotRuntimeListeners.delete(shotIdOrListener);
  };
}

export function getStillArtifactRuntimeVersion(shotId?: string): number {
  return shotId ? (shotRuntimeVersions.get(shotId) ?? 0) : runtimeVersion;
}

export function setStillArtifactJobStatus(
  shotId: string,
  artifactKey: string,
  status: PreparedArtifactRuntimeStatus | null,
): void {
  let entry = shotRuntime.get(shotId);
  if (!entry) {
    if (status === null) return;
    entry = { jobs: new Map(), errors: new Map() };
    shotRuntime.set(shotId, entry);
  }

  const previous = entry.jobs.get(artifactKey);
  if (status === null) {
    if (!entry.jobs.delete(artifactKey)) return;
  } else {
    if (previous === status) return;
    entry.jobs.set(artifactKey, status);
  }
  if (entry.jobs.size === 0 && entry.errors.size === 0) {
    shotRuntime.delete(shotId);
  }
  notifyRuntimeListeners(shotId);
}

export function setStillArtifactError(
  shotId: string,
  artifactKey: string,
  error: string | null,
): void {
  let entry = shotRuntime.get(shotId);
  if (!entry) {
    if (error === null) return;
    entry = { jobs: new Map(), errors: new Map() };
    shotRuntime.set(shotId, entry);
  }

  const previous = entry.errors.get(artifactKey);
  if (error === null) {
    if (!entry.errors.delete(artifactKey)) return;
  } else {
    if (previous === error) return;
    entry.errors.set(artifactKey, error);
  }
  if (entry.jobs.size === 0 && entry.errors.size === 0) {
    shotRuntime.delete(shotId);
  }
  notifyRuntimeListeners(shotId);
}

export function clearStillArtifactRuntime(shotId?: string): void {
  if (shotId) {
    if (!shotRuntime.delete(shotId)) return;
    notifyRuntimeListeners(shotId);
  } else {
    if (shotRuntime.size === 0) return;
    const affected = [...shotRuntime.keys()];
    shotRuntime.clear();
    for (const id of affected) notifyRuntimeListeners(id);
  }
}

export function resetStillArtifactRuntimeForTests(): void {
  const changed = shotRuntime.size > 0;
  shotRuntime.clear();
  if (changed) notifyRuntimeListeners();
}

const statusCache = new WeakMap<object, Map<string, {
  shot: Shot;
  version: number;
  status: ShotStillRuntimeStatus;
}>>();

function deriveEntryStatus(
  project: LocationProject,
  shot: Shot,
  spec: StillArtifactSpecification,
  expectedFingerprint: string,
): Omit<StillArtifactRuntimeEntry, 'isPrimary' | 'specification' | 'expectedFingerprint' | 'key'> {
  const key = stillArtifactKey(spec);
  const runtime = shotRuntime.get(shot.id);
  const jobStatus = runtime?.jobs.get(key);
  if (jobStatus === 'queued' || jobStatus === 'rendering') {
    return {
      status: jobStatus,
      materializedFingerprint: shot.materializedMedia?.stills[key]?.fingerprint,
      assetId: shot.materializedMedia?.stills[key]?.assetId,
      lastError: runtime?.errors.get(key),
    };
  }

  const lastError = runtime?.errors.get(key);
  const existing = shot.materializedMedia?.stills[key];
  if (!existing) {
    return {
      status: lastError ? 'failed' : 'missing',
      lastError,
    };
  }

  if (existing.fingerprint !== expectedFingerprint) {
    return {
      status: lastError ? 'failed' : 'stale',
      materializedFingerprint: existing.fingerprint,
      assetId: existing.assetId,
      lastError,
    };
  }

  const asset = project.assets.assets[existing.assetId];
  if (!asset) {
    return {
      status: 'missing',
      materializedFingerprint: existing.fingerprint,
      assetId: existing.assetId,
      lastError: lastError ?? 'Referenced project asset is missing.',
    };
  }

  return {
    status: lastError ? 'failed' : 'ready',
    materializedFingerprint: existing.fingerprint,
    assetId: existing.assetId,
    lastError,
  };
}

export function inspectShotStillRuntime(
  project: LocationProject,
  shot: Shot | string,
): ShotStillRuntimeStatus {
  const resolvedShot = typeof shot === 'string'
    ? project.shots.find((item) => item.id === shot)
    : shot;
  if (!resolvedShot) {
    return {
      shotId: typeof shot === 'string' ? shot : '',
      overall: 'missing',
      artifacts: [],
      readyCount: 0,
      totalCount: 0,
      label: 'Shot not found',
    };
  }

  const version = getStillArtifactRuntimeVersion(resolvedShot.id);
  const cachedForProject = statusCache.get(project);
  const cached = cachedForProject?.get(resolvedShot.id);
  if (cached && cached.shot === resolvedShot && cached.version === version) return cached.status;

  const specs = buildStillArtifactSpecificationsForShot({
    project,
    shot: resolvedShot,
    purpose: 'reconcile',
  });
  const primary = selectPrimaryStillSpecification(project, resolvedShot, specs);
  const primaryKey = stillArtifactKey(primary);

  const artifacts: StillArtifactRuntimeEntry[] = specs.map((spec) => {
    const key = stillArtifactKey(spec);
    const expected = computeStillArtifactFingerprint(project, resolvedShot, spec);
    const derived = deriveEntryStatus(project, resolvedShot, spec, expected.key);
    return {
      key,
      specification: spec,
      expectedFingerprint: expected.key,
      isPrimary: key === primaryKey,
      ...derived,
    };
  });

  const primaryEntry = artifacts.find((item) => item.isPrimary);
  const readyCount = artifacts.filter((item) => item.status === 'ready').length;
  const totalCount = artifacts.length;
  const anyRendering = artifacts.some(
    (item) => item.status === 'rendering' || item.status === 'queued',
  );
  const anyFailed = artifacts.some((item) => item.status === 'failed');
  const anyStale = artifacts.some((item) => item.status === 'stale' || item.status === 'missing');

  let overall: ShotStillRuntimeStatus['overall'] = 'ready';
  if (anyRendering) overall = 'rendering';
  else if (primaryEntry?.status === 'failed') overall = 'failed';
  else if (anyFailed && readyCount > 0) overall = 'partial';
  else if (anyStale) overall = readyCount > 0 ? 'partial' : 'missing';
  else if (readyCount === totalCount && totalCount > 0) overall = 'ready';
  else if (readyCount > 0) overall = 'partial';
  else overall = 'missing';

  const label = buildStatusLabel(overall, readyCount, totalCount, primaryEntry);

  const status: ShotStillRuntimeStatus = {
    shotId: resolvedShot.id,
    overall,
    primary: primaryEntry,
    artifacts,
    readyCount,
    totalCount,
    label,
  };
  const projectCache = cachedForProject ?? new Map();
  projectCache.set(resolvedShot.id, { shot: resolvedShot, version, status });
  statusCache.set(project, projectCache);
  return status;
}

function buildStatusLabel(
  overall: ShotStillRuntimeStatus['overall'],
  readyCount: number,
  totalCount: number,
  primary?: StillArtifactRuntimeEntry,
): string {
  if (overall === 'rendering' || overall === 'queued') {
    if (primary?.status === 'rendering' || primary?.status === 'queued') {
      return 'Updating projected reference…'.replace(
        'projected',
        primary.specification.appearance === 'clay'
          ? 'clay'
          : primary.specification.appearance === 'depth'
            ? 'depth'
            : 'projected',
      );
    }
    return 'Updating references…';
  }
  if (overall === 'failed') return 'Reference generation failed';
  if (overall === 'ready') return 'References ready';
  if (totalCount > 0) return `${readyCount} of ${totalCount} references ready`;
  return 'No references configured';
}

/**
 * Resolve the best available primary preview asset id for a shot card.
 * Order: current primary → stale primary → legacy viewport asset.
 */
export function resolvePrimaryStillPreviewAssetId(
  project: LocationProject,
  shot: Shot,
): { assetId?: string; stale: boolean; source: 'materialized' | 'legacy' | 'none' } {
  const status = inspectShotStillRuntime(project, shot);
  const primary = status.primary;
  if (primary?.assetId) {
    const asset = project.assets.assets[primary.assetId];
    if (asset) {
      return {
        assetId: primary.assetId,
        stale: primary.status === 'stale' || primary.status === 'failed',
        source: 'materialized',
      };
    }
  }

  const legacy =
    shot.assets.viewportProjectedAssetId
    ?? shot.assets.viewportRenderAssetId
    ?? shot.assets.viewportCleanPlateAssetId
    ?? shot.assets.viewportProjectedCleanPlateAssetId;

  if (legacy && project.assets.assets[legacy]) {
    return { assetId: legacy, stale: false, source: 'legacy' };
  }

  return { source: 'none', stale: false };
}

/** Async check that a materialized asset still has retrievable bytes. */
export async function hasRetrievableStillBlob(
  project: LocationProject,
  assetId: string,
): Promise<boolean> {
  const asset = project.assets.assets[assetId];
  if (!asset) return false;
  if (asset.uri?.startsWith('data:')) return true;
  const key = asset.storageKey ?? createProjectAssetStorageKey(project.id, assetId);
  const blob = await getProjectAssetBlob(key);
  return Boolean(blob);
}
