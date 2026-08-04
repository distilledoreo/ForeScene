/** Agent adapters for prepared production configuration contracts. */

import type {
  LocationProject,
  PoseSubstitutionApproval,
  ProductionConfiguration,
  ProductionEntityBinding,
  ProductionLocationDefinition,
} from '../../domain/types';
import { touchProject } from '../../state/slices/touchProject';
import { useAgentControlStore } from '../../state/useAgentControlStore';
import { useProjectSafetyStore } from '../../state/useProjectSafetyStore';
import { useProjectStore } from '../../state/useProjectStore';
import { parsePrevisProductionManifest } from '../previs/manifestValidation';
import {
  getProductionConfiguration,
  validateProductionConfiguration as validateProductionConfigurationEngine,
} from '../previs/productionConfiguration';
import {
  inspectEntityCapability as inspectEntityCapabilityEngine,
  resolveProductionPose as resolveProductionPoseEngine,
  validateProductionCapabilities as validateProductionCapabilitiesEngine,
} from '../previs/entityCapability';
import { resolvePrevisPosePresetId } from '../previs/posePresets';
import { agentError, agentWarning, writeAccessRequiredDiagnostic } from './diagnostics';
import type {
  AgentProductionConfigurationInspection,
  AgentProductionConfigurationMutationResult,
  AgentProductionConfigurationValidationResult,
  AgentProductionCapabilitiesValidationResult,
  AgentProductionPoseResolution,
  AgentPoseSubstitutionMutationResult,
} from './protocol';

function cloneConfiguration(project: LocationProject): ProductionConfiguration {
  return structuredClone(getProductionConfiguration(project));
}

function mutationFailure(operation: string) {
  return {
    ok: false,
    diagnostics: [writeAccessRequiredDiagnostic(operation)],
  } satisfies AgentProductionConfigurationMutationResult;
}

function productionMutation(
  operation: string,
  mutate: (project: LocationProject) => LocationProject,
): Promise<AgentProductionConfigurationMutationResult> {
  const runDestructive = useProjectSafetyStore.getState().runDestructiveProjectMutation;
  if (!runDestructive) {
    return Promise.resolve({
      ok: false,
      diagnostics: [agentError('persistence_not_ready', 'Project persistence is not ready.')],
    });
  }
  return runDestructive(operation, () => {
    useProjectStore.setState((state) => ({ project: touchProject(mutate(state.project)) }));
  }).then((verified) => ({
    ok: true,
    revisionId: verified?.revision.id,
    diagnostics: [],
  })).catch((error) => ({
    ok: false,
    diagnostics: [agentError(
      'production_configuration_mutation_failed',
      error instanceof Error ? error.message : `${operation} failed.`,
    )],
  }));
}

function ensureConfig(project: LocationProject): ProductionConfiguration {
  return {
    ...cloneConfiguration(project),
    schemaVersion: 1,
    bindings: { ...getProductionConfiguration(project).bindings },
    locations: { ...getProductionConfiguration(project).locations },
    shotContracts: { ...getProductionConfiguration(project).shotContracts },
    ...(getProductionConfiguration(project).poseSubstitutions
      ? { poseSubstitutions: getProductionConfiguration(project).poseSubstitutions?.map((item) => ({ ...item })) }
      : {}),
  };
}

function validateBindingTarget(project: LocationProject, binding: ProductionEntityBinding) {
  if (binding.kind === 'object' && !project.scene.objects.some((object) => object.id === binding.objectId)) {
    return agentError('stale_object_id', `No scene object with id "${binding.objectId}".`);
  }
  if (binding.kind === 'group') {
    const group = project.scene.objectGroups?.[binding.groupId];
    if (!group) return agentError('stale_group_id', `No object group with id "${binding.groupId}".`);
    if (group.objectIds.length === 0) return agentError('empty_object_group', `Object group "${binding.groupId}" is empty.`);
    const missing = group.objectIds.filter((objectId) => !project.scene.objects.some((object) => object.id === objectId));
    if (missing.length > 0) return agentError('partial_assembly', `Object group "${binding.groupId}" is missing: ${missing.join(', ')}.`);
  }
  if (binding.kind === 'location' && !getProductionConfiguration(project).locations[binding.locationId]) {
    return agentError('stale_location_id', `No prepared production location with id "${binding.locationId}".`);
  }
  if (binding.kind === 'panorama' && !project.panoRefs.some((pano) => pano.id === binding.panoId)) {
    return agentError('unknown_panorama_id', `No panorama with id "${binding.panoId}".`);
  }
  return undefined;
}

function validateLocationInput(project: LocationProject, location: ProductionLocationDefinition) {
  if (!location.id.trim()) return agentError('invalid_argument', 'Production location id is required.');
  const duplicateObjects = location.objectIds.filter((objectId, index) => location.objectIds.indexOf(objectId) !== index);
  if (duplicateObjects.length > 0) return agentError('ambiguous_duplicate_binding', `Location contains duplicate object ids: ${[...new Set(duplicateObjects)].join(', ')}.`);
  const missingObjects = location.objectIds.filter((objectId) => !project.scene.objects.some((object) => object.id === objectId));
  if (missingObjects.length > 0) return agentError('stale_object_id', `Location references missing objects: ${missingObjects.join(', ')}.`);
  for (const groupId of location.objectGroupIds) {
    const group = project.scene.objectGroups?.[groupId];
    if (!group) return agentError('stale_group_id', `Location references missing group "${groupId}".`);
    if (group.objectIds.length === 0) return agentError('empty_object_group', `Location references empty group "${groupId}".`);
  }
  const panoIds = [...(location.panoIds ?? []), ...(location.defaultPanoId ? [location.defaultPanoId] : [])];
  const missingPanos = panoIds.filter((panoId) => !project.panoRefs.some((pano) => pano.id === panoId));
  if (missingPanos.length > 0) return agentError('unknown_panorama_id', `Location references unknown panoramas: ${[...new Set(missingPanos)].join(', ')}.`);
  if (location.objectIds.length === 0 && location.objectGroupIds.length === 0) {
    return agentWarning('location_geometry_missing', `Location "${location.id}" has no prepared geometry references.`);
  }
  return undefined;
}

function mapManifestDiagnostics(items: Array<{ code: string; message: string; severity: string }>) {
  return items.map((item) => item.severity === 'warning' || item.severity === 'info'
    ? agentWarning(item.code, item.message)
    : agentError(item.code, item.message));
}

export function inspectAgentProductionConfiguration(): AgentProductionConfigurationInspection {
  const config = cloneConfiguration(useProjectStore.getState().project);
  return {
    ok: true,
    schemaVersion: 1,
    bindings: config.bindings,
    locations: config.locations,
    shotContractCount: Object.keys(config.shotContracts).length,
    poseSubstitutionCount: config.poseSubstitutions?.length ?? 0,
    diagnostics: [],
  };
}

export function validateAgentProductionConfiguration(input: { manifest: unknown }): AgentProductionConfigurationValidationResult {
  const parsed = parsePrevisProductionManifest(input.manifest);
  if (parsed.errors.length > 0 || !parsed.manifest) {
    return {
      ok: false,
      checkedEntityIds: [],
      checkedLocationIds: [],
      diagnostics: mapManifestDiagnostics(parsed.errors),
    };
  }
  const result = validateProductionConfigurationEngine(useProjectStore.getState().project, parsed.manifest);
  return {
    ok: result.ok,
    checkedEntityIds: result.checkedEntityIds,
    checkedLocationIds: result.checkedLocationIds,
    diagnostics: [
      ...result.diagnostics.map((item) => item.severity === 'warning'
        ? agentWarning(item.code, item.message)
        : agentError(item.code, item.message)),
      ...mapManifestDiagnostics(parsed.warnings),
    ],
  };
}

export async function bindAgentProductionEntity(input: {
  entityId: string;
  binding: ProductionEntityBinding;
}): Promise<AgentProductionConfigurationMutationResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') return mutationFailure('bindProductionEntity');
  const project = useProjectStore.getState().project;
  if (!input.entityId.trim()) return { ok: false, diagnostics: [agentError('invalid_argument', 'Production entity id is required.')] };
  const targetDiagnostic = validateBindingTarget(project, input.binding);
  if (targetDiagnostic && targetDiagnostic.severity === 'error') return { ok: false, diagnostics: [targetDiagnostic] };
  return productionMutation('Bind production entity', (current) => {
    const production = ensureConfig(current);
    production.bindings[input.entityId] = input.binding;
    const legacy = { ...(current.workflow.productionManifestAssetBindings ?? {}) };
    if (input.binding.kind === 'object') legacy[input.entityId] = input.binding.objectId;
    else delete legacy[input.entityId];
    return {
      ...current,
      schemaVersion: '1.2',
      workflow: {
        ...current.workflow,
        production,
        productionManifestAssetBindings: legacy,
      },
    };
  }).then((result) => targetDiagnostic && targetDiagnostic.severity === 'warning'
    ? { ...result, diagnostics: [targetDiagnostic] }
    : result);
}

export async function defineAgentProductionLocation(input: {
  location: ProductionLocationDefinition;
}): Promise<AgentProductionConfigurationMutationResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') return mutationFailure('defineProductionLocation');
  const project = useProjectStore.getState().project;
  const inputDiagnostic = validateLocationInput(project, input.location);
  if (inputDiagnostic?.severity === 'error') return { ok: false, diagnostics: [inputDiagnostic] };
  return productionMutation('Define production location', (current) => {
    const production = ensureConfig(current);
    production.locations[input.location.id] = structuredClone(input.location);
    return {
      ...current,
      schemaVersion: '1.2',
      workflow: { ...current.workflow, production },
    };
  }).then((result) => inputDiagnostic ? { ...result, diagnostics: [inputDiagnostic] } : result);
}

export async function removeAgentProductionBinding(input: {
  entityId: string;
}): Promise<AgentProductionConfigurationMutationResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') return mutationFailure('removeProductionBinding');
  if (!input.entityId.trim()) return { ok: false, diagnostics: [agentError('invalid_argument', 'Production entity id is required.')] };
  const project = useProjectStore.getState().project;
  if (!getProductionConfiguration(project).bindings[input.entityId]) {
    return { ok: false, diagnostics: [agentError('binding_not_found', `No production binding exists for "${input.entityId}".`)] };
  }
  return productionMutation('Remove production binding', (current) => {
    const production = ensureConfig(current);
    delete production.bindings[input.entityId];
    const legacy = { ...(current.workflow.productionManifestAssetBindings ?? {}) };
    delete legacy[input.entityId];
    return {
      ...current,
      schemaVersion: '1.2',
      workflow: {
        ...current.workflow,
        production,
        productionManifestAssetBindings: legacy,
      },
    };
  });
}

function mapCapabilityDiagnostics(items: Array<{
  code: string;
  severity: 'error' | 'warning';
  message: string;
  entityId?: string;
  shotId?: string;
  requestedPose?: string;
  }>) {
  return items.map((item) => item.severity === 'warning'
    ? agentWarning(item.code, item.message)
    : agentError(item.code, item.message));
}

export function inspectAgentEntityCapability(input: { entityId: string }) {
  const profile = inspectEntityCapabilityEngine(useProjectStore.getState().project, input.entityId);
  return structuredClone(profile);
}

export function validateAgentProductionCapabilities(input: { manifest?: unknown }): AgentProductionCapabilitiesValidationResult {
  let manifest: ReturnType<typeof parsePrevisProductionManifest>['manifest'];
  const parseResult = input.manifest === undefined
    ? undefined
    : parsePrevisProductionManifest(input.manifest);
  if (parseResult) {
    if (parseResult.errors.length > 0 || !parseResult.manifest) {
      return {
        ok: false,
        profiles: {},
        checkedEntityIds: [],
        checkedShotIds: [],
        diagnostics: mapManifestDiagnostics(parseResult.errors),
      };
    }
    manifest = parseResult.manifest;
  }
  const result = validateProductionCapabilitiesEngine(useProjectStore.getState().project, manifest);
  return {
    ok: result.ok,
    profiles: structuredClone(result.profiles),
    checkedEntityIds: result.checkedEntityIds,
    checkedShotIds: result.checkedShotIds,
    diagnostics: [
      ...mapCapabilityDiagnostics(result.diagnostics),
      ...(parseResult ? mapManifestDiagnostics(parseResult.warnings) : []),
    ],
  };
}

export function resolveAgentProductionPose(input: {
  entityId: string;
  requestedPose: string;
  shotId?: string;
}): AgentProductionPoseResolution {
  if (!input.entityId.trim() || !input.requestedPose.trim()) {
    return {
      entityId: input.entityId,
      ...(input.shotId ? { shotId: input.shotId } : {}),
      requestedPose: input.requestedPose,
      relationship: 'contradictory',
      requiresReview: true,
      reason: 'entityId and requestedPose are required.',
    };
  }
  return resolveProductionPoseEngine({
    project: useProjectStore.getState().project,
    entityId: input.entityId,
    requestedPose: input.requestedPose,
    shotId: input.shotId,
  });
}

export async function approveAgentPoseSubstitution(input: {
  approval: PoseSubstitutionApproval;
}): Promise<AgentPoseSubstitutionMutationResult> {
  if (useAgentControlStore.getState().controlMode !== 'read-write') {
    return { ok: false, diagnostics: [writeAccessRequiredDiagnostic('approvePoseSubstitution')] };
  }
  const approval = structuredClone(input.approval);
  if (!approval.entityId.trim() || !approval.requestedPose.trim()) {
    return { ok: false, diagnostics: [agentError('invalid_argument', 'Pose substitution entityId and requestedPose are required.')] };
  }
  if (approval.relationship !== 'approved_substitute' || !approval.resolvedPose?.trim()) {
    return {
      ok: false,
      diagnostics: [agentError(
        'invalid_pose_substitution',
        'Only an approved_substitute with a resolved native pose can be approved.',
      )],
    };
  }
  const resolvedPose = resolvePrevisPosePresetId(approval.resolvedPose);
  if (!resolvedPose) {
    return { ok: false, diagnostics: [agentError('invalid_pose_substitution', `Unknown resolved pose "${approval.resolvedPose}".`)] };
  }
  const normalizedApproval: PoseSubstitutionApproval = {
    ...approval,
    resolvedPose,
    requiresReview: false,
    approvedAt: approval.approvedAt ?? new Date().toISOString(),
  };
  const project = useProjectStore.getState().project;
  const candidate: LocationProject = {
    ...project,
    workflow: {
      ...project.workflow,
      production: {
        ...structuredClone(getProductionConfiguration(project)),
        poseSubstitutions: [
          ...(getProductionConfiguration(project).poseSubstitutions ?? []).filter((item) => !(
            item.entityId === normalizedApproval.entityId
            && item.requestedPose === normalizedApproval.requestedPose
            && JSON.stringify(item.shotIds ?? []) === JSON.stringify(normalizedApproval.shotIds ?? [])
          )),
          normalizedApproval,
        ],
      },
    },
  };
  const resolution = resolveProductionPoseEngine({
    project: candidate,
    entityId: normalizedApproval.entityId,
    requestedPose: normalizedApproval.requestedPose,
    shotId: normalizedApproval.shotIds?.[0],
  });
  if (resolution.relationship === 'contradictory') {
    return { ok: false, diagnostics: [agentError('invalid_pose_substitution', resolution.reason ?? 'Pose substitution is contradictory.')] };
  }
  const mutation = await productionMutation('Approve production pose substitution', (current) => {
    const production = ensureConfig(current);
    production.poseSubstitutions = [
      ...(production.poseSubstitutions ?? []).filter((item) => !(
        item.entityId === normalizedApproval.entityId
        && item.requestedPose === normalizedApproval.requestedPose
        && JSON.stringify(item.shotIds ?? []) === JSON.stringify(normalizedApproval.shotIds ?? [])
      )),
      normalizedApproval,
    ];
    return {
      ...current,
      schemaVersion: '1.2',
      workflow: { ...current.workflow, production },
    };
  });
  return { ...mutation, resolution };
}
