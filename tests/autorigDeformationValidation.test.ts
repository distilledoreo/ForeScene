import { describe, expect, it } from 'vitest';
import {
  analyzeDiagnosticPose,
  validateAutorigRigReady,
  validateNeutralDeformation,
} from '../src/engine/autorig/deformationValidation';
import { AUTORIG_REGION_CODE } from '../src/engine/autorig/regions';

describe('autorig deformation validation', () => {
  it('accepts matching neutral poses', () => {
    const rest = Float32Array.from([0, 0, 0, 1, 1, 0, 0, 1, 0]);
    const issues = validateNeutralDeformation({
      restPositions: rest,
      posedPositions: new Float32Array(rest),
    });
    expect(issues).toEqual([]);
  });

  it('flags exploding diagnostic poses in plain language', () => {
    const rest = Float32Array.from([
      0, 1, 0,
      0.5, 1, 0,
      -0.5, 1, 0,
    ]);
    const posed = Float32Array.from([
      0, 1, 0,
      5.0, 1, 0, // far left-arm vert
      -0.5, 1, 0,
    ]);
    const labels = Uint8Array.from([
      AUTORIG_REGION_CODE.torso,
      AUTORIG_REGION_CODE.leftArm,
      AUTORIG_REGION_CODE.rightArm,
    ]);
    const issues = analyzeDiagnosticPose({
      restPositions: rest,
      posedPositions: posed,
      regionLabels: labels,
      heightMeters: 1.75,
      jointPositions: {
        leftUpperArm: [0.2, 1.3, 0],
        rightUpperArm: [-0.2, 1.3, 0],
      },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message.toLowerCase()).not.toMatch(/capsule|vertex|bone index/);
    expect(issues[0]!.message).toMatch(/arm|limb|label|bend|move/i);
  });

  it('blocks apply when markers are missing', () => {
    const issues = validateAutorigRigReady({
      hasRequiredMarkers: false,
      headAboveHips: true,
      kneesBelowHips: true,
      anklesBelowKnees: true,
      limbsNotCrossed: true,
    });
    expect(issues.some((issue) => issue.severity === 'blocking')).toBe(true);
  });
});
