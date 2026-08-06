import type { LocationProject, Shot } from '../domain/types';
import { normalizeShotDepthSettings } from '../domain/defaults';
import { getSortedCameraKeyframes } from './cameraKeyframes';
import { resolveProjectedProjectorAssets } from './multiOriginProjection';
import { fingerprintShotTimeline } from './shotTimeline';
import { VIDEO_PERFORMANCE_CACHE_VERSION } from './videoPerformance';
import { assetContentIdentity, assetDependency, buildObjectRenderDependency, buildProjectedSourceDependencies, hash, stableSerialize } from './renderArtifactDependencies';
import { cameraKeyframesHaveObjectAnimation } from './objectKeyframes';
import type { StillArtifactSpecification } from './stillArtifactTypes';
export const STILL_ARTIFACT_RENDERER_VERSION = 'forescene-still-v1';
export interface StillArtifactFingerprint { key: string; dependencyIds: string[]; details: { rendererVersion: string; shotId: string; kind: StillArtifactSpecification['kind']; appearance: StillArtifactSpecification['appearance']; width: number; height: number; }; }
function relevantObjectsForStill(project: LocationProject, shot: Shot, spec: StillArtifactSpecification) {
  const oIds = new Set(Object.keys(shot.objectOverrides ?? {}));
  const kIds = new Set(shot.cameraKeyframes.flatMap((k) => Object.keys(k.objectOverrides ?? {})));
  const animate = cameraKeyframesHaveObjectAnimation(shot.cameraKeyframes);
  return project.scene.objects.filter((obj) => {
    const ref = oIds.has(obj.id) || kIds.has(obj.id);
    if (!obj.visible && !ref) return false;
    if (spec.contentMode === 'characters_only') {
      const isPerson = obj.stagingRole === 'person';
      const attached = typeof obj.metadata?.characterOwnerId === 'string' && (obj.metadata.characterOwnerId as string).length > 0;
      if (!isPerson && !((spec.includeCharacterAttachments !== false) && attached)) return false;
    } else if (spec.contentMode === 'clean_plate' || spec.peopleVariant === 'clean_plate') {
      if (obj.stagingRole === 'person') return false;
    }
    void animate;
    return true;
  });
}
export function computeStillArtifactFingerprint(project: LocationProject, shot: Shot | string, specification: StillArtifactSpecification): StillArtifactFingerprint {
  const s = typeof shot === 'string' ? project.shots.find((x) => x.id === shot) : shot;
  if (!s) throw new Error(`Shot ${String(shot)} not found.`);
  const { kind, appearance, width, height, peopleVariant, contentMode, timeSeconds, frameRole, backgroundColor, includeCharacterAttachments } = specification;
  const dep = new Set<string>([`shot:${s.id}`, `timeline:${fingerprintShotTimeline(s)}`]);
  const effectiveObjects = relevantObjectsForStill(project, s, specification).map((object) => {
    dep.add(`object:${object.id}`);
    if (object.modelAssetId) { const d = assetDependency(project, object.modelAssetId, 'asset'); if (d) dep.add(d); }
    if (object.poseableCharacter && object.poseableCharacter.kind !== 'builtin') { const d = assetDependency(project, object.poseableCharacter.assetId, 'pose-asset'); if (d) dep.add(d); }
    return buildObjectRenderDependency(project, object);
  });
  const linkedPano = project.panoRefs.find((p) => p.id === s.linkedPanoId);
  if (s.linkedPanoId) dep.add(`panorama:${s.linkedPanoId}`);
  const lpDep = assetDependency(project, linkedPano?.imageAssetId, 'pano-asset');
  if (lpDep) dep.add(lpDep);
  const projectedSources = appearance === 'projected' ? buildProjectedSourceDependencies(project) : [];
  for (const src of projectedSources) dep.add(`projector:${src.role}:${src.panoId}:${src.imageAssetContentIdentity}`);
  const projAssets = appearance === 'projected' ? resolveProjectedProjectorAssets(project) : undefined;
  const projectionSettings = projAssets ? { ...projAssets.settings, blendMode: projAssets.blendMode } : null;
  const depthSet = normalizeShotDepthSettings(s.exportSettings.depth);
  const depthRange = appearance === 'depth' ? { nearMeters: depthSet.nearMeters ?? null, farMeters: depthSet.farMeters ?? null, invert: depthSet.invert === true, rangeMode: depthSet.rangeMode } : null;
  const shotCameras = timeSeconds !== undefined ? [{ timeSeconds, camera: s.camera }] : (() => { const kfs = getSortedCameraKeyframes(s.cameraKeyframes); return kfs.length ? kfs.map((kf) => ({ timeSeconds: kf.timeSeconds, camera: kf.camera })) : [{ timeSeconds: 0, camera: s.camera }]; })();
  const content = stableSerialize({ cacheVersion: VIDEO_PERFORMANCE_CACHE_VERSION, rendererVersion: STILL_ARTIFACT_RENDERER_VERSION, effectiveShotTimeline: fingerprintShotTimeline(s), shotId: s.id, linkedPanoId: s.linkedPanoId ?? null, linkedPano: appearance === 'projected' && linkedPano ? { id: linkedPano.id, origin: linkedPano.origin, rotation: linkedPano.rotation, width: linkedPano.width, height: linkedPano.height, imageAssetContentIdentity: assetContentIdentity(project, linkedPano.imageAssetId) } : (s.linkedPanoId ?? null), effectiveSceneObjects: effectiveObjects, projectedSources, projectionSettings, scenePanoOrigin: project.scene.panoOrigin, scenePanoRotation: project.scene.panoRotation, depthRange, spec: { kind, appearance, width, height, peopleVariant: peopleVariant ?? null, contentMode: contentMode ?? null, timeSeconds: timeSeconds ?? null, frameRole: frameRole ?? null, backgroundColor: backgroundColor ?? null, includeCharacterAttachments: includeCharacterAttachments !== false }, shotCameras });
  const key = `still:${hash(content)}`;
  return { key, dependencyIds: [...dep].sort(), details: { rendererVersion: STILL_ARTIFACT_RENDERER_VERSION, shotId: s.id, kind, appearance, width, height } };
}
