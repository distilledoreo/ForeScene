import { describe, expect, it } from 'vitest';
import type { PrevisShotDefinition } from '../src/engine/previs/manifest';
import {
  inferNativeActionPose,
  resolveEmbeddedPropIntents,
  resolveReadableMotionCamera,
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
        camera: { position: [1.2, 1.6, -2], target: [0, 0.9, -5.8], fovDegrees: 50 },
        staging: [
          { subject: 'runner', transform: { position: [0, 0.875, -5.3] } },
          { subject: 'pursuer', transform: { position: [0, 0, -6.5] } },
        ],
      }, {
        timeSeconds: 3,
        camera: { position: [1.2, 1.6, 8.6], target: [0, 0.9, 4.8], fovDegrees: 50 },
        staging: [
          { subject: 'runner', transform: { position: [0, 0.875, 5.3] } },
          { subject: 'pursuer', transform: { position: [0, 0, 4.1] } },
        ],
      }],
    },
  };
}

describe('action intent', () => {
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
    const repaired = resolveReadableMotionCamera(shot, shot.motion!.keyframes[0]!)!;
    expect(repaired.position?.[0]).toBeCloseTo(5, 5);
    expect(repaired.position?.[1]).toBe(1.6);
    expect(repaired.position?.[2]).toBe(-2);
    expect(repaired.target).toEqual([0, 0.9, -5.8]);
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
