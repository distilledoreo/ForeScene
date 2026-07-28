import { describe, expect, it } from 'vitest';
import {
  BUDGET_CLASSIFICATION_LABELS,
  PERFORMANCE_BUDGETS,
  type BudgetClassification,
} from '../src/engine/budgets';
import { IMPORT_BUDGET_POLICY } from '../src/engine/modelImportBudget';
import { MAX_BUILD_HISTORY } from '../src/engine/buildHistory';
import { MAX_CAMERA_MOVE_DURATION_SECONDS } from '../src/engine/cameraKeyframes';

const REQUIRED: BudgetClassification[] = [
  'MeasuredBaseline',
  'RecommendedOperatingLimit',
  'HardEnforcedLimit',
];

describe('performance budgets registry', () => {
  it('labels every published figure with a known classification', () => {
    for (const [key, figure] of Object.entries(PERFORMANCE_BUDGETS)) {
      expect(REQUIRED, key).toContain(figure.classification);
      expect(BUDGET_CLASSIFICATION_LABELS[figure.classification].length).toBeGreaterThan(0);
    }
  });

  it('mirrors live hard-enforced engine constants', () => {
    expect(PERFORMANCE_BUDGETS.hardModelImportPolicy.value.maxPackedAssetBytes)
      .toBe(IMPORT_BUDGET_POLICY.maxPackedAssetBytes);
    expect(PERFORMANCE_BUDGETS.buildHistoryDepth.value).toBe(MAX_BUILD_HISTORY);
    expect(PERFORMANCE_BUDGETS.cameraMovePresets.value.maxDurationSeconds)
      .toBe(MAX_CAMERA_MOVE_DURATION_SECONDS);
    expect(PERFORMANCE_BUDGETS.recoveryAutosaveRevisions.classification).toBe('HardEnforcedLimit');
    expect(PERFORMANCE_BUDGETS.recommendedTriangleCount.classification).toBe('RecommendedOperatingLimit');
    expect(PERFORMANCE_BUDGETS.expected4kRenderMemoryPressure.classification).toBe('MeasuredBaseline');
  });
});
