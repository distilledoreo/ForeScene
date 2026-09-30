import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileProduction, solveShotCamera, subjectBoundsFromPlacement, type PrevisCameraAngle, type PrevisProductionManifestV1, type PrevisShotDefinition } from '../src/engine/previs';

function manifest(): PrevisProductionManifestV1 {
  return JSON.parse(readFileSync('examples/previs/minimal-dialogue.json', 'utf8'));
}

function compiledCameras(input: PrevisProductionManifestV1) {
  const compiled = compileProduction(input);
  expect(compiled.ok).toBe(true);
  return Object.fromEntries(compiled.shotBatches.flatMap((batch) => batch.plan.commands)
    .filter((command) => command.op === 'shot.create')
    .map((command) => command.op === 'shot.create' ? [command.shot.shotNumber, command.shot.camera] : []));
}

function solveOts(angle?: PrevisCameraAngle, rotation = 0, reverseSubjects = false) {
  const subjects = [
    subjectBoundsFromPlacement({ id: 'alex', position: [0, 0, 0], yawRadians: rotation }),
    subjectBoundsFromPlacement({ id: 'blair', position: [Math.sin(rotation) * 1.2, 0, Math.cos(rotation) * 1.2], yawRadians: Math.PI + rotation }),
  ];
  const shot: PrevisShotDefinition = {
    id: 's', name: 'OTS', shotNumber: '030', description: '', locationId: 'room', subjects: ['alex', 'blair'],
    camera: { template: 'over_the_shoulder', subjects: ['alex'], foregroundSubject: 'blair', angle, lensClass: 'normal' },
  };
  return solveShotCamera({ shot, subjects: reverseSubjects ? subjects.reverse() : subjects, aspectRatio: 16 / 9 });
}

function solvePair(angle?: PrevisCameraAngle, reverseSubjects = false) {
  const subjects = [
    subjectBoundsFromPlacement({ id: 'alex', position: [-1, 0, 0] }),
    subjectBoundsFromPlacement({ id: 'blair', position: [1, 0, 0] }),
  ];
  const shot: PrevisShotDefinition = {
    id: 'pair', name: 'Pair', shotNumber: '010', description: '', locationId: 'room', subjects: ['alex', 'blair'],
    camera: { template: 'two_shot', subjects: ['alex', 'blair'], angle, lensClass: 'wide' },
  };
  return solveShotCamera({ shot, subjects: reverseSubjects ? subjects.reverse() : subjects, aspectRatio: 16 / 9 });
}

describe('specialized previs camera angles', () => {
  it('changes only the original OTS shot when its authored angle changes to profile', () => {
    const before = manifest();
    const after = structuredClone(before);
    after.shots.find((shot) => shot.shotNumber === '030')!.camera.angle = 'profile';
    const original = compiledCameras(before);
    const edited = compiledCameras(after);
    expect(edited['030']).not.toEqual(original['030']);
    for (const number of ['010', '020', '040']) expect(edited[number]).toEqual(original[number]);
  });

  it('changes the two-shot camera when its angle changes from front to three-quarter', () => {
    const before = manifest();
    const after = structuredClone(before);
    after.shots.find((shot) => shot.shotNumber === '010')!.camera.angle = 'three_quarter';
    const original = compiledCameras(before);
    const edited = compiledCameras(after);
    expect(edited['010']).not.toEqual(original['010']);
    for (const number of ['020', '030', '040']) expect(edited[number]).toEqual(original[number]);
  });
  it('orbits toward the requested OTS angle while retaining hard framing acceptance', () => {
    const front = solveOts('front');
    const quarter = solveOts('three_quarter');
    const profile = solveOts('profile');
    const azimuth = (result: typeof front) => Math.abs(Math.atan2(result.camera.position[0], result.camera.position[2])) * 180 / Math.PI;
    for (const result of [front, quarter, profile]) expect(result.hardPass).toBe(true);
    expect(azimuth(quarter) - azimuth(front)).toBeGreaterThan(10);
    expect(azimuth(profile) - azimuth(quarter)).toBeGreaterThan(10);
    expect(Math.abs(90 - azimuth(profile))).toBeLessThan(Math.abs(90 - azimuth(quarter)));
    const rear = solveOts('rear');
    expect(rear.notes).toContain('camera_angle_constrained');
    expect(rear.warnings.join(' ')).toMatch(/Requested rear angle constrained/);
    expect(rear.camera.position.every(Number.isFinite)).toBe(true);
  });

  it('preserves the legacy OTS camera when angle is omitted', () => {
    const result = solveOts();
    expect(result.camera.position[0]).toBeCloseTo(1.0975);
    expect(result.camera.position[1]).toBeCloseTo(1.535);
    expect(result.camera.position[2]).toBeCloseTo(1.5);
    expect(result.hardPass).toBe(true);
  });

  it.each([Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI])('preserves local OTS geometry when rotating the set by %s radians', (rotation) => {
    const base = solveOts('three_quarter');
    const rotated = solveOts('three_quarter', rotation);
    const [x, , z] = rotated.camera.position;
    const localX = Math.cos(rotation) * x - Math.sin(rotation) * z;
    const localZ = Math.sin(rotation) * x + Math.cos(rotation) * z;
    expect(Math.abs(localX)).toBeCloseTo(Math.abs(base.camera.position[0]), 6);
    expect(localZ).toBeCloseTo(base.camera.position[2], 6);
    expect(rotated.hardPass).toBe(true);
  });

  it('uses declared subjects instead of unrelated input iteration order', () => {
    expect(solveOts('profile', 0, true).camera).toEqual(solveOts('profile').camera);
    expect(solvePair('three_quarter', true).camera).toEqual(solvePair('three_quarter').camera);
  });

  it('selects distinct front, oblique, profile, and rear two-shot views with both subjects framed', () => {
    const angles = ['front', 'three_quarter', 'profile', 'rear'] as const;
    const results = angles.map((angle) => solvePair(angle));
    for (const result of results) {
      expect(result.hardPass).toBe(true);
      expect(result.camera.position.every(Number.isFinite)).toBe(true);
    }
    expect(new Set(results.map((result) => JSON.stringify(result.camera))).size).toBe(4);
    expect(results[0].camera.position[2]).toBeGreaterThan(0);
    expect(results[3].camera.position[2]).toBeLessThan(0);
    expect(Math.abs(results[2].camera.position[0])).toBeGreaterThan(Math.abs(results[2].camera.position[2]));
  });

});
