import type { LocationProject, Shot } from '../domain/types';
import { normalizeShotDepthSettings } from '../domain/defaults';
import { resolveProjectedProjectorAssets } from './multiOriginProjection';
import {
  assetContentIdentity,
  assetDependency,
  buildObjectRenderDependency,
  buildProjectedSourceDependencies,
  hash,
  stableSerialize,
} from './renderArtifactDependencies';
import { getSceneObjectStagingRole } from './shotSceneState';
import { fingerprintShotTimeline } from './shotTimeline';
import { VIDEO_PERFORMANCE_CACHE_VERSION } from './videoPerformance';
import type { StillArtifactSpecification } from './stillArtifactTypes';

export const STILL_ARTIFACT_RENDERER_VERSION = 'forescene-still-v1';

export interface StillArtifactFingerprint {
  key: string;
  dependencyIds: string[];
  details: {
    rendererVersion: string;
    shotId: string;
    kind: StillArtifactSpecification['kind'];
    appearance: StillArtifactSpecification['appearance'];
    width: number;
    height: number;
  };
}

function relevantObjectsForStill(
  project: LocationProject,
  shot: Shot,
  spec: StillArtifactSpecification,
) {
  const overrideIds = new Set(Object.keys(shot.objectOverrides ?? {}));
  const keyframeOverrideIds = new Set(
    shot.cameraKeyframes.flatMap((keyframe) => Object.keys(keyframe.objectOverrides ?? {})),
  );

  return project.scene.objects.filter((object) => {
    const explicitlyReferenced = overrideIds.has(object.id) || keyframeOverrideIds.has(object.id);
    if (!object.visible && !explicitlyReferenced) return false;

    const isPerson = getSceneObjectStagingRole(object) === 'person';
    if (spec.contentMode === 'characters_only') {
      const attached = typeof object.metadata?.characterOwnerId === 'string'
        && (object.metadata.characterOwnerId as string).length > 0;
      if (!isPerson && !((spec.includeCharacterAttachments !== false) && attached)) return false;
    } else if (spec.contentMode === 'clean_plate' || spec.peopleVariant === 'clean_plate') {
      if (isPerson) return false;
    }
    return true;
  });
}

function stillObjectRenderDependency(project: LocationProject, object: LocationProject['scene']['objects'][number]) {
  // The shared dependency helper also serves editor caches and therefore
  // includes fields such as `locked` and the full metadata bag. Those do not
  // change pixels for still rendering; only the attachment relationship is
  // render-relevant metadata for characters-only passes.
  const { locked: _locked, metadata: _metadata, ...dependency } = buildObjectRenderDependency(project, object);
  return {
    ...dependency,
    characterOwnerId: typeof object.metadata?.characterOwnerId === 'string'
      ? object.metadata.characterOwnerId
      : null,
  };
}

export function computeStillArtifactFingerprint(
  project: LocationProject,
  shot: Shot | string,
  specification: StillArtifactSpecification,
): StillArtifactFingerprint {
  const resolvedShot = typeof shot === 'string'
    ? project.shots.find((item) => item.id === shot)
    : shot;
  if (!resolvedShot) {
    throw new Error(`Shot ${String(shot)} not found.`);
  }

  const {
    kind,
    appearance,
    width,
    height,
    peopleVariant,
    contentMode,
    timeSeconds,
    frameRole,
    backgroundColor,
    includeCharacterAttachments,
  } = specification;

  const usesProjection = appearance === 'projected';
  const usesDepth = appearance === 'depth';

  // A current viewport/character still renders the shot's landed camera and
  // overrides, not the entire camera-move timeline. Reference-frame stills are
  // sampled from the timeline and therefore retain the timeline dependency.
  const samplesTimeline = timeSeconds !== undefined || frameRole !== undefined;
  // Compute the immutable timeline digest once per fingerprint. Materialize
  // batches can call this function repeatedly for the same shot, while the
  // timeline helper itself walks every camera/object keyframe.
  const timelineFingerprint = samplesTimeline ? fingerprintShotTimeline(resolvedShot) : undefined;
  const dependencyIds = new Set<string>([`shot:${resolvedShot.id}`]);
  if (timelineFingerprint) dependencyIds.add(`timeline:${timelineFingerprint}`);

  const effectiveSceneObjects = relevantObjectsForStill(project, resolvedShot, specification)
    .map((object) => {
      dependencyIds.add(`object:${object.id}`);
      if (object.modelAssetId) {
        const dep = assetDependency(project, object.modelAssetId, 'asset');
        if (dep) dependencyIds.add(dep);
      }
      if (object.poseableCharacter && object.poseableCharacter.kind !== 'builtin') {
        const dep = assetDependency(project, object.poseableCharacter.assetId, 'pose-asset');
        if (dep) dependencyIds.add(dep);
      }
      return stillObjectRenderDependency(project, object);
    });

  const linkedPano = usesProjection
    ? project.panoRefs.find((pano) => pano.id === resolvedShot.linkedPanoId)
    : undefined;
  if (usesProjection && resolvedShot.linkedPanoId) {
    dependencyIds.add(`panorama:${resolvedShot.linkedPanoId}`);
  }
  if (usesProjection) {
    const linkedPanoAssetDep = assetDependency(project, linkedPano?.imageAssetId, 'pano-asset');
    if (linkedPanoAssetDep) dependencyIds.add(linkedPanoAssetDep);
  }

  const projectedSources = usesProjection ? buildProjectedSourceDependencies(project) : [];
  for (const source of projectedSources) {
    dependencyIds.add(`projector:${source.role}:${source.panoId}:${source.imageAssetContentIdentity}`);
  }

  const projectorAssets = usesProjection ? resolveProjectedProjectorAssets(project) : undefined;
  const projectionSettings = projectorAssets
    ? { ...projectorAssets.settings, blendMode: projectorAssets.blendMode }
    : null;

  const depthSettings = normalizeShotDepthSettings(resolvedShot.exportSettings.depth);
  const depthRange = usesDepth
    ? {
      nearMeters: depthSettings.nearMeters ?? null,
      farMeters: depthSettings.farMeters ?? null,
      invert: depthSettings.invert === true,
      rangeMode: depthSettings.rangeMode,
    }
    : null;

  const shotCameras = timeSeconds !== undefined
    ? [{ timeSeconds, camera: resolvedShot.camera }]
    : [{ timeSeconds: 0, camera: resolvedShot.camera }];

  const content = stableSerialize({
    cacheVersion: VIDEO_PERFORMANCE_CACHE_VERSION,
    rendererVersion: STILL_ARTIFACT_RENDERER_VERSION,
    effectiveShotTimeline: timelineFingerprint ?? null,
    shotId: resolvedShot.id,
    linkedPanoId: usesProjection ? (resolvedShot.linkedPanoId ?? null) : null,
    linkedPano: usesProjection && linkedPano
      ? {
        id: linkedPano.id,
        origin: linkedPano.origin,
        rotation: linkedPano.rotation,
        width: linkedPano.width,
        height: linkedPano.height,
        imageAssetContentIdentity: assetContentIdentity(project, linkedPano.imageAssetId),
      }
      : null,
    effectiveSceneObjects,
    currentShotObjectOverrides: samplesTimeline ? null : resolvedShot.objectOverrides ?? {},
    projectedSources,
    projectionSettings,
    scenePanoOrigin: usesProjection ? project.scene.panoOrigin : null,
    scenePanoRotation: usesProjection ? project.scene.panoRotation : null,
    depthRange,
    spec: {
      kind,
      appearance,
      width,
      height,
      peopleVariant: peopleVariant ?? null,
      contentMode: contentMode ?? null,
      timeSeconds: timeSeconds ?? null,
      frameRole: frameRole ?? null,
      backgroundColor: backgroundColor ?? null,
      includeCharacterAttachments: includeCharacterAttachments !== false,
    },
    shotCameras,
  });

  const key = `still:${hash(content)}`;
  return {
    key,
    dependencyIds: [...dependencyIds].sort(),
    details: {
      rendererVersion: STILL_ARTIFACT_RENDERER_VERSION,
      shotId: resolvedShot.id,
      kind,
      appearance,
      width,
      height,
    },
  };
}
