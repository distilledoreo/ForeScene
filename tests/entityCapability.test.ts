import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type { LocationProject, ProductionConfiguration, PoseableRigAsset } from '../src/domain/types';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';
import {
  inspectEntityCapability,
  resolveProductionPose,
  validateProductionCapabilities,
} from '../src/engine/previs/entityCapability';
import { REQUIRED_IMPORTED_HUMANOID_JOINTS } from '../src/engine/importedRig/analyzeSkeleton';

function productionFor(entityId: string, objectId: string): ProductionConfiguration {
  return {
    schemaVersion: 1,
    bindings: { [entityId]: { kind: 'object', objectId } },
    locations: {},
    shotContracts: {
      shot001: {
        capabilityRequirements: [{
          entityId,
          requires: { renderable: true },
        }],
      },
    },
  };
}

function poseManifest(entityId: string): PrevisProductionManifestV1 {
  return {
    version: 1,
    project: { name: 'Capability test', aspectRatio: '16:9' },
    locations: [{ id: 'room', name: 'Room', template: 'interior_room' }],
    cast: [{ id: entityId, name: 'Actor', type: 'human_dummy', defaultPose: 'running' }],
    shots: [{
      id: 'shot001',
      shotNumber: '001',
      name: 'Shot',
      description: 'Capability shot',
      locationId: 'room',
      subjects: [entityId],
      blocking: [{
        subject: entityId,
        placement: { type: 'location_slot', slot: 'center' },
        pose: 'running',
      }],
      camera: { template: 'medium', subjects: [entityId] },
    }],
  };
}

function autorigProject(): { project: LocationProject; objectId: string } {
  const project = createDefaultProject();
  const sourceAssetId = 'source-character';
  const rigAssetId = 'rig-character';
  const rig: PoseableRigAsset = {
    version: 1,
    id: 'rig-1',
    skeletonJoints: [...REQUIRED_IMPORTED_HUMANOID_JOINTS],
    bindMatrices: Object.fromEntries(REQUIRED_IMPORTED_HUMANOID_JOINTS.map((jointId) => [jointId, new Array(16).fill(0)])),
    skin: { influencesPerVertex: 1, indices: [0], weights: [1] },
    originalSourceAssetId: sourceAssetId,
    requiresRerigging: false,
  };
  project.assets.assets[sourceAssetId] = {
    id: sourceAssetId,
    type: 'model',
    name: 'Source',
    uri: 'data:model/gltf-binary;base64,AA==',
    createdAt: '',
  };
  project.assets.assets[rigAssetId] = {
    id: rigAssetId,
    type: 'poseable_rig',
    name: 'Rig',
    uri: 'data:application/json,{}',
    createdAt: '',
    metadata: { poseableRig: rig },
  };
  const object = createSceneObject('human_dummy');
  object.poseableCharacter = { kind: 'autorigged', assetId: rigAssetId, rigId: rig.id };
  object.name = 'Imported actor';
  project.scene.objects.push(object);
  return { project, objectId: object.id };
}

describe('production entity capabilities', () => {
  it('recognizes a built-in human as ready for deformation and timeline poses', () => {
    const project = createDefaultProject();
    const object = project.scene.objects.find((candidate) => candidate.type === 'human_dummy')!;
    project.workflow.production = productionFor('lead', object.id);

    const profile = inspectEntityCapability(project, 'lead');
    expect(profile.readiness).toBe('ready');
    expect(profile.poseable).toBe(true);
    expect(profile.deforming).toBe(true);
    expect(profile.timelinePoseable).toBe(true);
  });

  it('keeps static geometry valid for static work but blocks pose requirements', () => {
    const project = createDefaultProject();
    const wall = project.scene.objects.find((candidate) => candidate.type === 'wall')!;
    project.workflow.production = productionFor('lead', wall.id);
    project.workflow.production!.shotContracts.shot001.capabilityRequirements = [{
      entityId: 'lead',
      requires: { poseable: true, deforming: true },
    }];

    const profile = inspectEntityCapability(project, 'lead');
    expect(profile.readiness).toBe('ready_static_only');
    expect(validateProductionCapabilities(project).ok).toBe(false);
  });

  it('blocks an autorig shell marked for later rigging', () => {
    const { project, objectId } = autorigProject();
    const rigAsset = project.assets.assets['rig-character']!;
    rigAsset.metadata!.poseableRig!.requiresRerigging = true;
    project.workflow.production = productionFor('lead', objectId);
    project.workflow.production!.shotContracts.shot001.capabilityRequirements = [{
      entityId: 'lead',
      requires: { poseable: true },
    }];

    const profile = inspectEntityCapability(project, 'lead');
    expect(profile.readiness).toBe('requires_rerigging');
    expect(validateProductionCapabilities(project).diagnostics.some((item) => item.code === 'requires_rerigging')).toBe(true);
  });

  it('reports exact, approximate, and approved semantic pose resolution distinctly', () => {
    const project = createDefaultProject();
    const object = project.scene.objects.find((candidate) => candidate.type === 'human_dummy')!;
    project.workflow.production = productionFor('lead', object.id);

    expect(resolveProductionPose({ project, entityId: 'lead', requestedPose: 'walking' }).relationship).toBe('exact');
    expect(resolveProductionPose({ project, entityId: 'lead', requestedPose: 'standing-neutral' })).toMatchObject({
      resolvedPose: 'neutral',
      relationship: 'exact',
      requiresReview: false,
    });
    expect(resolveProductionPose({ project, entityId: 'lead', requestedPose: 'standing-alert' })).toMatchObject({
      resolvedPose: 'standing-relaxed',
      relationship: 'exact',
      requiresReview: false,
    });
    expect(resolveProductionPose({ project, entityId: 'lead', requestedPose: 'running' })).toMatchObject({
      resolvedPose: 'walk-contact-left',
      relationship: 'approximate',
      requiresReview: true,
    });

    project.workflow.production!.poseSubstitutions = [{
      entityId: 'lead',
      requestedPose: 'running',
      resolvedPose: 'walking',
      relationship: 'approved_substitute',
      requiresReview: false,
    }];
    expect(resolveProductionPose({ project, entityId: 'lead', requestedPose: 'running' })).toMatchObject({
      resolvedPose: 'walking',
      relationship: 'approved_substitute',
      requiresReview: false,
    });
  });

  it('infers pose requirements from a production manifest before compilation', () => {
    const project = createDefaultProject();
    const wall = project.scene.objects.find((candidate) => candidate.type === 'wall')!;
    project.workflow.production = productionFor('lead', wall.id);
    const result = validateProductionCapabilities(project, poseManifest('lead'));
    expect(result.ok).toBe(false);
    expect(result.checkedEntityIds).toContain('lead');
    expect(result.diagnostics.some((item) => item.code === 'required_poseable_asset_static')).toBe(true);
  });

  it('aggregates a complete multipart group without losing member readiness', () => {
    const project = createDefaultProject();
    const body = createSceneObject('box');
    body.productionClass = 'dynamic_subject';
    const accessory = createSceneObject('box');
    accessory.productionClass = 'dynamic_prop';
    project.scene.objects.push(body, accessory);
    project.scene.objectGroups = {
      assembly: { id: 'assembly', name: 'Assembly', objectIds: [body.id, accessory.id] },
    };
    project.workflow.production = {
      schemaVersion: 1,
      bindings: { creature: { kind: 'group', groupId: 'assembly' } },
      locations: {},
      shotContracts: {},
    };

    const profile = inspectEntityCapability(project, 'creature');
    expect(profile.assemblyComplete).toBe(true);
    expect(profile.objectIds).toEqual([body.id, accessory.id]);
    expect(profile.rigidTransformable).toBe(true);
  });
});
