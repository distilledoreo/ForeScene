/**
 * Central registry of storage and performance budget figures for Continuity Stage.
 *
 * Every numeric limit is labeled with one of:
 * - MeasuredBaseline — observed on documented hardware/fixtures (not a guarantee)
 * - RecommendedOperatingLimit — practical experience target; not hard-enforced
 * - HardEnforcedLimit — application actively blocks or constrains this value
 *
 * Product code should import concrete engines (modelImportBudget, videoPresets, …)
 * for enforcement. This module is the documentation-facing single index.
 */

import { IMPORT_BUDGET_POLICY } from './modelImportBudget';
import { MAX_BUILD_HISTORY } from './buildHistory';
import {
  DEFAULT_CAMERA_MOVE_DURATION_SECONDS,
  MAX_CAMERA_MOVE_DURATION_SECONDS,
  MIN_CAMERA_MOVE_DURATION_SECONDS,
} from './cameraKeyframes';
import {
  DEFAULT_VIDEO_FRAME_RATE,
  DEFAULT_VIDEO_HEIGHT,
  DEFAULT_VIDEO_WIDTH,
  VIDEO_RESOLUTION_PRESETS,
} from './videoPresets';

/** Classification for every published figure. */
export type BudgetClassification =
  | 'MeasuredBaseline'
  | 'RecommendedOperatingLimit'
  | 'HardEnforcedLimit';

export interface BudgetFigure<T = number> {
  value: T;
  classification: BudgetClassification;
  unit?: string;
  notes?: string;
}

const MIB = 1024 * 1024;

/** Recovery history caps from projectSafety (hard-enforced prune). */
export const RECOVERY_AUTOSAVE_REVISION_CAP = 8;
export const RECOVERY_SNAPSHOT_CAP = 10;

/**
 * Indexed catalog of storage/performance expectations.
 * Values mirror live engine constants where hard-enforced; otherwise documented guidance.
 */
export const PERFORMANCE_BUDGETS = {
  /** Typical graybox set complexity that stays responsive on mid-range laptops. */
  recommendedTriangleCount: {
    value: 250_000,
    classification: 'RecommendedOperatingLimit',
    unit: 'triangles',
    notes: 'Directional target for smooth Build + Shots fly camera. Not hard-enforced.',
  } satisfies BudgetFigure,

  /** Model import rejection uses byte-derived safety budget, not a fixed triangle count. */
  hardModelImportPolicy: {
    value: {
      maxPackedAssetBytes: IMPORT_BUDGET_POLICY.maxPackedAssetBytes,
      maxProjectAssetBytes: IMPORT_BUDGET_POLICY.maxProjectAssetBytes,
      maxSourceFileBytes: IMPORT_BUDGET_POLICY.maxSourceFileBytes,
      desktopBudgetCapBytes: IMPORT_BUDGET_POLICY.desktopBudgetCapBytes,
      mobileBudgetCapBytes: IMPORT_BUDGET_POLICY.mobileBudgetCapBytes,
    },
    classification: 'HardEnforcedLimit',
    notes: 'Enforced by estimateModelImportBudget + modelImport rejection path.',
  } satisfies BudgetFigure<Record<string, number>>,

  recommendedProjectStorageSize: {
    value: 200 * MIB,
    classification: 'RecommendedOperatingLimit',
    unit: 'bytes',
    notes: 'Comfortable IndexedDB project size for save/load on typical browsers. Larger projects work until quota.',
  } satisfies BudgetFigure,

  recoveryAutosaveRevisions: {
    value: RECOVERY_AUTOSAVE_REVISION_CAP,
    classification: 'HardEnforcedLimit',
    unit: 'revisions',
    notes: 'projectSafety prunes older autosaves beyond this count.',
  } satisfies BudgetFigure,

  recoverySnapshots: {
    value: RECOVERY_SNAPSHOT_CAP,
    classification: 'HardEnforcedLimit',
    unit: 'snapshots',
    notes: 'projectSafety prunes older recovery snapshots beyond this count.',
  } satisfies BudgetFigure,

  buildHistoryDepth: {
    value: MAX_BUILD_HISTORY,
    classification: 'HardEnforcedLimit',
    unit: 'steps',
    notes: 'Build undo stack depth cap.',
  } satisfies BudgetFigure,

  /** 4K render path pressure — observed guidance, not an app-enforced RAM check. */
  expected4kRenderMemoryPressure: {
    value: 1.5 * 1024 * MIB,
    classification: 'MeasuredBaseline',
    unit: 'bytes-peak-estimate',
    notes: 'Order-of-magnitude peak JS/GPU pressure for 4K camera-move encode on desktop Chromium; varies by GPU and scene.',
  } satisfies BudgetFigure,

  expectedStillExportDuration: {
    value: { clay1080pSeconds: 2, projected1080pSeconds: 5 },
    classification: 'MeasuredBaseline',
    unit: 'seconds',
    notes: 'Typical mid-range laptop stills for modest scenes; complex geometry and dual projectors take longer.',
  } satisfies BudgetFigure<{ clay1080pSeconds: number; projected1080pSeconds: number }>,

  cameraMovePresets: {
    value: {
      '1080p': VIDEO_RESOLUTION_PRESETS['1080p'],
      '4k': VIDEO_RESOLUTION_PRESETS['4k'],
      defaultFrameRate: DEFAULT_VIDEO_FRAME_RATE,
      defaultWidth: DEFAULT_VIDEO_WIDTH,
      defaultHeight: DEFAULT_VIDEO_HEIGHT,
      minDurationSeconds: MIN_CAMERA_MOVE_DURATION_SECONDS,
      maxDurationSeconds: MAX_CAMERA_MOVE_DURATION_SECONDS,
      defaultDurationSeconds: DEFAULT_CAMERA_MOVE_DURATION_SECONDS,
    },
    classification: 'HardEnforcedLimit',
    notes: 'Duration clamps and resolution presets enforced in camera-move authoring/export.',
  } satisfies BudgetFigure<Record<string, unknown>>,

  backupZipSizeExpectation: {
    value: 500 * MIB,
    classification: 'RecommendedOperatingLimit',
    unit: 'bytes',
    notes: 'Practical backup ZIP size for download/share. Larger ZIPs are allowed but may stress browser downloads.',
  } satisfies BudgetFigure,

  browserQuotaBehavior: {
    value: 'Browser IndexedDB/localStorage quotas vary; PanoRef surfaces save failures without claiming success.',
    classification: 'MeasuredBaseline',
    notes: 'No single hard quota is assumed. Failure messaging is required behavior.',
  } satisfies BudgetFigure<string>,

  webglGpuCaveats: {
    value: 'One WebGL context per SceneViewport; context is released on unmount. GPU memory is not queryable.',
    classification: 'MeasuredBaseline',
  } satisfies BudgetFigure<string>,

  supportedBrowsers: {
    value: ['Chromium desktop (primary)', 'WebKit desktop smoke', 'Edge Chromium'],
    classification: 'RecommendedOperatingLimit',
    notes: 'MP4 render path requires WebCodecs/MediaBunny-capable Chromium-class browsers. WebKit GPU is a non-blocking canary.',
  } satisfies BudgetFigure<string[]>,
} as const;

/** Human labels for docs. */
export const BUDGET_CLASSIFICATION_LABELS: Record<BudgetClassification, string> = {
  MeasuredBaseline: 'Measured baseline',
  RecommendedOperatingLimit: 'Recommended operating limit',
  HardEnforcedLimit: 'Hard-enforced limit',
};
