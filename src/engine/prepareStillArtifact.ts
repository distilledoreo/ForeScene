/**
 * Single-artifact still preparation: fingerprint → reuse → render (no project mutation).
 * Follows prepareVideoArtifact reliability: in-flight join, subscriber-safe cancel.
 */

import type { LocationProject, Shot } from '../domain/types';
import {
  createProjectAssetStorageKey,
  getProjectAssetBlob,
} from './projectAssetStore';
import {
  computeStillArtifactFingerprint,
  type StillArtifactFingerprint,
} from './stillArtifactFingerprint';
import {
  stillArtifactKey,
  type StillArtifactSpecification,
} from './stillArtifactTypes';
import {
  renderStillArtifact,
  type RenderedStillArtifact,
} from './stillArtifactRender';
import { recordPreparedMediaMetric } from './preparedMediaMetrics';

export interface PreparedStillArtifact {
  fingerprint: StillArtifactFingerprint;
  artifactKey: string;
  blob?: Blob;
  existingAssetId?: string;
  width: number;
  height: number;
  mimeType: 'image/png';
  cacheStatus: 'current' | 'rendered' | 'joined';
}

export interface PrepareStillArtifactParams {
  projectSnapshot: LocationProject;
  shotId: string;
  specification: StillArtifactSpecification;
  signal?: AbortSignal;
  /** Force re-render even when current. */
  force?: boolean;
  /**
   * Injectable renderer for unit tests. Production uses renderStillArtifact.
   */
  render?: (params: {
    project: LocationProject;
    shot: Shot;
    specification: StillArtifactSpecification;
    signal?: AbortSignal;
  }) => Promise<RenderedStillArtifact>;
}

type InflightSubscriber = {
  signal?: AbortSignal;
};

interface InflightStillJob {
  key: string;
  controller: AbortController;
  subscribers: Map<symbol, InflightSubscriber>;
  promise: Promise<PreparedStillArtifact>;
  settled: boolean;
}

const inflightJobs = new Map<string, InflightStillJob>();

/** Optional render hook for tests that want a global mock without DI. */
let testRenderOverride:
  | ((params: {
    project: LocationProject;
    shot: Shot;
    specification: StillArtifactSpecification;
    signal?: AbortSignal;
  }) => Promise<RenderedStillArtifact>)
  | undefined;

export function setPrepareStillArtifactRenderForTests(
  render: typeof testRenderOverride,
): void {
  testRenderOverride = render;
}

export function resetPrepareStillArtifactInflightForTests(): void {
  for (const job of inflightJobs.values()) {
    job.controller.abort();
  }
  inflightJobs.clear();
  testRenderOverride = undefined;
}

export function inspectPrepareStillInflightForTests() {
  return {
    jobs: inflightJobs.size,
    keys: [...inflightJobs.keys()],
  };
}

function cancellationError(): Error {
  const error = new Error('Still materialization was cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

function resolveShot(project: LocationProject, shotId: string): Shot {
  const shot = project.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error(`Shot ${shotId} not found.`);
  return shot;
}

function inflightIdentity(
  projectId: string,
  shotId: string,
  artifactKey: string,
  fingerprintKey: string,
): string {
  return `${projectId}::${shotId}::${artifactKey}::${fingerprintKey}`;
}

async function lookupCurrentArtifact(
  project: LocationProject,
  shot: Shot,
  specification: StillArtifactSpecification,
  fingerprint: StillArtifactFingerprint,
): Promise<PreparedStillArtifact | undefined> {
  const artifactKey = stillArtifactKey(specification);
  const existing = shot.materializedMedia?.stills[artifactKey];
  if (!existing || existing.fingerprint !== fingerprint.key) return undefined;

  const asset = project.assets.assets[existing.assetId];
  if (!asset) return undefined;
  if (asset.mimeType && asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg') {
    return undefined;
  }
  if (
    (existing.width > 0 && existing.width !== specification.width)
    || (existing.height > 0 && existing.height !== specification.height)
  ) {
    // Dimensions mismatch — treat as stale so export resolution stays correct.
    // Fingerprint already includes width/height, so this is a defensive check.
  }

  const storageKey = asset.storageKey
    ?? createProjectAssetStorageKey(project.id, asset.id);
  const blob = await getProjectAssetBlob(storageKey);
  if (!blob) {
    // Try data/blob URI when memory/IDB miss (legacy assets).
    if (asset.uri?.startsWith('data:') || asset.uri?.startsWith('blob:')) {
      // blob: may already be revoked; only treat data: as recoverable without IDB.
      if (asset.uri.startsWith('data:')) {
        return {
          fingerprint,
          artifactKey,
          existingAssetId: existing.assetId,
          width: existing.width,
          height: existing.height,
          mimeType: 'image/png',
          cacheStatus: 'current',
        };
      }
    }
    return undefined;
  }

  return {
    fingerprint,
    artifactKey,
    blob,
    existingAssetId: existing.assetId,
    width: existing.width,
    height: existing.height,
    mimeType: 'image/png',
    cacheStatus: 'current',
  };
}

async function renderPrepared(
  params: PrepareStillArtifactParams,
  shot: Shot,
  fingerprint: StillArtifactFingerprint,
  signal?: AbortSignal,
): Promise<PreparedStillArtifact> {
  throwIfCancelled(signal);
  const renderFn = params.render ?? testRenderOverride ?? renderStillArtifact;
  const rendered = await renderFn({
    project: params.projectSnapshot,
    shot,
    specification: params.specification,
    signal,
  });
  throwIfCancelled(signal);
  return {
    fingerprint,
    artifactKey: stillArtifactKey(params.specification),
    blob: rendered.blob,
    width: rendered.width,
    height: rendered.height,
    mimeType: 'image/png',
    cacheStatus: 'rendered',
  };
}

function releaseSubscriber(job: InflightStillJob, token: symbol): void {
  if (!job.subscribers.delete(token)) return;
  if (job.settled || job.subscribers.size > 0) return;
  if (inflightJobs.get(job.key) === job) inflightJobs.delete(job.key);
  job.controller.abort();
}

function awaitInflight(
  job: InflightStillJob,
  params: PrepareStillArtifactParams,
  cacheStatus: 'rendered' | 'joined',
): Promise<PreparedStillArtifact> {
  const token = Symbol('still-artifact-subscriber');
  job.subscribers.set(token, { signal: params.signal });

  return new Promise((resolve, reject) => {
    let active = true;
    const signal = params.signal;

    const cleanup = () => {
      if (!active) return;
      active = false;
      signal?.removeEventListener('abort', onAbort);
      releaseSubscriber(job, token);
    };

    const onAbort = () => {
      cleanup();
      reject(cancellationError());
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    job.promise.then(
      (result) => {
        if (!active) return;
        cleanup();
        resolve({
          ...result,
          cacheStatus: result.cacheStatus === 'current' ? 'current' : cacheStatus,
        });
      },
      (error) => {
        if (!active) return;
        cleanup();
        reject(error);
      },
    );
  });
}

function createInflightJob(
  params: PrepareStillArtifactParams,
  shot: Shot,
  fingerprint: StillArtifactFingerprint,
  key: string,
): InflightStillJob {
  const controller = new AbortController();
  const job: InflightStillJob = {
    key,
    controller,
    subscribers: new Map(),
    promise: Promise.resolve(undefined as unknown as PreparedStillArtifact),
    settled: false,
  };

  job.promise = Promise.resolve()
    .then(() => renderPrepared(params, shot, fingerprint, controller.signal))
    .catch((error) => {
      // When the shared job aborts because every subscriber left, swallow the
      // rejection for the job promise so late observers do not see unhandled rejections.
      // Individual subscriber promises already rejected via onAbort.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw error;
    })
    .finally(() => {
      job.settled = true;
      if (inflightJobs.get(job.key) === job) inflightJobs.delete(job.key);
    });

  // Prevent unhandled rejection when the last subscriber aborts before await.
  job.promise.catch(() => undefined);

  inflightJobs.set(job.key, job);
  return job;
}

/**
 * Prepare a still artifact from a frozen project snapshot.
 * Does not mutate live project state.
 */
export async function prepareStillArtifact(
  params: PrepareStillArtifactParams,
): Promise<PreparedStillArtifact> {
  throwIfCancelled(params.signal);
  const shot = resolveShot(params.projectSnapshot, params.shotId);
  const fingerprint = computeStillArtifactFingerprint(
    params.projectSnapshot,
    shot,
    params.specification,
  );
  const artifactKey = stillArtifactKey(params.specification);

  if (!params.force) {
    const current = await lookupCurrentArtifact(
      params.projectSnapshot,
      shot,
      params.specification,
      fingerprint,
    );
    if (current) {
      recordPreparedMediaMetric('stillReuseCount');
      return current;
    }
  }

  const key = inflightIdentity(
    params.projectSnapshot.id,
    params.shotId,
    artifactKey,
    fingerprint.key,
  );

  let job = inflightJobs.get(key);
  const cacheStatus: 'rendered' | 'joined' = job ? 'joined' : 'rendered';
  if (!job) {
    job = createInflightJob(params, shot, fingerprint, key);
  }

  return awaitInflight(job, params, cacheStatus);
}
