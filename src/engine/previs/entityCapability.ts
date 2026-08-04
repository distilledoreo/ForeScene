/**
 * Production capability and pose-readiness decisions.
 *
 * Importing an asset and rendering a mesh are not proof that the entity can
 * perform the action requested by a shot. This module keeps that decision pure
 * so the browser Agent API, compiler, and tests all use the same facts.
 */

import type {
  EntityCapabilityRequirement,
  HumanJointId,
  LocationProject,
  PoseResolution,
  PoseSubstitutionApproval,
  ProductionEntityBinding,
  ProductionConfiguration,
  SceneObject,
} from '../../domain/types';
import { HUMAN_JOINT_IDS, normalizePoseableCharacterSource } from '../humanPose';
import { getHumanPosePreset } from '../humanPosePresets';
import { REQUIRED_IMPORTED_HUMANOID_JOINTS } from '../importedRig/analyzeSkeleton';
import { resolvePoseableRigForObject } from '../poseableRigPackage';
import type { PrevisProductionManifestV1 } from './manifest';
import { getProductionConfiguration, isRenderableProductionObject, resolveProductionBindingObjectIds } from './productionConfiguration';
import { resolvePrevisPosePresetId } from './posePresets';

export type EntityCapabilityReadiness =
  | 'ready'
  | 'ready_static_only'
  | 'requires_manual_mapping'
  | 'requires_rerigging'
  | 'unsupported';

export interface EntityCapabilityProfile {
  entityId: string;
  binding?: ProductionEntityBinding;
  objectIds: string[];
  renderable: boolean;
  rigidTransformable: boolean;
  assemblyComplete: boolean;
  poseable: boolean;
  deforming: boolean;
  timelinePoseable: boolean;
  mappedJoints: HumanJointId[];
  missingRequiredJoints: HumanJointId[];
  readiness: EntityCapabilityReadiness;
  blockingReasons: string[];
  memberProfiles?: Record<string, EntityCapabilityProfile>;
}

export type ProductionCapabilityDiagnosticCode =
  | 'capability_binding_missing'
  | 'capability_requirement_unsatisfied'
  | 'required_poseable_asset_static'
  | 'required_joint_missing'
  | 'requires_manual_mapping'
  | 'requires_rerigging'
  | 'pose_substitution_needs_review'
  | 'contradictory_pose_substitution';

export interface ProductionCapabilityDiagnostic {
  code: ProductionCapabilityDiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  entityId?: string;
  shotId?: string;
  requestedPose?: string;
}

export interface ProductionCapabilityValidationResult {
  ok: boolean;
  profiles: Record<string, EntityCapabilityProfile>;
  diagnostics: ProductionCapabilityDiagnostic[];
  checkedEntityIds: string[];
  checkedShotIds: string[];
}

export interface ProductionPoseResolution extends PoseResolution {
  entityId: string;
  shotId?: string;
}

interface ObjectCapabilityFacts {
  objectId: string;
  renderable: boolean;
  rigidTransformable: boolean;
  poseable: boolean;
  deforming: boolean;
  timelinePoseable: boolean;
  mappedJoints: HumanJointId[];
  missingRequiredJoints: HumanJointId[];
  readiness: EntityCapabilityReadiness;
  blockingReasons: string[];
}

const BAD_ASSET_STATUSES = new Set(['missing', 'corrupt', 'unsupported']);

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function assetUsable(project: LocationProject, assetId: string | undefined): boolean {
  if (!assetId) return false;
  const asset = project.assets.assets[assetId];
  return Boolean(asset && !BAD_ASSET_STATUSES.has(asset.resolutionStatus ?? ''));
}

function requiredJointCoverage(joints: Iterable<HumanJointId>): {
  mappedJoints: HumanJointId[];
  missingRequiredJoints: HumanJointId[];
} {
  const mapped = new Set(joints);
  const missingRequiredJoints = REQUIRED_IMPORTED_HUMANOID_JOINTS.filter((jointId) => (
    !mapped.has(jointId) && !(jointId === 'spine' && mapped.has('chest'))
  ));
  return {
    mappedJoints: HUMAN_JOINT_IDS.filter((jointId) => mapped.has(jointId)),
    missingRequiredJoints,
  };
}

function usableAutorigSkin(project: LocationProject, skin: NonNullable<NonNullable<ReturnType<typeof resolvePoseableRigForObject>>['rig']['skin']>): boolean {
  if (skin.skinAssetId) return assetUsable(project, skin.skinAssetId);
  return Boolean(
    skin.indices && skin.weights
    && skin.indices.length > 0
    && skin.indices.length === skin.weights.length,
  );
}

function objectCapabilityFacts(project: LocationProject, object: SceneObject): ObjectCapabilityFacts {
  const source = normalizePoseableCharacterSource(object.poseableCharacter, object.type);
  const renderable = isRenderableProductionObject(project, object)
    && (!object.modelAssetId || assetUsable(project, object.modelAssetId));
  const blockingReasons: string[] = [];
  if (!renderable) blockingReasons.push(`Object "${object.id}" is not renderable or its model asset is unavailable.`);

  const base = {
    objectId: object.id,
    renderable,
    rigidTransformable: renderable,
    poseable: false,
    deforming: false,
    timelinePoseable: false,
    mappedJoints: [] as HumanJointId[],
    missingRequiredJoints: [] as HumanJointId[],
    readiness: 'unsupported' as EntityCapabilityReadiness,
    blockingReasons,
  };

  if (!source) {
    return {
      ...base,
      readiness: renderable ? 'ready_static_only' : 'unsupported',
    };
  }

  if (source.kind === 'builtin') {
    return {
      ...base,
      poseable: renderable,
      deforming: renderable,
      timelinePoseable: renderable,
      mappedJoints: [...HUMAN_JOINT_IDS],
      readiness: renderable ? 'ready' : 'unsupported',
    };
  }

  const resolved = resolvePoseableRigForObject(object, project.assets);
  const rig = resolved?.rig;
  if (!rig) {
    return {
      ...base,
      readiness: renderable ? 'unsupported' : 'unsupported',
      blockingReasons: [...blockingReasons, `Poseable rig for object "${object.id}" is missing.`],
    };
  }

  if (rig.requiresRerigging) {
    return {
      ...base,
      readiness: 'requires_rerigging',
      blockingReasons: [...blockingReasons, `Rig "${rig.id}" is marked requiresRerigging and cannot perform pose-dependent work.`],
    };
  }

  if (source.kind === 'importedRig') {
    const binding = rig.importedRigBinding;
    const sourceAssetId = binding?.sourceAssetId;
    const coverage = requiredJointCoverage(Object.keys(binding?.boneMap ?? {}) as HumanJointId[]);
    const sourceAvailable = assetUsable(project, sourceAssetId);
    if (!sourceAvailable) {
      return {
        ...base,
        mappedJoints: coverage.mappedJoints,
        missingRequiredJoints: coverage.missingRequiredJoints,
        readiness: 'unsupported',
        blockingReasons: [...blockingReasons, `Imported rig source asset "${sourceAssetId ?? '(missing)'}" is unavailable.`],
      };
    }
    if (!binding) {
      return {
        ...base,
        readiness: 'requires_manual_mapping',
        blockingReasons: [...blockingReasons, `Imported rig "${rig.id}" has no preserved humanoid mapping.`],
      };
    }
    if (coverage.missingRequiredJoints.length > 0) {
      return {
        ...base,
        mappedJoints: coverage.mappedJoints,
        missingRequiredJoints: coverage.missingRequiredJoints,
        readiness: 'requires_manual_mapping',
        blockingReasons: [...blockingReasons, `Imported rig is missing required joints: ${coverage.missingRequiredJoints.join(', ')}.`],
      };
    }
    return {
      ...base,
      poseable: renderable,
      deforming: renderable,
      timelinePoseable: renderable,
      mappedJoints: coverage.mappedJoints,
      missingRequiredJoints: [],
      readiness: renderable ? 'ready' : 'unsupported',
    };
  }

  const coverage = requiredJointCoverage(
    (rig.skeletonJoints ?? []).filter((jointId) => Boolean(rig.bindMatrices?.[jointId])),
  );
  const sourceAssetId = rig.originalSourceAssetId ?? rig.sourceMeshAssetId ?? rig.meshAssetId;
  const sourceAvailable = assetUsable(project, sourceAssetId);
  const hasBindMatrices = Object.keys(rig.bindMatrices ?? {}).length > 0;
  const hasSkin = Boolean(rig.skin && usableAutorigSkin(project, rig.skin));
  if (!sourceAvailable || !hasBindMatrices || !hasSkin || coverage.missingRequiredJoints.length > 0) {
    const reasons = [...blockingReasons];
    if (!sourceAvailable) reasons.push(`Autorig source mesh asset "${sourceAssetId ?? '(missing)'}" is unavailable.`);
    if (!hasBindMatrices) reasons.push(`Autorig "${rig.id}" has no usable bind matrices.`);
    if (!hasSkin) reasons.push(`Autorig "${rig.id}" has no usable skin weights.`);
    if (coverage.missingRequiredJoints.length > 0) reasons.push(`Autorig is missing required joints: ${coverage.missingRequiredJoints.join(', ')}.`);
    return {
      ...base,
      mappedJoints: coverage.mappedJoints,
      missingRequiredJoints: coverage.missingRequiredJoints,
      readiness: 'requires_rerigging',
      blockingReasons: reasons,
    };
  }
  return {
    ...base,
    poseable: renderable,
    deforming: renderable,
    timelinePoseable: renderable,
    mappedJoints: coverage.mappedJoints,
    missingRequiredJoints: [],
    readiness: renderable ? 'ready' : 'unsupported',
  };
}

function groupIsComplete(project: LocationProject, groupId: string): boolean {
  const group = project.scene.objectGroups?.[groupId];
  if (!group || group.objectIds.length === 0) return false;
  if (group.objectIds.some((objectId) => !project.scene.objects.some((object) => object.id === objectId))) return false;
  if (!group.sourceImportId) return true;
  const importedIds = project.scene.objects
    .filter((object) => object.importedModel?.sourceImportId === group.sourceImportId)
    .map((object) => object.id);
  return importedIds.every((objectId) => group.objectIds.includes(objectId));
}

function bindingForEntity(config: ProductionConfiguration, entityId: string): ProductionEntityBinding | undefined {
  return config.bindings[entityId]
    ?? config.bindings[`cast.${entityId}`]
    ?? config.bindings[`props.${entityId}`]
    ?? config.bindings[`locations.${entityId}`];
}

function aggregateBindingCapabilities(
  project: LocationProject,
  entityId: string,
  binding: ProductionEntityBinding | undefined,
): EntityCapabilityProfile {
  if (!binding) {
    return {
      entityId,
      objectIds: [],
      renderable: false,
      rigidTransformable: false,
      assemblyComplete: false,
      poseable: false,
      deforming: false,
      timelinePoseable: false,
      mappedJoints: [],
      missingRequiredJoints: [],
      readiness: 'unsupported',
      blockingReasons: [`No production binding exists for entity "${entityId}".`],
    };
  }

  const objectIds = resolveProductionBindingObjectIds(project, binding);
  const memberProfiles = Object.fromEntries(objectIds.flatMap((objectId) => {
    const object = project.scene.objects.find((candidate) => candidate.id === objectId);
    return object ? [[objectId, {
      entityId: objectId,
      objectIds: [objectId],
      assemblyComplete: true,
      ...objectCapabilityFacts(project, object),
    } satisfies EntityCapabilityProfile]] : [];
  }));
  const members = Object.values(memberProfiles);
  const missingGroup = binding.kind === 'group' && !groupIsComplete(project, binding.groupId);
  const locationWithoutGeometry = binding.kind === 'location' && objectIds.length === 0;
  const assemblyComplete = !missingGroup && !locationWithoutGeometry && (
    binding.kind !== 'object' || objectIds.length === 1
  );
  const blockingReasons = unique([
    ...members.flatMap((member) => member.blockingReasons),
    ...(missingGroup ? [`Object group "${binding.kind === 'group' ? binding.groupId : ''}" is empty, stale, or incomplete.`] : []),
    ...(locationWithoutGeometry ? ['Prepared location has no usable geometry.'] : []),
  ]);
  const renderable = members.length > 0 && members.every((member) => member.renderable);
  const rigidTransformable = assemblyComplete && renderable;
  const poseMembers = members.filter((member) => member.poseable || member.readiness === 'ready');
  const poseable = poseMembers.length > 0 && poseMembers.every((member) => member.poseable);
  const deforming = poseMembers.length > 0 && poseMembers.every((member) => member.deforming);
  const timelinePoseable = poseMembers.length > 0 && poseMembers.every((member) => member.timelinePoseable);
  const mappedJoints = HUMAN_JOINT_IDS.filter((jointId) => members.some((member) => member.mappedJoints.includes(jointId)));
  const missingRequiredJoints = unique(members.flatMap((member) => member.missingRequiredJoints));

  let readiness: EntityCapabilityReadiness;
  if (!assemblyComplete || !renderable) readiness = 'unsupported';
  else if (members.some((member) => member.readiness === 'requires_rerigging')) readiness = 'requires_rerigging';
  else if (members.some((member) => member.readiness === 'requires_manual_mapping')) readiness = 'requires_manual_mapping';
  else if (poseable && deforming && timelinePoseable) readiness = 'ready';
  else readiness = 'ready_static_only';

  return {
    entityId,
    binding,
    objectIds,
    renderable,
    rigidTransformable,
    assemblyComplete,
    poseable,
    deforming,
    timelinePoseable,
    mappedJoints,
    missingRequiredJoints,
    readiness,
    blockingReasons,
    ...(members.length > 0 ? { memberProfiles } : {}),
  };
}

export function inspectEntityCapability(
  project: LocationProject,
  entityId: string,
): EntityCapabilityProfile {
  const config = getProductionConfiguration(project);
  return aggregateBindingCapabilities(project, entityId, bindingForEntity(config, entityId));
}

function mergeRequirements(
  target: Map<string, { shotId?: string; requires: EntityCapabilityRequirement['requires'] }>,
  entityId: string,
  requires: EntityCapabilityRequirement['requires'],
  shotId?: string,
): void {
  const existing = target.get(entityId) ?? { requires: {} };
  const joints = unique([...(existing.requires.joints ?? []), ...(requires.joints ?? [])]);
  target.set(entityId, {
    shotId: existing.shotId ?? shotId,
    requires: {
      ...existing.requires,
      ...requires,
      ...(joints.length > 0 ? { joints } : {}),
    },
  });
}

function requirementsFromManifest(
  manifest: PrevisProductionManifestV1,
  target: Map<string, { shotId?: string; requires: EntityCapabilityRequirement['requires'] }>,
): void {
  for (const character of manifest.cast) {
    if (character.defaultPose) {
      mergeRequirements(target, character.id, {
        poseable: true,
        deforming: true,
      });
    }
  }
  for (const shot of manifest.shots) {
    for (const blocking of shot.blocking ?? []) {
      if (blocking.pose) {
        mergeRequirements(target, blocking.subject, {
          poseable: true,
          deforming: true,
        }, shot.id);
      }
    }
    for (const keyframe of shot.motion?.keyframes ?? []) {
      for (const staging of keyframe.staging ?? []) {
        if (staging.posePreset) {
          mergeRequirements(target, staging.subject, {
            poseable: true,
            deforming: true,
            timelinePoseable: true,
          }, shot.id);
        }
      }
    }
  }
}

function requirementDiagnostics(
  profile: EntityCapabilityProfile,
  requires: EntityCapabilityRequirement['requires'],
  entityId: string,
  shotId?: string,
): ProductionCapabilityDiagnostic[] {
  const diagnostics: ProductionCapabilityDiagnostic[] = [];
  const context = shotId ? ` for shot "${shotId}"` : '';
  const check = (condition: boolean | undefined, actual: boolean, capability: string) => {
    if (!condition || actual) return;
    diagnostics.push({
      code: capability === 'poseability' && profile.readiness === 'ready_static_only'
        ? 'required_poseable_asset_static'
        : profile.readiness === 'requires_manual_mapping'
          ? 'requires_manual_mapping'
          : profile.readiness === 'requires_rerigging'
            ? 'requires_rerigging'
            : 'capability_requirement_unsatisfied',
      severity: 'error',
      entityId,
      ...(shotId ? { shotId } : {}),
      message: `Entity "${entityId}" does not satisfy ${capability}${context}. ${profile.blockingReasons.join(' ')}`.trim(),
    });
  };
  check(requires.renderable, profile.renderable, 'renderable');
  check(requires.rigidAssembly, profile.rigidTransformable, 'rigid assembly');
  check(requires.poseable, profile.poseable, 'poseability');
  check(requires.deforming, profile.deforming, 'deformation');
  check(requires.timelinePoseable, profile.timelinePoseable, 'timeline poseability');
  if (requires.joints?.length) {
    const missing = requires.joints.filter((jointId) => (
      !profile.mappedJoints.includes(jointId)
      && !(jointId === 'spine' && profile.mappedJoints.includes('chest'))
    ));
    if (missing.length > 0) {
      diagnostics.push({
        code: 'required_joint_missing',
        severity: 'error',
        entityId,
        ...(shotId ? { shotId } : {}),
        message: `Entity "${entityId}" is missing required joints ${missing.join(', ')}${context}.`,
      });
    }
  }
  return diagnostics;
}

export function validateProductionCapabilities(
  project: LocationProject,
  manifest?: PrevisProductionManifestV1,
): ProductionCapabilityValidationResult {
  const config = getProductionConfiguration(project);
  const requirements = new Map<string, { shotId?: string; requires: EntityCapabilityRequirement['requires'] }>();
  for (const [shotId, contract] of Object.entries(config.shotContracts)) {
    for (const requirement of contract.capabilityRequirements ?? []) {
      mergeRequirements(requirements, requirement.entityId, requirement.requires, shotId);
    }
  }
  if (manifest) requirementsFromManifest(manifest, requirements);

  const profiles: Record<string, EntityCapabilityProfile> = {};
  const diagnostics: ProductionCapabilityDiagnostic[] = [];
  for (const [entityId, entry] of requirements) {
    const profile = inspectEntityCapability(project, entityId);
    profiles[entityId] = profile;
    if (!profile.binding) diagnostics.push({
      code: 'capability_binding_missing',
      severity: 'error',
      entityId,
      ...(entry.shotId ? { shotId: entry.shotId } : {}),
      message: `No prepared binding exists for capability-required entity "${entityId}".`,
    });
    diagnostics.push(...requirementDiagnostics(profile, entry.requires, entityId, entry.shotId));
  }
  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    profiles,
    diagnostics,
    checkedEntityIds: Object.keys(profiles),
    checkedShotIds: unique([...requirements.values()].flatMap((item) => item.shotId ? [item.shotId] : [])),
  };
}

function approvedSubstitution(
  config: ProductionConfiguration,
  entityId: string,
  requestedPose: string,
  shotId?: string,
): PoseSubstitutionApproval | undefined {
  return config.poseSubstitutions?.find((approval) => (
    approval.entityId === entityId
    && approval.requestedPose === requestedPose
    && (!shotId || !approval.shotIds || approval.shotIds.includes(shotId))
  ));
}

export function resolveProductionPose(input: {
  project: LocationProject;
  entityId: string;
  requestedPose: string;
  shotId?: string;
}): ProductionPoseResolution {
  const { project, entityId, requestedPose, shotId } = input;
  const approval = approvedSubstitution(getProductionConfiguration(project), entityId, requestedPose, shotId);
  if (approval) {
    if (approval.relationship === 'contradictory') {
      return {
        entityId,
        ...(shotId ? { shotId } : {}),
        requestedPose,
        relationship: 'contradictory',
        requiresReview: true,
        reason: approval.reason ?? `Approved pose policy marks "${requestedPose}" as contradictory.`,
      };
    }
    const resolvedPose = approval.resolvedPose ? resolvePrevisPosePresetId(approval.resolvedPose) : undefined;
    if (!resolvedPose || !getHumanPosePreset(resolvedPose)) {
      return {
        entityId,
        ...(shotId ? { shotId } : {}),
        requestedPose,
        relationship: 'contradictory',
        requiresReview: true,
        reason: `Approved substitution for "${requestedPose}" does not name a supported native pose.`,
      };
    }
    return {
      entityId,
      ...(shotId ? { shotId } : {}),
      requestedPose,
      resolvedPose,
      relationship: approval.relationship,
      requiresReview: false,
      ...(approval.reason ? { reason: approval.reason } : {}),
    };
  }

  const native = getHumanPosePreset(requestedPose);
  if (native) {
    return {
      entityId,
      ...(shotId ? { shotId } : {}),
      requestedPose,
      resolvedPose: native.id,
      relationship: 'exact',
      requiresReview: false,
    };
  }
  const resolvedPose = resolvePrevisPosePresetId(requestedPose);
  if (!resolvedPose || !getHumanPosePreset(resolvedPose)) {
    return {
      entityId,
      ...(shotId ? { shotId } : {}),
      requestedPose,
      relationship: 'contradictory',
      requiresReview: true,
      reason: `Pose "${requestedPose}" has no deterministic native or approved resolution.`,
    };
  }
  return {
    entityId,
    ...(shotId ? { shotId } : {}),
    requestedPose,
    resolvedPose,
    relationship: 'approximate',
    requiresReview: true,
    reason: `Pose "${requestedPose}" uses approximate native preset "${resolvedPose}" until a project substitution is approved.`,
  };
}
