/**
 * Shot-effective spatial state for Agent API primitives.
 * Reads and writes per-shot staging overrides — never mutates base scene objects.
 */

import type {
  CameraData,
  LocationProject,
  SceneObject,
  Shot,
  ShotObjectOverride,
  Transform,
  Vec3,
} from '../../domain/types';
import {
  resolveProjectForShot,
  resolveSceneObjectsForShot,
  updateShotObjectOverrides,
} from '../shotSceneState';
import { sampleShotTimeline } from '../shotTimeline';
import { objectWorldAabb } from '../previs/compositionTelemetry';
import { AGENT_UPRIGHT_OBJECT_TYPES } from './constants';

export interface ShotEffectiveState {
  shot: Shot;
  sampledTimeSeconds?: number;
  objects: SceneObject[];
  resolvedProject: LocationProject;
}

export function getShotEffectiveState(
  project: LocationProject,
  shotId: string,
  timeSeconds?: number,
): ShotEffectiveState | undefined {
  const shot = project.shots.find((candidate) => candidate.id === shotId);
  if (!shot) return undefined;

  if (timeSeconds !== undefined) {
    const sample = sampleShotTimeline(project, shotId, timeSeconds);
    const shotAtTime: Shot = {
      ...shot,
      camera: sample.camera,
      objectOverrides: sample.objectOverrides,
    };
    const resolvedProject = resolveProjectForShot(project, shotAtTime);
    return {
      shot: shotAtTime,
      sampledTimeSeconds: sample.sampledTimeSeconds,
      objects: resolvedProject.scene.objects,
      resolvedProject,
    };
  }

  const resolvedProject = resolveProjectForShot(project, shot);
  return {
    shot,
    objects: resolvedProject.scene.objects,
    resolvedProject,
  };
}

export function getEffectiveObject(
  state: ShotEffectiveState,
  objectId: string,
): SceneObject | undefined {
  return state.objects.find((candidate) => candidate.id === objectId);
}

export function identifyFloorY(
  project: LocationProject,
  position: Vec3,
): number {
  const floors = project.scene.objects.filter((object) => (
    (object.type === 'floor' || object.type === 'terrain_mass')
    && object.visible !== false
  ));
  if (floors.length === 0) return 0;

  let bestTop = -Infinity;
  for (const floor of floors) {
    const box = objectWorldAabb(floor);
    const insideX = position[0] >= box.min[0] && position[0] <= box.max[0];
    const insideZ = position[2] >= box.min[2] && position[2] <= box.max[2];
    if (insideX && insideZ) {
      bestTop = Math.max(bestTop, box.max[1]);
    }
  }
  if (bestTop !== -Infinity) return bestTop;

  // Fall back to the highest floor surface in the scene.
  for (const floor of floors) {
    bestTop = Math.max(bestTop, objectWorldAabb(floor).max[1]);
  }
  return Number.isFinite(bestTop) ? bestTop : 0;
}

export function uprightFloorPositionForObject(
  object: SceneObject,
  floorY: number,
): Vec3 {
  const height = object.dimensions[1] * object.transform.scale[1];
  const halfHeight = AGENT_UPRIGHT_OBJECT_TYPES.has(object.type) ? height / 2 : 0;
  return [
    object.transform.position[0],
    floorY + halfHeight,
    object.transform.position[2],
  ];
}

export function signedGroundClearanceMeters(
  object: SceneObject,
  floorY: number,
): number {
  const box = objectWorldAabb(object);
  return box.min[1] - floorY;
}

export function applyShotStagingPatch(
  project: LocationProject,
  shotId: string,
  objectId: string,
  patch: ShotObjectOverride,
): LocationProject {
  const shot = project.shots.find((candidate) => candidate.id === shotId);
  const baseObject = project.scene.objects.find((candidate) => candidate.id === objectId);
  if (!shot || !baseObject) return project;

  const overrides = updateShotObjectOverrides(shot, baseObject, patch);
  return {
    ...project,
    shots: project.shots.map((candidate) => candidate.id === shotId
      ? {
          ...candidate,
          objectOverrides: overrides,
          updatedAt: new Date().toISOString(),
        }
      : candidate),
  };
}

export function applyShotStagingTransform(
  project: LocationProject,
  shotId: string,
  objectId: string,
  transform: Partial<Transform>,
): LocationProject {
  const state = getShotEffectiveState(project, shotId);
  if (!state) return project;
  const effective = getEffectiveObject(state, objectId);
  const baseObject = project.scene.objects.find((candidate) => candidate.id === objectId);
  if (!effective || !baseObject) return project;

  const nextTransform: Transform = {
    position: transform.position
      ? [...transform.position] as Vec3
      : [...effective.transform.position] as Vec3,
    rotation: transform.rotation
      ? [...transform.rotation] as Vec3
      : [...effective.transform.rotation] as Vec3,
    scale: transform.scale
      ? [...transform.scale] as Vec3
      : [...effective.transform.scale] as Vec3,
  };

  return applyShotStagingPatch(project, shotId, objectId, { transform: nextTransform });
}

export function applyShotCamera(
  project: LocationProject,
  shotId: string,
  camera: CameraData,
): LocationProject {
  return {
    ...project,
    shots: project.shots.map((shot) => shot.id === shotId
      ? { ...shot, camera: { ...camera }, updatedAt: new Date().toISOString() }
      : shot),
  };
}

export function computeEnvironmentBounds(
  project: LocationProject,
  shot: Pick<Shot, 'objectOverrides'>,
): { min: Vec3; max: Vec3 } | null {
  const resolved = resolveProjectForShot(project, shot);
  const footprintObjects = resolved.scene.objects.filter((object) => (
    ['floor', 'terrain_mass', 'wall', 'box', 'column', 'arch', 'doorway'].includes(object.type)
    && object.visible !== false
  ));
  if (footprintObjects.length === 0) return null;

  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const object of footprintObjects) {
    const box = objectWorldAabb(object);
    min = [
      Math.min(min[0], box.min[0]),
      Math.min(min[1], box.min[1]),
      Math.min(min[2], box.min[2]),
    ];
    max = [
      Math.max(max[0], box.max[0]),
      Math.max(max[1], box.max[1]),
      Math.max(max[2], box.max[2]),
    ];
  }
  const headroom = 4;
  max[1] = max[1] + headroom;
  return { min, max };
}

export function cameraInsideBounds(
  camera: Vec3,
  bounds: { min: Vec3; max: Vec3 },
  margin = 0.05,
): boolean {
  return (
    camera[0] >= bounds.min[0] - margin && camera[0] <= bounds.max[0] + margin
    && camera[1] >= bounds.min[1] - margin && camera[1] <= bounds.max[1] + margin
    && camera[2] >= bounds.min[2] - margin && camera[2] <= bounds.max[2] + margin
  );
}

export function cameraIntersectsSolidGeometry(
  project: LocationProject,
  shot: Pick<Shot, 'objectOverrides' | 'camera'>,
): boolean {
  const resolved = resolveProjectForShot(project, shot);
  const solids = resolved.scene.objects.filter((object) => (
    ['wall', 'box', 'column', 'arch', 'doorway', 'stairs', 'terrain_mass'].includes(object.type)
    && object.visible !== false
  ));
  const camera = shot.camera.position;
  for (const object of solids) {
    const box = objectWorldAabb(object);
    const margin = 0.05;
    if (
      camera[0] >= box.min[0] - margin && camera[0] <= box.max[0] + margin
      && camera[1] >= box.min[1] - margin && camera[1] <= box.max[1] + margin
      && camera[2] >= box.min[2] - margin && camera[2] <= box.max[2] + margin
    ) {
      return true;
    }
  }
  return false;
}

export function displacementMeters(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

export function camerasNearlyEqual(a: CameraData, b: CameraData, epsilon = 0.05): boolean {
  const positionClose = displacementMeters(a.position, b.position) <= epsilon;
  const targetClose = displacementMeters(a.target, b.target) <= epsilon;
  const fovClose = Math.abs(a.fovDegrees - b.fovDegrees) <= epsilon;
  return positionClose && targetClose && fovClose;
}

export function resolveSceneObjectsAtShotTime(
  project: LocationProject,
  shotId: string,
  timeSeconds: number,
): SceneObject[] {
  const state = getShotEffectiveState(project, shotId, timeSeconds);
  return state?.objects ?? [];
}
