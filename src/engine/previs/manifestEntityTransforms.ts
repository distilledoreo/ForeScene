/**
 * Resolve per-member staging transforms for multipart group entities.
 */

import type { LocationProject, SceneObject, Transform } from '../../domain/types';
import { computeRigidGroupMemberTransforms, groupPivotFromObjects } from '../agent/groupTransform';
import type { PrevisEntityMapping } from './runState';

export interface ManifestEntityMemberTransform {
  objectId: string;
  transform: Transform;
}

export function resolveManifestEntityMemberTransforms(input: {
  mapping: PrevisEntityMapping | undefined;
  project: LocationProject | undefined;
  targetTransform: Transform;
}): ManifestEntityMemberTransform[] {
  const { mapping, project, targetTransform } = input;
  if (!mapping?.groupId || !mapping.objectIds?.length) return [];
  if (project) {
    const members = mapping.objectIds
      .map((objectId) => project.scene.objects.find((object) => object.id === objectId))
      .filter((member): member is SceneObject => Boolean(member));
    if (members.length > 0) {
      const pivot = groupPivotFromObjects(members);
      const memberTransforms = computeRigidGroupMemberTransforms(members, pivot, targetTransform);
      return mapping.objectIds.map((objectId) => ({
        objectId,
        transform: memberTransforms.get(objectId) ?? targetTransform,
      }));
    }
  }
  return mapping.objectIds.map((objectId) => ({
    objectId,
    transform: targetTransform,
  }));
}
