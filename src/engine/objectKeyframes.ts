import type {
  CameraKeyframe,
  LocationProject,
  SceneObject,
  Shot,
  ShotObjectOverride,
  ShotObjectOverrides,
  Transform,
} from '../domain/types';
import {
  canStageObjectPerShot,
  cloneTransform,
  resolveSceneObjectsForShot,
} from './shotSceneState';
import { applyCameraKeyframeEasing, getSortedCameraKeyframes } from './cameraKeyframes';

export function cloneShotObjectOverrides(
  overrides: ShotObjectOverrides | undefined,
): ShotObjectOverrides {
  if (!overrides) return {};
  const next: ShotObjectOverrides = {};
  for (const [objectId, override] of Object.entries(overrides)) {
    next[objectId] = cloneShotObjectOverride(override);
  }
  return next;
}

export function cloneShotObjectOverride(override: ShotObjectOverride): ShotObjectOverride {
  return {
    ...(override.transform ? { transform: cloneTransform(override.transform) } : {}),
    ...(override.visible !== undefined ? { visible: override.visible } : {}),
  };
}

/**
 * Freeze absolute stageable-object poses for a camera keyframe.
 * Always returns a defined map (possibly empty) so export can tell "base poses"
 * apart from "legacy keyframe with no snapshot".
 */
export function snapshotStageableObjectOverrides(
  project: Pick<LocationProject, 'scene'>,
  shot: Pick<Shot, 'objectOverrides'>,
): ShotObjectOverrides {
  const resolved = resolveSceneObjectsForShot(project, shot);
  const snapshot: ShotObjectOverrides = {};
  for (const object of resolved) {
    if (!canStageObjectPerShot(object)) continue;
    snapshot[object.id] = {
      transform: cloneTransform(object.transform),
      visible: object.visible,
    };
  }
  return snapshot;
}

/** True when start/end keyframes carry explicit object snapshots to animate. */
export function cameraKeyframesHaveObjectAnimation(
  keyframes: readonly CameraKeyframe[] = [],
): boolean {
  const sorted = getSortedCameraKeyframes(keyframes);
  if (sorted.length < 2) return false;
  return sorted[0].objectOverrides !== undefined
    || sorted[sorted.length - 1].objectOverrides !== undefined;
}

/**
 * Interpolate staged-object overrides between the surrounding camera keyframes.
 *
 * Explicit keyframe snapshots (including `{}`) always win. Only legacy keyframes
 * with `objectOverrides: undefined` fall back to the shot's live overrides.
 */
export function interpolateObjectOverrides(
  keyframes: readonly CameraKeyframe[],
  timeSeconds: number,
  fallbackOverrides: ShotObjectOverrides | undefined = {},
  baseObjects: readonly Pick<SceneObject, 'id' | 'transform' | 'visible'>[] = [],
): ShotObjectOverrides {
  const sorted = getSortedCameraKeyframes(keyframes);
  const fallback = fallbackOverrides ?? {};
  if (sorted.length === 0) return cloneShotObjectOverrides(fallback);

  const baseById = new Map(baseObjects.map((object) => [object.id, object]));

  if (sorted.length === 1 || timeSeconds <= sorted[0].timeSeconds) {
    return materializeOverrides(resolveKeyframeOverrides(sorted[0], fallback), baseById);
  }
  const last = sorted[sorted.length - 1];
  if (timeSeconds >= last.timeSeconds) {
    return materializeOverrides(resolveKeyframeOverrides(last, fallback), baseById);
  }

  const nextIndex = sorted.findIndex((keyframe) => keyframe.timeSeconds >= timeSeconds);
  const start = sorted[Math.max(0, nextIndex - 1)];
  const end = sorted[nextIndex];
  const span = Math.max(end.timeSeconds - start.timeSeconds, Number.EPSILON);
  const t = applyCameraKeyframeEasing(
    start.easing,
    (timeSeconds - start.timeSeconds) / span,
  );

  const startOverrides = resolveKeyframeOverrides(start, fallback);
  const endOverrides = resolveKeyframeOverrides(end, fallback);
  const ids = new Set([
    ...Object.keys(startOverrides),
    ...Object.keys(endOverrides),
    ...baseObjects.map((object) => object.id),
  ]);

  const result: ShotObjectOverrides = {};
  for (const id of ids) {
    const startOverride = startOverrides[id];
    const endOverride = endOverrides[id];
    // Skip objects that never appear in either snapshot — keep build pose.
    if (!startOverride && !endOverride) continue;

    const base = baseById.get(id);
    const startTransform = startOverride?.transform ?? base?.transform;
    const endTransform = endOverride?.transform ?? base?.transform;
    const startVisible = startOverride?.visible ?? base?.visible;
    const endVisible = endOverride?.visible ?? base?.visible;

    const override: ShotObjectOverride = {};
    if (startTransform && endTransform) {
      override.transform = lerpTransform(startTransform, endTransform, t);
    } else if (endTransform) {
      override.transform = cloneTransform(endTransform);
    } else if (startTransform) {
      override.transform = cloneTransform(startTransform);
    }

    if (startVisible !== undefined || endVisible !== undefined) {
      // Discrete visibility snap at midpoint — avoids half-visible props.
      const from = startVisible ?? endVisible ?? true;
      const to = endVisible ?? startVisible ?? true;
      override.visible = t < 0.5 ? from : to;
    }

    if (override.transform || override.visible !== undefined) {
      result[id] = override;
    }
  }
  return result;
}

function resolveKeyframeOverrides(
  keyframe: CameraKeyframe,
  fallback: ShotObjectOverrides,
): ShotObjectOverrides {
  // Explicit snapshot — including empty — means "use these poses", not live shot state.
  if (keyframe.objectOverrides !== undefined) {
    return cloneShotObjectOverrides(keyframe.objectOverrides);
  }
  return cloneShotObjectOverrides(fallback);
}

function materializeOverrides(
  overrides: ShotObjectOverrides,
  baseById: Map<string, Pick<SceneObject, 'id' | 'transform' | 'visible'>>,
): ShotObjectOverrides {
  const result: ShotObjectOverrides = {};
  for (const [id, override] of Object.entries(overrides)) {
    const base = baseById.get(id);
    result[id] = {
      transform: cloneTransform(override.transform ?? base?.transform ?? {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      }),
      visible: override.visible ?? base?.visible ?? true,
    };
  }
  return result;
}

function lerpTransform(start: Transform, end: Transform, t: number): Transform {
  return {
    position: [
      lerp(start.position[0], end.position[0], t),
      lerp(start.position[1], end.position[1], t),
      lerp(start.position[2], end.position[2], t),
    ],
    rotation: [
      lerpShortestAngleDegrees(start.rotation[0], end.rotation[0], t),
      lerpShortestAngleDegrees(start.rotation[1], end.rotation[1], t),
      lerpShortestAngleDegrees(start.rotation[2], end.rotation[2], t),
    ],
    scale: [
      lerp(start.scale[0], end.scale[0], t),
      lerp(start.scale[1], end.scale[1], t),
      lerp(start.scale[2], end.scale[2], t),
    ],
  };
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/** Interpolate Euler components through the nearest equivalent angle. */
function lerpShortestAngleDegrees(start: number, end: number, t: number): number {
  const delta = ((end - start + 180) % 360 + 360) % 360 - 180;
  return start + delta * t;
}
