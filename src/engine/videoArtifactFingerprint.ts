/**
 * Content-addressed fingerprints for deterministic camera-move MP4 artifacts.
 * A fingerprint change means the encoded bytes may differ and the cache must miss.
 *
 * Shared dependency builders live in renderArtifactDependencies.ts so still
 * fingerprints consume the same identities.
 */

import type {
  LocationProject,
  Shot,
  VideoEncoderMode,
} from '../domain/types';
import { cameraKeyframesHaveObjectAnimation } from './objectKeyframes';
import type { PeopleRenderVariant } from './peopleExport';
import type { SceneContentMode } from './shotSceneState';
import { fingerprintShotTimeline } from './shotTimeline';
import { VIDEO_PERFORMANCE_CACHE_VERSION } from './videoPerformance';
import type { VideoResolutionPresetId } from './videoPresets';
import {
  assetContentIdentity,
  assetDependency,
  buildObjectRenderDependency,
  buildProjectedSourceDependencies,
  hash,
  stableSerialize,
} from './renderArtifactDependencies';
import { resolveProjectedProjectorAssets } from './multiOriginProjection';

/** Bump when the fingerprint dependency schema changes. */
export const VIDEO_ARTIFACT_RENDERER_VERSION = 'forescene-video-v3';

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

export type { ProjectedSourceDependency } from './renderArtifactDependencies';
export { assetContentIdentity, buildObjectRenderDependency, buildProjectedSourceDependencies } from './renderArtifactDependencies';

function resolveContentMode(spec: VideoArtifactSpecification): SceneContentMode {
  if (spec.contentMode) return spec.contentMode;
  if (spec.peopleVariant === 'clean_plate') return 'clean_plate';
  return 'full_scene';
}

function relevantObjects(project: LocationProject, shot: Shot) {
  const overrideIds = new Set(Object.keys(shot.objectOverrides ?? {}));
  const keyframeOverrideIds = new Set(
    shot.cameraKeyframes.flatMap((keyframe) => Object.keys(keyframe.objectOverrides ?? {})),
  );
  const animate = cameraKeyframesHaveObjectAnimation(shot.cameraKeyframes);
  return project.scene.objects.filter((object) => {
    const explicitlyReferenced = overrideIds.has(object.id) || keyframeOverrideIds.has(object.id);
    if (!object.visible && !explicitlyReferenced) return false;
    if (animate || explicitlyReferenced) return true;
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

  const effectiveSceneObjects = relevantObjects(project, resolvedShot).map((object) => {
    dependencyIds.add(`object:${object.id}`);
    if (object.modelAssetId) {
      const dep = assetDependency(project, object.modelAssetId, 'asset');
      if (dep) dependencyIds.add(dep);
    }
    if (object.poseableCharacter && object.poseableCharacter.kind !== 'builtin') {
      const dep = assetDependency(project, object.poseableCharacter.assetId, 'pose-asset');
      if (dep) dependencyIds.add(dep);
    }
    return buildObjectRenderDependency(project, object);
  });

  const linkedPano = project.panoRefs.find((item) => item.id === resolvedShot.linkedPanoId);
  if (resolvedShot.linkedPanoId) dependencyIds.add(`panorama:${resolvedShot.linkedPanoId}`);
  const linkedPanoAssetDep = assetDependency(project, linkedPano?.imageAssetId, 'pano-asset');
  if (linkedPanoAssetDep) dependencyIds.add(linkedPanoAssetDep);

  const projectedSources = appearance === 'projected'
    ? buildProjectedSourceDependencies(project)
    : [];
  for (const source of projectedSources) {
    dependencyIds.add(`projector:${source.role}:${source.panoId}:${source.imageAssetContentIdentity}`);
  }

  const projectorAssets = appearance === 'projected'
    ? resolveProjectedProjectorAssets(project)
    : undefined;
  const projectionSettings = projectorAssets
    ? {
      ...projectorAssets.settings,
      blendMode: projectorAssets.blendMode,
      occlusionFilter: specification.occlusionFilter ?? 'fast',
    }
    : null;

  const renderSpecification = {
    appearance,
    contentMode,
    peopleVariant: specification.peopleVariant ?? null,
    mode,
    resolutionPreset: resolved.resolutionPreset,
    width: resolved.width,
    height: resolved.height,
    frameRate: resolved.frameRate,
    encoderMode: resolved.encoderMode,
    occlusionFilter: specification.occlusionFilter ?? (appearance === 'projected' ? 'fast' : null),
    depthRange: specification.depthRange ?? null,
    depthInvert: specification.depthInvert === true,
    backgroundColor: specification.backgroundColor ?? null,
    includeCharacterAttachments: specification.includeCharacterAttachments !== false,
    transparent: specification.transparent === true,
  };

  const content = stableSerialize({
    cacheVersion: VIDEO_PERFORMANCE_CACHE_VERSION,
    rendererVersion: VIDEO_ARTIFACT_RENDERER_VERSION,
    effectiveShotTimeline: fingerprintShotTimeline(resolvedShot),
    shotId: resolvedShot.id,
    linkedPanoId: resolvedShot.linkedPanoId ?? null,
    // Linked pano pose/image only affect projected frames. Clay/depth fingerprints
    // keep the id for staging identity but must not miss on pure projector re-alignment.
    linkedPano: appearance === 'projected' && linkedPano
      ? {
        id: linkedPano.id,
        origin: linkedPano.origin,
        rotation: linkedPano.rotation,
        width: linkedPano.width,
        height: linkedPano.height,
        imageAssetContentIdentity: assetContentIdentity(project, linkedPano.imageAssetId),
      }
      : (resolvedShot.linkedPanoId ?? null),
    effectiveSceneObjects,
    projectedSources,
    projectionSettings,
    // Scene pano origin/rotation affect graybox-linked still paths; keep for all
    // appearances so origin moves stay consistent with package metadata consumers.
    scenePanoOrigin: project.scene.panoOrigin,
    scenePanoRotation: project.scene.panoRotation,
    renderSpecification,
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
