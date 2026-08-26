import { describe, expect, it } from 'vitest';
import type { PrevisShotDefinition } from '../src/engine/previs/manifest';
import {
  canInferNativeActionPose,
  inferNativeActionPose,
  inferRigidLocomotionRotation,
  resolveEmbeddedPropIntents,
  resolveReadableMotionCamera,
  resolveReadableMotionSubjectPosition,
  rigidLocomotionGroundedPosition,
  READABLE_LOCOMOTION_COVER_FOLLOW,
  READABLE_LOCOMOTION_COVER_FOV_DEGREES,
  READABLE_LOCOMOTION_COVER_HEIGHT_METERS,
  READABLE_LOCOMOTION_COVER_LATERAL_METERS,
  RIGID_LOCOMOTION_LEAN_DEGREES,
} from '../src/engine/previs/actionIntent';
import type { PrevisProductionManifestV1 } from '../src/engine/previs/manifest';

function chase(): PrevisShotDefinition {
  return {
    id: 'chase',
    shotNumber: '010',
    name: 'Sprint chase',
    description: 'The pursuer chases the runner.',
    locationId: 'corridor',
    subjects: ['runner', 'pursuer'],
    camera: { template: 'full', subjects: ['runner', 'pursuer'], angle: 'three_quarter' },
    motion: {
      durationSeconds: 3,
      keyframes: [{
        timeSeconds: 0,
        camera: { position: [0.4, 1.6, -2], target: [0, 0.9, -5.8], fovDegrees: 50 },
        staging: [
          { subject: 'runner', transform: { position: [0, 0.875, -5.3] } },
          { subject: 'pursuer', transform: { position: [0, 0, -6.5] } },
        ],
      }, {
        timeSeconds: 3,
        camera: { position: [0.4, 1.6, 8.6], target: [0, 0.9, 4.8], fovDegrees: 50 },
        staging: [
          { subject: 'runner', transform: { position: [0, 0.875, 5.3] } },
          { subject: 'pursuer', transform: { position: [0, 0, 4.1] } },
        ],
      }],
    },
  };
}

describe('action intent', () => {
  it('does not invent deformation for imported rigs from prose alone', () => {
    expect(canInferNativeActionPose({
      id: 'rigged',
      name: 'Rigged character',
      type: 'imported_character',
      source: 'character.glb',
      rigMode: 'saved-rig',
      rigPackage: 'character.fsrig',
    })).toBe(false);
    expect(canInferNativeActionPose({
      id: 'dummy',
      name: 'Dummy',
      type: 'human_dummy',
    })).toBe(true);
  });

  it('orients imported locomotion toward travel with a readable local lean', () => {
    const runner = inferRigidLocomotionRotation(chase(), 'runner')!;
    const pursuer = inferRigidLocomotionRotation(chase(), 'pursuer')!;
    expect(runner[0]).toBeCloseTo(RIGID_LOCOMOTION_LEAN_DEGREES, 5);
    expect(runner[1]).toBeCloseTo(0, 5);
    expect(runner[2]).toBeCloseTo(0, 5);
    expect(pursuer).toEqual(runner);
    expect(inferRigidLocomotionRotation(chase(), 'runner')).toEqual(runner);
    const planted = rigidLocomotionGroundedPosition([0, 0.875, -5.3], 1.75);
    expect(planted[1]).toBeLessThan(0.875);
    expect(planted[1]).toBeGreaterThan(0.7);
    expect(rigidLocomotionGroundedPosition([0, 0, -6.5], 0)).toEqual([0, 0, -6.5]);
  });

  it('separates stacked chase silhouettes without changing travel', () => {
    const shot = chase();
    const start = shot.motion!.keyframes[0]!;
    const runner = resolveReadableMotionSubjectPosition(shot, start, 'runner')!;
    const pursuer = resolveReadableMotionSubjectPosition(shot, start, 'pursuer')!;
    expect(runner[0]).toBeLessThan(0);
    expect(pursuer[0]).toBeGreaterThan(0);
    expect(runner[2]).toBe(-5.3);
    expect(pursuer[2]).toBe(-6.5);
    expect(pursuer[0] - runner[0]).toBeCloseTo(0.96, 5);
  });

  it('keeps an already separated chase pair on its authored laterals', () => {
    const shot = chase();
    shot.motion!.keyframes[0]!.staging = [
      { subject: 'runner', transform: { position: [-0.8, 0.875, -5.3] } },
      { subject: 'pursuer', transform: { position: [0.8, 0, -6.5] } },
    ];
    expect(resolveReadableMotionSubjectPosition(shot, shot.motion!.keyframes[0]!, 'runner')).toEqual([-0.8, 0.875, -5.3]);
    expect(resolveReadableMotionSubjectPosition(shot, shot.motion!.keyframes[0]!, 'pursuer')).toEqual([0.8, 0, -6.5]);
  });

  it('derives a stable exact locomotion silhouette across timeline interpolation', () => {
    const shot = chase();
    expect(inferNativeActionPose(shot, 'runner', 0)).toBe('walk-contact-left');
    expect(inferNativeActionPose(shot, 'runner', 1)).toBe('walk-contact-left');
  });

  it('does not invent an articulated pose for an asset-authored battle-ready stance', () => {
    const shot = chase();
    shot.name = 'Battle-ready stance';
    shot.description = 'The equipped fighter holds position.';
    delete shot.motion;
    expect(inferNativeActionPose(shot, 'runner')).toBeUndefined();
  });

  it('adds a bounded lateral offset to a collinear multi-subject tracking camera', () => {
    const shot = chase();
    shot.name = 'Two-shot conversation';
    shot.description = 'The pair hold position.';
    const repaired = resolveReadableMotionCamera(shot, shot.motion!.keyframes[0]!)!;
    expect(repaired.position?.[0]).toBeCloseTo(1.2, 5);
    expect(repaired.position?.[1]).toBe(1.6);
    expect(repaired.position?.[2]).toBe(-2);
    expect(repaired.target).toEqual([0, 0.9, -5.8]);
  });

  it('locks a covering chase camera so subjects travel through the frame', () => {
    const shot = chase();
    const start = resolveReadableMotionCamera(shot, shot.motion!.keyframes[0]!)!;
    const end = resolveReadableMotionCamera(shot, shot.motion!.keyframes[1]!)!;
    expect(start.position?.[0]).toBeCloseTo(READABLE_LOCOMOTION_COVER_LATERAL_METERS, 5);
    expect(start.position?.[1]).toBe(READABLE_LOCOMOTION_COVER_HEIGHT_METERS);
    expect(start.position?.[2]).toBeCloseTo(READABLE_LOCOMOTION_COVER_FOLLOW * ((-5.3 + -6.5) / 2), 5);
    expect(end.position?.[2]).toBeCloseTo(READABLE_LOCOMOTION_COVER_FOLLOW * ((5.3 + 4.1) / 2), 5);
    expect(start.position?.[2]).not.toBeCloseTo(end.position?.[2] ?? 0, 1);
    expect(start.target?.[2]).toBeCloseTo((-5.3 + -6.5) / 2, 5);
    expect(end.target?.[2]).toBeCloseTo((5.3 + 4.1) / 2, 5);
    expect(start.fovDegrees).toBe(READABLE_LOCOMOTION_COVER_FOV_DEGREES);
  });

  it('aliases explicitly preferred built-in props to the sole saved-rig host', () => {
    const shot = chase();
    shot.subjects = ['fighter', 'shield'];
    shot.camera.subjects = ['fighter'];
    shot.requirements = {
      visibleProps: ['shield'],
      notes: ['Use built-in character geometry for the shield when available.'],
    };
    delete shot.motion;
    const manifest: PrevisProductionManifestV1 = {
      version: 1,
      project: { name: 'test', aspectRatio: '16:9' },
      locations: [{ id: 'corridor', name: 'Corridor', template: 'corridor' }],
      cast: [{
        id: 'fighter',
        name: 'Fighter',
        type: 'imported_character',
        source: 'fighter.glb',
        rigMode: 'saved-rig',
        rigPackage: 'fighter.fsrig',
      }],
      props: [{ id: 'shield', name: 'Shield', primitive: 'shield' }],
      shots: [shot],
    };

    const resolved = resolveEmbeddedPropIntents(manifest);
    expect(resolved.manifest.props?.[0]?.embeddedIn).toEqual({
      subject: 'fighter',
      joint: 'leftHand',
    });
    expect(resolved.derived).toHaveLength(1);
    expect(manifest.props?.[0]?.embeddedIn).toBeUndefined();
  });
});
