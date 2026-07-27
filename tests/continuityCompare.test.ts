import { describe, expect, it } from 'vitest';
import { createDefaultProject, createShot } from '../src/domain/defaults';
import {
  compareShotsForContinuity,
  getPreviousShotInSequence,
} from '../src/engine/continuityCompare';

describe('continuity compare', () => {
  it('reports camera/lens/staging deltas vs previous shot', () => {
    const project = createDefaultProject();
    const base = project.shots[0];
    const next = createShot({
      index: 2,
      camera: {
        ...base.camera,
        position: [base.camera.position[0] + 1, base.camera.position[1], base.camera.position[2]],
        fovDegrees: base.camera.fovDegrees + 5,
      },
    });
    const withTwo = {
      ...project,
      shots: [base, next],
    };
    expect(getPreviousShotInSequence(withTwo, next.id)?.id).toBe(base.id);
    const report = compareShotsForContinuity({
      project: withTwo,
      previousShot: base,
      currentShot: next,
    });
    expect(report.camera.some((d) => d.field === 'position')).toBe(true);
    expect(report.camera.some((d) => d.field === 'fov') || report.lens.length > 0).toBe(true);
    expect(report.summary).toMatch(/continuity change/i);
  });
});
