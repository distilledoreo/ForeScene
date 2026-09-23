/**
 * Shot-effective transforms for repair re-solves.
 *
 * Characters are staged per-shot via shot.objectOverrides; using base
 * scene.object.transform aims the camera at empty parking positions.
 */

import type { LocationProject, Shot, Vec3 } from '../../domain/types';
import { resolveProjectForShot } from '../shotSceneState';
import { resolveSceneRelationships, resolvedObjectWorldAabbs } from '../sceneRelationships';
import { objectWorldAabb } from './compositionTelemetry';
import type { SubjectBounds } from './cameraSolver';
import type { PrevisShotDefinition } from './manifest';
import { getProductionConfiguration } from './productionConfiguration';

const SOLID_TYPES = new Set([
  'wall', 'box', 'column', 'arch', 'stairs', 'terrain_mass', 'background_card',
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
      const boxes = visibleObjects.map(objectWorldAabb);
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

    const box = objectWorldAabb(object);
    const yaw = object.transform.rotation[1] * (Math.PI / 180);
    bounds.push({
      id,
      sourceObjectId: object.id,
      sourceTransform: object.transform,
      min: box.min,
      max: box.max,
      position: [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2],
      yawRadians: yaw,
      requireCompleteAssembly: binding?.kind === 'group',
    });
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
  const relationships = resolveSceneRelationships(resolved);
  const blockers: RepairBlockerAabb[] = [];
  for (const object of resolved.scene.objects) {
    if (!SOLID_TYPES.has(object.type)) continue;
    if (object.visible === false) continue;
    for (const box of resolvedObjectWorldAabbs(object, relationships)) {
      blockers.push({ id: object.id, min: box.min, max: box.max });
    }
  }
  return blockers;
}
