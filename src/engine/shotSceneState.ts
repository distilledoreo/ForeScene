import type {
  LocationProject,
  SceneObject,
  Shot,
  ShotObjectOverride,
  ShotObjectOverrides,
  StagingRole,
  Transform,
} from '../domain/types';

export interface ResolveShotSceneOptions {
  hidePeople?: boolean;
}

export function cloneTransform(transform: Transform): Transform {
  return {
    position: [...transform.position],
    rotation: [...transform.rotation],
    scale: [...transform.scale],
  };
}

export function transformsEqual(a: Transform, b: Transform): boolean {
  return (
    a.position.every((value, index) => value === b.position[index])
    && a.rotation.every((value, index) => value === b.rotation[index])
    && a.scale.every((value, index) => value === b.scale[index])
  );
}

export function getSceneObjectStagingRole(
  object: Pick<SceneObject, 'type' | 'stagingRole'>,
): StagingRole {
  if (object.stagingRole === 'set' || object.stagingRole === 'prop' || object.stagingRole === 'person') {
    return object.stagingRole;
  }
  return object.type === 'human_dummy' ? 'person' : 'set';
}

export function canStageObjectPerShot(object: Pick<SceneObject, 'type' | 'stagingRole' | 'locked'>): boolean {
  if (object.locked) return false;
  // Sun markers are helpers, not shot dressing.
  if (object.type === 'sun_marker') return false;
  return true;
}

/**
 * Keep all stageable objects discoverable, including ones hidden for this shot.
 * A hidden object cannot be picked in the viewport, so the staging list is its
 * recovery path.
 */
export function getStageableObjectsForShot<T extends Pick<SceneObject, 'type' | 'stagingRole' | 'locked'>>(
  objects: readonly T[],
): T[] {
  return objects.filter((object) => canStageObjectPerShot(object));
}

export function resolveSceneObjectsForShot(
  project: Pick<LocationProject, 'scene'>,
  shot: Pick<Shot, 'objectOverrides'>,
  options: ResolveShotSceneOptions = {},
): SceneObject[] {
  const overrides = shot.objectOverrides ?? {};
  return project.scene.objects.map((object) => {
    const override = overrides[object.id];
    const stagingRole = getSceneObjectStagingRole(object);
    return {
      ...object,
      stagingRole,
      transform: cloneTransform(override?.transform ?? object.transform),
      visible: options.hidePeople && stagingRole === 'person'
        ? false
        : (override?.visible ?? object.visible),
    };
  });
}

export function resolveProjectForShot(
  project: LocationProject,
  shot: Pick<Shot, 'objectOverrides'>,
  options: ResolveShotSceneOptions = {},
): LocationProject {
  return {
    ...project,
    scene: {
      ...project.scene,
      objects: resolveSceneObjectsForShot(project, shot, options),
    },
  };
}

/**
 * Resolve a shot scene for camera-move export with object animation.
 * Includes any object visible at start or end so visibility can snap mid-move.
 */
export function resolveProjectForAnimatedCameraMove(
  project: LocationProject,
  shot: Pick<Shot, 'objectOverrides' | 'cameraKeyframes'>,
  options: ResolveShotSceneOptions = {},
): LocationProject {
  const sorted = [...(shot.cameraKeyframes ?? [])].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const startOverrides = sorted[0]?.objectOverrides;
  const endOverrides = sorted[sorted.length - 1]?.objectOverrides;
  const fallback = shot.objectOverrides ?? {};
  // Explicit snapshots (including {}) win; only legacy undefined falls back.
  const start = startOverrides !== undefined ? startOverrides : fallback;
  const end = endOverrides !== undefined ? endOverrides : fallback;

  const objects = project.scene.objects.map((object) => {
    const stagingRole = getSceneObjectStagingRole(object);
    const startOverride = start[object.id];
    const endOverride = end[object.id];
    const startVisible = startOverride?.visible ?? object.visible;
    const endVisible = endOverride?.visible ?? object.visible;
    const hiddenByPeople = Boolean(options.hidePeople && stagingRole === 'person');
    return {
      ...object,
      stagingRole,
      transform: cloneTransform(startOverride?.transform ?? endOverride?.transform ?? object.transform),
      visible: hiddenByPeople ? false : (startVisible || endVisible),
    };
  });

  return {
    ...project,
    scene: {
      ...project.scene,
      objects,
    },
  };
}

export function updateShotObjectOverrides(
  shot: Pick<Shot, 'objectOverrides'>,
  baseObject: SceneObject,
  patch: ShotObjectOverride,
): ShotObjectOverrides {
  const next: ShotObjectOverride = {
    ...(shot.objectOverrides?.[baseObject.id] ?? {}),
    ...(patch.transform ? { transform: cloneTransform(patch.transform) } : {}),
    ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
  };
  const compact = { ...(shot.objectOverrides ?? {}) };
  const transformMatchesBase = !next.transform || transformsEqual(next.transform, baseObject.transform);
  const visibilityMatchesBase = next.visible === undefined || next.visible === baseObject.visible;
  if (transformMatchesBase && visibilityMatchesBase) {
    delete compact[baseObject.id];
  } else {
    compact[baseObject.id] = next;
  }
  return compact;
}

export function clearShotObjectOverride(
  shot: Pick<Shot, 'objectOverrides'>,
  objectId: string,
): ShotObjectOverrides {
  const next = { ...(shot.objectOverrides ?? {}) };
  delete next[objectId];
  return next;
}
