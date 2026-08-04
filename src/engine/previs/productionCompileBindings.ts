/**
 * Resolved production bindings for compile phases (object or multipart group).
 */

import type { LocationProject } from '../../domain/types';
import { resolveProductionBindingObjectIds } from './productionConfiguration';

export type ProductionCompileEntityBinding =
  | { kind: 'object'; objectId: string }
  | { kind: 'group'; groupId: string; objectIds: string[] };

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
