/**
 * Resolved production bindings for compile phases (object, multipart group, or prepared location).
 */

import type { LocationProject, Vec3 } from '../../domain/types';
import { resolveProductionBindingObjectIds } from './productionConfiguration';

export type ProductionCompileEntityBinding =
  | { kind: 'object'; objectId: string }
  | { kind: 'group'; groupId: string; objectIds: string[] };

export interface ProductionCompileLocationBinding {
  locationId: string;
  objectIds: string[];
  anchors: Record<string, Vec3>;
  blockerObjectIds: string[];
}

export function buildProductionCompileEntityBindings(
  project: LocationProject,
): Record<string, ProductionCompileEntityBinding> {
  const bindings: Record<string, ProductionCompileEntityBinding> = {};
  for (const [entityId, objectId] of Object.entries(project.workflow.productionManifestAssetBindings ?? {})) {
    if (objectId) bindings[entityId] = { kind: 'object', objectId };
  }
  const production = project.workflow.production;
  if (!production) return bindings;
  for (const [entityId, binding] of Object.entries(production.bindings)) {
    if (binding.kind === 'object') {
      bindings[entityId] = { kind: 'object', objectId: binding.objectId };
      continue;
    }
    if (binding.kind === 'group') {
      const objectIds = resolveProductionBindingObjectIds(project, binding);
      bindings[entityId] = { kind: 'group', groupId: binding.groupId, objectIds };
      continue;
    }
    if (binding.kind === 'location') {
      const locationDef = production.locations[binding.locationId];
      const anchorObjectId = locationDef?.objectIds[0];
      if (anchorObjectId) {
        bindings[binding.locationId] = { kind: 'object', objectId: anchorObjectId };
      }
    }
  }
  return bindings;
}

export function buildProductionCompileLocationBindings(
  project: LocationProject,
): Record<string, ProductionCompileLocationBinding> {
  const production = project.workflow.production;
  if (!production) return {};
  const bindings: Record<string, ProductionCompileLocationBinding> = {};
  for (const [locationId, locationDef] of Object.entries(production.locations)) {
    const objectIds = resolveProductionBindingObjectIds(project, {
      kind: 'location',
      locationId: locationDef.id,
    });
    const anchors: Record<string, Vec3> = {};
    for (const [key, anchor] of Object.entries(locationDef.anchors)) {
      anchors[key] = [...anchor.position] as Vec3;
    }
    bindings[locationId] = {
      locationId,
      objectIds,
      anchors,
      blockerObjectIds: [...locationDef.blockerObjectIds],
    };
  }
  return bindings;
}

export function resolveCompileEntityBinding(
  entityId: string,
  options: {
    entityBindings?: Record<string, ProductionCompileEntityBinding>;
    assetBindings?: Record<string, string>;
  },
): ProductionCompileEntityBinding | undefined {
  const explicit = options.entityBindings?.[entityId];
  if (explicit) return explicit;
  const legacyObjectId = options.assetBindings?.[entityId];
  return legacyObjectId ? { kind: 'object', objectId: legacyObjectId } : undefined;
}
