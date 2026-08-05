/**
 * Content-addressed fingerprints for deterministic camera-move MP4 artifacts.
 * A fingerprint change means the encoded bytes may differ and the cache must miss.
 */

import type {
  LocationProject,
  SceneObject,
  Shot,
  VideoEncoderMode,
} from '../domain/types';
import { cameraKeyframesHaveObjectAnimation } from './objectKeyframes';
import { fingerprintShotTimeline } from './shotTimeline';
import { VIDEO_PERFORMANCE_CACHE_VERSION } from './videoPerformance';
import type { VideoResolutionPresetId } from './videoPresets';
import type { PeopleRenderVariant } from './peopleExport';
import type { SceneContentMode } from './shotSceneState';

export const VIDEO_ARTIFACT_RENDERER_VERSION = 'forescene-video-v1';

export type VideoArtifactAppearance = 'clay' | 'projected' | 'depth';

export interface VideoArtifactSpecification {
  appearance: VideoArtifactAppearance;
  peopleVariant?: PeopleRenderVariant;
  contentMode?: SceneContentMode;
  mode?: 'render' | 'quickPreview';
  resolutionPreset?: VideoResolutionPresetId;
  frameRate?: number;
  width?: number;
  height?: number;
  encoderMode?: VideoEncoderMode;
  occlusionFilter?: 'soft' | 'fast';
  depthRange?: { nearMeters: number; farMeters: number };
  depthInvert?: boolean;
  backgroundColor?: string;
  includeCharacterAttachments?: boolean;
  transparent?: boolean;
}

export interface VideoArtifactFingerprint {
  key: string;
  dependencyIds: string[];
  details: {
    rendererVersion: string;
    shotId: string;
    appearance: VideoArtifactAppearance;
    width: number;
    height: number;
    frameRate: number;
    encoderMode: VideoEncoderMode;
    contentMode: SceneContentMode;
  };
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

function assetDependency(
  project: LocationProject,
  assetId: string | undefined,
  prefix: string,
): string | undefined {
  if (!assetId) return undefined;
  const asset = project.assets.assets[assetId];
  return `${prefix}:${assetId}:${asset?.contentHash ?? asset?.storageKey ?? asset?.uri ?? 'missing'}`;
}

function resolveContentMode(spec: VideoArtifactSpecification): SceneContentMode {
  if (spec.contentMode) return spec.contentMode;
  if (spec.peopleVariant === 'clean_plate') return 'clean_plate';
  return 'full_scene';
}

function relevantObjects(project: LocationProject, shot: Shot): SceneObject[] {
  const overrideIds = new Set(Object.keys(shot.objectOverrides ?? {}));
  const animate = cameraKeyframesHaveObjectAnimation(shot.cameraKeyframes);
  return project.scene.objects.filter((object) => {
    if (!object.visible && !overrideIds.has(object.id)) return false;
    if (animate || overrideIds.has(object.id)) return true;
    // Static scene geometry always contributes to clay/projected frames.
    return object.stagingRole !== 'person' || object.visible;
  });
}

export function computeVideoArtifactFingerprint(
  project: LocationProject,
  shot: Shot | string,
  specification: VideoArtifactSpecification,
  resolved: {
    width: number;
    height: number;
    frameRate: number;
    resolutionPreset: VideoResolutionPresetId;
    encoderMode: VideoEncoderMode;
  },
): VideoArtifactFingerprint {
  const resolvedShot = typeof shot === 'string'
    ? project.shots.find((item) => item.id === shot)
    : shot;
  if (!resolvedShot) {
    throw new Error(`Unknown shot '${typeof shot === 'string' ? shot : shot.id}'.`);
  }

  const contentMode = resolveContentMode(specification);
  const appearance = specification.appearance;
  const mode = specification.mode ?? 'render';
  const dependencyIds = new Set<string>([
    `shot:${resolvedShot.id}`,
    `timeline:${fingerprintShotTimeline(resolvedShot)}`,
  ]);

  const objects = relevantObjects(project, resolvedShot).map((object) => {
    dependencyIds.add(`object:${object.id}`);
    if (object.modelAssetId) {
      const dep = assetDependency(project, object.modelAssetId, 'asset');
      if (dep) dependencyIds.add(dep);
    }
    return {
      id: object.id,
      transform: object.transform,
      dimensions: object.dimensions,
      visible: object.visible,
      stagingRole: object.stagingRole,
      modelAssetId: object.modelAssetId,
      humanPose: object.humanPose,
      poseableCharacter: object.poseableCharacter,
      color: object.color,
    };
  });

  const linkedPano = project.panoRefs.find((item) => item.id === resolvedShot.linkedPanoId);
  if (resolvedShot.linkedPanoId) dependencyIds.add(`panorama:${resolvedShot.linkedPanoId}`);
  const panoAssetDep = assetDependency(project, linkedPano?.imageAssetId, 'pano-asset');
  if (panoAssetDep) dependencyIds.add(panoAssetDep);

  const primaryPanoId = project.settings.projectedStyle?.panoId ?? linkedPano?.id;
  const secondaryPanoId = project.settings.projectedStyle?.secondaryPanoId;
  if (appearance === 'projected') {
    if (primaryPanoId) dependencyIds.add(`projector:${primaryPanoId}`);
    if (secondaryPanoId) dependencyIds.add(`projector-secondary:${secondaryPanoId}`);
  }

  const content = stableSerialize({
    cacheVersion: VIDEO_PERFORMANCE_CACHE_VERSION,
    rendererVersion: VIDEO_ARTIFACT_RENDERER_VERSION,
    shotId: resolvedShot.id,
    timeline: fingerprintShotTimeline(resolvedShot),
    appearance,
    contentMode,
    peopleVariant: specification.peopleVariant ?? null,
    mode,
    resolutionPreset: resolved.resolutionPreset,
    width: resolved.width,
    height: resolved.height,
    frameRate: resolved.frameRate,
    // Requested encoder mode is part of the identity; actual hardware/software
    // selection is recorded in artifact metadata and may differ after fallback.
    encoderMode: resolved.encoderMode,
    occlusionFilter: specification.occlusionFilter ?? (appearance === 'projected' ? 'fast' : null),
    depthRange: specification.depthRange ?? null,
    depthInvert: specification.depthInvert === true,
    backgroundColor: specification.backgroundColor ?? null,
    includeCharacterAttachments: specification.includeCharacterAttachments !== false,
    transparent: specification.transparent === true,
    objects,
    linkedPanoId: resolvedShot.linkedPanoId ?? null,
    projectedStyle: appearance === 'projected' ? project.settings.projectedStyle : null,
    panoOrigin: project.scene.panoOrigin,
    panoRotation: project.scene.panoRotation,
  });

  const key = `video:${hash(content)}`;
  return {
    key,
    dependencyIds: [...dependencyIds].sort(),
    details: {
      rendererVersion: VIDEO_ARTIFACT_RENDERER_VERSION,
      shotId: resolvedShot.id,
      appearance,
      width: resolved.width,
      height: resolved.height,
      frameRate: resolved.frameRate,
      encoderMode: resolved.encoderMode,
      contentMode,
    },
  };
}
