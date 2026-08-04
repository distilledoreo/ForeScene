/** Content-addressed still-render fingerprints and cache index helpers. */

import type { LocationProject, SceneObject, Shot } from '../../domain/types';
import { sampleShotTimeline } from '../shotTimeline';
import type { RenderProfile } from './renderProfiles';

export const RENDER_CACHE_VERSION = 1;

export interface RenderFingerprint {
  key: string;
  dependencyIds: string[];
  details: {
    rendererVersion: string;
    renderProfile: string;
    shotId: string;
    timeSeconds: number;
    locationId?: string;
    locationRevision?: string;
  };
}

export interface RenderFingerprintInput {
  project: LocationProject;
  shot: Shot | string;
  profile: RenderProfile;
  timeSeconds?: number;
  rendererVersion?: string;
  locationId?: string;
  locationRevision?: string;
  /** Additional renderer settings such as projected-style configuration. */
  renderSettings?: Record<string, unknown>;
}

export interface RenderCacheEntry {
  key: string;
  shotId: string;
  timeSeconds: number;
  artifactId?: string;
  artifactPath?: string;
  sourceRevisionId?: string;
  dependencyIds: string[];
  createdAt: string;
  status: 'ready' | 'invalidated';
}

export interface RenderCacheIndex {
  version: typeof RENDER_CACHE_VERSION;
  entries: Record<string, RenderCacheEntry>;
}

export interface RenderCacheInspection {
  version: typeof RENDER_CACHE_VERSION;
  totalEntries: number;
  readyEntries: number;
  invalidatedEntries: number;
  dependencyIds: string[];
  entries: RenderCacheEntry[];
}

export interface RenderCacheDecision {
  hit: boolean;
  key: string;
  entry?: RenderCacheEntry;
  reasons: string[];
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function hash(value: string): string {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + index), 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function resolveShot(project: LocationProject, shot: Shot | string): Shot {
  const resolved = typeof shot === 'string' ? project.shots.find((item) => item.id === shot) : shot;
  if (!resolved) throw new Error(`Unknown shot '${typeof shot === 'string' ? shot : shot.id}'.`);
  return resolved;
}

function objectGroupMembers(project: LocationProject, groupIds: string[]): string[] {
  const groups = project.scene.objectGroups ?? {};
  return groupIds.flatMap((groupId) => groups[groupId]?.objectIds ?? []);
}

function productionLocationFor(project: LocationProject, shot: Shot): {
  id?: string;
  objectIds: string[];
  groupIds: string[];
  revision?: string;
} {
  const production = project.workflow.production;
  const contract = production?.shotContracts[shot.id]
    ?? production?.shotContracts[shot.productionShotId ?? '']
    ?? production?.shotContracts[shot.shotNumber];
  const locationId = contract?.environment?.locationId;
  const location = locationId ? production?.locations[locationId] : undefined;
  return {
    id: locationId,
    objectIds: location?.objectIds ?? [],
    groupIds: location?.objectGroupIds ?? [],
    revision: location ? stableSerialize(location) : undefined,
  };
}

function isStaticEnvironment(object: SceneObject): boolean {
  if (object.productionClass === 'dynamic_subject'
    || object.productionClass === 'dynamic_prop'
    || object.productionClass === 'conditional_set_piece') return false;
  return object.productionClass === 'static_environment'
    || object.category === 'architecture'
    || object.category === 'environment';
}

function relevantObjects(
  project: LocationProject,
  shot: Shot,
  effectiveOverrides: Record<string, unknown>,
): SceneObject[] {
  const location = productionLocationFor(project, shot);
  const locationObjectIds = new Set([
    ...location.objectIds,
    ...objectGroupMembers(project, location.groupIds),
  ]);
  const overrideIds = new Set(Object.keys(effectiveOverrides));
  const hasPreparedLocation = locationObjectIds.size > 0;
  return project.scene.objects.filter((object) => {
    if (overrideIds.has(object.id)) return true;
    if (hasPreparedLocation) return locationObjectIds.has(object.id);
    // With no prepared location contract, include only static set geometry.
    // Unbound dynamic objects are deliberately excluded from the dependency
    // set so adding an unused variant does not invalidate every shot.
    return isStaticEnvironment(object) && object.visible;
  });
}

function assetDependency(project: LocationProject, assetId: string | undefined, prefix: string): string | undefined {
  if (!assetId) return undefined;
  const asset = project.assets.assets[assetId];
  return `${prefix}:${assetId}:${asset?.contentHash ?? asset?.storageKey ?? asset?.uri ?? 'missing'}`;
}

function profileFingerprint(profile: RenderProfile): string {
  return stableSerialize(profile);
}

/** Compute all inputs that can change one rendered review frame. */
export function computeRenderFingerprint(input: RenderFingerprintInput): RenderFingerprint {
  const shot = resolveShot(input.project, input.shot);
  const timeSeconds = input.timeSeconds ?? 0;
  const sample = sampleShotTimeline(input.project, shot.id, timeSeconds);
  const location = productionLocationFor(input.project, shot);
  const objects = relevantObjects(input.project, shot, sample.objectOverrides);
  const dependencyIds = new Set<string>([
    `shot:${shot.id}`,
    `camera:${shot.id}:${stableSerialize(sample.camera)}`,
    `staging:${shot.id}:${stableSerialize(sample.objectOverrides)}`,
    ...(location.id ? [`location:${location.id}`] : []),
    ...(input.locationRevision ? [`location-revision:${input.locationRevision}`] : location.revision ? [`location-revision:${hash(location.revision)}`] : []),
  ]);
  const objectInputs = objects.map((object) => {
    dependencyIds.add(`object:${object.id}`);
    if (object.modelAssetId) dependencyIds.add(assetDependency(input.project, object.modelAssetId, 'asset')!);
    return {
      id: object.id,
      transform: object.transform,
      dimensions: object.dimensions,
      visible: object.visible,
      productionClass: object.productionClass,
      modelAssetId: object.modelAssetId,
      humanPose: object.humanPose,
      poseableCharacter: object.poseableCharacter,
    };
  });
  const pano = input.project.panoRefs.find((item) => item.id === shot.linkedPanoId);
  if (shot.linkedPanoId) dependencyIds.add(`panorama:${shot.linkedPanoId}`);
  const panoAsset = assetDependency(input.project, pano?.imageAssetId, 'pano-asset');
  if (panoAsset) dependencyIds.add(panoAsset);

  const content = stableSerialize({
    version: RENDER_CACHE_VERSION,
    rendererVersion: input.rendererVersion ?? 'forescene-renderer-v1',
    profile: profileFingerprint(input.profile),
    shotId: shot.id,
    timeSeconds: sample.sampledTimeSeconds,
    camera: sample.camera,
    objectOverrides: sample.objectOverrides,
    objects: objectInputs,
    linkedPanoId: shot.linkedPanoId,
    pano: pano ? { id: pano.id, imageAssetId: pano.imageAssetId, sourcePanoId: pano.sourcePanoId, projection: pano.projection } : undefined,
    projectedStyle: input.renderSettings ?? input.project.settings.projectedStyle,
    locationId: input.locationId ?? location.id,
    locationRevision: input.locationRevision ?? location.revision,
  });
  const key = `render:${hash(content)}`;
  return {
    key,
    dependencyIds: [...dependencyIds].sort(),
    details: {
      rendererVersion: input.rendererVersion ?? 'forescene-renderer-v1',
      renderProfile: input.profile.id,
      shotId: shot.id,
      timeSeconds: sample.sampledTimeSeconds,
      ...(input.locationId ?? location.id ? { locationId: input.locationId ?? location.id } : {}),
      ...(input.locationRevision ?? location.revision ? { locationRevision: input.locationRevision ?? location.revision } : {}),
    },
  };
}

export function createRenderCacheIndex(): RenderCacheIndex {
  return { version: RENDER_CACHE_VERSION, entries: {} };
}

export function recordRenderCacheEntry(
  index: RenderCacheIndex,
  fingerprint: RenderFingerprint,
  entry: Omit<RenderCacheEntry, 'key' | 'shotId' | 'timeSeconds' | 'dependencyIds' | 'status'> & { status?: RenderCacheEntry['status'] },
): RenderCacheIndex {
  return {
    ...index,
    entries: {
      ...index.entries,
      [fingerprint.key]: {
        key: fingerprint.key,
        shotId: fingerprint.details.shotId,
        timeSeconds: fingerprint.details.timeSeconds,
        dependencyIds: [...fingerprint.dependencyIds],
        status: entry.status ?? 'ready',
        ...entry,
      },
    },
  };
}

export function explainRenderCacheHit(index: RenderCacheIndex, fingerprint: RenderFingerprint): RenderCacheDecision {
  const entry = index.entries[fingerprint.key];
  if (!entry || entry.status !== 'ready') return explainRenderCacheMiss(index, fingerprint);
  return { hit: true, key: fingerprint.key, entry, reasons: ['content_fingerprint_match'] };
}

export function explainRenderCacheMiss(index: RenderCacheIndex, fingerprint: RenderFingerprint): RenderCacheDecision {
  const entry = index.entries[fingerprint.key];
  return {
    hit: false,
    key: fingerprint.key,
    ...(entry ? { entry } : {}),
    reasons: entry?.status === 'invalidated'
      ? ['cached_entry_invalidated']
      : ['no_content_fingerprint_match'],
  };
}

export function invalidateRenderDependencies(index: RenderCacheIndex, dependencyIds: string[]): RenderCacheIndex {
  const invalidated = new Set(dependencyIds);
  const entries = Object.fromEntries(Object.entries(index.entries).map(([key, entry]) => [
    key,
    entry.dependencyIds.some((dependencyId) => invalidated.has(dependencyId))
      ? { ...entry, status: 'invalidated' as const }
      : entry,
  ]));
  return { ...index, entries };
}

export function clearRenderCache(): RenderCacheIndex {
  return createRenderCacheIndex();
}

export function inspectRenderCache(index: RenderCacheIndex): RenderCacheInspection {
  const entries = Object.values(index.entries);
  return {
    version: index.version,
    totalEntries: entries.length,
    readyEntries: entries.filter((entry) => entry.status === 'ready').length,
    invalidatedEntries: entries.filter((entry) => entry.status === 'invalidated').length,
    dependencyIds: [...new Set(entries.flatMap((entry) => entry.dependencyIds))].sort(),
    entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
  };
}
