import { describe, expect, it } from 'vitest';
import {
  createInitialRunState,
  createProductionRunId,
  deriveProductionRunStatus,
  emptyProductionTiming,
  getRenderProfile,
  groupJobsByLocation,
  migrateRenderProfileChange,
  previsPhaseToProductionPhase,
  ProductionTimeBudget,
  ProductionTimeBudgetExceededError,
  hasMissingControlVideos,
  RAPID_REVIEW_PROFILE,
  renderProfileFingerprint,
  resolveRenderAppearanceForShot,
  resolveProductionConfig,
  resolveRenderProfileForMode,
} from '../src/engine/previs';

describe('render profiles', () => {
  it('defines rapid-review at 640x360 without video export', () => {
    expect(RAPID_REVIEW_PROFILE).toMatchObject({
      id: 'rapid-review',
      width: 640,
      height: 360,
      renderVideo: false,
      skipPackage: true,
    });
  });

  it('resolves delivery profile for previs mode', () => {
    const profile = resolveRenderProfileForMode('previs');
    expect(profile.id).toBe('delivery');
    expect(profile.renderVideo).toBe(true);
    expect(resolveRenderAppearanceForShot(profile, { linkedPanoId: 'pano-ruins' })).toBe('projected');
    expect(resolveRenderAppearanceForShot(profile, { linkedPanoId: null })).toBe('clay');
  });

  it('produces stable fingerprints for cache invalidation', () => {
    const a = renderProfileFingerprint(getRenderProfile('rapid-review'));
    const b = renderProfileFingerprint(getRenderProfile('rapid-review'));
    const c = renderProfileFingerprint(getRenderProfile('delivery'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('production run config', () => {
  it('defaults to rapid-review mode with auto repair', () => {
    const config = resolveProductionConfig({
      manifestPath: 'examples/previs/minimal-dialogue.json',
    });
    expect(config.mode).toBe('rapid-review');
    expect(config.renderProfileId).toBe('rapid-review');
    expect(config.autoRepair).toBe(true);
    expect(config.maxRepairPasses).toBe(2);
    expect(config.skipPackage).toBe(true);
  });

  it('uses delivery settings for previs mode', () => {
    const config = resolveProductionConfig({
      manifestPath: 'examples/previs/minimal-dialogue.json',
      mode: 'previs',
    });
    expect(config.mode).toBe('previs');
    expect(config.renderProfileId).toBe('delivery');
    expect(config.maxRepairPasses).toBe(3);
    expect(config.skipPackage).toBe(false);
  });

  it('creates unique run ids', () => {
    const a = createProductionRunId();
    const b = createProductionRunId();
    expect(a).toMatch(/^prod_/);
    expect(b).toMatch(/^prod_/);
    expect(a).not.toBe(b);
  });
});

describe('production run status', () => {
  it('maps validation outcomes to terminal statuses', () => {
    expect(deriveProductionRunStatus({
      ok: true,
      failed: 0,
      warnings: 0,
      reviewRequiredShotIds: [],
    })).toBe('completed');

    expect(deriveProductionRunStatus({
      ok: true,
      failed: 0,
      warnings: 2,
      reviewRequiredShotIds: [],
    })).toBe('completed_with_warnings');

    expect(deriveProductionRunStatus({
      ok: false,
      failed: 0,
      warnings: 0,
      reviewRequiredShotIds: ['010'],
    })).toBe('needs_review');

    expect(deriveProductionRunStatus({
      ok: false,
      failed: 3,
      warnings: 0,
      reviewRequiredShotIds: [],
      error: 'render failed',
    })).toBe('failed');
  });
});

describe('production run state machine', () => {
  it('maps previs phases onto production phases', () => {
    expect(previsPhaseToProductionPhase('shots')).toBe('compile');
    expect(previsPhaseToProductionPhase('render')).toBe('render_review_frames');
    expect(previsPhaseToProductionPhase('contactSheet')).toBe('create_review_sheets');
    expect(previsPhaseToProductionPhase('complete')).toBe('complete');
  });

  it('invalidates frames when render profile fingerprint changes', () => {
    const state = createInitialRunState({
      manifestHash: 'abc',
      shotNumbers: ['010'],
    });
    const withFrame = {
      ...state,
      renderProfileFingerprint: 'old',
      shots: {
        '010': {
          compile: 'complete' as const,
          render: 'complete' as const,
          validation: 'passed' as const,
          framePath: '/tmp/010.png',
          renderSource: 'canonical_clay_renderer' as const,
        },
      },
    };
    const migrated = migrateRenderProfileChange(withFrame, 'new');
    expect(migrated.invalidated).toBe(true);
    expect(migrated.state.shots['010']?.render).toBe('pending');
    expect(migrated.state.shots['010']?.framePath).toBeUndefined();
    expect(migrated.state.phases.render).toBe('pending');
  });
});

describe('control video skipping', () => {
  it('ignores missing control videos when rapid-review skips them', () => {
    const shots = [{ shotNumber: '020', motion: { renderControlVideo: true } }];
    const shotStates = { '020': { compile: 'complete', video: 'pending' } };

    expect(hasMissingControlVideos({
      skipControlVideos: true,
      shots,
      shotStates,
    })).toBe(false);

    expect(hasMissingControlVideos({
      skipControlVideos: false,
      shots,
      shotStates,
    })).toBe(true);
  });
});

describe('production time budget', () => {
  it('throws when the budget is exceeded', () => {
    const budget = new ProductionTimeBudget(0, Date.now() - 1000);
    expect(() => budget.assertWithinBudget('render_review_frames')).toThrow(ProductionTimeBudgetExceededError);
  });

  it('reports remaining time while within budget', () => {
    const budget = new ProductionTimeBudget(60);
    expect(budget.isExpired()).toBe(false);
    expect(budget.remainingMs()).toBeGreaterThan(0);
  });
});

describe('render session helpers', () => {
  it('groups jobs by location in stable order', () => {
    const grouped = groupJobsByLocation(
      [
        { locationId: 'b', shotId: 's2' },
        { locationId: 'a', shotId: 's1' },
        { locationId: 'b', shotId: 's3' },
      ],
      ['a', 'b'],
    );
    expect(grouped.map((group) => group.locationId)).toEqual(['a', 'b']);
    expect(grouped[1]?.jobs).toHaveLength(2);
  });

  it('provides empty timing defaults', () => {
    expect(emptyProductionTiming()).toEqual({
      validationMs: 0,
      compilationMs: 0,
      renderingMs: 0,
      reviewMs: 0,
      repairMs: 0,
      totalMs: 0,
    });
  });
});
