import type {
  LocationProject,
  ProductionConfiguration,
  ProductionEntityBinding,
  ProductionLocationDefinition,
  ProductionObjectClass,
  SceneObject,
} from '../../domain/types';
import type { PrevisProductionManifestV1 } from './manifest';

export type ProductionConfigurationDiagnosticCode =
  | 'missing_binding'
  | 'stale_object_id'
  | 'stale_group_id'
  | 'stale_location_id'
  | 'empty_object_group'
  | 'partial_assembly'
  | 'location_geometry_missing'
  | 'unknown_panorama_id'
  | 'ambiguous_duplicate_binding'
  | 'bound_entity_not_renderable'
  | 'required_poseable_asset_static'
  | 'unclassified_dynamic_object'
  | 'expected_panorama_missing'
  | 'panorama_not_in_location';

export interface ProductionConfigurationDiagnostic {
  code: ProductionConfigurationDiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  entityId?: string;
  locationId?: string;
  groupId?: string;
  objectId?: string;
  shotId?: string;
}

export interface ProductionConfigurationValidationResult {
  ok: boolean;
  diagnostics: ProductionConfigurationDiagnostic[];
  checkedEntityIds: string[];
  checkedLocationIds: string[];
}

type ManifestEntityKind = 'cast' | 'prop' | 'location';

interface ManifestEntity {
  id: string;
  kind: ManifestEntityKind;
}

function diagnostic(
  code: ProductionConfigurationDiagnosticCode,
  message: string,
  details: Omit<ProductionConfigurationDiagnostic, 'code' | 'severity' | 'message'> = {},
): ProductionConfigurationDiagnostic {
  return { code, severity: 'error', message, ...details };
}

export function getProductionConfiguration(project: LocationProject): ProductionConfiguration {
  if (project.workflow.production) return project.workflow.production;
  const legacyBindings = project.workflow.productionManifestAssetBindings ?? {};
  return {
    schemaVersion: 1,
    bindings: Object.fromEntries(
      Object.entries(legacyBindings).map(([entityId, objectId]) => [entityId, { kind: 'object', objectId }]),
    ),
    locations: {},
    shotContracts: {},
  };
}

function manifestEntities(manifest: PrevisProductionManifestV1): ManifestEntity[] {
  return [
    ...manifest.cast.map((entry) => ({ id: entry.id, kind: 'cast' as const })),
    ...(manifest.props ?? []).map((entry) => ({ id: entry.id, kind: 'prop' as const })),
    ...manifest.locations.map((entry) => ({ id: entry.id, kind: 'location' as const })),
  ];
}

function objectById(project: LocationProject, objectId: string): SceneObject | undefined {
  return project.scene.objects.find((object) => object.id === objectId);
}

function isAssetUnavailable(project: LocationProject, object: SceneObject): boolean {
  const assetId = object.modelAssetId
    ?? (object.poseableCharacter?.kind === 'autorigged' || object.poseableCharacter?.kind === 'importedRig'
      ? object.poseableCharacter.assetId
      : undefined);
  if (!assetId) return false;
  const status = project.assets.assets[assetId]?.resolutionStatus;
  return status === 'missing' || status === 'corrupt' || status === 'unsupported';
}

export function isRenderableProductionObject(project: LocationProject, object: SceneObject): boolean {
  return object.type !== 'sun_marker' && !isAssetUnavailable(project, object);
}

export function classifyProductionObject(
  object: SceneObject,
  role?: ManifestEntityKind,
): ProductionObjectClass {
  if (object.productionClass) return object.productionClass;
  if (object.type === 'sun_marker' || object.category === 'helper' && object.type !== 'human_dummy') return 'helper';
  if (object.poseableCharacter || object.type === 'human_dummy' || object.stagingRole === 'person') return 'dynamic_subject';
  if (object.stagingRole === 'prop') return 'dynamic_prop';
  if (role === 'cast') return 'dynamic_subject';
  if (role === 'prop') return 'dynamic_prop';
  if (object.category === 'architecture' || object.category === 'environment') return 'static_environment';
  return 'unclassified';
}

function groupMembers(project: LocationProject, groupId: string): {
  group?: NonNullable<LocationProject['scene']['objectGroups']>[string];
  objectIds: string[];
  missingObjectIds: string[];
} {
  const group = project.scene.objectGroups?.[groupId];
  if (!group) return { objectIds: [], missingObjectIds: [] };
  const objectIds = [...new Set(group.objectIds)];
  const missingObjectIds = objectIds.filter((objectId) => !objectById(project, objectId));
  return { group, objectIds, missingObjectIds };
}

function groupHasPartialImportedAssembly(project: LocationProject, groupId: string): boolean {
  const group = project.scene.objectGroups?.[groupId];
  if (!group?.sourceImportId) return false;
  const importedObjectIds = project.scene.objects
    .filter((object) => object.importedModel?.sourceImportId === group.sourceImportId)
    .map((object) => object.id);
  return importedObjectIds.some((objectId) => !group.objectIds.includes(objectId));
}

export function resolveProductionBindingObjectIds(
  project: LocationProject,
  binding: ProductionEntityBinding,
): string[] {
  if (binding.kind === 'object') return objectById(project, binding.objectId) ? [binding.objectId] : [];
  if (binding.kind === 'group') return groupMembers(project, binding.groupId).objectIds;
  if (binding.kind === 'location') {
    const location = project.workflow.production?.locations[binding.locationId];
    if (!location) return [];
    return resolveLocationObjectIds(project, location);
  }
  return [];
}

function resolveLocationObjectIds(project: LocationProject, location: ProductionLocationDefinition): string[] {
  const objectIds = new Set(location.objectIds);
  for (const groupId of location.objectGroupIds) {
    for (const objectId of groupMembers(project, groupId).objectIds) objectIds.add(objectId);
  }
  return [...objectIds];
}

function bindingTargetKey(binding: ProductionEntityBinding): string {
  switch (binding.kind) {
    case 'object': return `object:${binding.objectId}`;
    case 'group': return `group:${binding.groupId}`;
    case 'location': return `location:${binding.locationId}`;
    case 'panorama': return `panorama:${binding.panoId}`;
  }
}

function validateLocationDefinition(
  project: LocationProject,
  location: ProductionLocationDefinition,
  diagnostics: ProductionConfigurationDiagnostic[],
): void {
  const geometryIds = resolveLocationObjectIds(project, location);
  for (const objectId of location.objectIds) {
    if (!objectById(project, objectId)) {
      diagnostics.push(diagnostic('stale_object_id', `Location "${location.id}" references missing object "${objectId}".`, {
        locationId: location.id,
        objectId,
      }));
    }
  }
  for (const groupId of location.objectGroupIds) {
    const members = groupMembers(project, groupId);
    if (!members.group) {
      diagnostics.push(diagnostic('stale_group_id', `Location "${location.id}" references missing group "${groupId}".`, {
        locationId: location.id,
        groupId,
      }));
      continue;
    }
    if (members.objectIds.length === 0) {
      diagnostics.push(diagnostic('empty_object_group', `Location "${location.id}" references empty group "${groupId}".`, {
        locationId: location.id,
        groupId,
      }));
    }
    for (const objectId of members.missingObjectIds) {
      diagnostics.push(diagnostic('partial_assembly', `Location "${location.id}" group "${groupId}" is missing object "${objectId}".`, {
        locationId: location.id,
        groupId,
        objectId,
      }));
    }
    if (groupHasPartialImportedAssembly(project, groupId)) {
      diagnostics.push(diagnostic('partial_assembly', `Location "${location.id}" uses an incomplete imported assembly in group "${groupId}".`, {
        locationId: location.id,
        groupId,
      }));
    }
  }
  if (!geometryIds.some((objectId) => {
    const object = objectById(project, objectId);
    return object ? isRenderableProductionObject(project, object) : false;
  })) {
    diagnostics.push(diagnostic('location_geometry_missing', `Location "${location.id}" has no usable renderable geometry.`, {
      locationId: location.id,
    }));
  }
  const panoIds = location.panoIds ?? [];
  for (const panoId of [...panoIds, ...(location.defaultPanoId ? [location.defaultPanoId] : [])]) {
    if (!project.panoRefs.some((pano) => pano.id === panoId)) {
      diagnostics.push(diagnostic('unknown_panorama_id', `Location "${location.id}" references unknown panorama "${panoId}".`, {
        locationId: location.id,
      }));
    }
  }
}

function validateRequiredPoseability(
  project: LocationProject,
  manifest: PrevisProductionManifestV1,
  config: ProductionConfiguration,
  diagnostics: ProductionConfigurationDiagnostic[],
): void {
  for (const [shotId, contract] of Object.entries(config.shotContracts)) {
    for (const requirement of contract.capabilityRequirements ?? []) {
      const needsPose = Boolean(
        requirement.requires.poseable
        || requirement.requires.deforming
        || requirement.requires.timelinePoseable
        || requirement.requires.joints?.length,
      );
      if (!needsPose) continue;
      const binding = config.bindings[requirement.entityId];
      const objectIds = binding ? resolveProductionBindingObjectIds(project, binding) : [];
      const poseable = objectIds.some((objectId) => {
        const object = objectById(project, objectId);
        return Boolean(object?.poseableCharacter || object?.type === 'human_dummy');
      });
      if (!poseable) {
        diagnostics.push(diagnostic(
          'required_poseable_asset_static',
          `Shot "${shotId}" requires poseability for "${requirement.entityId}", but its binding resolves only to static geometry.`,
          { shotId, entityId: requirement.entityId },
        ));
      }
    }
  }
  // Keep the manifest argument part of this pure validator's contract and make
  // the missing-entity failure explicit when a contract names an unknown id.
  const manifestIds = new Set(manifestEntities(manifest).map((entity) => entity.id));
  for (const [shotId, contract] of Object.entries(config.shotContracts)) {
    for (const requirement of contract.capabilityRequirements ?? []) {
      if (!manifestIds.has(requirement.entityId)) {
        diagnostics.push(diagnostic('missing_binding', `Shot "${shotId}" capability requirement names unknown entity "${requirement.entityId}".`, {
          shotId,
          entityId: requirement.entityId,
        }));
      }
    }
  }
}

function validateEnvironmentContracts(
  project: LocationProject,
  config: ProductionConfiguration,
  diagnostics: ProductionConfigurationDiagnostic[],
): void {
  for (const [shotId, contract] of Object.entries(config.shotContracts)) {
    const environment = contract.environment;
    if (!environment) continue;
    const location = config.locations[environment.locationId];
    if (!location) {
      diagnostics.push(diagnostic(
        'stale_location_id',
        `Shot "${shotId}" references missing prepared location "${environment.locationId}".`,
        { shotId, locationId: environment.locationId },
      ));
      continue;
    }
    const expectedPanoId = environment.expectedPanoId
      ?? location.defaultPanoId
      ?? location.panoIds?.[0];
    if (!expectedPanoId) {
      diagnostics.push(diagnostic(
        'expected_panorama_missing',
        `Shot "${shotId}" has an environment contract but location "${location.id}" has no expected panorama.`,
        { shotId, locationId: location.id },
      ));
      continue;
    }
    if (!project.panoRefs.some((pano) => pano.id === expectedPanoId)) {
      diagnostics.push(diagnostic(
        'unknown_panorama_id',
        `Shot "${shotId}" requires unknown panorama "${expectedPanoId}".`,
        { shotId, locationId: location.id },
      ));
    }
    if (location.panoIds?.length && !location.panoIds.includes(expectedPanoId)) {
      diagnostics.push(diagnostic(
        'panorama_not_in_location',
        `Panorama "${expectedPanoId}" is not prepared for location "${location.id}".`,
        { shotId, locationId: location.id },
      ));
    }
  }
}

export function validateProductionConfiguration(
  project: LocationProject,
  manifest: PrevisProductionManifestV1,
): ProductionConfigurationValidationResult {
  const config = getProductionConfiguration(project);
  const diagnostics: ProductionConfigurationDiagnostic[] = [];
  const entities = manifestEntities(manifest);
  const entityIds = new Set<string>();
  for (const entity of entities) {
    if (entityIds.has(entity.id)) {
      diagnostics.push(diagnostic('ambiguous_duplicate_binding', `Manifest entity id "${entity.id}" is used by more than one entity kind.`, {
        entityId: entity.id,
      }));
    }
    entityIds.add(entity.id);
  }

  const targetOwners = new Map<string, string[]>();
  for (const entity of entities) {
    const binding = config.bindings[entity.id];
    if (!binding) {
      diagnostics.push(diagnostic('missing_binding', `No prepared production binding exists for ${entity.kind} entity "${entity.id}".`, {
        entityId: entity.id,
      }));
      continue;
    }
    const targetKey = bindingTargetKey(binding);
    targetOwners.set(targetKey, [...(targetOwners.get(targetKey) ?? []), entity.id]);

    if (binding.kind === 'object') {
      const object = objectById(project, binding.objectId);
      if (!object) {
        diagnostics.push(diagnostic('stale_object_id', `Binding for "${entity.id}" references missing object "${binding.objectId}".`, {
          entityId: entity.id,
          objectId: binding.objectId,
        }));
        continue;
      }
      if (!isRenderableProductionObject(project, object)) {
        diagnostics.push(diagnostic('bound_entity_not_renderable', `Binding for "${entity.id}" resolves to non-renderable object "${binding.objectId}".`, {
          entityId: entity.id,
          objectId: binding.objectId,
        }));
      }
      for (const [groupId, group] of Object.entries(project.scene.objectGroups ?? {})) {
        if (group.objectIds.includes(object.id) && group.objectIds.length > 1) {
          diagnostics.push(diagnostic('partial_assembly', `Entity "${entity.id}" binds one member of multipart group "${groupId}" instead of the complete group.`, {
            entityId: entity.id,
            groupId,
            objectId: object.id,
          }));
        }
      }
      if ((entity.kind === 'cast' || entity.kind === 'prop') && classifyProductionObject(object, entity.kind) === 'unclassified') {
        diagnostics.push(diagnostic('unclassified_dynamic_object', `Dynamic entity "${entity.id}" is bound to object "${object.id}" without a usable production classification.`, {
          entityId: entity.id,
          objectId: object.id,
        }));
      }
    } else if (binding.kind === 'group') {
      const members = groupMembers(project, binding.groupId);
      if (!members.group) {
        diagnostics.push(diagnostic('stale_group_id', `Binding for "${entity.id}" references missing group "${binding.groupId}".`, {
          entityId: entity.id,
          groupId: binding.groupId,
        }));
      } else if (members.objectIds.length === 0) {
        diagnostics.push(diagnostic('empty_object_group', `Binding for "${entity.id}" references empty group "${binding.groupId}".`, {
          entityId: entity.id,
          groupId: binding.groupId,
        }));
      } else {
        for (const objectId of members.missingObjectIds) {
          diagnostics.push(diagnostic('partial_assembly', `Binding for "${entity.id}" is missing group member "${objectId}".`, {
            entityId: entity.id,
            groupId: binding.groupId,
            objectId,
          }));
        }
        if (groupHasPartialImportedAssembly(project, binding.groupId)) {
          diagnostics.push(diagnostic('partial_assembly', `Binding for "${entity.id}" references an incomplete imported assembly.`, {
            entityId: entity.id,
            groupId: binding.groupId,
          }));
        }
        if ((entity.kind === 'cast' || entity.kind === 'prop') && members.objectIds.some((objectId) => {
          const object = objectById(project, objectId);
          return object ? classifyProductionObject(object, entity.kind) === 'unclassified' : false;
        })) {
          diagnostics.push(diagnostic('unclassified_dynamic_object', `Dynamic group entity "${entity.id}" contains an unclassified object.`, {
            entityId: entity.id,
            groupId: binding.groupId,
          }));
        }
      }
    } else if (binding.kind === 'location') {
      const location = config.locations[binding.locationId];
      if (!location) {
        diagnostics.push(diagnostic('stale_location_id', `Binding for "${entity.id}" references missing prepared location "${binding.locationId}".`, {
          entityId: entity.id,
          locationId: binding.locationId,
        }));
      }
    } else if (!project.panoRefs.some((pano) => pano.id === binding.panoId)) {
      diagnostics.push(diagnostic('unknown_panorama_id', `Binding for "${entity.id}" references unknown panorama "${binding.panoId}".`, {
        entityId: entity.id,
      }));
    }
  }

  for (const [target, owners] of targetOwners) {
    if (owners.length > 1) {
      diagnostics.push(diagnostic('ambiguous_duplicate_binding', `Production target "${target}" is bound to multiple entities: ${owners.join(', ')}.`, {
        entityId: owners[0],
      }));
    }
  }

  for (const location of Object.values(config.locations)) {
    validateLocationDefinition(project, location, diagnostics);
  }
  validateRequiredPoseability(project, manifest, config, diagnostics);
  validateEnvironmentContracts(project, config, diagnostics);

  return {
    ok: diagnostics.length === 0,
    diagnostics,
    checkedEntityIds: entities.map((entity) => entity.id),
    checkedLocationIds: Object.keys(config.locations),
  };
}
