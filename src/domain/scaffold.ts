/**
 * Explicit system-scaffold markers for blank-project detection.
 * Prefer tags over fuzzy name/number heuristics.
 */

import type { SceneObject, Shot, Vec3 } from './types';

export type ScaffoldKind = 'initial-floor' | 'initial-light' | 'origin-shot';

export interface ScaffoldSnapshot {
  name: string;
  dimensions?: Vec3;
  position?: Vec3;
  /** Origin-shot camera fingerprint. */
  cameraPosition?: Vec3;
  cameraTarget?: Vec3;
  shotNumber?: string;
}

export interface SystemScaffoldMetadata {
  systemScaffold: true;
  scaffoldKind: ScaffoldKind;
  /** Canonical state at creation; edits that diverge clear “intact scaffold” status. */
  scaffoldSnapshot: ScaffoldSnapshot;
}

function vecClose(a: Vec3 | undefined, b: Vec3 | undefined, eps = 1e-4): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a[0] - b[0]) <= eps
    && Math.abs(a[1] - b[1]) <= eps
    && Math.abs(a[2] - b[2]) <= eps
  );
}

export function createScaffoldMetadata(
  kind: ScaffoldKind,
  snapshot: ScaffoldSnapshot,
): SystemScaffoldMetadata {
  return {
    systemScaffold: true,
    scaffoldKind: kind,
    scaffoldSnapshot: snapshot,
  };
}

export function readScaffoldMetadata(
  metadata: Record<string, unknown> | undefined,
): SystemScaffoldMetadata | undefined {
  if (!metadata || metadata.systemScaffold !== true) return undefined;
  const kind = metadata.scaffoldKind;
  if (kind !== 'initial-floor' && kind !== 'initial-light' && kind !== 'origin-shot') {
    return undefined;
  }
  const snap = metadata.scaffoldSnapshot;
  if (!snap || typeof snap !== 'object') return undefined;
  return {
    systemScaffold: true,
    scaffoldKind: kind,
    scaffoldSnapshot: snap as ScaffoldSnapshot,
  };
}

/** True when the object is tagged as system scaffold and still matches its snapshot. */
export function isIntactSystemScaffoldObject(object: SceneObject): boolean {
  const meta = readScaffoldMetadata(object.metadata as Record<string, unknown> | undefined);
  if (!meta) return false;
  const { scaffoldSnapshot: snap, scaffoldKind } = meta;
  if (object.name !== snap.name) return false;
  if (scaffoldKind === 'initial-floor' || scaffoldKind === 'initial-light') {
    if (snap.dimensions && !vecClose(object.dimensions, snap.dimensions)) return false;
    if (snap.position && !vecClose(object.transform.position, snap.position)) return false;
  }
  return true;
}

/** True when the shot is tagged as origin scaffold and still matches its snapshot. */
export function isIntactSystemScaffoldShot(shot: Shot): boolean {
  const meta = readScaffoldMetadata(shot.metadata as Record<string, unknown> | undefined);
  if (!meta || meta.scaffoldKind !== 'origin-shot') return false;
  const snap = meta.scaffoldSnapshot;
  if (shot.name !== snap.name) return false;
  if (snap.shotNumber !== undefined && shot.shotNumber !== snap.shotNumber) return false;
  if (snap.cameraPosition && !vecClose(shot.camera.position, snap.cameraPosition)) return false;
  if (snap.cameraTarget && !vecClose(shot.camera.target, snap.cameraTarget)) return false;
  // User staging / keyframes / pano link mean real work.
  if (shot.objectOverrides && Object.keys(shot.objectOverrides).length > 0) return false;
  if ((shot.cameraKeyframes?.length ?? 0) > 0) return false;
  if (shot.linkedPanoId) return false;
  return true;
}

export function tagObjectAsScaffold(
  object: SceneObject,
  kind: Exclude<ScaffoldKind, 'origin-shot'>,
): SceneObject {
  const snapshot: ScaffoldSnapshot = {
    name: object.name,
    dimensions: [...object.dimensions] as Vec3,
    position: [...object.transform.position] as Vec3,
  };
  object.metadata = {
    ...object.metadata,
    ...createScaffoldMetadata(kind, snapshot),
  };
  return object;
}

export function tagShotAsScaffold(shot: Shot): Shot {
  const snapshot: ScaffoldSnapshot = {
    name: shot.name,
    shotNumber: shot.shotNumber,
    cameraPosition: [...shot.camera.position] as Vec3,
    cameraTarget: [...shot.camera.target] as Vec3,
  };
  shot.metadata = {
    ...shot.metadata,
    ...createScaffoldMetadata('origin-shot', snapshot),
  };
  return shot;
}
