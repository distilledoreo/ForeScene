import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type {
  HumanJointId,
  PoseableRigAsset,
  ProductionConfiguration,
  ProjectAsset,
} from '../src/domain/types';
import {
  describeSceneObjectComposition,
  IMPORTED_HUMANOID_LANDMARK_HEIGHT,
  resolveAnatomicalBodyBounds,
} from '../src/engine/previs/compositionTelemetry';
import {
  COMPOSITION_NUMERIC_EPSILON,
  inspectShotCompositionError,
} from '../src/engine/previs/compositionConstraints';
import { resolvePoseableHumanoidTelemetry } from '../src/engine/previs/poseableRigTelemetry';
import {
  registerPoseableCharacterInstance,
  resetPoseableCharacterInstancesForTests,
  type PoseableCharacter,
} from '../src/engine/poseableCharacter';

function createImportedHumanoidFixture() {
  const project = createDefaultProject();
  const subject = createSceneObject('human_dummy', 1, [0, 1, 0]);
  subject.name = 'Imported Humanoid';
  subject.transform.position = [0, 1, 0];
  subject.poseableCharacter = { kind: 'importedRig', assetId: 'asset-rig', rigId: 'rig-imported' };
  subject.dimensions = [4, 2, 2];
  subject.metadata = {
    humanoidTelemetry: {
      primaryBodyBounds: {
        min: [-0.3, -1, -0.3],
        max: [0.3, 1, 0.3],
      },
    },
  };
  project.scene.objects = [subject];
  const shot = project.shots[0]!;
  shot.camera = {
    ...shot.camera,
    position: [0, 1.6, 3.7],
    target: [0, 0.98, 0],
    fovDegrees: 42,
  };
  return { project, shot, subject };
}

function createRigAsset(rig: PoseableRigAsset): ProjectAsset {
  return {
    id: 'asset-rig',
    type: 'poseable_rig',
    name: 'Test rig',
    uri: 'data:application/json,{}',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { poseableRig: rig },
  };
}

function createMarkerRig(): PoseableRigAsset {
  const marker = (jointId: HumanJointId, position: [number, number, number]) => ({
    id: `marker-${jointId}`,
    jointId,
    position,
  });
  return {
    version: 1,
    id: 'rig-test',
    skeletonJoints: ['hips', 'spine', 'chest', 'neck', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'],
    markers: [
      marker('hips', [0, 0, 0]),
      marker('spine', [0, 0.35, 0]),
      marker('chest', [0, 0.65, 0]),
      marker('neck', [0, 0.9, 0]),
      marker('head', [0, 1.1, 0]),
      marker('leftHand', [-0.45, 0.75, 0]),
      marker('rightHand', [0.45, 0.75, 0]),
      marker('leftFoot', [-0.15, -1, 0]),
      marker('rightFoot', [0.15, -1, 0]),
    ],
  };
}

function addRig(project: ReturnType<typeof createDefaultProject>, rig = createMarkerRig()) {
  project.assets.assets['asset-rig'] = createRigAsset(rig);
}

function createRigOnlyFixture() {
  const fixture = createImportedHumanoidFixture();
  fixture.subject.metadata = { agentSavedRigImport: true };
  addRig(fixture.project);
  return fixture;
}

function createEvaluatedInstance() {
  const root = new THREE.Group();
  const bones = new Map<HumanJointId, THREE.Bone>();
  const addBone = (id: HumanJointId, position: [number, number, number]) => {
    const bone = new THREE.Bone();
    bone.position.set(...position);
    root.add(bone);
    bones.set(id, bone);
  };
  addBone('hips', [0, 1, 0]);
  addBone('neck', [0, 1.9, 0]);
  addBone('head', [0, 2.1, 0]);
  addBone('leftFoot', [-0.15, 0, 0]);
  addBone('rightFoot', [0.15, 0, 0]);
  root.updateMatrixWorld(true);
  const character = {
    bindInstance: () => undefined,
    getJoints: () => [...bones.entries()].map(([id, node]) => ({ id, node, displayName: id })),
  } as unknown as PoseableCharacter;
  return { root, bones, character };
}

afterEach(() => {
  resetPoseableCharacterInstancesForTests();
});

describe('imported humanoid composition telemetry', () => {
  it('derives fallback landmarks from the primary body bounds without mapped joints', () => {
    const { project, shot, subject } = createImportedHumanoidFixture();
    const telemetry = describeSceneObjectComposition({ project, shot, object: subject });

    expect(IMPORTED_HUMANOID_LANDMARK_HEIGHT).toMatchObject({
      headTop: 0.96,
      eyes: 0.89,
      chest: 0.68,
      waist: 0.53,
    });
    expect(telemetry.landmarks?.headTop?.inFrame).toBe(true);
    expect(telemetry.landmarks?.eyes?.inFrame).toBe(true);
    expect(telemetry.landmarks?.chest?.inFrame).toBe(true);
    expect(telemetry.landmarks?.waist?.inFrame).toBe(true);
    expect(telemetry.footPoint?.inFrame).toBe(true);
    expect(telemetry.feetY).toBe(telemetry.footPoint?.y);
    expect(telemetry.landmarkSource).toBe('bounds_fallback');
  });

  it('uses hydrated fsrig markers before persisted bounds fallback', () => {
    const { project, shot, subject } = createImportedHumanoidFixture();
    addRig(project);

    const resolved = resolvePoseableHumanoidTelemetry({ object: subject, assets: project.assets });
    const telemetry = describeSceneObjectComposition({ project, shot, object: subject });

    expect(resolved?.source).toBe('rig_marker');
    expect(resolved?.confidence).toBeGreaterThan(0.8);
    expect(resolved?.positions.hips).toEqual([0, 1, 0]);
    expect(resolved?.positions.leftHand).toEqual([-0.45, 1.75, 0]);
    expect(telemetry.landmarkSource).toBe('rig_marker');
    expect(telemetry.landmarkConfidence).toBeGreaterThan(0.8);
  });

  it('constructs anatomical body bounds from rig joints instead of embedded accessories', () => {
    const { project, shot, subject } = createRigOnlyFixture();
    subject.dimensions = [4, 2, 2];

    const telemetry = describeSceneObjectComposition({ project, shot, object: subject });

    expect(telemetry.bodyBoundsSource).toBe('rig_marker');
    expect(telemetry.bodyBounds?.widthCoverage).toBeLessThan(telemetry.assemblyBounds?.widthCoverage ?? 0);
    expect(telemetry.bodyBounds?.heightCoverage).toBeLessThan(telemetry.assemblyBounds?.heightCoverage ?? 0);
    expect(telemetry.bodyCoverage).toBeLessThan(telemetry.assemblyCoverage ?? 0);
  });

  it('keeps anatomical body coverage stable while assembly bounds grow for accessories', () => {
    const first = createRigOnlyFixture();
    const second = createRigOnlyFixture();
    first.subject.dimensions = [2, 2, 2];
    second.subject.dimensions = [8, 2, 2];

    const firstTelemetry = describeSceneObjectComposition({ project: first.project, shot: first.shot, object: first.subject });
    const secondTelemetry = describeSceneObjectComposition({ project: second.project, shot: second.shot, object: second.subject });

    expect(secondTelemetry.bodyCoverage ?? 0).toBeCloseTo(firstTelemetry.bodyCoverage ?? 0, 8);
    expect(secondTelemetry.bodyBounds?.heightCoverage).toBeCloseTo(firstTelemetry.bodyBounds?.heightCoverage ?? 0, 8);
    expect(secondTelemetry.assemblyCoverage).toBeGreaterThan(firstTelemetry.assemblyCoverage ?? 0);
    expect(secondTelemetry.completeAssemblyInFrame).toBe(false);
  });

  it('prefers explicit primary body metadata over rig-derived bounds', () => {
    const { project, subject } = createRigOnlyFixture();
    subject.metadata = {
      humanoidTelemetry: {
        primaryBodyBounds: {
          min: [-0.1, -0.5, -0.1],
          max: [0.1, 0.5, 0.1],
        },
      },
    };

    const resolution = resolveAnatomicalBodyBounds({
      object: subject,
      assets: project.assets,
      rigTelemetry: resolvePoseableHumanoidTelemetry({ object: subject, assets: project.assets }),
    });

    expect(resolution.source).toBe('explicit_body_mesh');
    expect(resolution.bounds).toEqual({
      min: [-0.1, 0.5, -0.1],
      max: [0.1, 1.5, 0.1],
    });
  });

  it('tolerates insignificant normalized feet range differences', () => {
    const { project, shot, subject } = createRigOnlyFixture();
    const telemetry = describeSceneObjectComposition({ project, shot, object: subject });
    const lowerBound = telemetry.feetY! + COMPOSITION_NUMERIC_EPSILON / 2;
    project.workflow.production = {
      schemaVersion: 1,
      bindings: { subject: { kind: 'object', objectId: subject.id } },
      locations: {},
      shotContracts: {
        [shot.id]: {
          composition: {
            subjects: [{
              entityId: 'subject',
              expectedFeetY: [lowerBound, Math.min(1, lowerBound + 0.1)],
            }],
          },
        },
      },
    } satisfies ProductionConfiguration;

    const result = inspectShotCompositionError(project, shot);
    expect(result.diagnostics.map((item) => item.message)).not.toContain('Subject "subject" feet Y is outside the reference range.');
  });

  it('uses evaluated hydrated rig joints before marker and bounds data', () => {
    const { project, shot, subject } = createImportedHumanoidFixture();
    addRig(project);
    const evaluated = createEvaluatedInstance();
    registerPoseableCharacterInstance(subject.id, evaluated.character, evaluated.root);

    const resolved = resolvePoseableHumanoidTelemetry({ object: subject, assets: project.assets });
    const telemetry = describeSceneObjectComposition({ project, shot, object: subject });

    expect(resolved?.source).toBe('evaluated_joint');
    expect(resolved?.positions.hips).toEqual([0, 1, 0]);
    expect(resolved?.positions.head).toEqual([0, 2.1, 0]);
    expect(telemetry.landmarkSource).toBe('evaluated_joint');
  });

  it('updates telemetry when an evaluated joint is posed', () => {
    const { project, subject } = createImportedHumanoidFixture();
    addRig(project);
    const evaluated = createEvaluatedInstance();
    registerPoseableCharacterInstance(subject.id, evaluated.character, evaluated.root);

    const before = resolvePoseableHumanoidTelemetry({ object: subject, assets: project.assets });
    evaluated.bones.get('head')!.position.x = 0.35;
    evaluated.root.updateMatrixWorld(true);
    const after = resolvePoseableHumanoidTelemetry({ object: subject, assets: project.assets });

    expect(before?.positions.head).toEqual([0, 2.1, 0]);
    expect(after?.positions.head).toEqual([0.35, 2.1, 0]);
  });

  it('uses bind-matrix rig landmarks when markers are unavailable', () => {
    const { project, subject } = createImportedHumanoidFixture();
    addRig(project, {
      ...createMarkerRig(),
      markers: [],
      bindMatrices: {
        hips: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        chest: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.7, 0, 1],
        neck: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1],
        head: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 0, 1],
        leftFoot: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.15, -1, 0, 1],
        rightFoot: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.15, -1, 0, 1],
      },
    });

    const resolved = resolvePoseableHumanoidTelemetry({ object: subject, assets: project.assets });
    expect(resolved?.source).toBe('rig_marker');
    expect(resolved?.confidence).toBe(0.75);
    expect(resolved?.positions.head).toEqual([0, 2.2, 0]);
  });

  it('keeps bounds fallback when no usable hydrated rig exists', () => {
    const { project, shot, subject } = createImportedHumanoidFixture();
    addRig(project, { version: 1, id: 'empty-rig', skeletonJoints: [] });

    expect(resolvePoseableHumanoidTelemetry({ object: subject, assets: project.assets })).toBeUndefined();
    expect(describeSceneObjectComposition({ project, shot, object: subject }).landmarkSource).toBe('bounds_fallback');
  });

  it('keeps attached accessories out of body coverage but in assembly crop bounds', () => {
    const { project, shot, subject } = createImportedHumanoidFixture();
    const telemetry = describeSceneObjectComposition({ project, shot, object: subject });

    expect(telemetry.bodyBounds?.widthCoverage).toBeLessThan(telemetry.assemblyBounds?.widthCoverage ?? 0);
    expect(telemetry.bodyCoverage).toBeLessThan(telemetry.assemblyCoverage ?? 0);
    expect(telemetry.bounds).toEqual(telemetry.assemblyBounds);
    expect(telemetry.completeAssemblyInFrame).toBe(false);
  });

  it('does not treat a retained attachment hand anchor as visible hand geometry', () => {
    const { project, shot, subject } = createImportedHumanoidFixture();
    const withoutRig = describeSceneObjectComposition({ project, shot, object: subject });
    addRig(project);
    const withRig = describeSceneObjectComposition({ project, shot, object: subject });

    expect(withRig.landmarkSource).toBe('rig_marker');
    expect(withRig.bodyBounds).toEqual(withoutRig.bodyBounds);
    expect(withRig.bodyCoverage).toBe(withoutRig.bodyCoverage);
    expect(withRig.assemblyBounds).toEqual(withoutRig.assemblyBounds);
  });

  it('validates foot contact independently from the environment floor line', () => {
    const { project, shot, subject } = createImportedHumanoidFixture();
    const telemetry = describeSceneObjectComposition({ project, shot, object: subject });
    project.workflow.production = {
      schemaVersion: 1,
      bindings: { subject: { kind: 'object', objectId: subject.id } },
      locations: {},
      shotContracts: {
        [shot.id]: {
          composition: {
            subjects: [{
              entityId: 'subject',
              expectedFootPoint: [telemetry.footPoint!.x, telemetry.footPoint!.y],
              expectedFeetY: [telemetry.feetY! - 0.001, telemetry.feetY! + 0.001],
              completeAssemblyInFrame: true,
            }],
            floorLineY: 0,
          },
        },
      },
    } satisfies ProductionConfiguration;

    const result = inspectShotCompositionError(project, shot);
    expect(result.diagnostics.map((item) => item.message)).toContain('Floor line is outside the reference tolerance.');
    expect(result.diagnostics.map((item) => item.message)).toContain('Subject "subject" complete assembly is cropped.');
    expect(result.diagnostics.map((item) => item.message)).not.toContain('Subject "subject" foot point is outside the reference tolerance.');
    expect(result.diagnostics.map((item) => item.message)).not.toContain('Subject "subject" feet Y is outside the reference range.');
  });

  it('supports an achievable full-body hero range from bounds-derived framing', () => {
    const { project, shot, subject } = createImportedHumanoidFixture();
    const telemetry = describeSceneObjectComposition({ project, shot, object: subject });
    const body = telemetry.bodyBounds!;
    const height = subject.dimensions[1];
    const bodyHeight = body.heightCoverage;

    expect(bodyHeight).toBeGreaterThanOrEqual(0.65);
    expect(bodyHeight).toBeLessThanOrEqual(0.85);
    expect(body.centerX).toBeGreaterThanOrEqual(0.42);
    expect(body.centerX).toBeLessThanOrEqual(0.58);
    expect(telemetry.landmarks?.headTop?.y).toBeGreaterThanOrEqual(0.06);
    expect(telemetry.landmarks?.headTop?.y).toBeLessThanOrEqual(0.18);
    expect(telemetry.landmarks?.eyes?.y).toBeGreaterThanOrEqual(0.14);
    expect(telemetry.landmarks?.eyes?.y).toBeLessThanOrEqual(0.30);
    expect(telemetry.feetY).toBeGreaterThanOrEqual(0.82);
    expect(telemetry.feetY).toBeLessThanOrEqual(0.96);
    expect(height).toBeGreaterThan(0);
  });
});
