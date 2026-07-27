/**
 * Shot-to-shot continuity comparison: camera, lens, staging, and visibility deltas.
 */

import type {
  CameraData,
  LocationProject,
  SceneObject,
  Shot,
  ShotObjectOverrides,
  Transform,
  Vec3,
} from '../domain/types';
import { resolveProjectForShot } from './shotSceneState';
import { verticalFovToFocalLength } from './focalLength';

export interface ContinuityScalarDelta {
  field: string;
  label: string;
  previous: number | string | boolean;
  current: number | string | boolean;
  delta?: number;
  unit?: string;
}

export interface ContinuityTransformDelta {
  objectId: string;
  objectName: string;
  positionDeltaMeters: Vec3;
  rotationDeltaDegrees: Vec3;
  scaleDelta: Vec3;
  visibilityChanged: boolean;
  previousVisible: boolean;
  currentVisible: boolean;
}

export interface ContinuityCompareReport {
  previousShotId: string;
  currentShotId: string;
  previousShotLabel: string;
  currentShotLabel: string;
  camera: ContinuityScalarDelta[];
  lens: ContinuityScalarDelta[];
  clipping: ContinuityScalarDelta[];
  staging: ContinuityTransformDelta[];
  visibility: ContinuityScalarDelta[];
  summary: string;
}

function vecDelta(a: Vec3, b: Vec3): Vec3 {
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

function nearlyEqual(a: number, b: number, epsilon = 1e-4): boolean {
  return Math.abs(a - b) <= epsilon;
}

function cameraDeltas(previous: CameraData, current: CameraData): ContinuityScalarDelta[] {
  const deltas: ContinuityScalarDelta[] = [];
  const pos = vecDelta(previous.position, current.position);
  const posMag = Math.hypot(pos[0], pos[1], pos[2]);
  if (!nearlyEqual(posMag, 0)) {
    deltas.push({
      field: 'position',
      label: 'Camera position',
      previous: previous.position.map((v) => v.toFixed(3)).join(', '),
      current: current.position.map((v) => v.toFixed(3)).join(', '),
      delta: posMag,
      unit: 'm',
    });
  }
  const target = vecDelta(previous.target, current.target);
  const targetMag = Math.hypot(target[0], target[1], target[2]);
  if (!nearlyEqual(targetMag, 0)) {
    deltas.push({
      field: 'target',
      label: 'Look-at target',
      previous: previous.target.map((v) => v.toFixed(3)).join(', '),
      current: current.target.map((v) => v.toFixed(3)).join(', '),
      delta: targetMag,
      unit: 'm',
    });
  }
  if (!nearlyEqual(previous.fovDegrees, current.fovDegrees)) {
    deltas.push({
      field: 'fov',
      label: 'Vertical FOV',
      previous: previous.fovDegrees,
      current: current.fovDegrees,
      delta: current.fovDegrees - previous.fovDegrees,
      unit: '°',
    });
  }
  return deltas;
}

function lensDeltas(previous: CameraData, current: CameraData): ContinuityScalarDelta[] {
  const prevFocal = verticalFovToFocalLength(previous.fovDegrees, previous.aspectRatio);
  const currFocal = verticalFovToFocalLength(current.fovDegrees, current.aspectRatio);
  const deltas: ContinuityScalarDelta[] = [];
  if (!nearlyEqual(prevFocal, currFocal, 0.05)) {
    deltas.push({
      field: 'focalLength',
      label: 'Focal length',
      previous: Number(prevFocal.toFixed(1)),
      current: Number(currFocal.toFixed(1)),
      delta: Number((currFocal - prevFocal).toFixed(1)),
      unit: 'mm',
    });
  }
  if (!nearlyEqual(previous.aspectRatio, current.aspectRatio, 1e-3)) {
    deltas.push({
      field: 'aspect',
      label: 'Aspect ratio',
      previous: Number(previous.aspectRatio.toFixed(3)),
      current: Number(current.aspectRatio.toFixed(3)),
      delta: Number((current.aspectRatio - previous.aspectRatio).toFixed(3)),
    });
  }
  return deltas;
}

function clippingDeltas(previous: CameraData, current: CameraData): ContinuityScalarDelta[] {
  const deltas: ContinuityScalarDelta[] = [];
  if (!nearlyEqual(previous.near, current.near, 1e-4)) {
    deltas.push({
      field: 'near',
      label: 'Near clip',
      previous: previous.near,
      current: current.near,
      delta: current.near - previous.near,
      unit: 'm',
    });
  }
  if (!nearlyEqual(previous.far, current.far, 1e-3)) {
    deltas.push({
      field: 'far',
      label: 'Far clip',
      previous: previous.far,
      current: current.far,
      delta: current.far - previous.far,
      unit: 'm',
    });
  }
  return deltas;
}

function transformOf(
  object: SceneObject,
  overrides?: ShotObjectOverrides,
): { transform: Transform; visible: boolean } {
  const override = overrides?.[object.id];
  return {
    transform: override?.transform ?? object.transform,
    visible: override?.visible ?? object.visible,
  };
}

function stagingDeltas(
  previousObjects: readonly SceneObject[],
  currentObjects: readonly SceneObject[],
  previousOverrides?: ShotObjectOverrides,
  currentOverrides?: ShotObjectOverrides,
): ContinuityTransformDelta[] {
  const byId = new Map(currentObjects.map((object) => [object.id, object]));
  const deltas: ContinuityTransformDelta[] = [];
  for (const prev of previousObjects) {
    const curr = byId.get(prev.id);
    if (!curr) continue;
    const a = transformOf(prev, previousOverrides);
    const b = transformOf(curr, currentOverrides);
    const positionDeltaMeters = vecDelta(a.transform.position, b.transform.position);
    const rotationDeltaDegrees = vecDelta(a.transform.rotation, b.transform.rotation);
    const scaleDelta = vecDelta(a.transform.scale, b.transform.scale);
    const moved = !nearlyEqual(Math.hypot(...positionDeltaMeters), 0)
      || !nearlyEqual(Math.hypot(...rotationDeltaDegrees), 0, 0.05)
      || !nearlyEqual(Math.hypot(...scaleDelta), 0, 1e-3);
    const visibilityChanged = a.visible !== b.visible;
    if (!moved && !visibilityChanged) continue;
    deltas.push({
      objectId: prev.id,
      objectName: prev.name,
      positionDeltaMeters,
      rotationDeltaDegrees,
      scaleDelta,
      visibilityChanged,
      previousVisible: a.visible,
      currentVisible: b.visible,
    });
  }
  return deltas;
}

export function getPreviousShotInSequence(
  project: Pick<LocationProject, 'shots'>,
  currentShotId: string,
): Shot | undefined {
  const index = project.shots.findIndex((shot) => shot.id === currentShotId);
  if (index <= 0) return undefined;
  return project.shots[index - 1];
}

export function compareShotsForContinuity(params: {
  project: LocationProject;
  previousShot: Shot;
  currentShot: Shot;
}): ContinuityCompareReport {
  const { project, previousShot, currentShot } = params;
  const prevResolved = resolveProjectForShot(project, previousShot);
  const currResolved = resolveProjectForShot(project, currentShot);

  const camera = cameraDeltas(previousShot.camera, currentShot.camera);
  const lens = lensDeltas(previousShot.camera, currentShot.camera);
  const clipping = clippingDeltas(previousShot.camera, currentShot.camera);
  const staging = stagingDeltas(
    prevResolved.scene.objects,
    currResolved.scene.objects,
    previousShot.objectOverrides,
    currentShot.objectOverrides,
  );
  const visibility: ContinuityScalarDelta[] = staging
    .filter((item) => item.visibilityChanged)
    .map((item) => ({
      field: `visibility:${item.objectId}`,
      label: `${item.objectName} visibility`,
      previous: item.previousVisible,
      current: item.currentVisible,
    }));

  const changeCount = camera.length + lens.length + clipping.length + staging.length;
  const summary = changeCount === 0
    ? 'No continuity deltas between these shots.'
    : `${changeCount} continuity change${changeCount === 1 ? '' : 's'} vs previous shot.`;

  return {
    previousShotId: previousShot.id,
    currentShotId: currentShot.id,
    previousShotLabel: previousShot.name || previousShot.productionShotId || previousShot.id,
    currentShotLabel: currentShot.name || currentShot.productionShotId || currentShot.id,
    camera,
    lens,
    clipping,
    staging,
    visibility,
    summary,
  };
}
