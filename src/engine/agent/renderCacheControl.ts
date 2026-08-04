/** Browser-owned persistence and inspection adapters for the render cache. */

import { useProjectStore } from '../../state/useProjectStore';
import {
  clearRenderCache,
  explainRenderCacheHit,
  explainRenderCacheMiss,
  inspectRenderCache,
  invalidateRenderDependencies,
  recordRenderCacheEntry,
  type RenderCacheDecision,
  type RenderCacheIndex,
  type RenderCacheInspection,
  type RenderFingerprint,
} from '../previs/renderCache';

const STORAGE_KEY = 'forescene.render-cache.v1';
const indexes = new Map<string, RenderCacheIndex>();

function projectKey(projectId?: string): string {
  return projectId ?? useProjectStore.getState().project.id ?? 'default';
}

function loadIndex(key: string): RenderCacheIndex {
  const cached = indexes.get(key);
  if (cached) return cached;
  if (typeof window === 'undefined') {
    const empty = clearRenderCache();
    indexes.set(key, empty);
    return empty;
  }
  try {
    const stored = JSON.parse(window.localStorage.getItem(`${STORAGE_KEY}:${key}`) ?? 'null') as RenderCacheIndex | null;
    if (stored?.version === 1 && stored.entries && typeof stored.entries === 'object') {
      indexes.set(key, stored);
      return stored;
    }
  } catch {
    // A corrupt cache must be treated as empty; project revisions remain authoritative.
  }
  const empty = clearRenderCache();
  indexes.set(key, empty);
  return empty;
}

function saveIndex(key: string, index: RenderCacheIndex): RenderCacheIndex {
  indexes.set(key, index);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(`${STORAGE_KEY}:${key}`, JSON.stringify(index));
    } catch {
      // Cache persistence is opportunistic and must never block production recovery.
    }
  }
  return index;
}

export function inspectAgentRenderCache(input: { projectId?: string } = {}): RenderCacheInspection {
  return inspectRenderCache(loadIndex(projectKey(input.projectId)));
}

export function explainAgentRenderCacheHit(input: { projectId?: string; fingerprint: RenderFingerprint }): RenderCacheDecision {
  return explainRenderCacheHit(loadIndex(projectKey(input.projectId)), input.fingerprint);
}

export function explainAgentRenderCacheMiss(input: { projectId?: string; fingerprint: RenderFingerprint }): RenderCacheDecision {
  return explainRenderCacheMiss(loadIndex(projectKey(input.projectId)), input.fingerprint);
}

export function invalidateAgentRenderDependencies(input: { projectId?: string; dependencyIds: string[] }): RenderCacheInspection {
  const key = projectKey(input.projectId);
  return inspectRenderCache(saveIndex(key, invalidateRenderDependencies(loadIndex(key), input.dependencyIds)));
}

export function clearAgentRenderCache(input: { projectId?: string } = {}): RenderCacheInspection {
  const key = projectKey(input.projectId);
  return inspectRenderCache(saveIndex(key, clearRenderCache()));
}

/** Internal adapter used by browser-owned production runs after a verified render. */
export function recordAgentRenderCacheEntry(input: {
  projectId?: string;
  fingerprint: RenderFingerprint;
  artifactId?: string;
  artifactPath?: string;
  sourceRevisionId?: string;
}): RenderCacheInspection {
  const key = projectKey(input.projectId);
  const index = recordRenderCacheEntry(loadIndex(key), input.fingerprint, {
    artifactId: input.artifactId,
    artifactPath: input.artifactPath,
    sourceRevisionId: input.sourceRevisionId,
    createdAt: new Date().toISOString(),
  });
  return inspectRenderCache(saveIndex(key, index));
}

export function resetAgentRenderCacheForTests(): void {
  indexes.clear();
  if (typeof window !== 'undefined') {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${STORAGE_KEY}:`)) window.localStorage.removeItem(key);
    }
  }
}
