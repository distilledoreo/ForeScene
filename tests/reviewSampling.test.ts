import { describe, expect, it } from 'vitest';
import { createCameraKeyframe, createDefaultProject } from '../src/domain/defaults';
import { planReviewSamples } from '../src/engine/previs/reviewSampling';

describe('event-aware review sampling', () => {
  it('uses one frame for a static shot', () => {
    const shot = createDefaultProject().shots[0]!;
    const plan = planReviewSamples({ shotId: shot.id, shot });
    expect(plan.samples).toHaveLength(1);
    expect(plan.samples[0]!.timeSeconds).toBe(0);
  });

  it('uses start and end for a simple linear camera move', () => {
    const shot = createDefaultProject().shots[0]!;
    shot.cameraKeyframes = [
      createCameraKeyframe({ label: 'start', timeSeconds: 0, camera: shot.camera }),
      createCameraKeyframe({ label: 'end', timeSeconds: 4, camera: { ...shot.camera, position: [2, 1.5, 5] } }),
    ];
    const plan = planReviewSamples({ shotId: shot.id, shot, maxSamples: 3 });
    expect(plan.samples.map((sample) => sample.timeSeconds)).toEqual([0, 4]);
  });

  it('prioritizes visibility events while staying within the sample bound', () => {
    const shot = createDefaultProject().shots[0]!;
    shot.cameraKeyframes = [
      createCameraKeyframe({ label: 'start', timeSeconds: 0, camera: shot.camera }),
      createCameraKeyframe({ label: 'event', timeSeconds: 2, camera: { ...shot.camera, position: [1, 1.5, 5] }, objectOverrides: { prop: { visible: false } } }),
      createCameraKeyframe({ label: 'end', timeSeconds: 4, camera: { ...shot.camera, position: [2, 1.5, 5] } }),
    ];
    const plan = planReviewSamples({ shotId: shot.id, shot, maxSamples: 3 });
    expect(plan.samples).toHaveLength(3);
    expect(plan.samples[1]!.timeSeconds).toBe(2);
    expect(plan.samples[1]!.reasons).toContain('visibility_or_pose_event');
  });
});
