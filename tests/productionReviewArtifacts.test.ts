import { describe, expect, it } from 'vitest';
import {
  buildProductionReviewArtifacts,
  createProductionRepairIntents,
  normalizeProductionVisualReview,
} from '../src/engine/previs/productionReviewArtifacts';

describe('production review artifacts', () => {
  it('plans master, location, motion, and continuity review artifacts with tile metadata', () => {
    const result = buildProductionReviewArtifacts({
      frames: [
        {
          shotId: 'shot-1',
          shotNumber: '001',
          name: 'Wide',
          framePath: 'shot-1.png',
          locationId: 'interior',
          cameraRecipe: 'wide',
          presenceStatus: 'passed',
          panoramaStatus: 'passed',
          cacheHit: true,
          motionSamples: [
            { timeSeconds: 0, framePath: 'shot-1-0.png', cacheHit: true },
            { timeSeconds: 2, framePath: 'shot-1-2.png', cacheHit: false },
            { timeSeconds: 4, framePath: 'shot-1-4.png' },
          ],
        },
        {
          shotId: 'shot-2',
          shotNumber: '002',
          name: 'Close',
          framePath: 'shot-2.png',
          locationId: 'interior',
          presenceStatus: 'needs_review',
          panoramaStatus: 'passed',
          compositionError: 0.14,
          diagnosticCodes: ['unexpected_dynamic_object'],
        },
        {
          shotId: 'shot-3',
          shotNumber: '003',
          name: 'Exterior',
          framePath: 'shot-3.png',
          locationId: 'exterior',
          presenceStatus: 'passed',
          panoramaStatus: 'passed',
        },
      ],
    });

    expect(result.locationIds).toEqual(['interior', 'exterior']);
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      'master_sequence',
      'location_sheet',
      'location_sheet',
      'motion_triptych',
      'continuity_strip',
    ]);

    const master = result.artifacts[0]!;
    expect(master.contactSheet.shots[0]).toMatchObject({
      locationId: 'interior',
      cameraRecipe: 'wide',
      presenceStatus: 'passed',
      panoramaStatus: 'passed',
      cacheHit: true,
    });
    expect(master.contactSheet.shots[1]!.badges).toContain('presence:needs_review');
    expect(master.contactSheet.shots[1]!.badges).toContain('diag:unexpected_dynamic_object');

    const triptych = result.artifacts.find((artifact) => artifact.kind === 'motion_triptych')!;
    expect(triptych.tiles.map((tile) => tile.metadata.sampleTimeSeconds)).toEqual([0, 2, 4]);
  });

  it('normalizes review proposals and emits verified repair intents without project mutation', () => {
    const review = normalizeProductionVisualReview({
      approvedShotIds: ['shot-1', 'unknown'],
      failedShots: [
        { shotId: 'shot-2', category: 'presence', reason: 'Extra actor visible.', confidence: 2 },
        { shotId: 'unknown', category: 'other', reason: 'Ignore me.', confidence: 1 },
      ],
      systemicPatterns: [{ category: 'presence', affectedShotIds: ['shot-1', 'shot-2', 'unknown'] }],
    }, ['shot-1', 'shot-2']);

    expect(review).toEqual({
      approvedShotIds: ['shot-1'],
      failedShots: [{ shotId: 'shot-2', category: 'presence', reason: 'Extra actor visible.', confidence: 1 }],
      systemicPatterns: [{ category: 'presence', affectedShotIds: ['shot-1', 'shot-2'] }],
    });
    expect(createProductionRepairIntents(review)).toEqual([{
      shotId: 'shot-2',
      category: 'presence',
      reason: 'Extra actor visible.',
      confidence: 1,
      requiresVerifiedMutation: true,
    }]);
  });
});

