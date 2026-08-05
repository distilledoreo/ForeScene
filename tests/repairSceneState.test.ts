/**
 * Repair re-solves must use shot.objectOverrides, not base scene transforms.
 */

import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/domain/defaults';
import type { LocationProject, SceneObject, Shot, Transform, Vec3 } from '../src/domain/types';
import {
  buildRepairPlan,
  buildSubjectBoundsForRepair,
  solidBlockersForRepair,
  solveShotCamera,
  type PrevisShotDefinition,
} from '../src/engine/previs';

function makeHuman(
  id: string,
  name: string,
  position: Vec3,
  height = 1.75,
): SceneObject {
  return {
    id,
    name,
    type: 'human_dummy',
    transform: {
      position: [position[0], height / 2, position[2]],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    dimensions: [0.55, height, 0.55],
    visible: true,
    locked: false,
    color: '#888888',
    stagingRole: 'person',
  } as SceneObject;
}

function makeShot(partial: {
  id?: string;
  shotNumber?: string;
  camera: Shot['camera'];
  objectOverrides?: Shot['objectOverrides'];
}): Shot {
  return {
    id: partial.id ?? 'shot-030',
    name: 'OTS',
    description: 'test',
    shotNumber: partial.shotNumber ?? '030',
    camera: partial.camera,
    cameraKeyframes: [],
    objectOverrides: partial.objectOverrides,
    landmarkIds: [],
    promptOverrides: {},
    status: 'planned',
    assets: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    exportSettings: {
      width: 1280,
      height: 720,
      includeViewport: true,
      includeAiResultFrame: false,
      includePanoCrop: false,
      includeFullPano: false,
      includeCubemap: false,
      includeGrayboxPano: false,
      includeCameraMoveVideo: false,
      includeCameraMoveReferenceFrames: false,
      includeMetadata: true,
      includePrompt: true,
    },
  };
}

function stagedOverride(position: Vec3, height = 1.75): { transform: Transform; visible: boolean } {
  return {
    transform: {
      position: [position[0], height / 2, position[2]],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    visible: true,
  };
}

const otsDefinition: PrevisShotDefinition = {
  id: 's030',
  shotNumber: '030',
  name: 'Blair OTS',
  description: 'OTS',
  locationId: 'room',
  subjects: ['alex', 'blair'],
  camera: {
    template: 'over_the_shoulder',
    subjects: ['alex'],
    foregroundSubject: 'blair',
    angle: 'three_quarter',
  },
  requirements: { visibleSubjects: ['alex', 'blair'] },
};

describe('repair scene state — shot overrides', () => {
  it('uses shot objectOverrides, not base parking positions', () => {
    const project = createDefaultProject() as LocationProject;
    // Base (parking) far from origin — the bug aimed here.
    const alex = makeHuman('alex-id', 'Alex', [8, 0, 8]);
    const blair = makeHuman('blair-id', 'Blair', [8, 0, 9.2], 1.68);
    project.scene.objects = [alex, blair];

    const shot = makeShot({
      camera: {
        position: [0, 1.5, 2],
        target: [0, 1.1, 0],
        fovDegrees: 35,
        aspectRatio: 16 / 9,
        near: 0.05,
        far: 500,
      },
      objectOverrides: {
        'alex-id': stagedOverride([0, 0, 0]),
        'blair-id': stagedOverride([0, 0, 1.2], 1.68),
      },
    });
    project.shots = [shot];

    const bounds = buildSubjectBoundsForRepair({
      project,
      shot,
      definition: otsDefinition,
      subjectNames: { alex: 'Alex', blair: 'Blair' },
    });

    expect(bounds).toHaveLength(2);
    const alexBounds = bounds.find((b) => b.id === 'alex')!;
    const blairBounds = bounds.find((b) => b.id === 'blair')!;
    expect(alexBounds.position[0]).toBeCloseTo(0, 5);
    expect(alexBounds.position[2]).toBeCloseTo(0, 5);
    expect(blairBounds.position[0]).toBeCloseTo(0, 5);
    expect(blairBounds.position[2]).toBeCloseTo(1.2, 5);
    // Must not use base parking at [8, 8].
    expect(Math.hypot(alexBounds.position[0] - 8, alexBounds.position[2] - 8)).toBeGreaterThan(5);
  });

  it('OTS re-solve targets staged centroid, not base parking', () => {
    const project = createDefaultProject() as LocationProject;
    const alex = makeHuman('alex-id', 'Alex', [8, 0, 8]);
    const blair = makeHuman('blair-id', 'Blair', [8, 0, 9.2], 1.68);
    project.scene.objects = [alex, blair];

    const shot = makeShot({
      camera: {
        // Wrong camera aimed at parking — what a buggy repair would produce.
        position: [10.478, 1.478, 8],
        target: [8, 1.338, 8],
        fovDegrees: 35,
        aspectRatio: 16 / 9,
        near: 0.05,
        far: 500,
      },
      objectOverrides: {
        'alex-id': stagedOverride([0, 0, 0]),
        'blair-id': stagedOverride([0, 0, 1.2], 1.68),
      },
    });
    project.shots = [shot];

    const subjects = buildSubjectBoundsForRepair({
      project,
      shot,
      definition: otsDefinition,
      subjectNames: { alex: 'Alex', blair: 'Blair' },
    });

    const plan = buildRepairPlan({
      shotTarget: { id: shot.id },
      camera: shot.camera,
      template: 'over_the_shoulder',
      primarySubjectId: 'alex',
      foregroundSubjectId: 'blair',
      subjects,
      aspectRatio: 16 / 9,
      shotDefinition: otsDefinition,
      issues: [{
        code: 'ots_foreground_missing',
        message: 'empty frame',
      }],
    });

    expect(plan?.description).toMatch(/OTS dedicated re-solve/i);
    const cmd = plan!.commands.find((c) => c.op === 'shot.updateCamera');
    expect(cmd && cmd.op === 'shot.updateCamera').toBe(true);
    if (cmd && cmd.op === 'shot.updateCamera') {
      const target = cmd.camera.target!;
      // Should aim near staged actors around origin, not parking at [8,8].
      expect(Math.hypot(target[0] - 8, target[2] - 8)).toBeGreaterThan(4);
      expect(Math.hypot(target[0], target[2])).toBeLessThan(3);

      // Re-solve with those subjects keeps both in front of camera.
      const resolved = solveShotCamera({
        shot: otsDefinition,
        subjects,
        aspectRatio: 16 / 9,
      });
      const toAlex = [
        0 - resolved.camera.position[0],
        0.875 - resolved.camera.position[1],
        0 - resolved.camera.position[2],
      ] as Vec3;
      const forward = [
        resolved.camera.target[0] - resolved.camera.position[0],
        resolved.camera.target[1] - resolved.camera.position[1],
        resolved.camera.target[2] - resolved.camera.position[2],
      ] as Vec3;
      const fLen = Math.hypot(forward[0], forward[1], forward[2]) || 1;
      const aLen = Math.hypot(toAlex[0], toAlex[1], toAlex[2]) || 1;
      const dot = (forward[0] * toAlex[0] + forward[1] * toAlex[1] + forward[2] * toAlex[2])
        / (fLen * aLen);
      expect(dot).toBeGreaterThan(0.15);
    }
  });

  it('respects shot-level wall visibility for blockers', () => {
    const project = createDefaultProject() as LocationProject;
    const wall = {
      id: 'wall-1',
      name: 'Wall',
      type: 'wall',
      transform: {
        position: [0, 1.25, -1] as Vec3,
        rotation: [0, 0, 0] as Vec3,
        scale: [1, 1, 1] as Vec3,
      },
      dimensions: [4, 2.5, 0.2] as Vec3,
      visible: true,
      locked: false,
      color: '#666',
      stagingRole: 'set',
    } as SceneObject;
    project.scene.objects = [makeHuman('alex-id', 'Alex', [0, 0, 0]), wall];

    const shotHidden = makeShot({
      camera: {
        position: [0, 1.5, 3],
        target: [0, 1.1, 0],
        fovDegrees: 35,
        aspectRatio: 16 / 9,
        near: 0.05,
        far: 500,
      },
      objectOverrides: {
        'wall-1': { visible: false },
      },
    });

    const blockers = solidBlockersForRepair({ project, shot: shotHidden });
    expect(blockers.find((b) => b.id === 'wall-1')).toBeUndefined();
  });
});
