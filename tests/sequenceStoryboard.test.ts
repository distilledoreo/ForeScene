import { describe, expect, it } from 'vitest';
import { createDefaultProject, createShot, createCameraKeyframe } from '../src/domain/defaults';
import {
  buildSequenceStoryboard,
  copyStagingToNextShot,
  reorderShots,
  resolveAnimaticFrame,
} from '../src/engine/sequenceStoryboard';

describe('sequence storyboard', () => {
  it('builds items with duration, kind, and total length', () => {
    const project = createDefaultProject();
    const shotA = project.shots[0];
    const shotB = createShot({
      index: 2,
      camera: shotA.camera,
    });
    const move = {
      ...shotB,
      cameraKeyframes: [
        createCameraKeyframe({ label: 'Start', timeSeconds: 0, camera: shotB.camera }),
        createCameraKeyframe({
          label: 'End',
          timeSeconds: 4,
          camera: {
            ...shotB.camera,
            position: [1, shotB.camera.position[1], shotB.camera.position[2]],
          },
        }),
      ],
    };
    const board = buildSequenceStoryboard({ ...project, shots: [shotA, move] });
    expect(board.shotCount).toBe(2);
    expect(board.videoCount).toBe(1);
    expect(board.totalDurationSeconds).toBeGreaterThanOrEqual(4);
    expect(board.items[1]?.kind).toBe('video');
    expect(board.items[1]?.durationSeconds).toBeCloseTo(4, 5);
  });

  it('reorders shots and copies staging to next', () => {
    const project = createDefaultProject();
    const a = project.shots[0];
    const b = createShot({
      index: 2,
      camera: a.camera,
    });
    const c = createShot({
      index: 3,
      camera: a.camera,
    });
    const shots = [a, b, c];
    const reordered = reorderShots(shots, c.id, 0);
    expect(reordered.map((s) => s.id)).toEqual([c.id, a.id, b.id]);

    const withStaging = shots.map((shot, index) => (
      index === 0
        ? {
          ...shot,
          objectOverrides: {
            [project.scene.objects[0]?.id ?? 'obj']: {
              transform: {
                position: [1, 0, 0] as [number, number, number],
                rotation: [0, 0, 0] as [number, number, number],
                scale: [1, 1, 1] as [number, number, number],
              },
            },
          },
        }
        : shot
    ));
    const copied = copyStagingToNextShot(withStaging, withStaging[0].id);
    expect(copied[1]?.objectOverrides).toEqual(withStaging[0].objectOverrides);
  });

  it('resolves animatic playhead frames', () => {
    const project = createDefaultProject();
    const board = buildSequenceStoryboard(project);
    const frame = resolveAnimaticFrame(board, 0.5);
    expect(frame?.shotId).toBe(project.shots[0]?.id);
  });
});
