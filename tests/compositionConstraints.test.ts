import { describe, expect, it } from 'vitest';
import { createDefaultProject, createSceneObject } from '../src/domain/defaults';
import type { ProductionConfiguration } from '../src/domain/types';
import {
  describeSceneObjectComposition,
} from '../src/engine/previs/compositionTelemetry';
import {
  getShotCompositionContract,
  inspectShotCompositionError,
  verifyShotCompositionConstraints,
} from '../src/engine/previs/compositionConstraints';
import { solveShotToCompositionConstraints } from '../src/engine/previs/compositionConstraintSolver';
import { FAILURE_CODES, validateShotFrame } from '../src/engine/previs/frameValidation';

function normalizedBounds(
  bounds: ReturnType<typeof describeSceneObjectComposition>['bounds'],
  width: number,
  height: number,
) {
  const left = bounds.pixels.left / width;
  const top = bounds.pixels.top / height;
  const right = bounds.pixels.right / width;
  const bottom = bounds.pixels.bottom / height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function projectWithCompositionContract() {
  const project = createDefaultProject();
  const shot = project.shots[0]!;
  const subject = createSceneObject('human_dummy', 10, [0, 0.875, 0.85]);
  subject.name = 'Lead';
  project.scene.objects = [subject];
  shot.camera = {
    ...shot.camera,
    position: [1.2, 1.6, 6] as [number, number, number],
    target: [0, 0.95, 0.85] as [number, number, number],
    fovDegrees: 55,
  };
  const referenceShot = {
    ...shot,
    camera: {
      ...shot.camera,
      position: [0, 1.6, 6] as [number, number, number],
      target: [0, 0.95, 0.85] as [number, number, number],
      fovDegrees: 45,
    },
  };
  const reference = describeSceneObjectComposition({ project, shot: referenceShot, object: subject });
  project.workflow.production = {
    schemaVersion: 1,
    bindings: { lead: { kind: 'object', objectId: subject.id } },
    locations: {},
    shotContracts: {
      [shot.id]: {
        composition: {
          subjects: [{
            entityId: 'lead',
            expectedBounds: normalizedBounds(reference.bounds, shot.exportSettings.width, shot.exportSettings.height),
            headPoint: [reference.landmarks?.headTop?.x ?? 0.5, reference.landmarks?.headTop?.y ?? 0.5],
          }],
          cropTolerance: 0.04,
        },
      },
    },
  } satisfies ProductionConfiguration;
  return { project, shot, subject };
}

describe('reference-driven composition constraints', () => {
  it('resolves a contract by shot id, production id, or shot number', () => {
    const { project, shot } = projectWithCompositionContract();
    expect(getShotCompositionContract(project, shot)?.subjects).toHaveLength(1);
    const byProductionId = { ...shot, productionShotId: 'A-010' };
    project.workflow.production!.shotContracts = {
      'A-010': project.workflow.production!.shotContracts[shot.id]!,
    };
    expect(getShotCompositionContract(project, byProductionId)).toBeDefined();
  });

  it('hard-fails missing entities and out-of-tolerance reference bounds', () => {
    const { project, shot } = projectWithCompositionContract();
    const result = verifyShotCompositionConstraints(project, shot);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain('composition_constraint_out_of_tolerance');

    project.workflow.production!.shotContracts[shot.id]!.composition!.subjects[0]!.entityId = 'missing';
    const missing = inspectShotCompositionError(project, shot);
    expect(missing.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'composition_entity_missing', entityId: 'missing' }),
    ]));
  });

  it('refines a shifted camera into the reference tolerance without changing subject state', () => {
    const { project, shot, subject } = projectWithCompositionContract();
    const beforeCamera = structuredClone(shot.camera);
    const beforePosition = structuredClone(subject.transform.position);
    const solved = solveShotToCompositionConstraints(project, shot, undefined, { maxIterations: 12 });

    expect(solved.ok).toBe(true);
    expect(solved.changed).toBe(true);
    expect(solved.after.diagnostics).toEqual([]);
    expect(subject.transform.position).toEqual(beforePosition);
    expect(shot.camera).toEqual(beforeCamera);
  });

  it('adds reference violations to the hard frame-validation failure set', () => {
    const { project, shot } = projectWithCompositionContract();
    const definition = {
      version: 1,
      shotNumber: shot.shotNumber,
      id: 'fixture',
      name: shot.name,
      description: '',
      locationId: 'location',
      subjects: [],
      camera: { template: 'wide' as const, subjects: [] },
    };
    const result = validateShotFrame({
      project,
      shot,
      definition,
      frameExists: true,
      frameByteSize: 100,
    });
    expect(result.status).toBe('failed');
    expect(FAILURE_CODES.has('composition_constraint_out_of_tolerance')).toBe(true);
  });
});
