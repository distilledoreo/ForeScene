/**
 * Content-addressed fingerprints for deterministic camera-move MP4 artifacts.
 * A fingerprint change means the encoded bytes may differ and the cache must miss.
 *
 * The dependency record mirrors the inputs that actually affect WebGL frames:
 * shot timeline, render-relevant scene objects (materials, hierarchy, assets),
 * projected pano sources (origin/rotation/image identity from PanoReference),
 * projection settings, and the encode specification.
 */

import type {
  LocationProject,
  PanoReference,
  PoseableCharacterSource,
  SceneObject,
  Shot,
  VideoEncoderMode,
} from '../domain/types';
import { resolveProjectedProjectorAssets } from './multiOriginProjection';
import { cameraKeyframesHaveObjectAnimation } from './objectKeyframes';
import type { PeopleRenderVariant } from './peopleExport';
import type { SceneContentMode } from './shotSceneState';
import { fingerprintShotTimeline } from './shotTimeline';
import { VIDEO_PERFORMANCE_CACHE_VERSION } from './videoPerformance';
import type { VideoResolutionPresetId } from './videoPresets';

/** Bump when the fingerprint dependency schema changes. */
export const VIDEO_ARTIFACT_RENDERER_VERSION = 'forescene-video-v2';

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

export interface ProjectedSourceDependency {
  panoId: string;
  origin: [number, number, number];
  rotation: [number, number, number];
  width: number;
  height: number;
  imageAssetContentIdentity: string;
  role: 'primary' | 'secondary';
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

/** Stable content identity for a project asset (hash preferred over URI). */
export function assetContentIdentity(
  project: LocationProject,
  assetId: string | undefined,
): string {
  if (!assetId) return 'missing';
  const asset = project.assets.assets[assetId];
  if (!asset) return `missing:${assetId}`;
  return asset.contentHash
    ?? asset.storageKey
    ?? asset.uri
    ?? `id:${assetId}`;
}

function assetDependency(
  project: LocationProject,
  assetId: string | undefined,
  prefix: string,
): string | undefined {
  if (!assetId) return undefined;
  return `${prefix}:${assetId}:${assetContentIdentity(project, assetId)}`;
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

function poseableSourceIdentity(
  project: LocationProject,
  source: PoseableCharacterSource | undefined,
): unknown {
  if (!source) return null;
  if (source.kind === 'builtin') {
    return { kind: 'builtin', characterId: source.characterId };
  }
  return {
    kind: source.kind,
    assetId: source.assetId,
    rigId: source.rigId,
    assetContent: assetContentIdentity(project, source.assetId),
  };
}

/** Render-affecting object fields used by clay / projected / depth video. */
export function buildObjectRenderDependency(
  project: LocationProject,
  object: SceneObject,
): Record<string, unknown> {
  const modelDep = object.modelAssetId
    ? assetContentIdentity(project, object.modelAssetId)
    : null;
  return {
    id: object.id,
    type: object.type,
    transform: object.transform,
    dimensions: object.dimensions,
    visible: object.visible,
    locked: object.locked,
    stagingRole: object.stagingRole,
    category: object.category,
    productionClass: object.productionClass,
    surfaceStyle: object.surfaceStyle ?? null,
    color: object.color ?? null,
    secondaryColor: object.secondaryColor ?? null,
    materialId: object.materialId ?? null,
    parentId: object.parentId ?? null,
    modelAssetId: object.modelAssetId ?? null,
    modelAssetContent: modelDep,
    importedModel: object.importedModel
      ? {
        sourceName: object.importedModel.sourceName,
        sourceFormat: object.importedModel.sourceFormat,
        sourceKind: object.importedModel.sourceKind,
        vertexCount: object.importedModel.vertexCount,
        triangleCount: object.importedModel.triangleCount,
        meshCount: object.importedModel.meshCount,
      }
      : null,
    humanPose: object.humanPose ?? null,
    poseableCharacter: poseableSourceIdentity(project, object.poseableCharacter),
    metadata: object.metadata ?? null,
  };
}

function panoSourceDependency(
  project: LocationProject,
  pano: PanoReference,
  role: 'primary' | 'secondary',
): ProjectedSourceDependency {
  return {
    panoId: pano.id,
    origin: [...pano.origin] as [number, number, number],
    rotation: [...pano.rotation] as [number, number, number],
    width: pano.width,
    height: pano.height,
    imageAssetContentIdentity: assetContentIdentity(project, pano.imageAssetId),
    role,
  };
}

/**
 * Projected sources the renderer will actually sample — PanoReference origin/
 * rotation/image, not scene.panoOrigin alone.
 */
export function buildProjectedSourceDependencies(
  project: LocationProject,
): ProjectedSourceDependency[] {
  const assets = resolveProjectedProjectorAssets(project);
  if (!assets) return [];
  const sources: ProjectedSourceDependency[] = [
    panoSourceDependency(project, assets.primary, 'primary'),
  ];
  if (assets.secondary) {
    sources.push(panoSourceDependency(project, assets.secondary, 'secondary'));
  }
  return sources;
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
