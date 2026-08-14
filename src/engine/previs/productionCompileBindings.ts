/**
 * Resolved production bindings for compile phases (object, multipart group, or prepared location).
 */

import type { LocationProject, Vec3 } from '../../domain/types';
import type { PrevisProductionManifestV1 } from './manifest';
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

function normalizedBindingKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Bind a landmarked existing set without authoring replacement geometry. */
export function inferExistingProjectLocationBindings(
  project: LocationProject,
  manifest: PrevisProductionManifestV1,
): Record<string, ProductionCompileLocationBinding> {
  const landmarks = project.landmarks.map((landmark) => ({
    landmark,
    key: normalizedBindingKey(landmark.name),
  }));
  const centers = manifest.locations.flatMap((location) => {
    const prefix = `${normalizedBindingKey(location.id)}_`;
    const center = landmarks.find((entry) => entry.key === `${prefix}center`);
    return center ? [{ location, prefix, center: center.landmark.position }] : [];
  });
  const bindings: Record<string, ProductionCompileLocationBinding> = {};
  for (const entry of centers) {
    const objectIds = project.scene.objects
      .filter((object) => !object.locked && object.type !== 'sun_marker' && object.category !== 'helper')
      .filter((object) => {
        const position = object.transform.position;
        const ownDistance = Math.hypot(position[0] - entry.center[0], position[2] - entry.center[2]);
        return centers.every((candidate) => {
          if (candidate.location.id === entry.location.id) return true;
          const otherDistance = Math.hypot(position[0] - candidate.center[0], position[2] - candidate.center[2]);
          return ownDistance <= otherDistance;
        });
      })
      .map((object) => object.id);
    const anchors = Object.fromEntries(
      landmarks
        .filter((candidate) => candidate.key.startsWith(entry.prefix))
        .map((candidate) => [
          candidate.key.slice(entry.prefix.length),
          [...candidate.landmark.position] as Vec3,
        ]),
    );
    if (objectIds.length === 0 || !anchors.center) continue;
    const blockerObjectIds = project.scene.objects
      .filter((object) => objectIds.includes(object.id) && object.type !== 'floor')
      .map((object) => object.id);
    bindings[entry.location.id] = {
      locationId: entry.location.id,
      objectIds,
      anchors,
      blockerObjectIds,
    };
  }
  return bindings;
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
