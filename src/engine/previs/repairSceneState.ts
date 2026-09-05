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
import { getProductionConfiguration } from './productionConfiguration';

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
    const configuration = getProductionConfiguration(resolved);
    const binding = [id, `cast.${id}`, `prop.${id}`, `assets.${id}`]
      .map((key) => configuration.bindings[key])
      .find(Boolean);
    const objects = binding?.kind === 'group'
      ? (resolved.scene.objectGroups?.[binding.groupId]?.objectIds ?? []).flatMap((objectId) => {
          const object = resolved.scene.objects.find((candidate) => candidate.id === objectId);
          return object ? [object] : [];
        })
      : binding?.kind === 'object'
        ? resolved.scene.objects.filter((candidate) => candidate.id === binding.objectId)
        : resolved.scene.objects.filter((candidate) => (
            candidate.name === name
            || candidate.name.toLowerCase() === name.toLowerCase()
            || candidate.name.toLowerCase().includes(id.toLowerCase())
            || candidate.id === id
          )).slice(0, 1);
    const visibleObjects = objects.filter((object) => object.visible !== false);
    if (visibleObjects.length === 0) continue;

    if (visibleObjects.length > 1) {
      const boxes = visibleObjects.map((object) => {
        const half: Vec3 = [
          object.dimensions[0] * object.transform.scale[0] / 2,
          object.dimensions[1] * object.transform.scale[1] / 2,
          object.dimensions[2] * object.transform.scale[2] / 2,
        ];
        return {
          min: object.transform.position.map((value, index) => value - half[index]!) as Vec3,
          max: object.transform.position.map((value, index) => value + half[index]!) as Vec3,
        };
      });
      const min: Vec3 = [0, 1, 2].map((axis) => Math.min(...boxes.map((box) => box.min[axis]!))) as Vec3;
      const max: Vec3 = [0, 1, 2].map((axis) => Math.max(...boxes.map((box) => box.max[axis]!))) as Vec3;
      bounds.push({
        id,
        min,
        max,
        position: [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2],
        requireCompleteAssembly: true,
      });
      continue;
    }

    const object = visibleObjects[0]!;

    // Effective visibility already merged by resolveProjectForShot.
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
      requireCompleteAssembly: binding?.kind === 'group',
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
