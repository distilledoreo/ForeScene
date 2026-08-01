import type {
  CameraData,
  CameraKeyframe,
  CameraKeyframeEasing,
  LocationProject,
  Shot,
  ShotObjectOverride,
  ShotObjectOverrides,
} from '../domain/types';
import { createCameraKeyframe } from '../domain/defaults';
import { createId } from '../utils/ids';
import {
  applyCameraKeyframeEasing,
  clampDuration,
  getCameraMoveDurationSeconds,
  getSortedCameraKeyframes,
  interpolateCameraKeyframes,
  MAX_CAMERA_MOVE_DURATION_SECONDS,
  MIN_CAMERA_MOVE_DURATION_SECONDS,
  removeIntermediateCameraKeyframe,
  updateCameraMoveDuration,
  updateIntermediateCameraKeyframeTime,
} from './cameraKeyframes';
import {
  cloneShotObjectOverrides,
  interpolateObjectOverrides,
  snapshotStageableObjectOverrides,
} from './objectKeyframes';
import {
  canStageObjectPerShot,
  cloneTransform,
  updateShotObjectOverrides,
} from './shotSceneState';
import { cloneHumanPose } from './humanPose';
import { pruneUnreferencedProjectAssets } from './projectAssets';

export interface ShotTimelineInspection {
  shotId: string;
  durationSeconds: number;
  renderable: boolean;
  hasManualTiming: boolean;
  keyframes: CameraKeyframe[];
}

export interface ShotTimelineSample {
  shotId: string;
  requestedTimeSeconds: number;
  sampledTimeSeconds: number;
  durationSeconds: number;
  camera: CameraData;
  objectOverrides: ShotObjectOverrides;
}

export interface ReplaceShotTimelineInput {
  durationSeconds?: number;
  keyframes: readonly CameraKeyframe[];
}

export interface CreateShotKeyframeInput {
  id?: string;
  label?: string;
  timeSeconds: number;
  camera: CameraData;
  easing?: CameraKeyframeEasing;
  objectOverrides?: ShotObjectOverrides;
  snapshotShotStaging?: boolean;
}

export interface UpdateShotKeyframePatch {
  timeSeconds?: number;
  label?: string;
  camera?: Partial<CameraData>;
  easing?: CameraKeyframeEasing;
  objectOverrides?: ShotObjectOverrides;
}

export interface StageObjectAtKeyframeInput {
  transform?: ShotObjectOverride['transform'];
  visible?: boolean;
  humanPose?: ShotObjectOverride['humanPose'];
}

/**
 * Pure temporal authoring service. Every operation returns a new project and
 * never reaches into application state, React, the viewport, or persistence.
 */

export function inspectShotTimeline(
  project: LocationProject,
  shot: Pick<Shot, 'id' | 'cameraKeyframes' | 'assets' | 'objectOverrides'> | string,
): ShotTimelineInspection {
  const resolved = resolveShot(project, typeof shot === 'string' ? shot : shot.id);
  const keyframes = getSortedCameraKeyframes(resolved.cameraKeyframes).map(cloneKeyframe);
  const durationSeconds = getCameraMoveDurationSeconds(keyframes);
  return {
    shotId: resolved.id,
    durationSeconds,
    renderable: keyframes.length >= 2 && durationSeconds > 0,
    hasManualTiming: hasManualTiming(keyframes, durationSeconds),
    keyframes,
  };
}

export function replaceShotTimeline(
  project: LocationProject,
  shotId: string,
  input: ReplaceShotTimelineInput,
): LocationProject {
  const keyframes = getSortedCameraKeyframes(input.keyframes.map(cloneKeyframe));
  validateCompletedTimeline(keyframes, input.durationSeconds);
  return updateShotTimeline(project, shotId, keyframes);
}

export function createShotKeyframe(
  project: LocationProject,
  shotId: string,
  input: CreateShotKeyframeInput,
): LocationProject {
  const shot = resolveShot(project, shotId);
  assertFiniteTime(input.timeSeconds, 'timeSeconds');
  const objectOverrides = input.snapshotShotStaging
    ? snapshotStageableObjectOverrides(project, shot)
    : input.objectOverrides;
  const keyframe = {
    ...createCameraKeyframe({
    label: input.label ?? `Keyframe ${shot.cameraKeyframes.length + 1}`,
    timeSeconds: input.timeSeconds,
    camera: cloneCamera(input.camera),
    easing: input.easing,
    objectOverrides: objectOverrides ? cloneShotObjectOverrides(objectOverrides) : undefined,
    }),
    id: input.id ?? createId('keyframe'),
  } satisfies CameraKeyframe;
  const next = getSortedCameraKeyframes([...shot.cameraKeyframes, keyframe]);
  validatePartialTimeline(next);
  return updateShotTimeline(project, shotId, next);
}

export function updateShotKeyframe(
  project: LocationProject,
  shotId: string,
  keyframeId: string,
  patch: UpdateShotKeyframePatch,
): LocationProject {
  const shot = resolveShot(project, shotId);
  const existing = resolveKeyframe(shot, keyframeId);
  const camera = patch.camera ? { ...cloneCamera(existing.camera), ...cloneCameraPatch(patch.camera) } : cloneCamera(existing.camera);
  const next = shot.cameraKeyframes.map((keyframe) => keyframe.id === keyframeId
    ? {
        ...cloneKeyframe(keyframe),
        ...(patch.timeSeconds !== undefined ? { timeSeconds: patch.timeSeconds } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        camera,
        ...(patch.easing !== undefined ? { easing: patch.easing } : {}),
        ...(patch.objectOverrides !== undefined
          ? { objectOverrides: cloneShotObjectOverrides(patch.objectOverrides) }
          : {}),
      }
    : cloneKeyframe(keyframe));
  validatePartialTimeline(next);
  return updateShotTimeline(project, shotId, getSortedCameraKeyframes(next));
}

export function deleteShotKeyframe(
  project: LocationProject,
  shotId: string,
  keyframeId: string,
): LocationProject {
  const shot = resolveShot(project, shotId);
  resolveKeyframe(shot, keyframeId);
  const sorted = getSortedCameraKeyframes(shot.cameraKeyframes);
  const index = sorted.findIndex((keyframe) => keyframe.id === keyframeId);
  if (index === 0 || index === sorted.length - 1) {
    throw new Error('The first and final keyframes cannot be deleted by an intermediate delete.');
  }
  return updateShotTimeline(project, shotId, removeIntermediateCameraKeyframe(sorted, keyframeId));
}

export function setShotTimelineDuration(
  project: LocationProject,
  shotId: string,
  durationSeconds: number,
): LocationProject {
  assertDuration(durationSeconds);
  const shot = resolveShot(project, shotId);
  const next = updateCameraMoveDuration(shot.cameraKeyframes, durationSeconds);
  validatePartialTimeline(next);
  return updateShotTimeline(project, shotId, next);
}

export function stageObjectAtKeyframe(
  project: LocationProject,
  shotId: string,
  keyframeId: string,
  objectId: string,
  patch: StageObjectAtKeyframeInput,
): LocationProject {
  const shot = resolveShot(project, shotId);
  const keyframe = resolveKeyframe(shot, keyframeId);
  const object = project.scene.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Error(`Unknown scene object '${objectId}'.`);
  if (!canStageObjectPerShot(object)) throw new Error(`Scene object '${objectId}' cannot be staged.`);
  const baseOverrides = keyframe.objectOverrides ?? {};
  const nextOverrides = updateShotObjectOverrides(
    { objectOverrides: baseOverrides },
    object,
    {
      ...(patch.transform ? { transform: cloneTransform(patch.transform) } : {}),
      ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
      ...(patch.humanPose !== undefined ? { humanPose: cloneHumanPose(patch.humanPose) } : {}),
    },
  );
  return updateShotKeyframe(project, shotId, keyframeId, { objectOverrides: nextOverrides });
}

export function clearKeyframeStaging(
  project: LocationProject,
  shotId: string,
  keyframeId: string,
  objectId?: string,
): LocationProject {
  const shot = resolveShot(project, shotId);
  const keyframe = resolveKeyframe(shot, keyframeId);
  if (!objectId) return updateShotKeyframe(project, shotId, keyframeId, { objectOverrides: {} });
  const next = cloneShotObjectOverrides(keyframe.objectOverrides);
  delete next[objectId];
  return updateShotKeyframe(project, shotId, keyframeId, { objectOverrides: next });
}

export function clearShotTimeline(project: LocationProject, shotId: string): LocationProject {
  resolveShot(project, shotId);
  return updateShotTimeline(project, shotId, []);
}

/** Persist a timeline draft, including the temporary one-keyframe capture state. */
export function setShotTimelineKeyframes(
  project: LocationProject,
  shotId: string,
  keyframes: readonly CameraKeyframe[],
): LocationProject {
  const sorted = getSortedCameraKeyframes(keyframes.map(cloneKeyframe));
  validatePartialTimeline(sorted);
  return updateShotTimeline(project, shotId, sorted);
}

export function sampleShotTimeline(
  project: LocationProject,
  shotId: string,
  timeSeconds: number,
): ShotTimelineSample {
  const shot = resolveShot(project, shotId);
  assertFiniteTime(timeSeconds, 'timeSeconds');
  const keyframes = getSortedCameraKeyframes(shot.cameraKeyframes);
  if (keyframes.length === 0) {
    return {
      shotId,
      requestedTimeSeconds: timeSeconds,
      sampledTimeSeconds: 0,
      durationSeconds: 0,
      camera: structuredClone(shot.camera),
      objectOverrides: structuredClone(shot.objectOverrides ?? {}),
    };
  }
  const durationSeconds = getCameraMoveDurationSeconds(keyframes);
  const sampledTimeSeconds = Math.max(0, Math.min(timeSeconds, durationSeconds));
  return {
    shotId,
    requestedTimeSeconds: timeSeconds,
    sampledTimeSeconds,
    durationSeconds,
    camera: interpolateCameraKeyframes(keyframes, sampledTimeSeconds),
    objectOverrides: interpolateObjectOverrides(
      keyframes,
      sampledTimeSeconds,
      shot.objectOverrides,
      project.scene.objects,
    ),
  };
}

export function invalidateShotTimelineArtifacts(
  project: LocationProject,
  shotId: string,
): LocationProject {
  const shot = resolveShot(project, shotId);
  const nextShots = project.shots.map((candidate) => candidate.id === shotId
    ? {
        ...candidate,
        assets: { ...candidate.assets, cameraMoveVideoAssetId: undefined },
        cameraKeyframes: candidate.cameraKeyframes.map((keyframe) => {
          const { previewAssetId: _asset, previewStorageKey: _storage, previewUri: _uri, ...rest } = keyframe;
          return rest;
        }),
      }
    : candidate);
  return pruneUnreferencedProjectAssets({ ...project, shots: nextShots });
}

function updateShotTimeline(project: LocationProject, shotId: string, keyframes: readonly CameraKeyframe[]): LocationProject {
  resolveShot(project, shotId);
  const next = {
    ...project,
    shots: project.shots.map((shot) => shot.id === shotId
      ? { ...shot, cameraKeyframes: keyframes.map(cloneKeyframe) }
      : shot),
  };
  return invalidateShotTimelineArtifacts(next, shotId);
}

function resolveShot(project: LocationProject, shotId: string): Shot {
  const shot = project.shots.find((candidate) => candidate.id === shotId);
  if (!shot) throw new Error(`Unknown shot '${shotId}'.`);
  return shot;
}

function resolveKeyframe(shot: Shot, keyframeId: string): CameraKeyframe {
  const keyframe = shot.cameraKeyframes.find((candidate) => candidate.id === keyframeId);
  if (!keyframe) throw new Error(`Unknown keyframe '${keyframeId}' in shot '${shot.id}'.`);
  return keyframe;
}

function cloneKeyframe(keyframe: CameraKeyframe): CameraKeyframe {
  return {
    ...keyframe,
    camera: cloneCamera(keyframe.camera),
    ...(keyframe.objectOverrides !== undefined
      ? { objectOverrides: cloneShotObjectOverrides(keyframe.objectOverrides) }
      : {}),
  };
}

function cloneCamera(camera: CameraData): CameraData {
  return {
    ...camera,
    position: [...camera.position],
    target: [...camera.target],
  };
}

function cloneCameraPatch(camera: Partial<CameraData>): Partial<CameraData> {
  return {
    ...camera,
    ...(camera.position ? { position: [...camera.position] as CameraData['position'] } : {}),
    ...(camera.target ? { target: [...camera.target] as CameraData['target'] } : {}),
  };
}

function validatePartialTimeline(keyframes: readonly CameraKeyframe[]): void {
  const ids = new Set<string>();
  let previousTime = -Infinity;
  for (const keyframe of getSortedCameraKeyframes(keyframes)) {
    if (!keyframe.id || ids.has(keyframe.id)) throw new Error('Timeline keyframe IDs must be unique.');
    ids.add(keyframe.id);
    assertFiniteTime(keyframe.timeSeconds, 'keyframe timeSeconds');
    if (keyframe.timeSeconds <= previousTime) throw new Error('Timeline keyframe times must be strictly increasing.');
    previousTime = keyframe.timeSeconds;
    validateCamera(keyframe.camera);
  }
}

function validateCompletedTimeline(keyframes: readonly CameraKeyframe[], durationSeconds?: number): void {
  validatePartialTimeline(keyframes);
  const sorted = getSortedCameraKeyframes(keyframes);
  if (sorted.length < 2) throw new Error('A completed timeline requires at least two keyframes.');
  if (Math.abs(sorted[0].timeSeconds) > 0.0001) throw new Error('The first keyframe must start at time 0.');
  const duration = durationSeconds ?? sorted[sorted.length - 1].timeSeconds;
  assertDuration(duration);
  if (Math.abs(sorted[sorted.length - 1].timeSeconds - duration) > 0.0001) {
    throw new Error('The final keyframe time must equal the timeline duration.');
  }
}

/** Validate a timeline after a complete agent plan has finished applying. */
export function validateCompletedShotTimeline(shot: Pick<Shot, 'cameraKeyframes'>): void {
  if (shot.cameraKeyframes.length === 0) return;
  validateCompletedTimeline(shot.cameraKeyframes);
}

function validateCamera(camera: CameraData): void {
  const values = [...camera.position, ...camera.target, camera.fovDegrees, camera.aspectRatio, camera.near, camera.far];
  if (values.some((value) => !Number.isFinite(value))) throw new Error('Camera values must be finite.');
}

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function assertDuration(value: number): void {
  if (!Number.isFinite(value) || value < MIN_CAMERA_MOVE_DURATION_SECONDS || value > MAX_CAMERA_MOVE_DURATION_SECONDS) {
    throw new Error(`Timeline duration must be between ${MIN_CAMERA_MOVE_DURATION_SECONDS} and ${MAX_CAMERA_MOVE_DURATION_SECONDS} seconds.`);
  }
  // Keep this call as the single shared normalization point if engine limits change.
  clampDuration(value);
}

function hasManualTiming(keyframes: readonly CameraKeyframe[], durationSeconds: number): boolean {
  if (keyframes.length < 2) return false;
  return keyframes.some((keyframe, index) => {
    const expected = (index / (keyframes.length - 1)) * durationSeconds;
    return Math.abs(keyframe.timeSeconds - expected) > 0.001;
  });
}

// Keep the imported easing helper part of this module's public interpolation contract.
export { applyCameraKeyframeEasing };
