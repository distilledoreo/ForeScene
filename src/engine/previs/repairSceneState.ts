/**
 * Shot-effective transforms for repair re-solves.
 *
 * Characters are staged per-shot via shot.objectOverrides; using base
 * scene.object.transform aims the camera at empty parking positions.
 */

import type { LocationProject, Shot, Vec3 } from '../../domain/types';
import { resolveProjectForShot } from '../shotSceneState';
import { subjectBoundsFromPlacement, type SubjectBounds } from './cameraSolver';
import type { PrevisShotDefinition } from './manifest';

const SOLID_TYPES = new Set([
  'wall', 'box', 'column', 'arch', 'doorway', 'stairs', 'terrain_mass', 'background_card',
]);

export interface RepairBlockerAabb {
  id: string;
  min: Vec3;
  max: Vec3;
}

/**
 * Build subject bounds from the shot-resolved scene (objectOverrides applied).
 * Skips subjects that are not effectively visible for this shot.
 */
export function buildSubjectBoundsForRepair(params: {
  project: LocationProject;
  shot: Shot;
  definition: PrevisShotDefinition;
  subjectNames?: Record<string, string>;
}): SubjectBounds[] {
  const resolved = resolveProjectForShot(params.project, params.shot);
  const ids = new Set([
    ...params.definition.subjects,
    ...params.definition.camera.subjects,
    ...(params.definition.camera.foregroundSubject
      ? [params.definition.camera.foregroundSubject]
      : []),
  ]);

  const bounds: SubjectBounds[] = [];
  for (const id of ids) {
    const name = params.subjectNames?.[id] ?? id;
    const object = resolved.scene.objects.find((candidate) => (
      candidate.name === name
      || candidate.name.toLowerCase() === name.toLowerCase()
      || candidate.name.toLowerCase().includes(id.toLowerCase())
      || candidate.id === id
    ));
    if (!object) continue;

    // Effective visibility already merged by resolveProjectForShot.
    if (object.visible === false) continue;

    const height = object.dimensions[1] * object.transform.scale[1];
    const width = object.dimensions[0] * object.transform.scale[0];
    const depth = object.dimensions[2] * object.transform.scale[2];
    // Staged humans use center Y = height/2; convert to floor contact for bounds.
    const floorY = object.transform.position[1] - height / 2;
    const yaw = object.transform.rotation[1] * (Math.PI / 180);
    bounds.push(subjectBoundsFromPlacement({
      id,
      position: [object.transform.position[0], floorY, object.transform.position[2]],
      height,
      width,
      depth,
      yawRadians: yaw,
    }));
  }
  return bounds;
}

/**
 * Solid blockers from the shot-resolved scene (respects wall hide overrides).
 */
export function solidBlockersForRepair(params: {
  project: LocationProject;
  shot: Shot;
}): RepairBlockerAabb[] {
  const resolved = resolveProjectForShot(params.project, params.shot);
  const blockers: RepairBlockerAabb[] = [];
  for (const object of resolved.scene.objects) {
    if (!SOLID_TYPES.has(object.type)) continue;
    if (object.visible === false) continue;
    const hx = (object.dimensions[0] * object.transform.scale[0]) / 2;
    const hy = (object.dimensions[1] * object.transform.scale[1]) / 2;
    const hz = (object.dimensions[2] * object.transform.scale[2]) / 2;
    const c = object.transform.position;
    blockers.push({
      id: object.id,
      min: [c[0] - hx, c[1] - hy, c[2] - hz],
      max: [c[0] + hx, c[1] + hy, c[2] + hz],
    });
  }
  return blockers;
}
